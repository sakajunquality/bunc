import { afterEach, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { lstat, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tar from "tar-stream";
import { BlobStore } from "../src/oci/blob-store.ts";
import { sha256 } from "../src/oci/digest.ts";
import { media, type Descriptor } from "../src/oci/types.ts";
import { resolveBase, type ImageSource } from "../src/oci/source.ts";
import { unpack } from "../src/rootfs.ts";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function temporary() { const path = await mkdtemp(join(tmpdir(), "bunc-rootfs-test-")); directories.push(path); return path; }
const platform = { os: "linux" as const, architecture: process.arch === "arm64" ? "arm64" as const : "amd64" as const };
type Entry = { name: string; data?: string; type?: "file" | "directory" | "symlink" | "link"; linkname?: string };

async function archive(entries: Entry[]) {
  const pack = tar.pack(), chunks: Buffer[] = [];
  const collected = (async () => { for await (const chunk of pack) { if (!Buffer.isBuffer(chunk)) throw new Error("Expected binary tar data"); chunks.push(chunk); } return Buffer.concat(chunks); })();
  for (const entry of entries) pack.entry({ name: entry.name, type: entry.type ?? "file", linkname: entry.linkname, uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000, mode: entry.type === "directory" ? 0o755 : 0o644 }, entry.data ?? "");
  pack.finalize(); return collected;
}

async function fixture(layers: Entry[][]) {
  const parent = await temporary(), layout = join(parent, "image"), state = join(parent, "state");
  await mkdir(state); const store = new BlobStore(layout), descriptors: Descriptor[] = [], diffIds: string[] = [];
  for (const entries of layers) {
    const bytes = await archive(entries); diffIds.push(sha256(bytes)); descriptors.push(await store.put(gzipSync(bytes), media.gzip));
  }
  const config = await store.put(Buffer.from(JSON.stringify({ ...platform, rootfs: { type: "layers", diff_ids: diffIds } })), media.config);
  const manifest = await store.put(Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: media.manifest, config, layers: descriptors })), media.manifest);
  const index = await store.put(Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: media.index, manifests: [{ ...manifest, platform }] })), media.index);
  await writeFile(join(layout, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
  await writeFile(join(layout, "index.json"), JSON.stringify({ schemaVersion: 2, mediaType: media.index, manifests: [index] }));
  return { parent, layout, state, descriptors };
}

test("rejects an upper-layer write through a lower-layer symlink parent", async () => {
  const f = await fixture([[{ name: "redirect", type: "symlink", linkname: "../escaped" }], [{ name: "redirect/escaped", data: "bad" }]]);
  const sentinel = join(f.state, "escaped");
  await expect(unpack(f.layout, f.state)).rejects.toThrow("Non-directory archive parent");
  expect(await Bun.file(sentinel).exists()).toBe(false);
});

test("applies a whiteout before replacing its parent with a same-layer symlink", async () => {
  const f = await fixture([
    [{ name: "parent", type: "directory" }, { name: "parent/secret", data: "lower" }],
    [{ name: "parent/.wh.secret" }, { name: "parent", type: "symlink", linkname: "/tmp" }],
  ]);
  const image = await unpack(f.layout, f.state);
  const parent = await lstat(join(image.root, "parent"));
  expect(parent.isSymbolicLink()).toBe(true);
  expect(await Bun.file(join(f.parent, "secret")).exists()).toBe(false);
});

test("rejects hardlinks to symlinks but preserves cross-layer regular hardlinks", async () => {
  const unsafe = await fixture([[{ name: "target", type: "symlink", linkname: "/tmp/outside" }, { name: "copy", type: "link", linkname: "target" }]]);
  await expect(unpack(unsafe.layout, unsafe.state)).rejects.toThrow("Hardlink target");

  const safe = await fixture([[{ name: "target", data: "approved" }], [{ name: "copy", type: "link", linkname: "target" }]]);
  const image = await unpack(safe.layout, safe.state), target = await lstat(join(image.root, "target")), copy = await lstat(join(image.root, "copy"));
  expect(await Bun.file(join(image.root, "copy")).text()).toBe("approved");
  expect(copy.ino).toBe(target.ino);
});

test("enforces explicit compressed, decoded, content, and entry preparation limits", async () => {
  const f = await fixture([[{ name: "one", data: "12345678" }, { name: "two", data: "abcdefgh" }]]);
  for (const name of ["compressed", "decoded", "content", "entries"]) await mkdir(join(f.parent, name));
  await expect(unpack(f.layout, join(f.parent, "compressed"), { maxCompressedBytes: 1 })).rejects.toThrow("compressed content");
  await expect(unpack(f.layout, join(f.parent, "decoded"), { maxDecodedLayerBytes: 1 })).rejects.toThrow("size limit");
  await expect(unpack(f.layout, join(f.parent, "content"), { maxFilesystemBytes: 8 })).rejects.toThrow("filesystem content");
  await expect(unpack(f.layout, join(f.parent, "entries"), { maxEntries: 1 })).rejects.toThrow("too many archive entries");
});

test("rejects aggregate compressed size before opening any layer body", async () => {
  const parent = await temporary(), store = new BlobStore(join(parent, "destination"));
  const config = { mediaType: media.config, digest: sha256("config-not-opened"), size: 128 } as Descriptor;
  const layer = { mediaType: media.gzip, digest: sha256("layer-not-opened"), size: 1024 } as Descriptor;
  const bytes = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: media.manifest, config, layers: [layer] }));
  const root = { mediaType: media.manifest, digest: sha256(bytes), size: bytes.length } as Descriptor;
  const opened: string[] = [];
  const source: ImageSource = {
    async root() { return { descriptor: root, bytes }; },
    async blob(descriptor) {
      opened.push(descriptor.digest);
      return (async function* () { yield Buffer.alloc(descriptor.size); })();
    },
  };
  await expect(resolveBase(source, platform, store, { maxLayerBytes: 512 })).rejects.toThrow("compressed content");
  expect(opened).toEqual([]);
  expect(await Bun.file(store.path(layer.digest)).exists()).toBe(false);
  expect(await Bun.file(store.path(config.digest)).exists()).toBe(false);
});
