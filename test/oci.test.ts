import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, zstdCompressSync } from "node:zlib";
import tar from "tar-stream";
import { BlobStore } from "../src/oci/blob-store.ts";
import { LayoutSource, resolveBase } from "../src/oci/source.ts";
import { decodeLayer } from "../src/oci/decode.ts";
import { media, type Descriptor } from "../src/oci/types.ts";
import { descriptor, sha256 } from "../src/oci/digest.ts";
import { imagePath, unpack } from "../src/rootfs.ts";

const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function temporary() { const path = await mkdtemp(join(tmpdir(), "bunc-test-")); directories.push(path); return path; }
const platform = { os: "linux" as const, architecture: process.arch === "arm64" ? "arm64" as const : "amd64" as const };
type Entry = { name: string; data?: string; type?: "file" | "directory" | "symlink" | "link"; linkname?: string };
async function archive(entries: Entry[]) {
  const pack = tar.pack(), chunks: Buffer[] = [];
  const collected = (async () => { for await (const chunk of pack) { if (!Buffer.isBuffer(chunk)) throw new Error("Expected binary tar data"); chunks.push(chunk); } return Buffer.concat(chunks); })();
  for (const entry of entries) pack.entry({ name: entry.name, type: entry.type ?? "file", linkname: entry.linkname, uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000, mode: entry.type === "directory" ? 0o755 : 0o644 }, entry.data ?? "");
  pack.finalize();
  return collected;
}
async function fixture(layers: Entry[][] = [[{ name: "app/hello.txt", data: "hello" }]]) {
  const parent = await temporary(), layout = join(parent, "image"), state = join(parent, "state");
  await mkdir(state); const store = new BlobStore(layout);
  const descriptors: Descriptor[] = [], diffIds: string[] = [];
  for (const entries of layers) {
    const bytes = await archive(entries); diffIds.push(sha256(bytes));
    descriptors.push(await store.put(gzipSync(bytes), media.gzip));
  }
  const config = await store.put(Buffer.from(JSON.stringify({ ...platform, rootfs: { type: "layers", diff_ids: diffIds }, config: { User: "65532:65532", Entrypoint: ["/app/server"], WorkingDir: "/app" } })), media.config);
  const manifest = await store.put(Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: media.manifest, config, layers: descriptors })), media.manifest);
  const imageIndex = await store.put(Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: media.index, manifests: [{ ...manifest, platform }] })), media.index);
  await writeFile(join(layout, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
  await writeFile(join(layout, "index.json"), JSON.stringify({ schemaVersion: 2, mediaType: media.index, manifests: [imageIndex] }));
  return { parent, layout, state, store, manifest, config, descriptors };
}

test("selects the platform manifest through a nested OCI index", async () => {
  const f = await fixture();
  const image = await resolveBase(new LayoutSource(f.layout), platform, new BlobStore(join(f.parent, "cas")));
  expect(image.descriptor.digest).toBe(f.manifest.digest);
  expect(image.config.config?.User).toBe("65532:65532");
});
test("rejects a different architecture", async () => {
  const f = await fixture();
  await expect(resolveBase(new LayoutSource(f.layout), { os: "linux", architecture: platform.architecture === "arm64" ? "amd64" : "arm64" }, new BlobStore(join(f.parent, "cas")))).rejects.toThrow("found 0");
});
test("rejects corrupted metadata", async () => {
  const f = await fixture(); await writeFile(f.store.path(f.config.digest), "{}");
  await expect(unpack(f.layout, f.state)).rejects.toThrow("mismatch");
});
test("rejects corrupted compressed content before extraction", async () => {
  const f = await fixture(); await writeFile(f.store.path(f.descriptors[0]!.digest), "corrupt");
  await expect(unpack(f.layout, f.state)).rejects.toThrow("mismatch");
});
test("rejects a missing blob", async () => {
  const f = await fixture(); await rm(f.store.path(f.descriptors[0]!.digest));
  await expect(unpack(f.layout, f.state)).rejects.toThrow("does not contain blob");
});
for (const [name, mediaType, encode] of [
  ["plain", media.tar, (data: Buffer) => data],
  ["gzip", media.gzip, gzipSync],
  ["zstd", media.zstd, zstdCompressSync],
] as const) {
  test(`decodes ${name} layers and validates the uncompressed digest`, async () => {
    const root = await temporary(), store = new BlobStore(root), data = Buffer.from("layer contents");
    const d = await store.put(encode(data), mediaType), output = join(root, "decoded");
    await decodeLayer(store, d, sha256(data), output);
    expect(await readFile(output)).toEqual(data);
    await expect(decodeLayer(store, d, sha256("wrong"))).rejects.toThrow("DiffID mismatch");
    await expect(decodeLayer(store, d, sha256(data), undefined, 2)).rejects.toThrow("size limit");
  });
}
test("rejects malformed and traversal-shaped digests", () => {
  for (const digest of ["sha256:../outside", "sha512:" + "a".repeat(64), "sha256:" + "a".repeat(63)]) expect(() => descriptor({ mediaType: media.tar, digest, size: 1 })).toThrow("digest");
});
test("applies lower-layer whiteouts and opaque directories", async () => {
  const f = await fixture([
    [{ name: "app/removed", data: "old" }, { name: "app/opaque/lower", data: "old" }, { name: "app/kept", data: "keep" }],
    [{ name: "app/.wh.removed" }, { name: "app/opaque/.wh..wh..opq" }, { name: "app/opaque/upper", data: "new" }],
  ]);
  const image = await unpack(f.layout, f.state);
  expect(await Bun.file(join(image.root, "app/removed")).exists()).toBe(false);
  expect(await Bun.file(join(image.root, "app/opaque/lower")).exists()).toBe(false);
  expect(await Bun.file(join(image.root, "app/opaque/upper")).text()).toBe("new");
  expect(await Bun.file(join(image.root, "app/kept")).text()).toBe("keep");
});
test("rejects traversal entries", async () => {
  const f = await fixture([[{ name: "../escaped", data: "bad" }]]);
  await expect(unpack(f.layout, f.state)).rejects.toThrow("Unsafe archive path");
  expect(await Bun.file(join(f.state, "escaped")).exists()).toBe(false);
});
test("rejects extraction through a symlink parent", async () => {
  const f = await fixture([[{ name: "link", type: "symlink", linkname: "/tmp" }, { name: "link/escaped", data: "bad" }]]);
  await expect(unpack(f.layout, f.state)).rejects.toThrow("Non-directory archive parent");
});
test("resolves absolute image symlinks inside the rootfs and bounds loops", async () => {
  const root = await temporary(); await mkdir(join(root, "usr"));
  await writeFile(join(root, "usr/bun"), "executable"); await symlink("/usr/bun", join(root, "bun"));
  expect(await imagePath(root, "/bun")).toBe(join(root, "usr/bun"));
  await symlink("loop", join(root, "loop"));
  await expect(imagePath(root, "/loop")).rejects.toThrow("Too many image symlinks");
});
