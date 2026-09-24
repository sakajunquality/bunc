import { randomBytes } from "node:crypto";
import { constants, closeSync, fchmodSync, fsyncSync, ftruncateSync, fstatSync, lstatSync, openSync, readFileSync, writeSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { hostname, platform } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { dlopen } from "bun:ffi";

const LOCK_EX = 2;
const LOCK_NB = 4;
const STATE_SCHEMA = 1 as const;
const MAX_JOURNAL_BYTES = 256 * 1024;
const runIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const keyPattern = /^[a-f0-9]{64}$/;
const tokenPattern = /^[a-f0-9]{32}$/;

export interface ProcessIdentity {
  pid: number;
  bootId: string;
  startTime: string;
}

export type OwnedResource =
  | { kind: "cgroup"; path: string; ownerToken: string }
  | { kind: "mount"; path: string; ownerToken: string }
  | { kind: "process"; identity: ProcessIdentity };

export interface JobJournalData {
  schemaVersion: 1;
  runId: string;
  owner: ProcessIdentity;
  environmentKey: string;
  status: "active" | "complete" | "recovered" | "quarantined";
  resources: OwnedResource[];
  createdAt: string;
  updatedAt: string;
  recoveryErrors: string[];
}

export class StateBusyError extends Error {
  constructor(readonly stateRoot: string) {
    super(`Sandbox state root is busy: ${stateRoot}`);
    this.name = "StateBusyError";
  }
}

export interface StateRootLease {
  readonly root: string;
  readonly token: string;
  readonly owner: ProcessIdentity;
  readonly released: boolean;
  release(): Promise<void>;
}

export interface JobJournal {
  readonly path: string;
  readonly data: JobJournalData;
  record(resource: OwnedResource): Promise<void>;
  release(resource: OwnedResource): Promise<void>;
  finish(): Promise<void>;
}

export interface RecoveryHandlers {
  cleanupCgroup(resource: Extract<OwnedResource, { kind: "cgroup" }>): Promise<void>;
  cleanupMount?(resource: Extract<OwnedResource, { kind: "mount" }>): Promise<void>;
  cleanupProcess?(resource: Extract<OwnedResource, { kind: "process" }>): Promise<void>;
}

export interface RecoveryResult {
  runId: string;
  status: "active" | "recovered" | "quarantined";
  errors: string[];
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], context: string) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${context} contains unknown field ${JSON.stringify(key)}`);
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${context} must be an object`);
  return value as Record<string, unknown>;
}

function privateDirectory(path: string) {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`State path is not a real directory: ${path}`);
  if (typeof process.geteuid === "function" && info.uid !== process.geteuid()) throw new Error(`State path has a foreign owner: ${path}`);
  if ((info.mode & 0o077) !== 0) throw new Error(`State path permissions must deny group and other access: ${path}`);
}

let flockCall: ((fd: number, operation: number) => number) | undefined;
function flock(fd: number, operation: number): number {
  if (!flockCall) {
    const library = platform() === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
    const loaded = dlopen(library, { flock: { args: ["i32", "i32"], returns: "i32" } });
    flockCall = (lockFd, lockOperation) => loaded.symbols.flock(lockFd, lockOperation);
  }
  return flockCall(fd, operation);
}

function systemIdentity(pid: number): ProcessIdentity | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    if (platform() === "linux") {
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const end = stat.lastIndexOf(")");
      if (end < 0) return;
      const fields = stat.slice(end + 2).trim().split(/\s+/);
      const startTime = fields[19];
      if (!startTime || !/^\d+$/.test(startTime)) return;
      return { pid, bootId, startTime };
    }
    if (platform() === "darwin") {
      const boot = Bun.spawnSync(["/usr/sbin/sysctl", "-n", "kern.boottime"]);
      const started = Bun.spawnSync(["/bin/ps", "-o", "lstart=", "-p", String(pid)]);
      if (boot.exitCode !== 0 || started.exitCode !== 0) return;
      const bootId = `${hostname()}:${boot.stdout.toString().trim()}`;
      const startTime = started.stdout.toString().trim();
      if (!startTime) return;
      return { pid, bootId, startTime };
    }
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }
  throw new Error(`Sandbox state is unsupported on ${platform()}`);
}

export function currentProcessIdentity(): ProcessIdentity {
  const identity = systemIdentity(process.pid);
  if (!identity) throw new Error("Cannot determine the supervisor process identity");
  return identity;
}

export function processIdentityMatches(identity: ProcessIdentity): boolean {
  const current = systemIdentity(identity.pid);
  return current !== undefined && current.bootId === identity.bootId && current.startTime === identity.startTime;
}

function assertLease(lease: StateRootLease) {
  if (lease.released) throw new Error("State-root lease has already been released");
}

export async function acquireStateRoot(root: string): Promise<StateRootLease> {
  if (!isAbsolute(root)) throw new Error("State root must be an absolute path");
  await mkdir(root, { mode: 0o700 }).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
  privateDirectory(root);
  for (const child of ["jobs", "prepared", "quarantine"]) {
    const path = join(root, child);
    await mkdir(path, { mode: 0o700 }).catch((error) => { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; });
    privateDirectory(path);
  }
  const lockPath = join(root, ".lock");
  // Bun/Node opens descriptors close-on-exec; O_NOFOLLOW protects the final path.
  const fd = openSync(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || (typeof process.geteuid === "function" && info.uid !== process.geteuid()) || (info.mode & 0o077) !== 0) {
      throw new Error("State lock must be a private regular file owned by the operator");
    }
    fchmodSync(fd, 0o600);
    if (flock(fd, LOCK_EX | LOCK_NB) !== 0) throw new StateBusyError(root);
    const owner = currentProcessIdentity(), token = randomBytes(16).toString("hex");
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: STATE_SCHEMA, owner, token, acquiredAt: new Date().toISOString() }) + "\n");
    ftruncateSync(fd, 0); writeSync(fd, bytes, 0, bytes.length, 0); fsyncSync(fd);
    let released = false;
    return {
      root, token, owner,
      get released() { return released; },
      async release() {
        if (released) return;
        released = true;
        closeSync(fd);
      },
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

async function boundedJSON(path: string): Promise<unknown> {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_JOURNAL_BYTES || (typeof process.geteuid === "function" && info.uid !== process.geteuid()) || (info.mode & 0o077) !== 0) throw new Error(`Unsafe or oversized state file: ${path}`);
  return JSON.parse(await readFile(path, "utf8"));
}

function parseIdentity(value: unknown): ProcessIdentity {
  const item = record(value, "Process identity");
  exactKeys(item, ["pid", "bootId", "startTime"], "Process identity");
  if (!Number.isSafeInteger(item.pid) || (item.pid as number) <= 0 || typeof item.bootId !== "string" || !item.bootId || typeof item.startTime !== "string" || !item.startTime) throw new Error("Invalid process identity");
  return item as unknown as ProcessIdentity;
}

function parseResource(value: unknown): OwnedResource {
  const item = record(value, "Owned resource");
  if (item.kind === "process") {
    exactKeys(item, ["kind", "identity"], "Process resource");
    return { kind: "process", identity: parseIdentity(item.identity) };
  }
  if (item.kind !== "cgroup" && item.kind !== "mount") throw new Error("Invalid owned resource kind");
  exactKeys(item, ["kind", "path", "ownerToken"], "Owned resource");
  if (typeof item.path !== "string" || !isAbsolute(item.path) || typeof item.ownerToken !== "string" || !tokenPattern.test(item.ownerToken)) throw new Error("Invalid owned resource");
  return item as OwnedResource;
}

export function parseJobJournal(value: unknown): JobJournalData {
  const item = record(value, "Job journal");
  exactKeys(item, ["schemaVersion", "runId", "owner", "environmentKey", "status", "resources", "createdAt", "updatedAt", "recoveryErrors"], "Job journal");
  if (item.schemaVersion !== STATE_SCHEMA || typeof item.runId !== "string" || !runIdPattern.test(item.runId) || typeof item.environmentKey !== "string" || !keyPattern.test(item.environmentKey)) throw new Error("Invalid job journal identity");
  if (!["active", "complete", "recovered", "quarantined"].includes(item.status as string) || !Array.isArray(item.resources) || !Array.isArray(item.recoveryErrors) || !(item.recoveryErrors as unknown[]).every((v) => typeof v === "string")) throw new Error("Invalid job journal state");
  if (typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt)) || typeof item.updatedAt !== "string" || !Number.isFinite(Date.parse(item.updatedAt))) throw new Error("Invalid job journal timestamp");
  return { ...item, owner: parseIdentity(item.owner), resources: item.resources.map(parseResource) } as JobJournalData;
}

async function atomicJSON(path: string, value: unknown) {
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value) + "\n");
    await handle.sync();
  } finally { await handle.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

function sameResource(a: OwnedResource, b: OwnedResource): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function createJobJournal(lease: StateRootLease, runId: string, environmentKey: string): Promise<JobJournal> {
  assertLease(lease);
  if (!runIdPattern.test(runId) || !keyPattern.test(environmentKey)) throw new Error("Invalid run or environment key");
  const path = join(lease.root, "jobs", runId);
  await mkdir(path, { mode: 0o700 });
  privateDirectory(path);
  const file = join(path, "journal.json");
  const now = new Date().toISOString();
  const data: JobJournalData = { schemaVersion: 1, runId, owner: lease.owner, environmentKey, status: "active", resources: [], createdAt: now, updatedAt: now, recoveryErrors: [] };
  await atomicJSON(file, data);
  const save = async () => { data.updatedAt = new Date().toISOString(); await atomicJSON(file, data); };
  return {
    path, data,
    async record(resource) {
      assertLease(lease);
      if (data.status !== "active") throw new Error("Cannot acquire resources for an inactive job");
      const parsed = parseResource(resource);
      if (data.resources.some((existing) => sameResource(existing, parsed))) throw new Error("Resource is already journaled");
      data.resources.push(parsed); await save();
    },
    async release(resource) {
      assertLease(lease);
      const parsed = parseResource(resource), index = data.resources.findIndex((existing) => sameResource(existing, parsed));
      if (index < 0) throw new Error("Resource is not journaled");
      data.resources.splice(index, 1); await save();
    },
    async finish() {
      assertLease(lease);
      if (data.resources.length) throw new Error("Cannot finish a job with acquired resources");
      data.status = "complete"; await save();
    },
  };
}

export async function recoverAbandonedJobs(lease: StateRootLease, handlers: RecoveryHandlers): Promise<RecoveryResult[]> {
  assertLease(lease);
  const root = join(lease.root, "jobs"), results: RecoveryResult[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !runIdPattern.test(entry.name)) throw new Error(`Unsafe job-state entry: ${entry.name}`);
    const path = join(root, entry.name), file = join(path, "journal.json");
    privateDirectory(path);
    let journal: JobJournalData;
    try { journal = parseJobJournal(await boundedJSON(file)); }
    catch (error) {
      const quarantine = join(lease.root, "quarantine", `${entry.name}-${randomBytes(8).toString("hex")}`);
      await rename(path, quarantine);
      results.push({ runId: entry.name, status: "quarantined", errors: [`Invalid journal: ${String((error as Error).message)}`] });
      continue;
    }
    if (journal.runId !== entry.name) throw new Error(`Journal run ID does not match its directory: ${entry.name}`);
    if (journal.status !== "active" && journal.status !== "quarantined") continue;
    if (processIdentityMatches(journal.owner)) { results.push({ runId: journal.runId, status: "active", errors: [] }); continue; }
    const errors: string[] = [];
    for (const resource of [...journal.resources].reverse()) {
      try {
        if (resource.kind === "cgroup") await handlers.cleanupCgroup(resource);
        else if (resource.kind === "mount") {
          if (!handlers.cleanupMount) throw new Error("No mount cleanup handler is configured");
          await handlers.cleanupMount(resource);
        } else if (processIdentityMatches(resource.identity)) {
          if (!handlers.cleanupProcess) throw new Error("No process cleanup handler is configured");
          await handlers.cleanupProcess(resource);
        }
      } catch (error) { errors.push(`${resource.kind}: ${(error as Error).message}`); }
    }
    journal.recoveryErrors = errors;
    journal.updatedAt = new Date().toISOString();
    if (errors.length) journal.status = "quarantined";
    else { journal.status = "recovered"; journal.resources = []; }
    await atomicJSON(file, journal);
    results.push({ runId: journal.runId, status: journal.status, errors });
  }
  return results;
}

/** Cache entries referenced by unfinished journals cannot be removed. */
export async function preparedEnvironmentReferences(lease: StateRootLease): Promise<Set<string>> {
  assertLease(lease);
  const references = new Set<string>(), root = join(lease.root, "jobs");
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !runIdPattern.test(entry.name)) throw new Error(`Unsafe job-state entry: ${entry.name}`);
    const path = join(root, entry.name); privateDirectory(path);
    const journal = parseJobJournal(await boundedJSON(join(path, "journal.json")));
    if (journal.runId !== entry.name) throw new Error(`Journal run ID does not match its directory: ${entry.name}`);
    if (journal.status === "active" || journal.status === "quarantined") references.add(journal.environmentKey);
  }
  return references;
}

export async function inspectState(root: string): Promise<{ locked: boolean; jobs: JobJournalData[] }> {
  privateDirectory(root);
  const jobs: JobJournalData[] = [];
  for (const entry of await readdir(join(root, "jobs"), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !runIdPattern.test(entry.name)) throw new Error(`Unsafe job-state entry: ${entry.name}`);
    jobs.push(parseJobJournal(await boundedJSON(join(root, "jobs", entry.name, "journal.json"))));
  }
  let lease: StateRootLease | undefined;
  try { lease = await acquireStateRoot(root); }
  catch (error) { if (!(error instanceof StateBusyError)) throw error; }
  if (lease) await lease.release();
  return { locked: !lease, jobs };
}
