import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, rm, statfs, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { dlopen } from "bun:ffi";
import { SandboxError } from "./contract.ts";
import type { EffectiveLimits } from "./policy.ts";

const GiB = 1024 ** 3, MiB = 1024 ** 2;
const lockName = ".bunc-results.lock", reservationName = ".bunc-reservation";
export const RESULT_CAPACITY_DEFAULTS = Object.freeze({
  maxSiblings: 256,
  maxStoredBytes: GiB,
  minFreeBytes: 64 * MiB,
  maxEntries: 16_384,
  maxDepth: 8,
  metadataReserveBytes: MiB,
});

export interface ResultCapacityOptions {
  reservedBytes: number;
  maxSiblings?: number;
  maxStoredBytes?: number;
  minFreeBytes?: number;
  maxEntries?: number;
  maxDepth?: number;
}

export interface ResultCapacity {
  resultsRoot: string;
  siblings: number;
  entries: number;
  storedBytes: number;
  availableBytes: number;
  reservedBytes: number;
}

function reject(message: string): never { throw new SandboxError("POLICY_DENIED", message); }
function limit(value: number | undefined, fallback: number, label: string, allowZero = false): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < (allowZero ? 0 : 1)) reject(`${label} must be a ${allowZero ? "nonnegative" : "positive"} safe integer`);
  return selected;
}

/** Reserve the maximum stream, artifact, and metadata bytes for one result. */
export function resultReservation(limits: Pick<EffectiveLimits, "stdioBytes" | "artifactBytes">): number {
  const reserved = limits.stdioBytes + limits.artifactBytes + RESULT_CAPACITY_DEFAULTS.metadataReserveBytes;
  if (!Number.isSafeInteger(reserved)) reject("Result reservation is too large");
  return reserved;
}

async function readReservation(path: string): Promise<number> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    validateOwnedFile(info, "Retained result reservation");
    if (info.size < 1 || info.size > 32) reject("Retained result reservation is invalid");
    const text = await handle.readFile({ encoding: "utf8" });
    if (!/^[1-9][0-9]*\n?$/.test(text)) reject("Retained result reservation is invalid");
    const value = Number(text.trim());
    if (!Number.isSafeInteger(value)) reject("Retained result reservation is invalid");
    return value;
  } finally { await handle.close(); }
}

function validateOwnedFile(info: Awaited<ReturnType<typeof lstat>>, label: string): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (Number(info.mode) & 0o077) !== 0) reject(`${label} is not a private regular file`);
  const uid = process.geteuid?.();
  if (uid !== undefined && info.uid !== uid) reject(`${label} is not owned by the supervisor identity`);
}

async function validateResultsRoot(resultsRoot: string): Promise<void> {
  const rootInfo = await lstat(resultsRoot).catch(error => { throw new SandboxError("POLICY_DENIED", "Dedicated results root is unavailable", { cause: error }); });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) reject("Results root must be a directory, not a link");
  if ((rootInfo.mode & 0o022) !== 0) reject("Results root must not be group- or world-writable");
  const uid = process.geteuid?.();
  if (uid !== undefined && rootInfo.uid !== uid) reject("Results root must be owned by the supervisor identity");
}

function resultTarget(resultDir: string): { targetName: string; resultsRoot: string } {
  if (!isAbsolute(resultDir) || resolve(resultDir) !== resultDir || resultDir.includes("\0")) reject("Result directory must be a normalized absolute path");
  const targetName = basename(resultDir), resultsRoot = dirname(resultDir);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(targetName) || resultsRoot === parse(resultsRoot).root) reject("Result directory must be a named child of a dedicated results root");
  return { targetName, resultsRoot };
}

/**
 * Check a dedicated result parent before exclusively creating `resultDir`.
 * Existing entries are inspected with lstat and links are never followed.
 */
export async function assertResultCapacity(resultDir: string, options: ResultCapacityOptions): Promise<ResultCapacity> {
  const { resultsRoot } = resultTarget(resultDir);
  const maxSiblings = limit(options.maxSiblings, RESULT_CAPACITY_DEFAULTS.maxSiblings, "maxSiblings");
  const maxStoredBytes = limit(options.maxStoredBytes, RESULT_CAPACITY_DEFAULTS.maxStoredBytes, "maxStoredBytes");
  const minFreeBytes = limit(options.minFreeBytes, RESULT_CAPACITY_DEFAULTS.minFreeBytes, "minFreeBytes", true);
  const maxEntries = limit(options.maxEntries, RESULT_CAPACITY_DEFAULTS.maxEntries, "maxEntries");
  const maxDepth = limit(options.maxDepth, RESULT_CAPACITY_DEFAULTS.maxDepth, "maxDepth");
  const reservedBytes = limit(options.reservedBytes, 0, "reservedBytes");
  if (reservedBytes > maxStoredBytes) reject("Requested result reservation exceeds retained result capacity");

  await validateResultsRoot(resultsRoot);
  try { await lstat(resultDir); reject("Result directory already exists"); }
  catch (error) { if (error instanceof SandboxError || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

  let siblings = 0, entries = 0, storedBytes = 0;
  const addBytes = (bytes: number) => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || storedBytes > maxStoredBytes - bytes) reject("Retained result byte capacity is exhausted");
    storedBytes += bytes;
  };
  const scan = async (directory: string, depth: number, resultTop = false): Promise<number> => {
    let directoryBytes = 0, reservation = 0;
    const handle = await opendir(directory);
    try {
      while (true) {
        const entry = await handle.read();
        if (entry === null) break;
        entries++;
        if (entries > maxEntries) reject("Retained result entry scan limit exceeded");
        const path = join(directory, entry.name), info = await lstat(path);
        if (info.isSymbolicLink()) reject("Retained results contain a symbolic link");
        if (info.isDirectory()) {
          if (depth >= maxDepth) reject("Retained result depth limit exceeded");
          directoryBytes += await scan(path, depth + 1);
        } else if (info.isFile()) {
          if (info.nlink !== 1) reject("Retained results contain a hardlinked file");
          if (resultTop && entry.name === reservationName) reservation = await readReservation(path);
          else directoryBytes += info.size;
          if (!Number.isSafeInteger(directoryBytes)) reject("Retained result byte accounting overflowed");
        } else reject("Retained results contain a special file");
      }
    } finally { await handle.close(); }
    return Math.max(directoryBytes, reservation);
  };
  const root = await opendir(resultsRoot);
  try {
    while (true) {
      const entry = await root.read();
      if (entry === null) break;
      if (entry.name === lockName) {
        const info = await lstat(join(resultsRoot, entry.name)); validateOwnedFile(info, "Results capacity lock");
        continue;
      }
      siblings++;
      if (siblings + 1 > maxSiblings) reject("Retained result sibling capacity is exhausted");
      entries++;
      if (entries > maxEntries) reject("Retained result entry scan limit exceeded");
      const path = join(resultsRoot, entry.name), info = await lstat(path);
      if (info.isSymbolicLink()) reject("Retained results contain a symbolic link");
      if (info.isDirectory()) addBytes(await scan(path, 1, true));
      else if (info.isFile()) {
        if (info.nlink !== 1) reject("Retained results contain a hardlinked file");
        addBytes(info.size);
      } else reject("Retained results contain a special file");
    }
  } finally { await root.close(); }
  if (storedBytes > maxStoredBytes - reservedBytes) reject("Retained result byte capacity cannot admit this job");
  const filesystem = await statfs(resultsRoot, { bigint: true });
  const available = filesystem.bavail * filesystem.bsize;
  const required = BigInt(reservedBytes) + BigInt(minFreeBytes);
  if (available < required) reject("Results filesystem does not have the required free-space reserve");
  return {
    resultsRoot, siblings, entries, storedBytes,
    availableBytes: available > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(available),
    reservedBytes,
  };
}

function lockLibrary() {
  const name = process.platform === "linux" ? "libc.so.6" : process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : reject("Result reservation locks require Linux or macOS");
  return dlopen(name, { flock: { args: ["i32", "i32"], returns: "i32" } });
}

/** Atomically admit capacity and create an empty reserved result directory. */
export async function reserveResultDirectory(resultDir: string, options: ResultCapacityOptions): Promise<ResultCapacity> {
  const { resultsRoot } = resultTarget(resultDir), lockPath = join(resultsRoot, lockName);
  await validateResultsRoot(resultsRoot);
  const lock = await open(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    .catch(error => { throw new SandboxError("POLICY_DENIED", "Cannot open the results capacity lock", { cause: error }); });
  let library: ReturnType<typeof lockLibrary>;
  try { library = lockLibrary(); }
  catch (error) { await lock.close(); throw error; }
  let created = false;
  try {
    validateOwnedFile(await lock.stat(), "Results capacity lock");
    if (library.symbols.flock(lock.fd, 2 | 4) !== 0) throw new SandboxError("BUSY", "Another result capacity admission is in progress");
    const capacity = await assertResultCapacity(resultDir, options);
    await mkdir(resultDir, { mode: 0o700 }); created = true;
    const marker = await open(join(resultDir, reservationName), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await marker.writeFile(`${options.reservedBytes}\n`); await marker.sync(); }
    finally { await marker.close(); }
    return capacity;
  } catch (error) {
    if (created) await rm(resultDir, { recursive: true, force: true });
    throw error;
  } finally {
    library.symbols.flock(lock.fd, 8);
    library.close();
    await lock.close();
  }
}

/** Remove the live reservation after the final result metadata is durable. */
export async function releaseResultReservation(resultDir: string): Promise<void> {
  try { await unlink(join(resultDir, reservationName)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
