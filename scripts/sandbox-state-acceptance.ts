import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { dlopen, ptr, read } from "bun:ffi";
import type { JobResult } from "../src/sandbox/contract.ts";

export interface SandboxStateAcceptanceOptions {
  command: readonly string[];
  environment: string;
  stateRoot: string;
  layout?: string;
  labRoot?: string;
  cgroupParent?: string;
}

export interface SandboxStateAcceptanceCheck {
  name: string;
  ms: number;
  outcome: "succeeded" | "rejected" | "recovered" | "verified";
}

interface Invocation { stdout: string; stderr: string; code: number }
interface PreparationMarker { schemaVersion: 1; ownerToken: string; cgroupParent: string; cgroupPath: string }
interface LinuxProcessIdentity { pid: number; ppid: number; bootId: string; startTime: string; state: string }

const preparationName = /^\.prepare-[a-f0-9]{64}-[a-f0-9]{16}$/;
const ownerToken = /^[a-f0-9]{32}$/;

function message(invocation: Invocation) { return invocation.stderr || invocation.stdout; }

async function waitFor<T>(label: string, timeoutMs: number, inspect: () => Promise<T | undefined>): Promise<T> {
  const end = performance.now() + timeoutMs;
  while (performance.now() < end) {
    const value = await inspect();
    if (value !== undefined) return value;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function boundedInvocation(command: readonly string[], args: string[], timeoutMs = 60_000): Promise<Invocation> {
  const child = Bun.spawn([...command, "sandbox", ...args, "--experimental-sandbox"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  } finally { clearTimeout(timer); }
}

function parseJSON<T>(text: string, label: string): T {
  try { return JSON.parse(text) as T; }
  catch (error) { throw new Error(`${label} returned invalid JSON: ${text.slice(0, 2000)}`, { cause: error }); }
}

function exactMarker(value: unknown, parent: string): PreparationMarker {
  assert(value && typeof value === "object" && !Array.isArray(value), "Preparation marker must be an object");
  const item = value as Record<string, unknown>;
  assert.deepEqual(Object.keys(item).sort(), ["cgroupParent", "cgroupPath", "ownerToken", "schemaVersion"]);
  assert.equal(item.schemaVersion, 1); assert.equal(typeof item.ownerToken, "string"); assert.match(item.ownerToken as string, ownerToken);
  const expected = join(parent, `bunc-prepare-${item.ownerToken}`);
  assert.equal(item.cgroupParent, parent); assert.equal(item.cgroupPath, expected); assert.equal(dirname(expected), parent);
  return item as unknown as PreparationMarker;
}

async function populated(cgroup: string) {
  try { return /^populated 1$/m.test(await readFile(join(cgroup, "cgroup.events"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function pathExists(path: string) {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function assertPreparationControls(cgroup: string) {
  assert.equal((await readFile(join(cgroup, "memory.max"), "utf8")).trim(), String(1024 ** 3));
  assert.equal((await readFile(join(cgroup, "memory.swap.max"), "utf8")).trim(), "0");
  assert.equal((await readFile(join(cgroup, "memory.oom.group"), "utf8")).trim(), "1");
  assert.equal((await readFile(join(cgroup, "pids.max"), "utf8")).trim(), "64");
  assert.equal((await readFile(join(cgroup, "cpu.max"), "utf8")).trim(), "100000 100000");
  const pids = (await readFile(join(cgroup, "cgroup.procs"), "utf8")).trim().split("\n").filter(Boolean);
  assert(pids.length > 0, "Preparation cgroup must contain its worker");
  for (const pid of pids) assert.match(pid, /^[1-9][0-9]*$/);
  return pids.map(Number);
}

async function linuxProcessIdentity(pid: number): Promise<LinuxProcessIdentity | undefined> {
  try {
    const [bootId, stat] = await Promise.all([readFile("/proc/sys/kernel/random/boot_id", "utf8"), readFile(`/proc/${pid}/stat`, "utf8")]);
    const end = stat.lastIndexOf(")"); if (end < 0) throw new Error(`Malformed process stat for ${pid}`);
    const fields = stat.slice(end + 2).trim().split(/\s+/), state = fields[0], ppid = Number(fields[1]), startTime = fields[19];
    if (!state || !/^[A-Za-z]$/.test(state) || !Number.isSafeInteger(ppid) || ppid < 0) throw new Error(`Malformed process state for ${pid}`);
    if (!startTime || !/^\d+$/.test(startTime)) throw new Error(`Malformed process start time for ${pid}`);
    return { pid, ppid, bootId: bootId.trim(), startTime, state };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
}

async function directChildren(parentPid: number): Promise<LinuxProcessIdentity[]> {
  const entries = await readdir("/proc", { withFileTypes: true });
  if (entries.length > 131_072) throw new Error("Process table exceeds acceptance scan bound");
  const children: LinuxProcessIdentity[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[1-9][0-9]*$/.test(entry.name)) continue;
    const identity = await linuxProcessIdentity(Number(entry.name));
    if (identity?.ppid === parentPid) children.push(identity);
  }
  return children;
}

async function stableDirectGuardian(parentPid: number): Promise<LinuxProcessIdentity | undefined> {
  const children = await directChildren(parentPid);
  if (children.length > 1) throw new Error(`Expected one native guardian child, saw ${children.map(child => child.pid).join(",")}`);
  const candidate = children[0]; if (!candidate) return;
  await Bun.sleep(5);
  const current = await linuxProcessIdentity(candidate.pid);
  if (!current || current.ppid !== parentPid || current.bootId !== candidate.bootId || current.startTime !== candidate.startTime || current.state === "Z" || current.state === "X") return;
  return current;
}

async function guardianStillRunning(identity: LinuxProcessIdentity) {
  const current = await linuxProcessIdentity(identity.pid);
  if (current === undefined || current.bootId !== identity.bootId || current.startTime !== identity.startTime) return false;
  if (current.state !== "Z" && current.state !== "X") return true;
  // The acceptance process is PID 1, so the killed supervisor's guardian is
  // adopted here. Reap only the exact identity observed before the crash; never
  // use waitpid(-1), which could steal a Bun-managed subprocess status.
  const library = dlopen("libc.so.6", { waitpid: { args: ["i32", "ptr", "i32"], returns: "i32" }, __errno_location: { args: [], returns: "ptr" } });
  const status = new Int32Array(1);
  try {
    const result = library.symbols.waitpid(identity.pid, ptr(status), 1);
    if (result === identity.pid) return false;
    if (result < 0 && read.i32(library.symbols.__errno_location()!) === 10) return false; // ECHILD: already reaped.
    if (result === 0) return true;
    throw new Error(`Cannot reap preparation guardian ${identity.pid}`);
  } finally { library.close(); }
}

/**
 * Destructive only inside generated /lab state and exact bunc-jobs children.
 * The supplied command may be a Bun script command or the compiled executable.
 */
export async function runSandboxStateAcceptance(options: SandboxStateAcceptanceOptions): Promise<SandboxStateAcceptanceCheck[]> {
  assert(options.command.length > 0 && options.command.every(value => value.length > 0 && !value.includes("\0")), "A direct bunc command is required");
  const labRoot = resolve(options.labRoot ?? "/lab"), layout = resolve(options.layout ?? "/image");
  const environment = resolve(options.environment), stateRoot = resolve(options.stateRoot);
  assert(labRoot === "/lab" || labRoot.startsWith("/lab/"), "State acceptance must remain beneath /lab");
  assert(stateRoot.startsWith(`${labRoot}/`), "The ordinary state root must be beneath the lab root");
  assert(environment.startsWith(`${labRoot}/`), "The environment descriptor must be beneath the lab root");
  assert.equal(layout, "/image", "State acceptance uses the approved /image layout");
  const cgroupParent = await realpath(options.cgroupParent ?? "/sys/fs/cgroup/bunc-jobs");
  assert.equal(cgroupParent, "/sys/fs/cgroup/bunc-jobs", "State acceptance uses only the disposable bunc-jobs cgroup subtree");
  await mkdir(labRoot, { recursive: true });
  const checks: SandboxStateAcceptanceCheck[] = [];
  const invoke = (args: string[], timeoutMs?: number) => boundedInvocation(options.command, args, timeoutMs);
  const startedCache = performance.now();

  const inspected = await invoke(["cache", "--state-root", stateRoot]);
  assert.equal(inspected.code, 0, `cache inspect: ${message(inspected)}`);
  const cache = parseJSON<{ entries: { key: string }[]; incomplete: string[] }>(inspected.stdout, "cache inspect");
  assert.equal(cache.incomplete.length, 0, "Ordinary cache must have no incomplete preparations");
  assert.equal(cache.entries.length, 1, `Expected one prepared environment: ${inspected.stdout}`);
  const key = cache.entries[0]!.key; assert.match(key, /^[a-f0-9]{64}$/);
  const removed = await invoke(["cache", "--state-root", stateRoot, "--remove", key]);
  assert.equal(removed.code, 0, `cache remove: ${message(removed)}`);
  const removedCache = parseJSON<{ removed: string[]; entries: unknown[] }>(removed.stdout, "cache remove");
  assert.deepEqual(removedCache.removed, [key]); assert.equal(removedCache.entries.length, 0);

  const request = join(labRoot, "cache-miss-request.json"), resultsRoot = join(labRoot, "state-acceptance-results"), resultDirectory = join(resultsRoot, "cache-miss");
  await rm(resultsRoot, { recursive: true, force: true }); await mkdir(resultsRoot, { mode: 0o700 });
  await writeFile(request, JSON.stringify({ schemaVersion: 1, code: "console.log('must not execute')", inputs: [], limits: {} }), { mode: 0o600 });
  const missing = await invoke(["run", "--environment", environment, "--state-root", stateRoot, "--cgroup-parent", cgroupParent, "--request", request, "--result-dir", resultDirectory]);
  const missingResult = parseJSON<JobResult>(missing.stdout, "unprepared run");
  assert.equal(missing.code, 2, `${missing.stdout}\n${missing.stderr}`);
  assert.equal(missingResult.outcome, "rejected"); assert.equal(missingResult.reason?.code, "ENVIRONMENT_NOT_PREPARED");
  assert.equal(missingResult.cleanup, "not_needed");
  checks.push({ name: "cache-remove-and-miss", ms: performance.now() - startedCache, outcome: "rejected" });

  const reprepare = await invoke(["prepare", "--layout", layout, "--environment", environment, "--state-root", stateRoot, "--cgroup-parent", cgroupParent], 180_000);
  assert.equal(reprepare.code, 0, `reprepare ordinary cache: ${message(reprepare)}`);
  const restored = await invoke(["cache", "--state-root", stateRoot]);
  assert.equal(restored.code, 0, `restored cache inspect: ${message(restored)}`);
  assert.equal(parseJSON<{ entries: { key: string }[] }>(restored.stdout, "restored cache").entries[0]?.key, key);
  checks.push({ name: "cache-reprepare", ms: 0, outcome: "succeeded" });

  const startedCrash = performance.now(), crashState = await mkdtemp(join(labRoot, "state-crash-"));
  await rm(crashState, { recursive: true }); // prepare must create and protect the state root itself.
  let prepareChild: ReturnType<typeof Bun.spawn> | undefined, crashCgroup: string | undefined;
  try {
    prepareChild = Bun.spawn([...options.command, "sandbox", "prepare", "--layout", layout, "--environment", environment,
      "--state-root", crashState, "--cgroup-parent", cgroupParent, "--experimental-sandbox"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const stdout = new Response(prepareChild.stdout as ReadableStream<Uint8Array>).text();
    const stderr = new Response(prepareChild.stderr as ReadableStream<Uint8Array>).text();
    const observed = await waitFor("a live bounded preparation cgroup", 30_000, async () => {
      let names: string[];
      try { names = await readdir(join(crashState, "prepared")); } catch { return; }
      for (const name of names) {
        if (!preparationName.test(name)) continue;
        const staging = join(crashState, "prepared", name), markerPath = join(staging, ".bunc-preparation-resource.json");
        try {
          const info = await lstat(markerPath);
          assert(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 4096 && (info.mode & 0o077) === 0, "Preparation marker must be a protected bounded regular file");
          if (typeof process.geteuid === "function") assert.equal(info.uid, process.geteuid(), "Preparation marker must be operator-owned");
          const marker = exactMarker(JSON.parse(await readFile(markerPath, "utf8")), cgroupParent);
          if (!await populated(marker.cgroupPath)) continue;
          return { name, staging, marker };
        } catch (error) {
          if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
          throw error;
        }
      }
    });
    crashCgroup = observed.marker.cgroupPath;
    // Freeze the exact observed child so preparation cannot win the race before
    // the supervisor crash. The native guardian remains outside this cgroup.
    await writeFile(join(crashCgroup, "cgroup.freeze"), "1");
    await waitFor("the preparation cgroup to freeze", 5000, async () => /^frozen 1$/m.test(await readFile(join(crashCgroup!, "cgroup.events"), "utf8")) ? true : undefined);
    const workerPids = await assertPreparationControls(crashCgroup);
    const guardian = await waitFor("stable preparation guardian identity", 5000, () => stableDirectGuardian(prepareChild!.pid));
    assert(!workerPids.includes(guardian.pid), "Guardian must remain outside the preparation cgroup");
    checks.push({ name: "native-preparation-controls", ms: 0, outcome: "verified" });
    prepareChild.kill("SIGKILL");
    const exit = await prepareChild.exited; assert.notEqual(exit, 0, "Killed preparation supervisor must not succeed");
    await Promise.all([stdout, stderr]);
    await waitFor("guardian cgroup termination", 10_000, async () => !await populated(crashCgroup!) ? true : undefined);
    await waitFor("guardian process exit", 10_000, async () => !await guardianStillRunning(guardian) ? true : undefined);
    assert((await readdir(join(crashState, "prepared"))).includes(observed.name), "Interrupted preparation staging must remain for recovery");

    const gc = await invoke(["gc", "--state-root", crashState, "--cgroup-parent", cgroupParent]);
    assert.equal(gc.code, 0, `preparation gc: ${gc.stdout}\n${gc.stderr}`);
    const recovery = parseJSON<{ incompletePreparations: string[] }>(gc.stdout, "preparation gc");
    assert(recovery.incompletePreparations.includes(observed.name), `GC did not report ${observed.name}: ${gc.stdout}`);
    assert.equal(await pathExists(crashCgroup), false, "GC must remove the exact orphan preparation cgroup");
    assert.equal((await readdir(join(crashState, "prepared"))).length, 0, "GC must remove interrupted staging");
    checks.push({ name: "preparation-crash-recovery", ms: performance.now() - startedCrash, outcome: "recovered" });

    const finalPrepare = await invoke(["prepare", "--layout", layout, "--environment", environment, "--state-root", crashState, "--cgroup-parent", cgroupParent], 180_000);
    assert.equal(finalPrepare.code, 0, `prepare after crash recovery: ${message(finalPrepare)}`);
    const finalCache = await invoke(["cache", "--state-root", crashState]);
    assert.equal(finalCache.code, 0, `cache after recovery: ${message(finalCache)}`);
    assert.equal(parseJSON<{ entries: unknown[] }>(finalCache.stdout, "cache after recovery").entries.length, 1);
    checks.push({ name: "prepare-after-recovery", ms: 0, outcome: "succeeded" });
  } finally {
    if (prepareChild && prepareChild.exitCode === null) {
      prepareChild.kill("SIGKILL");
      await Promise.race([prepareChild.exited, Bun.sleep(5000)]);
    }
    if (crashCgroup && await pathExists(crashCgroup)) {
      try { await writeFile(join(crashCgroup, "cgroup.freeze"), "0"); } catch {}
      try { await writeFile(join(crashCgroup, "cgroup.kill"), "1"); } catch {}
      try { await waitFor("failed acceptance cgroup termination", 5000, async () => !await populated(crashCgroup!) ? true : undefined); } catch {}
    }
    try { await invoke(["gc", "--state-root", crashState, "--cgroup-parent", cgroupParent], 15_000); } catch {}
    await rm(crashState, { recursive: true, force: true });
    await rm(request, { force: true }); await rm(resultsRoot, { recursive: true, force: true });
  }
  return checks;
}
