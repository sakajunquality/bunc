import { randomBytes } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { dlopen, ptr, read } from "bun:ffi";
import { bootstrapInternal } from "./bootstrap.ts";
import { executePreparationWork, type PreparationExecutor, type PreparationWork } from "./environment.ts";

const markerName = ".bunc-preparation-resource.json";
const workName = ".bunc-preparation-work.json";
const tokenPattern = /^[a-f0-9]{32}$/;

interface PreparationMarker {
  schemaVersion: 1;
  ownerToken: string;
  cgroupParent: string;
  cgroupPath: string;
}

export interface PreparationRecovery { complete: boolean; errors: string[]; recovered: string[] }

function writeControl(path: string, name: string, value: string | number) { writeFileSync(join(path, name), String(value)); }
function populated(path: string): boolean {
  try { return /^populated 1$/m.test(readFileSync(join(path, "cgroup.events"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function kill(path: string) { try { writeControl(path, "cgroup.kill", 1); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
async function waitEmpty(path: string, timeoutMs = 5000) {
  const end = performance.now() + timeoutMs;
  while (performance.now() < end) { if (!populated(path)) return true; await Bun.sleep(20); }
  return !populated(path);
}
async function reap(pid: number, timeoutMs = 5000) {
  const lib = dlopen("libc.so.6", { waitpid: { args: ["i32", "ptr", "i32"], returns: "i32" }, __errno_location: { args: [], returns: "ptr" } });
  const status = new Int32Array(1), end = performance.now() + timeoutMs;
  try {
    while (performance.now() < end) {
      const result = lib.symbols.waitpid(pid, ptr(status), 1), errno = result < 0 ? read.i32(lib.symbols.__errno_location()!) : 0;
      if (result === pid || result < 0 && errno === 10) return true;
      if (result < 0 && errno !== 4) return false;
      await Bun.sleep(20);
    }
    return false;
  } finally { lib.close(); }
}

async function boundedFd(fd: number, limit = 64 * 1024): Promise<Buffer> {
  const reader = Bun.file(fd).stream().getReader(), chunks: Buffer[] = []; let bytes = 0;
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      const chunk = Buffer.from(item.value); bytes += chunk.length;
      if (bytes > limit) { await reader.cancel(); throw new Error("Preparation diagnostic exceeded its bound"); }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally { /* Bun's native file stream owns the supplied descriptor. */ }
}

async function guardianResult(fd: number): Promise<{ status: number; deadline: boolean }> {
  const data = await boundedFd(fd), result = { status: -1, deadline: false };
  if (data.length % 8) throw new Error("Truncated preparation guardian protocol");
  for (let offset = 0; offset < data.length; offset += 8) {
    const kind = data.readInt32LE(offset), value = data.readInt32LE(offset + 4);
    if (kind === 68) result.deadline = true;
    else if (kind === 69) result.status = value;
    else throw new Error("Unknown preparation guardian event");
  }
  if (result.status < 0) throw new Error("Preparation guardian returned no process status");
  return result;
}

function preparationCommand(config: string): string[] {
  const entrypoint = Bun.isStandaloneExecutable ? [process.execPath] : [process.execPath, resolve(process.argv[1]!)];
  return [...entrypoint, "--sandbox-prepare-worker", config];
}

/** Execute trusted environment preparation with an outer cgroup and guardian. */
export function createPreparationExecutor(cgroupParentInput: string): PreparationExecutor {
  return async (work, limits) => {
    if (limits.signal.aborted) throw limits.signal.reason;
    for (const [name, value] of Object.entries({ timeoutMs: limits.timeoutMs, memoryBytes: limits.memoryBytes, diskBytes: limits.diskBytes }))
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid preparation ${name}`);
    const parent = realpathSync(cgroupParentInput), token = randomBytes(16).toString("hex");
    const cgroup = join(parent, `bunc-prepare-${token}`), markerPath = join(work.staging, markerName), workPath = join(work.staging, workName);
    const marker: PreparationMarker = { schemaVersion: 1, ownerToken: token, cgroupParent: parent, cgroupPath: cgroup };
    writeFileSync(markerPath, JSON.stringify(marker), { mode: 0o600, flag: "wx" });
    writeFileSync(workPath, JSON.stringify(work), { mode: 0o600, flag: "wx" });
    let guardianPid: number | undefined, livenessFd: number | undefined, created = false, success = false;
    const cleanupErrors: unknown[] = [];
    try {
      mkdirSync(cgroup, { mode: 0o755 }); created = true;
      writeControl(cgroup, "memory.max", limits.memoryBytes); writeControl(cgroup, "memory.swap.max", 0);
      writeControl(cgroup, "memory.oom.group", 1); writeControl(cgroup, "pids.max", 64); writeControl(cgroup, "cpu.max", "100000 100000");
      const procs = openSync(join(cgroup, "cgroup.procs"), "w"), killFd = openSync(join(cgroup, "cgroup.kill"), "w");
      let boot;
      try {
        boot = bootstrapInternal({ stateDir: work.staging, cgroupProcsFd: procs, cgroupKillFd: killFd,
          hardDeadlineMs: limits.timeoutMs, command: preparationCommand(workPath),
          env: ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "BUNC_SANDBOX_SETUP_FD=3"], namespaceFlags: 0 });
      } finally { closeSync(procs); closeSync(killFd); }
      guardianPid = boot.guardianPid; livenessFd = boot.livenessFd;
      const stdout = boundedFd(boot.stdoutFd), stderr = boundedFd(boot.stderrFd), setup = boundedFd(boot.setupFd, 4096), event = guardianResult(boot.eventFd);
      const abort = () => { try { kill(cgroup); } catch {} };
      limits.signal.addEventListener("abort", abort, { once: true });
      if (limits.signal.aborted) abort();
      let observed;
      try { [observed] = await Promise.all([event, stdout, stderr, setup]); }
      finally { limits.signal.removeEventListener("abort", abort); }
      if (limits.signal.aborted) throw limits.signal.reason;
      if (observed.deadline) throw new Error("Environment preparation exceeded its native hard deadline");
      const signal = observed.status & 0x7f, code = observed.status >>> 8 & 0xff;
      if (signal || code !== 0) {
        const diagnostics = (await stderr).toString("utf8").slice(0, 2000);
        const oom = /^oom_kill [1-9]/m.test(readFileSync(join(cgroup, "memory.events"), "utf8"));
        throw new Error(oom ? "Environment preparation exceeded its memory limit" : `Environment preparation child failed (${signal ? `signal ${signal}` : `exit ${code}`})${diagnostics ? `: ${diagnostics}` : ""}`);
      }
      success = true;
    } finally {
      if (created) {
        try { kill(cgroup); if (!await waitEmpty(cgroup)) throw new Error("Preparation cgroup remained populated"); } catch (error) { cleanupErrors.push(error); }
      }
      if (livenessFd !== undefined) try { closeSync(livenessFd); } catch {}
      if (guardianPid !== undefined) try { if (!await reap(guardianPid)) throw new Error("Preparation guardian did not exit"); } catch (error) { cleanupErrors.push(error); }
      if (created && !cleanupErrors.length) try { rmdirSync(cgroup); } catch (error) { cleanupErrors.push(error); }
      if (!cleanupErrors.length) {
        try { unlinkSync(workPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanupErrors.push(error); }
        try { unlinkSync(markerPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") cleanupErrors.push(error); }
      }
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, success ? "Preparation succeeded but cleanup was incomplete" : "Preparation failed and cleanup was incomplete");
    }
  };
}

/** Internal child dispatch. The resource-bounded parent owns publication. */
export async function preparationWorker(configFile: string): Promise<never> {
  try { closeSync(3); } catch {}
  const info = lstatSync(configFile);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024 || (info.mode & 0o077) !== 0) throw new Error("Unsafe preparation work file");
  const work: PreparationWork = JSON.parse(readFileSync(configFile, "utf8"));
  await executePreparationWork(work);
  process.exit(0);
}

function readMarker(path: string, expectedParent: string): PreparationMarker {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096 || (info.mode & 0o077) !== 0) throw new Error("Unsafe preparation resource marker");
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid preparation resource marker");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).sort().join(",") !== "cgroupParent,cgroupPath,ownerToken,schemaVersion" || item.schemaVersion !== 1 || typeof item.ownerToken !== "string" || !tokenPattern.test(item.ownerToken)) throw new Error("Invalid preparation resource marker");
  const expectedPath = join(expectedParent, `bunc-prepare-${item.ownerToken}`);
  if (item.cgroupParent !== expectedParent || item.cgroupPath !== expectedPath || dirname(expectedPath) !== expectedParent) throw new Error("Preparation resource marker does not own this cgroup");
  return item as unknown as PreparationMarker;
}

/** Recover only cgroups named by protected incomplete-preparation markers. */
export async function recoverPreparationResources(input: { stateRoot: string; cgroupParent: string }): Promise<PreparationRecovery> {
  const errors: string[] = [], recovered: string[] = [], parent = realpathSync(input.cgroupParent), prepared = join(realpathSync(input.stateRoot), "prepared");
  for (const entry of readdirSync(prepared, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^\.prepare-[a-f0-9]{64}-[a-f0-9]{16}$/.test(entry.name)) continue;
    const markerPath = join(prepared, entry.name, markerName);
    if (!existsSync(markerPath)) continue;
    try {
      const marker = readMarker(markerPath, parent);
      if (existsSync(marker.cgroupPath)) {
        kill(marker.cgroupPath);
        if (!await waitEmpty(marker.cgroupPath)) throw new Error("Recovered preparation cgroup remained populated");
        rmdirSync(marker.cgroupPath);
      }
      unlinkSync(markerPath); recovered.push(entry.name);
    } catch (error) { errors.push(`${entry.name}: ${String(error)}`); }
  }
  return { complete: errors.length === 0, errors, recovered };
}
