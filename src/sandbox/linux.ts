import { dlopen, ptr, read } from "bun:ffi";
import { chmodSync, chownSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { restrictDevices } from "../oci-runtime/devices.ts";
import { bootstrapSandbox } from "./bootstrap.ts";
import { checkSandboxSeccompSupport, SANDBOX_SECCOMP_REVISION } from "./seccomp.ts";
import type { SandboxWorkerConfig } from "./worker.ts";

export interface SandboxLinuxLimits {
  memoryBytes: number;
  cpuPeriodMicros: number;
  cpuQuotaMicros: number;
  pidsMax: number;
  scratchBytes: number;
  scratchInodes: number;
}

export interface SandboxLinuxPlan extends SandboxWorkerConfig {
  stateDir: string;
  cgroupParent: string;
  runId: string;
  ownerToken: string;
  limits: SandboxLinuxLimits;
  hardDeadlineMs: number;
  /** Internal acceptance override; production uses the current bunc entrypoint. */
  workerCommand?: string[];
}

export interface LinuxSetupInfo { ready: true; execConfirmed: true }
export interface LinuxExit {
  exitCode: number | null;
  signal: number | null;
  deadline: boolean;
  stopReason: "cancelled" | "deadline" | "main_exit" | null;
}
export interface LinuxMetrics {
  cpuUsageUsec: number | null;
  memoryPeakBytes: number | null;
  oomKills: number | null;
  pidsDenied: number | null;
  populated: boolean | null;
}
export interface LinuxCleanup { complete: boolean; errors: string[] }
export interface LinuxDoctorCheck { name: string; ok: boolean; message: string }
export interface LinuxDoctorReport { ok: boolean; platform: string; seccompRevision: string; checks: LinuxDoctorCheck[] }

export interface LinuxSandboxProcess {
  pid: number;
  guardianPid: number;
  cgroupPath: string;
  scratchDir: string;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  setup: Promise<LinuxSetupInfo>;
  wait(): Promise<LinuxExit>;
  stop(reason?: "cancelled" | "deadline" | "main_exit"): Promise<void>;
  snapshotMetrics(): LinuxMetrics;
  cleanup(): Promise<LinuxCleanup>;
}

const runIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const ownerPattern = /^[a-f0-9]{32}$/;

function directCgroupPath(parent: string, runId: string): string {
  if (!runIdPattern.test(runId)) throw new Error("Invalid sandbox run ID");
  const resolvedParent = realpathSync(parent);
  const path = join(resolvedParent, `bunc-${runId}`);
  if (resolve(path) !== path || resolve(join(path, "..")) !== resolvedParent) throw new Error("Invalid sandbox cgroup path");
  return path;
}

function probeOpenat2(): { ok: boolean; message: string } {
  if (process.platform !== "linux") return { ok: false, message: "openat2 requires Linux" };
  const libc = dlopen("libc.so.6", {
    syscall: { args: ["i64", "i64", "ptr", "ptr", "u64"], returns: "i64" },
    __errno_location: { args: [], returns: "ptr" },
  });
  let root = -1, opened = -1;
  try {
    root = openSync("/", 0x200000); // O_PATH (same value on supported ABIs)
    const path = Buffer.from("proc\0"), how = new BigUint64Array([0x200000n, 0n, 0x02n | 0x04n | 0x08n]);
    opened = Number(libc.symbols.syscall(437, root, ptr(path), ptr(how), how.byteLength));
    if (opened < 0) return { ok: false, message: `openat2 constrained lookup failed: errno ${read.i32(libc.symbols.__errno_location()!)}` };
    return { ok: true, message: "openat2 constrained lookup available" };
  } catch (error) { return { ok: false, message: String(error) }; }
  finally { if (opened >= 0) closeSync(opened); if (root >= 0) closeSync(root); libc.close(); }
}

function writeControl(path: string, name: string, value: string | number) {
  writeFileSync(join(path, name), String(value));
}

function readNumber(path: string): number | null {
  try { const value = Number(readFileSync(path, "utf8").trim()); return Number.isSafeInteger(value) && value >= 0 ? value : null; }
  catch { return null; }
}

function keyedNumber(path: string, key: string): number | null {
  try {
    const match = readFileSync(path, "utf8").split("\n").find(line => line.startsWith(key + " "));
    return match ? readNumberValue(match.slice(key.length + 1)) : null;
  } catch { return null; }
}
function readNumberValue(value: string): number | null { const n = Number(value.trim()); return Number.isSafeInteger(n) && n >= 0 ? n : null; }

function populated(path: string): boolean | null {
  const value = keyedNumber(join(path, "cgroup.events"), "populated"); return value === null ? null : value === 1;
}

function killCgroup(path: string) {
  try { writeControl(path, "cgroup.kill", 1); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

async function waitEmpty(path: string, timeoutMs = 5000): Promise<boolean> {
  const end = performance.now() + timeoutMs;
  while (performance.now() < end) {
    const state = populated(path);
    if (state === false || state === null && !existsSync(path)) return true;
    await Bun.sleep(20);
  }
  return populated(path) === false;
}

async function reapGuardian(pid: number, timeoutMs = 5000): Promise<boolean> {
  const lib = dlopen("libc.so.6", {
    waitpid: { args: ["i32", "ptr", "i32"], returns: "i32" },
    __errno_location: { args: [], returns: "ptr" },
  });
  const status = new Int32Array(1), end = performance.now() + timeoutMs;
  try {
    while (performance.now() < end) {
      const result = lib.symbols.waitpid(pid, ptr(status), 1);
      if (result === pid || result < 0 && read.i32(lib.symbols.__errno_location()!) === 10) return true;
      if (result < 0 && read.i32(lib.symbols.__errno_location()!) !== 4) return false;
      await Bun.sleep(20);
    }
    return false;
  } finally { lib.close(); }
}

function mountScratch(path: string, limits: SandboxLinuxLimits) {
  const lib = dlopen("libc.so.6", {
    mount: { args: ["ptr", "ptr", "ptr", "u64", "ptr"], returns: "i32" },
    __errno_location: { args: [], returns: "ptr" },
  });
  const buffers: Buffer[] = [];
  const c = (value: string) => { const b = Buffer.from(value + "\0"); buffers.push(b); return ptr(b); };
  try {
    const data = `mode=0755,size=${limits.scratchBytes},nr_inodes=${limits.scratchInodes}`;
    const result = lib.symbols.mount(c("tmpfs"), c(path), c("tmpfs"), 2 | 4 | 8, c(data));
    if (result < 0) throw new Error(`Cannot mount bounded sandbox scratch: errno ${read.i32(lib.symbols.__errno_location()!)}`);
  } finally { lib.close(); }
}

function unmountScratch(path: string) {
  const lib = dlopen("libc.so.6", { umount2: { args: ["ptr", "i32"], returns: "i32" }, __errno_location: { args: [], returns: "ptr" } });
  const encoded = Buffer.from(path + "\0");
  try { if (lib.symbols.umount2(ptr(encoded), 0) < 0) throw new Error(`Cannot unmount sandbox scratch: errno ${read.i32(lib.symbols.__errno_location()!)}`); }
  finally { lib.close(); }
}

function webStream(fd: number): ReadableStream<Uint8Array> {
  // Bun's native fd stream owns the descriptor and integrates pipe readiness
  // with the event loop; node:fs streams perform blocking pipe reads in the
  // finite libuv worker pool and can starve the setup channel.
  const reader = Bun.file(fd).stream().getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try { const item = await reader.read(); if (item.done) controller.close(); else controller.enqueue(item.value); }
      catch (error) { controller.error(error); }
    },
    async cancel(reason) { await reader.cancel(reason); },
  });
}

async function readBounded(stream: ReadableStream<Uint8Array>, maximum: number): Promise<Buffer> {
  const reader = stream.getReader(), chunks: Uint8Array[] = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    total += value.byteLength; if (total > maximum) { await reader.cancel(); throw new Error("Sandbox control protocol exceeded its bound"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function validatePlan(plan: SandboxLinuxPlan) {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) throw new Error("Experimental sandbox requires native Linux amd64/arm64");
  if (process.getuid?.() !== 0) throw new Error("Experimental sandbox requires root in a disposable Linux host");
  if (!ownerPattern.test(plan.ownerToken)) throw new Error("Invalid sandbox owner token");
  directCgroupPath(plan.cgroupParent, plan.runId);
  if (!Number.isSafeInteger(plan.hardDeadlineMs) || plan.hardDeadlineMs < 1 || plan.hardDeadlineMs > 120_000) throw new Error("Invalid hard sandbox deadline");
  for (const [name, value] of Object.entries(plan.limits)) if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid sandbox limit ${name}`);
  if (!Number.isSafeInteger(plan.nofile) || plan.nofile < 3) throw new Error("Invalid sandbox NOFILE limit");
  if (plan.limits.cpuQuotaMicros > plan.limits.cpuPeriodMicros * 64) throw new Error("Invalid sandbox CPU quota");
  if (![plan.uid, plan.gid].every(value => Number.isInteger(value) && value > 0 && value <= 0xffffffff)) throw new Error("Sandbox identity must be nonroot");
  if (!plan.executable.startsWith("/") || plan.argv[0] !== plan.executable || !plan.argv.length) throw new Error("Invalid sandbox executable");
  if (plan.workerCommand && (!plan.workerCommand.length || plan.workerCommand.some(value => !value || value.includes("\0")))) throw new Error("Invalid internal worker command");
  if ([plan.executable, ...plan.argv, ...plan.env, plan.cwd, plan.hostname].some(value => value.includes("\0"))) throw new Error("NUL in sandbox process configuration");
  if (!plan.cwd.startsWith("/")) throw new Error("Sandbox cwd must be absolute");
}

export async function spawnLinuxSandbox(plan: SandboxLinuxPlan): Promise<LinuxSandboxProcess> {
  validatePlan(plan);
  const seccomp = checkSandboxSeccompSupport(); if (!seccomp.available) throw new Error(seccomp.message);
  const openat2 = probeOpenat2(); if (!openat2.ok) throw new Error(openat2.message);
  const cgroupPath = directCgroupPath(plan.cgroupParent, plan.runId), scratchDir = join(plan.stateDir, "scratch");
  const workerConfig: SandboxLinuxPlan = { ...plan, cgroupParent: realpathSync(plan.cgroupParent) };
  // Persist recovery ownership before acquiring the first kernel resource.
  writeFileSync(join(plan.stateDir, "worker.json"), JSON.stringify(workerConfig), { mode: 0o600, flag: "wx" });
  let scratchMounted = false, cgroupCreated = false;
  try {
    mkdirSync(cgroupPath, { mode: 0o755 }); cgroupCreated = true;
    writeControl(cgroupPath, "memory.max", plan.limits.memoryBytes);
    writeControl(cgroupPath, "memory.swap.max", 0);
    writeControl(cgroupPath, "memory.oom.group", 1);
    writeControl(cgroupPath, "pids.max", plan.limits.pidsMax);
    writeControl(cgroupPath, "cpu.max", `${plan.limits.cpuQuotaMicros} ${plan.limits.cpuPeriodMicros}`);
    restrictDevices(cgroupPath);
    mkdirSync(scratchDir, { mode: 0o700 }); mountScratch(scratchDir, plan.limits); scratchMounted = true;
    for (const [name, mode] of [["work", 0o700], ["output", 0o700], ["tmp", 0o1777], ["home", 0o700], ["dev-shm", 0o1777]] as const) {
      const path = join(scratchDir, name); mkdirSync(path, { mode }); chownSync(path, plan.uid, plan.gid); chmodSync(path, mode);
    }
    const procsFd = openSync(join(cgroupPath, "cgroup.procs"), "w"), killFd = openSync(join(cgroupPath, "cgroup.kill"), "w");
    let boot;
    try { boot = bootstrapSandbox(plan.stateDir, procsFd, killFd, plan.hardDeadlineMs, plan.workerCommand); }
    finally { closeSync(procsFd); closeSync(killFd); }
    const stdout = webStream(boot.stdoutFd), stderr = webStream(boot.stderrFd);
    const setupBytes = readBounded(webStream(boot.setupFd), 16 * 1024);
    const eventBytes = readBounded(webStream(boot.eventFd), 64 * 1024);
    let stopReason: LinuxExit["stopReason"] = null;
    const setup = setupBytes.then(data => {
      let offset = 0, ready = false;
      while (offset + 12 <= data.length) {
        const kind = data.readInt32LE(offset), value = data.readInt32LE(offset + 4), length = data.readUInt32LE(offset + 8); offset += 12;
        if (length > 1800 || offset + length > data.length) throw new Error("Truncated sandbox setup protocol");
        const message = data.subarray(offset, offset + length).toString(); offset += length;
        if (kind === 82) ready = true;
        else if (kind === 70) throw new Error(`Sandbox exec failed (errno ${value})`);
        else if (kind === 83) throw new Error(`Sandbox setup failed${message ? `: ${message}` : ""}`);
        else throw new Error("Unknown sandbox setup event");
      }
      if (offset !== data.length || !ready) throw new Error("Sandbox exited before completing setup");
      return { ready: true, execConfirmed: true } as const;
    });
    void setup.catch(() => {}); // The caller still observes the original promise.
    const waited = eventBytes.then(data => {
      let deadline = false, status: number | undefined;
      if (data.length % 8) throw new Error("Truncated sandbox guardian protocol");
      for (let offset = 0; offset < data.length; offset += 8) {
        const kind = data.readInt32LE(offset), value = data.readInt32LE(offset + 4);
        if (kind === 68) deadline = true;
        else if (kind === 69) status = value;
        else throw new Error("Unknown sandbox guardian event");
      }
      if (status === undefined) throw new Error("Sandbox guardian exited without process status");
      const signal = status & 0x7f;
      return { exitCode: signal === 0 ? status >>> 8 & 0xff : null, signal: signal || null, deadline, stopReason: deadline ? "deadline" : stopReason } satisfies LinuxExit;
    });
    void waited.catch(() => {});
    return {
      pid: boot.pid, guardianPid: boot.guardianPid, cgroupPath, scratchDir, stdout, stderr, setup,
      wait: () => waited,
      stop: async (reason = "cancelled") => {
        stopReason ??= reason; killCgroup(cgroupPath);
        if (!await waitEmpty(cgroupPath)) throw new Error("Sandbox cgroup remained populated after stop");
      },
      snapshotMetrics: () => ({
        cpuUsageUsec: keyedNumber(join(cgroupPath, "cpu.stat"), "usage_usec"),
        memoryPeakBytes: readNumber(join(cgroupPath, "memory.peak")),
        oomKills: keyedNumber(join(cgroupPath, "memory.events"), "oom_kill"),
        pidsDenied: keyedNumber(join(cgroupPath, "pids.events"), "max"), populated: populated(cgroupPath),
      }),
      cleanup: async () => {
        const errors: string[] = [];
        try { killCgroup(cgroupPath); if (!await waitEmpty(cgroupPath)) throw new Error("Sandbox cgroup remained populated"); } catch (error) { errors.push(String(error)); }
        try { closeSync(boot.livenessFd); } catch {}
        try { if (!await reapGuardian(boot.guardianPid)) throw new Error("Sandbox guardian did not exit"); } catch (error) { errors.push(String(error)); }
        try { unmountScratch(scratchDir); } catch (error) { errors.push(String(error)); }
        if (!errors.length) try { rmdirSync(cgroupPath); } catch (error) { errors.push(String(error)); }
        return { complete: errors.length === 0, errors };
      },
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try { killCgroup(cgroupPath); if (!await waitEmpty(cgroupPath)) cleanupErrors.push(new Error("Sandbox cgroup remained populated during failed spawn")); } catch (cleanup) { cleanupErrors.push(cleanup); }
    if (scratchMounted) try { unmountScratch(scratchDir); } catch (cleanup) { cleanupErrors.push(cleanup); }
    if (cgroupCreated) try { rmdirSync(cgroupPath); } catch (cleanup) { cleanupErrors.push(cleanup); }
    if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors], "Sandbox spawn failed and cleanup was incomplete");
    throw error;
  }
}

export async function recoverLinuxSandbox(input: { cgroupParent: string; runId: string }): Promise<LinuxCleanup> {
  const errors: string[] = []; let path: string;
  try { path = directCgroupPath(input.cgroupParent, input.runId); }
  catch (error) { return { complete: false, errors: [String(error)] }; }
  if (!existsSync(path)) return { complete: true, errors };
  try { killCgroup(path); if (!await waitEmpty(path)) throw new Error("Recovered sandbox cgroup remained populated"); } catch (error) { errors.push(String(error)); }
  if (!errors.length) try { rmdirSync(path); } catch (error) { errors.push(String(error)); }
  return { complete: errors.length === 0, errors };
}

export function doctorLinuxSandbox(input: { cgroupParent?: string } = {}): LinuxDoctorReport {
  const checks: LinuxDoctorCheck[] = [];
  const add = (name: string, ok: boolean, message: string) => checks.push({ name, ok, message });
  add("platform", process.platform === "linux" && ["x64", "arm64"].includes(process.arch), `${process.platform}/${process.arch}`);
  add("identity", process.getuid?.() === 0, process.getuid?.() === 0 ? "root" : `uid ${process.getuid?.() ?? "unknown"}`);
  add("cgroup-v2", existsSync("/sys/fs/cgroup/cgroup.controllers") && existsSync("/sys/fs/cgroup/cgroup.kill"), "cgroup v2 with cgroup.kill required");
  const seccomp = checkSandboxSeccompSupport(); add("seccomp", seccomp.available, seccomp.message);
  const openat2 = probeOpenat2(); add("openat2", openat2.ok, openat2.message);
  add("mount-namespace", existsSync("/proc/self/ns/mnt"), "mount namespace handle");
  if (input.cgroupParent) {
    try {
      const parent = realpathSync(input.cgroupParent);
      const controllers = readFileSync(join(parent, "cgroup.controllers"), "utf8").trim().split(/\s+/);
      const enabled = readFileSync(join(parent, "cgroup.subtree_control"), "utf8").trim().split(/\s+/).map(value => value.replace(/^\+/, ""));
      const required = ["cpu", "memory", "pids"], missing = required.filter(value => !controllers.includes(value) || !enabled.includes(value));
      add("cgroup-parent", missing.length === 0, missing.length ? `controllers not delegated: ${missing.join(", ")}` : parent);
      if (!missing.length && process.getuid?.() === 0) {
        const probe = join(parent, `bunc-doctor-${process.pid}`);
        try {
          mkdirSync(probe); writeControl(probe, "memory.max", 32 * 1024 * 1024); writeControl(probe, "pids.max", 4);
          restrictDevices(probe); rmdirSync(probe);
          add("enforcement-probe", true, "cgroup controls and device BPF attach succeeded");
        } catch (error) { add("enforcement-probe", false, String(error)); }
        finally { if (existsSync(probe)) try { rmdirSync(probe); } catch {} }
      }
    } catch (error) { add("cgroup-parent", false, String(error)); }
  }
  return { ok: checks.every(check => check.ok), platform: `${process.platform}/${process.arch}`, seccompRevision: SANDBOX_SECCOMP_REVISION, checks };
}
