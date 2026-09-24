import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readSync, writeSync } from "node:fs";
import { chmod, chown, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { SandboxError, decodeInput, validateRelativePath, type Artifact, type JobRequest } from "./contract.ts";
import type { EffectiveLimits } from "./policy.ts";

export interface StagedJobFiles {
  codeDir: string;
  inputDir: string;
  codeDigest: string;
  inputsDigest: string;
}

export interface StageOptions { uid?: number; gid?: number }
export interface CollectOptions { signal?: AbortSignal }

const sha256 = (data: Uint8Array) => `sha256:${createHash("sha256").update(data).digest("hex")}`;

async function writeExclusive(path: string, bytes: Uint8Array, mode: number): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
      if (bytesWritten === 0) throw new Error(`Short write while staging ${path}`);
      offset += bytesWritten;
    }
    await handle.sync();
  } finally { await handle.close(); }
}

function digestInputs(files: readonly { path: string; bytes: Buffer }[]): string {
  const hash = createHash("sha256");
  const length = Buffer.allocUnsafe(8);
  for (const file of [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    const path = Buffer.from(file.path);
    length.writeBigUInt64BE(BigInt(path.length)); hash.update(length); hash.update(path);
    length.writeBigUInt64BE(BigInt(file.bytes.length)); hash.update(length); hash.update(file.bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

/** Stage immutable job data below an existing private per-run directory. */
export async function stageJobFiles(root: string, request: JobRequest, limits: EffectiveLimits, options: StageOptions = {}): Promise<StagedJobFiles> {
  const code = Buffer.from(request.code);
  if (code.length > limits.sourceBytes) throw new SandboxError("POLICY_DENIED", "Source exceeds the effective source limit");
  if ((request.inputs?.length ?? 0) > limits.inputFiles) throw new SandboxError("POLICY_DENIED", "Input count exceeds the effective input limit");
  const decoded = (request.inputs ?? []).map(input => ({ path: validateRelativePath(input.path, "input path", { depth: limits.pathDepth, bytes: limits.pathBytes }), bytes: decodeInput(input) }));
  if (decoded.reduce((sum, input) => sum + input.bytes.length, 0) > limits.inputBytes) throw new SandboxError("POLICY_DENIED", "Inputs exceed the effective byte limit");

  const codeDir = join(root, "code"), inputDir = join(root, "input");
  await mkdir(root, { mode: 0o700 });
  try {
    await mkdir(codeDir, { mode: 0o700 });
    await mkdir(inputDir, { mode: 0o700 });
    await mkdir(join(codeDir, "node_modules"), { mode: 0o700 });
    await writeExclusive(join(codeDir, "main.ts"), code, 0o600);
    await writeExclusive(join(codeDir, "bunfig.toml"), Buffer.alloc(0), 0o600);
    const directories = new Set<string>([inputDir]);
    for (const input of decoded) {
      const parts = input.path.split("/");
      let parent = inputDir;
      for (const part of parts.slice(0, -1)) {
        parent = join(parent, part);
        if (!directories.has(parent)) { await mkdir(parent, { mode: 0o700 }); directories.add(parent); }
      }
      await writeExclusive(join(inputDir, input.path), input.bytes, 0o600);
    }
    const uid = options.uid, gid = options.gid;
    const files = [join(codeDir, "main.ts"), join(codeDir, "bunfig.toml"), ...decoded.map(input => join(inputDir, input.path))];
    if (uid !== undefined || gid !== undefined) {
      if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid! < 0 || gid! < 0) throw new Error("Both a valid uid and gid are required for staging ownership");
      for (const path of [...files, join(codeDir, "node_modules"), ...[...directories].reverse(), codeDir]) await chown(path, uid!, gid!);
    }
    for (const path of files) await chmod(path, 0o444);
    await chmod(join(codeDir, "node_modules"), 0o555);
    for (const path of [...directories].sort((a, b) => b.length - a.length)) await chmod(path, 0o555);
    await chmod(codeDir, 0o555);
    return { codeDir, inputDir, codeDigest: sha256(code), inputsDigest: digestInputs(decoded) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function collectionError(code: "ARTIFACT_INVALID" | "ARTIFACT_LIMIT" | "COLLECTION_TIMEOUT", message: string, cause?: unknown): SandboxError {
  return new SandboxError(code, message, cause === undefined ? undefined : { cause });
}

/**
 * Collect files into `destinationRoot/artifacts` and return paths relative to
 * `destinationRoot`. Linux traversal opens every entry relative to a pinned
 * directory descriptor with openat2; it has no path-based fallback.
 */
export async function collectArtifacts(outputRoot: string, destinationRoot: string, limits: EffectiveLimits, options: CollectOptions = {}): Promise<Artifact[]> {
  if (process.platform !== "linux") throw new SandboxError("UNSUPPORTED_HOST", "Artifact collection requires Linux openat2");
  const signal = options.signal;
  const checkCancelled = () => { if (signal?.aborted) throw collectionError("COLLECTION_TIMEOUT", "Artifact collection was cancelled", signal.reason); };
  checkCancelled();
  const artifactsRoot = join(destinationRoot, "artifacts");
  await mkdir(artifactsRoot, { mode: 0o700 });
  let ffi: typeof import("bun:ffi");
  try { ffi = await import("bun:ffi"); }
  catch (error) { await rm(artifactsRoot, { recursive: true, force: true }); throw new SandboxError("UNSUPPORTED_HOST", "Bun FFI is required for safe artifact collection", { cause: error }); }
  const { CString, dlopen, ptr, read, toArrayBuffer } = ffi;
  const loaded = (() => { try { return { library: dlopen("libc.so.6", {
    syscall: { args: ["i64", "i32", "ptr", "ptr", "u64"], returns: "i64" },
    fcntl: { args: ["i32", "i32", "i32"], returns: "i32" },
    fdopendir: { args: ["i32"], returns: "ptr" },
    readdir: { args: ["ptr"], returns: "ptr" },
    closedir: { args: ["ptr"], returns: "i32" },
    __errno_location: { args: [], returns: "ptr" },
    strerror: { args: ["i32"], returns: "cstring" },
  }) }; } catch (error) { return { error }; } })();
  if (!("library" in loaded)) {
    await rm(artifactsRoot, { recursive: true, force: true });
    throw new SandboxError("UNSUPPORTED_HOST", "Linux libc is required for safe artifact collection", { cause: loaded.error });
  }
  const libc = loaded.library!;
  const symbols = libc.symbols;
  const OPENAT2 = 437, O_DIRECTORY = constants.O_DIRECTORY, O_NOFOLLOW = constants.O_NOFOLLOW, O_NONBLOCK = constants.O_NONBLOCK;
  const RESOLVE_NO_MAGICLINKS = 0x02, RESOLVE_NO_SYMLINKS = 0x04, RESOLVE_BENEATH = 0x08;
  const openRelative = (parent: number, name: string, directory: boolean): number => {
    const path = Buffer.from(name + "\0");
    const how = Buffer.alloc(24);
    how.writeBigUInt64LE(BigInt(O_NOFOLLOW | O_NONBLOCK | (directory ? O_DIRECTORY : 0)), 0);
    how.writeBigUInt64LE(0n, 8);
    how.writeBigUInt64LE(BigInt(RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS | RESOLVE_BENEATH), 16);
    const fd = Number(symbols.syscall(OPENAT2, parent, ptr(path), ptr(how), how.length));
    if (fd < 0) {
      const errno = read.i32(symbols.__errno_location()!);
      if (errno === 38) throw new SandboxError("UNSUPPORTED_HOST", "The host kernel does not provide openat2");
      throw collectionError("ARTIFACT_INVALID", `Cannot safely open artifact entry ${name}: ${symbols.strerror(errno)}`);
    }
    if (symbols.fcntl(fd, 2, 1) < 0) { closeSync(fd); throw collectionError("ARTIFACT_INVALID", `Cannot make artifact descriptor close-on-exec: ${name}`); }
    return fd;
  };
  let rootFd = -1;
  const artifacts: Artifact[] = [];
  const destinationDirectories = [artifactsRoot, destinationRoot];
  let entries = 0, directories = 0, files = 0, totalBytes = 0;
  try {
    try {
      rootFd = openSync(outputRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      if (symbols.fcntl(rootFd, 2, 1) < 0) throw new Error("Cannot make output descriptor close-on-exec");
    }
    catch (error) { throw collectionError("ARTIFACT_INVALID", "Output root is not a safe directory", error); }
    const walk = async (directoryFd: number, relative: string, depth: number): Promise<void> => {
      const childDirectories: { fd: number; path: string; depth: number }[] = [];
      let nextChild = 0;
      try {
        checkCancelled();
        let names: string[] = [];
        // fdopendir takes ownership, so enumerate through an explicit duplicate
        // and keep the pinned traversal descriptor under this walker's ownership.
        const enumerationFd = symbols.fcntl(directoryFd, 1030, 0); // F_DUPFD_CLOEXEC
        if (enumerationFd < 0 || enumerationFd === directoryFd) throw collectionError("ARTIFACT_INVALID", `Cannot duplicate artifact directory descriptor (${directoryFd}/${enumerationFd})`);
        const directory = symbols.fdopendir(enumerationFd);
        if (!directory) { closeSync(enumerationFd); throw collectionError("ARTIFACT_INVALID", "Cannot enumerate artifact directory descriptor"); }
        try {
          while (true) {
            const errnoPointer = symbols.__errno_location()!;
            new DataView(toArrayBuffer(errnoPointer, 0, 4)).setInt32(0, 0, true);
            const entry = symbols.readdir(directory);
            if (!entry) {
              const errno = read.i32(errnoPointer);
              if (errno !== 0) throw collectionError("ARTIFACT_INVALID", `Cannot enumerate artifact directory: ${symbols.strerror(errno)}`);
              break;
            }
            const name = new CString(entry, 19);
            if (name === "." || name === "..") continue;
            checkCancelled();
            entries++;
            if (entries > limits.artifactEntries) throw collectionError("ARTIFACT_LIMIT", "Artifact entry limit exceeded");
            names.push(name);
          }
        } finally {
          if (symbols.closedir(directory) !== 0) throw collectionError("ARTIFACT_INVALID", "Cannot close artifact directory stream");
          try { fstatSync(directoryFd); } catch (error) { throw collectionError("ARTIFACT_INVALID", `Pinned artifact directory descriptor ${directoryFd} was lost after duplicate ${enumerationFd}`, error); }
        }
        names = names.sort();
        for (const name of names) {
          checkCancelled();
          const path = relative ? `${relative}/${name}` : name;
          try { validateRelativePath(path, "artifact path", { depth: limits.pathDepth, bytes: limits.pathBytes }); }
          catch (error) { throw collectionError("ARTIFACT_INVALID", `Invalid artifact path: ${path}`, error); }
          let fd = -1;
          try {
            fd = openRelative(directoryFd, name, false);
            let stat = fstatSync(fd, { bigint: true });
            if (stat.isDirectory()) {
              const probeFd = fd; fd = -1; closeSync(probeFd);
              fd = openRelative(directoryFd, name, true); stat = fstatSync(fd, { bigint: true });
              if (!stat.isDirectory()) throw collectionError("ARTIFACT_INVALID", `Artifact changed type during collection: ${path}`);
              directories++;
              if (directories > limits.artifactDirectories || depth >= limits.pathDepth) throw collectionError("ARTIFACT_LIMIT", `Artifact directory limit exceeded at ${path}`);
              const destinationDirectory = join(artifactsRoot, path);
              mkdirSync(destinationDirectory, { mode: 0o700 }); destinationDirectories.push(destinationDirectory);
              childDirectories.push({ fd, path, depth: depth + 1 }); fd = -1;
              continue;
            }
            if (!stat.isFile()) throw collectionError("ARTIFACT_INVALID", `Artifact is not a regular file: ${path}`);
            if (stat.nlink !== 1n) throw collectionError("ARTIFACT_INVALID", `Hardlinked artifact is not allowed: ${path}`);
            if (stat.size > 0n && stat.blocks * 512n < stat.size) throw collectionError("ARTIFACT_INVALID", `Sparse artifact is not allowed: ${path}`);
            if (stat.size > BigInt(Number.MAX_SAFE_INTEGER) || stat.size > BigInt(limits.artifactBytes - totalBytes)) throw collectionError("ARTIFACT_LIMIT", `Artifact byte limit exceeded at ${path}`);
            files++;
            if (files > limits.artifactFiles) throw collectionError("ARTIFACT_LIMIT", "Artifact file limit exceeded");
            const size = Number(stat.size), destination = join(artifactsRoot, path);
            const output = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            const hash = createHash("sha256");
            let copied = 0;
            try {
              const chunk = Buffer.allocUnsafe(64 * 1024);
              while (true) {
                checkCancelled();
                const count = readSync(fd, chunk, 0, Math.min(chunk.length, limits.artifactBytes - totalBytes - copied), null);
                if (count === 0) break;
                copied += count;
                if (copied > size || totalBytes + copied > limits.artifactBytes) throw collectionError("ARTIFACT_LIMIT", `Artifact grew beyond its byte limit: ${path}`);
                hash.update(chunk.subarray(0, count));
                let offset = 0;
                while (offset < count) {
                  const written = writeSync(output, chunk, offset, count - offset, copied - count + offset);
                  if (written === 0) throw new Error(`Short artifact write: ${path}`);
                  offset += written;
                }
              }
              if (copied !== size) throw collectionError("ARTIFACT_INVALID", `Artifact size changed during collection: ${path}`);
              const after = fstatSync(fd, { bigint: true });
              if (after.dev !== stat.dev || after.ino !== stat.ino || after.nlink !== 1n || after.size !== stat.size) throw collectionError("ARTIFACT_INVALID", `Artifact changed during collection: ${path}`);
              fsyncSync(output);
            } finally { closeSync(output); }
            totalBytes += copied;
            artifacts.push({ path, file: `artifacts/${path}`, bytes: copied, sha256: `sha256:${hash.digest("hex")}` });
          } finally { if (fd >= 0) closeSync(fd); }
        }
        closeSync(directoryFd); directoryFd = -1;
        while (nextChild < childDirectories.length) {
          const child = childDirectories[nextChild++]!;
          const childFd = child.fd; child.fd = -1;
          await walk(childFd, child.path, child.depth);
        }
      } finally {
        if (directoryFd >= 0) closeSync(directoryFd);
        for (; nextChild < childDirectories.length; nextChild++) if (childDirectories[nextChild]!.fd >= 0) closeSync(childDirectories[nextChild]!.fd);
      }
    };
    const ownedRoot = rootFd; rootFd = -1;
    await walk(ownedRoot, "", 0);
    for (const path of destinationDirectories.sort((a, b) => b.length - a.length)) {
      const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    return artifacts.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  } catch (error) {
    await rm(artifactsRoot, { recursive: true, force: true });
    throw error;
  } finally {
    if (rootFd >= 0) closeSync(rootFd);
    libc.close();
  }
}
