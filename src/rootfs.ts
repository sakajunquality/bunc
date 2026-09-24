import { chmod, chown, lstat, mkdir, readdir, rm, symlink, link, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import tar from "tar-stream";
import { BlobStore } from "./oci/blob-store.ts";
import { LayoutSource, resolveBase } from "./oci/source.ts";
import { decodeLayer } from "./oci/decode.ts";

export interface UnpackLimits {
  maxCompressedBytes?: number;
  maxDecodedLayerBytes?: number;
  maxFilesystemBytes?: number;
  maxEntries?: number;
  onProgress?: (progress: { filesystemBytes: number; entries: number }) => void;
}

function pathName(name: string): string {
  if (name.includes("\0") || name.startsWith("/") || name.split("/").includes("..")) throw new Error(`Unsafe archive path: ${JSON.stringify(name)}`);
  return posix.normalize(name).replace(/^\.\//, "").replace(/\/$/, "");
}
async function exists(path: string) {
  try { return await lstat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
}
async function parents(root: string, name: string) {
  let current = root;
  for (const part of name.split("/").slice(0, -1)) {
    current = join(current, part);
    const info = await exists(current);
    if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error(`Non-directory archive parent: ${name}`);
    if (!info) await mkdir(current, { mode: 0o755 });
  }
}

/** Intentionally bounded, copy-based unpacker for trusted experimental images. */
export async function unpack(layout: string, state: string, options: UnpackLimits = {}) {
  const limits = {
    maxCompressedBytes: options.maxCompressedBytes ?? 1024 ** 3,
    maxDecodedLayerBytes: options.maxDecodedLayerBytes ?? 512 * 1024 ** 2,
    maxFilesystemBytes: options.maxFilesystemBytes ?? 1024 ** 3,
    maxEntries: options.maxEntries ?? 100_000,
  };
  for (const [name, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  const root = join(state, "rootfs"); await mkdir(root, { mode: 0o755 });
  const store = new BlobStore(join(state, "cas"));
  const platform = { os: "linux" as const, architecture: process.arch === "arm64" ? "arm64" as const : "amd64" as const };
  const image = await resolveBase(new LayoutSource(layout), platform, store, { maxLayerBytes: limits.maxCompressedBytes });
  const compressedBytes = image.manifest.layers.reduce((sum, layer) => sum + layer.size, 0);
  if (!Number.isSafeInteger(compressedBytes) || compressedBytes > limits.maxCompressedBytes) throw new Error("Image compressed content exceeds preparation limit");
  let total = 0, count = 0;
  for (const [index, layer] of image.manifest.layers.entries()) {
    const decoded = join(state, `layer-${index}.tar`);
    await decodeLayer(store, layer, image.config.rootfs.diff_ids[index]!, decoded, limits.maxDecodedLayerBytes);
    const entries: { name: string; type: string; mode: number; uid: number; gid: number; target: string; data: Buffer }[] = [];
    const extract = tar.extract();
    extract.on("entry", (header, stream, next) => {
      void (async () => {
        const name = pathName(header.name), chunks: Buffer[] = [];
        for await (const chunk of stream) {
          if (!Buffer.isBuffer(chunk)) throw new Error("Expected binary tar data");
          total += chunk.length;
          if (total > limits.maxFilesystemBytes) throw new Error("Image filesystem content exceeds preparation limit");
          chunks.push(Buffer.from(chunk));
        }
        if (++count > limits.maxEntries) throw new Error("Image has too many archive entries");
        options.onProgress?.({ filesystemBytes: total, entries: count });
        if (name !== "." && name !== "") entries.push({ name, type: header.type ?? "file", mode: (header.mode ?? 0o644) & 0o1777, uid: header.uid ?? 0, gid: header.gid ?? 0, target: header.linkname ?? "", data: Buffer.concat(chunks) });
        next();
      })().catch(error => extract.destroy(error));
    });
    await pipeline(createReadStream(decoded), extract);
    // Whiteouts affect lower layers, not entries subsequently added by this layer.
    for (const e of entries.filter(e => posix.basename(e.name).startsWith(".wh."))) {
      await parents(root, e.name);
      const base = posix.basename(e.name), parent = join(root, dirname(e.name));
      if (base === ".wh..wh..opq") {
        for (const child of await readdir(parent)) await rm(join(parent, child), { recursive: true, force: true });
      } else {
        const target = base.slice(4);
        if (!target || target === "." || target === "..") throw new Error("Invalid whiteout target");
        await rm(join(parent, target), { recursive: true, force: true });
      }
    }
    const live = entries.filter(e => !posix.basename(e.name).startsWith(".wh."));
    for (const e of live.filter(e => e.type !== "link")) {
      await parents(root, e.name);
      const destination = join(root, e.name), old = await exists(destination);
      if (e.type === "directory") {
        if (old && !old.isDirectory()) await rm(destination, { recursive: true, force: true });
        await mkdir(destination, { recursive: true });
      } else {
        await rm(destination, { recursive: true, force: true });
        if (e.type === "file") await writeFile(destination, e.data, { flag: "wx", mode: e.mode });
        else if (e.type === "symlink") { await symlink(e.target, destination); continue; }
        else throw new Error(`Unsupported archive entry type: ${e.type}`);
      }
      await chown(destination, e.uid, e.gid); await chmod(destination, e.mode);
    }
    for (const e of live.filter(e => e.type === "link")) {
      const target = pathName(e.target); await parents(root, target); await parents(root, e.name);
      if (!(await exists(join(root, target)))?.isFile()) throw new Error("Hardlink target must be an existing regular file");
      await rm(join(root, e.name), { recursive: true, force: true });
      await link(join(root, target), join(root, e.name));
    }
    await rm(decoded);
  }
  return { root, config: image.config.config ?? {}, digest: image.descriptor.digest, platform };
}

/** Follow image links within the image, never relative to the launcher filesystem. */
export async function imagePath(root: string, name: string): Promise<string> {
  let pending = posix.resolve("/", name).split("/").filter(Boolean), parts: string[] = [], links = 0;
  while (pending.length) {
    const part = pending.shift()!;
    if (part === ".") continue;
    if (part === "..") { parts.pop(); continue; }
    const candidate = join(root, ...parts, part), info = await lstat(candidate);
    if (info.isSymbolicLink()) {
      if (++links > 40) throw new Error("Too many image symlinks");
      const { readlink } = await import("node:fs/promises"), target = await readlink(candidate);
      if (target.startsWith("/")) parts = [];
      pending = [...target.split("/").filter(Boolean), ...pending];
    } else parts.push(part);
  }
  return join(root, ...parts);
}
