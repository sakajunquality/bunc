import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm, statfs, writeFile } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { canonicalJSON, assertDigest, sha256 } from "../oci/digest.ts";
import { imagePath, unpack, type UnpackLimits } from "../rootfs.ts";
import { acquireStateRoot, type StateRootLease } from "./state.ts";

export const PREPARATION_FORMAT = "sandbox-rootfs-v1" as const;
export const SANDBOX_UID = 65532 as const;
export const SANDBOX_GID = 65532 as const;
export const SANDBOX_WORKING_DIRECTORY = "/work" as const;
export const SANDBOX_RUNTIME_FLAGS = ["--no-install", "--no-env-file", "--config=/code/bunfig.toml"] as const;
const descriptorFields = ["schemaVersion", "manifestDigest", "architecture", "interpreter", "packagePath", "workingDirectory", "uid", "gid", "runtimeFlags", "policyRevision"] as const;
const preparedFields = ["schemaVersion", "preparationFormat", "key", "descriptor", "descriptorDigest", "manifestDigest", "architecture", "interpreter", "interpreterHostPath", "packagePath", "packageHostPath", "workingDirectory", "uid", "gid", "runtimeFlags", "policyRevision", "preparedAt", "sizeBytes", "entryCount", "interpreterMetadata"] as const;
const keyPattern = /^[a-f0-9]{64}$/;
const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const MAX_PREPARED_METADATA_BYTES = 128 * 1024;

export type NativeArchitecture = "amd64" | "arm64";

export interface EnvironmentDescriptor {
  schemaVersion: 1;
  manifestDigest: `sha256:${string}`;
  architecture: NativeArchitecture;
  interpreter: string;
  packagePath: string | null;
  workingDirectory: "/work";
  uid: 65532;
  gid: 65532;
  runtimeFlags: ["--no-install", "--no-env-file", "--config=/code/bunfig.toml"];
  policyRevision: string;
}

interface FileMetadata {
  mode: number;
  uid: number;
  gid: number;
  size: number;
  sha256: `sha256:${string}`;
}

interface PreparedMetadata {
  schemaVersion: 1;
  preparationFormat: typeof PREPARATION_FORMAT;
  key: string;
  descriptor: EnvironmentDescriptor;
  descriptorDigest: `sha256:${string}`;
  manifestDigest: `sha256:${string}`;
  architecture: NativeArchitecture;
  interpreter: string;
  interpreterHostPath: string;
  packagePath: string | null;
  packageHostPath: string | null;
  workingDirectory: "/work";
  uid: 65532;
  gid: 65532;
  runtimeFlags: typeof SANDBOX_RUNTIME_FLAGS;
  policyRevision: string;
  preparedAt: string;
  sizeBytes: number;
  entryCount: number;
  interpreterMetadata: FileMetadata;
}

export interface PreparedEnvironment extends Omit<PreparedMetadata, "descriptor" | "preparationFormat" | "schemaVersion" | "interpreterMetadata"> {
  rootfs: string;
  descriptor: EnvironmentDescriptor;
  preparationFormat: typeof PREPARATION_FORMAT;
  interpreterMetadata: FileMetadata;
}

export interface PrepareEnvironmentOptions {
  stateRoot: string;
  layout: string;
  descriptor: EnvironmentDescriptor | unknown;
  maxPreparedEntries?: number;
  maxPreparedBytes?: number;
  minimumFreeBytes?: number;
  preparationTimeoutMs?: number;
  maxPreparationMemoryBytes?: number;
  preparationExecutor?: PreparationExecutor;
}

export interface PreparationWork {
  layout: string;
  staging: string;
  descriptor: EnvironmentDescriptor;
  unpackLimits: Required<Omit<UnpackLimits, "onProgress">>;
}

export interface PreparationResourceLimits {
  timeoutMs: number;
  memoryBytes: number;
  diskBytes: number;
  signal: AbortSignal;
}

export type PreparationExecutor = (work: PreparationWork, limits: PreparationResourceLimits) => Promise<void>;

export interface PreparedCacheInspection {
  entries: PreparedEnvironment[];
  incomplete: string[];
  sizeBytes: number;
}

function object(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${context} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], context: string) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${context} contains unknown field ${JSON.stringify(key)}`);
  for (const key of allowed) if (!(key in value)) throw new Error(`${context} is missing field ${JSON.stringify(key)}`);
}

function nativeArchitecture(): NativeArchitecture {
  if (process.arch === "x64") return "amd64";
  if (process.arch === "arm64") return "arm64";
  throw new Error(`Unsupported sandbox host architecture: ${process.arch}`);
}

function guestPath(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0") || value.includes("\\") || value.length > 240) throw new Error(`${name} must be a short absolute POSIX path`);
  if (value !== posix.normalize(value) || value === "/" || value.split("/").some((part) => part === "." || part === "..")) throw new Error(`${name} must be a normalized absolute POSIX path`);
  return value;
}

export function parseEnvironmentDescriptor(input: Uint8Array | string | unknown): EnvironmentDescriptor {
  let value = input;
  if (typeof input === "string" || input instanceof Uint8Array) {
    const bytes = Buffer.from(input);
    if (bytes.length > MAX_DESCRIPTOR_BYTES) throw new Error("Environment descriptor exceeds size limit");
    value = JSON.parse(bytes.toString("utf8"));
  }
  const item = object(value, "Environment descriptor");
  exactKeys(item, descriptorFields, "Environment descriptor");
  if (item.schemaVersion !== 1) throw new Error("Unsupported environment descriptor schemaVersion");
  assertDigest(item.manifestDigest);
  if (item.architecture !== "amd64" && item.architecture !== "arm64") throw new Error("Unsupported environment architecture");
  if (item.architecture !== nativeArchitecture()) throw new Error(`Environment architecture ${String(item.architecture)} does not match native host ${nativeArchitecture()}`);
  const interpreter = guestPath(item.interpreter, "interpreter");
  const packagePath = item.packagePath === null ? null : guestPath(item.packagePath, "packagePath");
  const replaced = ["/proc", "/dev", "/code", "/input", "/work", "/output", "/tmp", "/home/sandbox", "/.bunc-old-root"];
  for (const [name, path] of [["interpreter", interpreter], ["packagePath", packagePath]] as const) {
    if (path !== null && replaced.some((mountpoint) => path === mountpoint || path.startsWith(`${mountpoint}/`))) throw new Error(`${name} is hidden by a fixed sandbox mount`);
  }
  if (item.workingDirectory !== SANDBOX_WORKING_DIRECTORY || item.uid !== SANDBOX_UID || item.gid !== SANDBOX_GID) throw new Error("Environment identity and working directory must match the sandbox v1 profile");
  if (!Array.isArray(item.runtimeFlags) || item.runtimeFlags.length !== SANDBOX_RUNTIME_FLAGS.length || !item.runtimeFlags.every((flag, index) => flag === SANDBOX_RUNTIME_FLAGS[index])) throw new Error("Environment runtimeFlags must match the sandbox v1 profile");
  if (typeof item.policyRevision !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(item.policyRevision)) throw new Error("Invalid environment policyRevision");
  return { schemaVersion: 1, manifestDigest: item.manifestDigest, architecture: item.architecture, interpreter, packagePath, workingDirectory: SANDBOX_WORKING_DIRECTORY, uid: SANDBOX_UID, gid: SANDBOX_GID, runtimeFlags: [...SANDBOX_RUNTIME_FLAGS], policyRevision: item.policyRevision };
}

export function environmentDescriptorDigest(descriptor: EnvironmentDescriptor): `sha256:${string}` {
  return sha256(canonicalJSON(parseEnvironmentDescriptor(descriptor)));
}

export function preparedEnvironmentKey(descriptor: EnvironmentDescriptor): string {
  const valid = parseEnvironmentDescriptor(descriptor);
  return sha256(canonicalJSON({ manifestDigest: valid.manifestDigest, architecture: valid.architecture, preparationFormat: PREPARATION_FORMAT, descriptorDigest: environmentDescriptorDigest(valid) })).slice("sha256:".length);
}

async function boundedJSON(path: string, limit: number): Promise<unknown> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit || (typeof process.geteuid === "function" && info.uid !== process.geteuid()) || (info.mode & 0o077) !== 0) throw new Error(`Unsafe or oversized metadata file: ${path}`);
  return JSON.parse(await readFile(path, "utf8"));
}

async function digestFile(path: string): Promise<`sha256:${string}`> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function resolveImageEntry(rootfs: string, path: string, type: "file" | "directory") {
  const resolved = await imagePath(rootfs, path);
  if (!inside(rootfs, resolved)) throw new Error(`${path} resolves outside the prepared rootfs`);
  const info = await lstat(resolved);
  if (info.isSymbolicLink() || (type === "file" ? !info.isFile() : !info.isDirectory())) throw new Error(`Environment ${path} is not a ${type}`);
  return { resolved, info };
}

async function provisionDirectory(rootfs: string, guest: string) {
  let path = rootfs;
  for (const part of guest.split("/").filter(Boolean)) {
    path = join(path, part);
    if (!inside(rootfs, path)) throw new Error(`Invalid prepared mountpoint ${guest}`);
    try {
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Prepared mountpoint has an unsafe parent: ${guest}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(path, { mode: 0o755 });
    }
  }
}

async function validateMountpoints(rootfs: string, hasPackages: boolean) {
  const paths = ["/proc", "/dev", "/code", "/input", "/work", "/output", "/tmp", "/home/sandbox", "/dev/shm", "/.bunc-old-root", ...(hasPackages ? ["/code/node_modules"] : [])];
  for (const guest of paths) {
    const path = join(rootfs, ...guest.split("/").filter(Boolean));
    const info = await lstat(path);
    if (!inside(rootfs, path) || !info.isDirectory() || info.isSymbolicLink()) throw new Error(`Prepared mountpoint changed or is unsafe: ${guest}`);
  }
  for (const guest of ["/input", "/work", "/output", "/.bunc-old-root", ...(hasPackages ? ["/code/node_modules"] : ["/code"])]) {
    const path = join(rootfs, ...guest.split("/").filter(Boolean));
    if ((await readdir(path)).length !== 0) throw new Error(`Prepared mountpoint must be empty: ${guest}`);
  }
  if (hasPackages) {
    const codeEntries = await readdir(join(rootfs, "code"));
    if (codeEntries.length !== 1 || codeEntries[0] !== "node_modules") throw new Error("Prepared /code mountpoint contains unexpected image data");
  }
}

/** Internal preparation-child entrypoint. The caller must enforce its resource limits. */
export async function executePreparationWork(work: PreparationWork): Promise<void> {
  const descriptor = parseEnvironmentDescriptor(work.descriptor), staging = resolve(work.staging);
  const unpacked = await unpack(resolve(work.layout), staging, work.unpackLimits);
  if (unpacked.digest !== descriptor.manifestDigest) throw new Error(`Prepared manifest ${unpacked.digest} does not match expected ${descriptor.manifestDigest}`);
  if (unpacked.platform.architecture !== descriptor.architecture) throw new Error("Prepared image architecture does not match the environment descriptor");
  for (const path of ["/proc", "/dev", "/code", "/input", "/work", "/output", "/tmp", "/home/sandbox", "/dev/shm", "/.bunc-old-root"]) await provisionDirectory(unpacked.root, path);
  if (descriptor.packagePath !== null) await provisionDirectory(unpacked.root, "/code/node_modules");
  const interpreter = await resolveImageEntry(unpacked.root, descriptor.interpreter, "file");
  if ((interpreter.info.mode & 0o111) === 0) throw new Error("Environment interpreter is not executable");
  if (descriptor.packagePath !== null) await resolveImageEntry(unpacked.root, descriptor.packagePath, "directory");
  await rm(join(staging, "cas"), { recursive: true, force: true });
  await writeFile(join(staging, "preparation-receipt.json"), JSON.stringify({ schemaVersion: 1, preparationFormat: PREPARATION_FORMAT, manifestDigest: unpacked.digest, architecture: unpacked.platform.architecture }) + "\n", { mode: 0o600, flag: "wx" });
}

/** For tests and non-Linux development only; it does not provide a memory boundary. */
export const inProcessPreparationExecutor: PreparationExecutor = async (work, limits) => {
  if (limits.signal.aborted) throw limits.signal.reason;
  await executePreparationWork(work);
  if (limits.signal.aborted) throw limits.signal.reason;
};

async function treeUsage(root: string, limit = 200_000): Promise<{ sizeBytes: number; entryCount: number }> {
  let sizeBytes = 0, entryCount = 0;
  const pending = [root];
  while (pending.length) {
    const path = pending.pop()!;
    const info = await lstat(path);
    if (++entryCount > limit) throw new Error("Prepared environment contains too many filesystem entries");
    sizeBytes += info.blocks * 512;
    if (!Number.isSafeInteger(sizeBytes)) throw new Error("Prepared environment size overflow");
    if (info.isDirectory() && !info.isSymbolicLink()) {
      for (const name of await readdir(path)) pending.push(join(path, name));
    }
  }
  return { sizeBytes, entryCount };
}

function parseFileMetadata(value: unknown): FileMetadata {
  const item = object(value, "Interpreter metadata");
  exactKeys(item, ["mode", "uid", "gid", "size", "sha256"], "Interpreter metadata");
  for (const key of ["mode", "uid", "gid", "size"] as const) if (!Number.isSafeInteger(item[key]) || (item[key] as number) < 0) throw new Error("Invalid interpreter metadata");
  assertDigest(item.sha256);
  return item as unknown as FileMetadata;
}

function parsePreparedMetadata(value: unknown): PreparedMetadata {
  const item = object(value, "Prepared environment metadata");
  exactKeys(item, preparedFields, "Prepared environment metadata");
  if (item.schemaVersion !== 1 || item.preparationFormat !== PREPARATION_FORMAT || typeof item.key !== "string" || !keyPattern.test(item.key)) throw new Error("Invalid prepared environment format or key");
  const descriptor = parseEnvironmentDescriptor(item.descriptor);
  const descriptorDigest = environmentDescriptorDigest(descriptor);
  if (item.descriptorDigest !== descriptorDigest || item.key !== preparedEnvironmentKey(descriptor) || item.manifestDigest !== descriptor.manifestDigest || item.architecture !== descriptor.architecture) throw new Error("Prepared environment identity mismatch");
  if (item.interpreter !== descriptor.interpreter || item.packagePath !== descriptor.packagePath || item.workingDirectory !== descriptor.workingDirectory || item.uid !== descriptor.uid || item.gid !== descriptor.gid || item.policyRevision !== descriptor.policyRevision) throw new Error("Prepared environment contract mismatch");
  if (!Array.isArray(item.runtimeFlags) || JSON.stringify(item.runtimeFlags) !== JSON.stringify(descriptor.runtimeFlags)) throw new Error("Prepared environment runtime flags mismatch");
  if (typeof item.interpreterHostPath !== "string" || typeof item.packageHostPath !== (descriptor.packagePath === null ? "object" : "string")) throw new Error("Invalid prepared environment host paths");
  if (descriptor.packagePath === null && item.packageHostPath !== null) throw new Error("Invalid prepared package host path");
  if (typeof item.preparedAt !== "string" || !Number.isFinite(Date.parse(item.preparedAt)) || !Number.isSafeInteger(item.sizeBytes) || (item.sizeBytes as number) < 0 || !Number.isSafeInteger(item.entryCount) || (item.entryCount as number) < 1) throw new Error("Invalid prepared environment measurements");
  return { ...item, descriptor, descriptorDigest, interpreterMetadata: parseFileMetadata(item.interpreterMetadata) } as PreparedMetadata;
}

async function openEntry(stateRoot: string, key: string): Promise<PreparedEnvironment> {
  if (!keyPattern.test(key)) throw new Error("Invalid prepared environment key");
  const entry = join(stateRoot, "prepared", key), info = await lstat(entry);
  if (!info.isDirectory() || info.isSymbolicLink() || (typeof process.geteuid === "function" && info.uid !== process.geteuid()) || (info.mode & 0o077) !== 0) throw new Error("Prepared cache entry is not a protected operator-owned directory");
  const metadata = parsePreparedMetadata(await boundedJSON(join(entry, "prepared.json"), MAX_PREPARED_METADATA_BYTES));
  const rootfs = join(entry, "rootfs"), rootInfo = await lstat(rootfs);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Prepared rootfs is not a real directory");
  await validateMountpoints(rootfs, metadata.packagePath !== null);
  const interpreter = await resolveImageEntry(rootfs, metadata.interpreter, "file");
  const actual: FileMetadata = { mode: interpreter.info.mode & 0o7777, uid: interpreter.info.uid, gid: interpreter.info.gid, size: interpreter.info.size, sha256: await digestFile(interpreter.resolved) };
  if ((actual.mode & 0o111) === 0 || JSON.stringify(actual) !== JSON.stringify(metadata.interpreterMetadata)) throw new Error("Prepared interpreter metadata changed; reprepare the environment");
  const packageHostPath = metadata.packagePath === null ? null : (await resolveImageEntry(rootfs, metadata.packagePath, "directory")).resolved;
  if (metadata.interpreterHostPath !== interpreter.resolved || metadata.packageHostPath !== packageHostPath) throw new Error("Prepared environment host paths do not match the cache location");
  return { ...metadata, rootfs, interpreterHostPath: interpreter.resolved, packageHostPath };
}

export async function openPreparedEnvironment(stateRoot: string, descriptor: EnvironmentDescriptor | unknown): Promise<PreparedEnvironment> {
  const root = resolve(stateRoot), valid = parseEnvironmentDescriptor(descriptor), key = preparedEnvironmentKey(valid);
  try { return await openEntry(root, key); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Environment is not prepared: ${key}`, { cause: error });
    throw error;
  }
}

interface PreparationLimits {
  maxPreparedEntries: number;
  maxPreparedBytes: number;
  minimumFreeBytes: number;
  preparationTimeoutMs: number;
  maxPreparationMemoryBytes: number;
}

async function prepareWithLease(lease: StateRootLease, layout: string, descriptor: EnvironmentDescriptor, limits: PreparationLimits, executor: PreparationExecutor): Promise<PreparedEnvironment> {
  const key = preparedEnvironmentKey(descriptor), destination = join(lease.root, "prepared", key);
  try { return await openEntry(lease.root, key); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const cacheBefore = await inspectPreparedCache(lease.root), before = cacheBefore.entries;
  if (before.length + cacheBefore.incomplete.length >= limits.maxPreparedEntries) throw new Error("Prepared environment entry capacity is exhausted");
  if (cacheBefore.sizeBytes >= limits.maxPreparedBytes) throw new Error("Prepared environment byte capacity is exhausted");
  const preparationDiskBytes = limits.maxPreparedBytes - cacheBefore.sizeBytes;
  const filesystem = await statfs(join(lease.root, "prepared"));
  const available = Number(filesystem.bavail) * Number(filesystem.bsize);
  if (!Number.isSafeInteger(available) || available < limits.minimumFreeBytes + preparationDiskBytes) throw new Error("Insufficient free space to prepare an environment within its disk budget");
  const staging = join(lease.root, "prepared", `.prepare-${key}-${randomBytes(8).toString("hex")}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    // Reserve metadata and one filesystem block per archive entry. The remaining
    // budget bounds retained compressed blobs, one decoded layer, and extracted
    // file data. The parent also checks actual allocated blocks before publish.
    const metadataReserve = 96 * 1024 ** 2;
    const maxEntries = Math.min(100_000, Math.floor(preparationDiskBytes / (10 * 4096)));
    const entryReserve = maxEntries * 4096;
    const contentBudget = preparationDiskBytes - metadataReserve - entryReserve;
    if (maxEntries < 1 || contentBudget < 3) throw new Error("Prepared environment disk budget is too small");
    const unpackLimits: PreparationWork["unpackLimits"] = {
      maxCompressedBytes: Math.min(1024 ** 3, Math.floor(contentBudget / 4)),
      maxDecodedLayerBytes: Math.min(512 * 1024 ** 2, Math.floor(contentBudget / 4)),
      maxFilesystemBytes: Math.min(1024 ** 3, contentBudget - 2 * Math.floor(contentBudget / 4)),
      maxEntries,
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Environment preparation exceeded its deadline")), limits.preparationTimeoutMs);
    try {
      await executor({ layout: resolve(layout), staging, descriptor, unpackLimits }, { timeoutMs: limits.preparationTimeoutMs, memoryBytes: limits.maxPreparationMemoryBytes, diskBytes: preparationDiskBytes, signal: controller.signal });
    } finally { clearTimeout(timeout); }
    if (controller.signal.aborted) throw controller.signal.reason;
    const receipt = object(await boundedJSON(join(staging, "preparation-receipt.json"), 4096), "Preparation receipt");
    exactKeys(receipt, ["schemaVersion", "preparationFormat", "manifestDigest", "architecture"], "Preparation receipt");
    if (receipt.schemaVersion !== 1 || receipt.preparationFormat !== PREPARATION_FORMAT || receipt.manifestDigest !== descriptor.manifestDigest || receipt.architecture !== descriptor.architecture) throw new Error("Preparation child returned inconsistent content identity");
    const rootfs = join(staging, "rootfs");
    await validateMountpoints(rootfs, descriptor.packagePath !== null);
    const interpreter = await resolveImageEntry(rootfs, descriptor.interpreter, "file");
    if ((interpreter.info.mode & 0o111) === 0) throw new Error("Environment interpreter is not executable");
    const packageHostPath = descriptor.packagePath === null ? null : (await resolveImageEntry(rootfs, descriptor.packagePath, "directory")).resolved;
    await rm(join(staging, "preparation-receipt.json"));
    const usage = await treeUsage(rootfs);
    const cacheUsage = await treeUsage(join(lease.root, "prepared"));
    if (usage.sizeBytes > limits.maxPreparedBytes || cacheUsage.sizeBytes > limits.maxPreparedBytes) throw new Error("Prepared environment byte capacity would be exceeded");
    const interpreterMetadata: FileMetadata = { mode: interpreter.info.mode & 0o7777, uid: interpreter.info.uid, gid: interpreter.info.gid, size: interpreter.info.size, sha256: await digestFile(interpreter.resolved) };
    const descriptorDigest = environmentDescriptorDigest(descriptor);
    const metadata: PreparedMetadata = { schemaVersion: 1, preparationFormat: PREPARATION_FORMAT, key, descriptor, descriptorDigest, manifestDigest: descriptor.manifestDigest, architecture: descriptor.architecture, interpreter: descriptor.interpreter, interpreterHostPath: join(destination, relative(staging, interpreter.resolved)), packagePath: descriptor.packagePath, packageHostPath: packageHostPath === null ? null : join(destination, relative(staging, packageHostPath)), workingDirectory: descriptor.workingDirectory, uid: descriptor.uid, gid: descriptor.gid, runtimeFlags: SANDBOX_RUNTIME_FLAGS, policyRevision: descriptor.policyRevision, preparedAt: new Date().toISOString(), sizeBytes: usage.sizeBytes, entryCount: usage.entryCount, interpreterMetadata };
    const metadataFile = await open(join(staging, "prepared.json"), "wx", 0o600);
    try { await metadataFile.writeFile(JSON.stringify(metadata) + "\n"); await metadataFile.sync(); }
    finally { await metadataFile.close(); }
    const stagingDirectory = await open(staging, "r");
    try { await stagingDirectory.sync(); } finally { await stagingDirectory.close(); }
    await chmod(staging, 0o700);
    await rename(staging, destination);
    const directory = await open(join(lease.root, "prepared"), "r");
    try { await directory.sync(); } finally { await directory.close(); }
    return await openEntry(lease.root, key);
  } catch (error) {
    // A bounded executor leaves this protected marker only when its cgroup or
    // guardian cleanup is incomplete. Preserve the complete staging directory
    // so GC can validate ownership and stop the resource before deleting it.
    let resourceMarkerExists = false;
    try { await lstat(join(staging, ".bunc-preparation-resource.json")); resourceMarkerExists = true; }
    catch (markerError) { if ((markerError as NodeJS.ErrnoException).code !== "ENOENT") resourceMarkerExists = true; }
    if (!resourceMarkerExists) await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function prepareEnvironment(options: PrepareEnvironmentOptions): Promise<PreparedEnvironment> {
  const descriptor = parseEnvironmentDescriptor(options.descriptor);
  const limits = {
    maxPreparedEntries: options.maxPreparedEntries ?? 16,
    maxPreparedBytes: options.maxPreparedBytes ?? 4 * 1024 ** 3,
    minimumFreeBytes: options.minimumFreeBytes ?? 256 * 1024 ** 2,
    preparationTimeoutMs: options.preparationTimeoutMs ?? 120_000,
    maxPreparationMemoryBytes: options.maxPreparationMemoryBytes ?? 1024 ** 3,
  };
  for (const [name, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  if (limits.maxPreparedEntries > 1024 || limits.maxPreparedBytes > 8 * 1024 ** 3 || limits.preparationTimeoutMs > 10 * 60_000 || limits.maxPreparationMemoryBytes > 4 * 1024 ** 3) throw new Error("Environment preparation limits exceed the implementation ceiling");
  const executor = options.preparationExecutor ?? (process.platform === "linux" ? undefined : inProcessPreparationExecutor);
  if (!executor) throw new Error("Linux environment preparation requires a bounded preparation executor");
  const lease = await acquireStateRoot(resolve(options.stateRoot));
  try { return await prepareWithLease(lease, options.layout, descriptor, limits, executor); }
  finally { await lease.release(); }
}

export async function inspectPreparedEnvironments(stateRoot: string): Promise<PreparedEnvironment[]> {
  return (await inspectPreparedCache(stateRoot)).entries;
}

export async function inspectPreparedCache(stateRoot: string): Promise<PreparedCacheInspection> {
  const root = resolve(stateRoot), directory = join(root, "prepared"), entries: PreparedEnvironment[] = [], incomplete: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".prepare-")) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^\.prepare-[a-f0-9]{64}-[a-f0-9]{16}$/.test(entry.name)) throw new Error(`Unsafe incomplete preparation entry: ${entry.name}`);
      incomplete.push(entry.name); continue;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink() || !keyPattern.test(entry.name)) throw new Error(`Unsafe prepared cache entry: ${entry.name}`);
    entries.push(await openEntry(root, entry.name));
  }
  const usage = await treeUsage(directory);
  return { entries: entries.sort((a, b) => a.key.localeCompare(b.key)), incomplete: incomplete.sort(), sizeBytes: usage.sizeBytes };
}

export async function removePreparedEnvironments(lease: StateRootLease, keys: readonly string[], activeKeys: ReadonlySet<string>, maxEntries = 128): Promise<string[]> {
  if (lease.released) throw new Error("State-root lease has already been released");
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0 || keys.length > maxEntries) throw new Error("Prepared cleanup exceeds its entry limit");
  const removed: string[] = [];
  for (const key of keys) {
    if (!keyPattern.test(key)) throw new Error(`Invalid prepared environment key: ${key}`);
    if (activeKeys.has(key)) throw new Error(`Prepared environment is referenced by an active job: ${key}`);
    const path = join(lease.root, "prepared", key), info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe prepared cache entry: ${key}`);
    await openEntry(lease.root, key);
    await rm(path, { recursive: true });
    removed.push(key);
  }
  return removed;
}

export async function removeIncompletePreparations(lease: StateRootLease, maxEntries = 128): Promise<string[]> {
  if (lease.released) throw new Error("State-root lease has already been released");
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new Error("Invalid incomplete preparation cleanup limit");
  const { incomplete } = await inspectPreparedCache(lease.root);
  if (incomplete.length > maxEntries) throw new Error("Incomplete preparation cleanup exceeds its entry limit");
  for (const name of incomplete) await rm(join(lease.root, "prepared", name), { recursive: true });
  return incomplete;
}
