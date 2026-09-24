import { afterEach, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tar from "tar-stream";
import { BlobStore } from "../src/oci/blob-store.ts";
import { sha256 } from "../src/oci/digest.ts";
import { media, type Descriptor } from "../src/oci/types.ts";
import { environmentDescriptorDigest, inProcessPreparationExecutor, inspectPreparedCache, inspectPreparedEnvironments, openPreparedEnvironment, parseEnvironmentDescriptor, prepareEnvironment, preparedEnvironmentKey, removeIncompletePreparations, removePreparedEnvironments, SANDBOX_RUNTIME_FLAGS, type EnvironmentDescriptor, type PrepareEnvironmentOptions } from "../src/sandbox/environment.ts";
import { acquireStateRoot } from "../src/sandbox/state.ts";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function temporary() { const path = await mkdtemp(join(tmpdir(), "bunc-environment-test-")); directories.push(path); return path; }
const architecture = process.arch === "arm64" ? "arm64" as const : "amd64" as const;
type Entry = { name: string; data?: string; type?: "file" | "directory" | "symlink"; mode?: number; linkname?: string };
const prepare = (options: Omit<PrepareEnvironmentOptions, "preparationExecutor">) => prepareEnvironment({ ...options, preparationExecutor: inProcessPreparationExecutor });

async function archive(entries: Entry[]) {
  const pack = tar.pack(), chunks: Buffer[] = [];
  const collected = (async () => { for await (const chunk of pack) { if (!Buffer.isBuffer(chunk)) throw new Error("Expected binary tar data"); chunks.push(chunk); } return Buffer.concat(chunks); })();
  for (const entry of entries) pack.entry({ name: entry.name, type: entry.type ?? "file", linkname: entry.linkname, uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000, mode: entry.mode ?? (entry.type === "directory" ? 0o755 : 0o644) }, entry.data ?? "");
  pack.finalize(); return collected;
}

async function fixture(entries: Entry[] = [{ name: "usr/local/bin/bun", data: "bun", mode: 0o755 }, { name: "opt/packages", type: "directory" }, { name: "opt/packages/pkg.txt", data: "approved" }]) {
  const parent = await temporary(), layout = join(parent, "image"), stateRoot = join(parent, "state");
  const store = new BlobStore(layout), bytes = await archive(entries), layer = await store.put(gzipSync(bytes), media.gzip);
  const config = await store.put(Buffer.from(JSON.stringify({ os: "linux", architecture, rootfs: { type: "layers", diff_ids: [sha256(bytes)] } })), media.config);
  const manifest = await store.put(Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: media.manifest, config, layers: [layer] })), media.manifest);
  const index = await store.put(Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: media.index, manifests: [{ ...manifest, platform: { os: "linux", architecture } }] })), media.index);
  await writeFile(join(layout, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
  await writeFile(join(layout, "index.json"), JSON.stringify({ schemaVersion: 2, mediaType: media.index, manifests: [index] }));
  const descriptor: EnvironmentDescriptor = { schemaVersion: 1, manifestDigest: manifest.digest, architecture, interpreter: "/usr/local/bin/bun", packagePath: "/opt/packages", workingDirectory: "/work", uid: 65532, gid: 65532, runtimeFlags: [...SANDBOX_RUNTIME_FLAGS], policyRevision: "offline-v1" };
  return { parent, layout, stateRoot, manifest, descriptor };
}

test("strictly validates the fixed native environment contract", async () => {
  const f = await fixture();
  expect(parseEnvironmentDescriptor(f.descriptor)).toEqual(f.descriptor);
  expect(environmentDescriptorDigest(f.descriptor)).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(preparedEnvironmentKey(f.descriptor)).toMatch(/^[a-f0-9]{64}$/);
  expect(() => parseEnvironmentDescriptor({ ...f.descriptor, unknown: true })).toThrow("unknown field");
  expect(() => parseEnvironmentDescriptor({ ...f.descriptor, runtimeFlags: ["--install"] })).toThrow("runtimeFlags");
  expect(() => parseEnvironmentDescriptor({ ...f.descriptor, interpreter: "/usr/../bin/bun" })).toThrow("normalized");
  expect(() => parseEnvironmentDescriptor({ ...f.descriptor, packagePath: "/code/node_modules" })).toThrow("hidden by");
  expect(() => parseEnvironmentDescriptor({ ...f.descriptor, architecture: architecture === "arm64" ? "amd64" : "arm64" })).toThrow("native host");
  expect(parseEnvironmentDescriptor({ ...f.descriptor, packagePath: null }).packagePath).toBeNull();
});

test("prepares exact OCI content atomically with all fixed mountpoints", async () => {
  const f = await fixture(), prepared = await prepare({ stateRoot: f.stateRoot, layout: f.layout, descriptor: f.descriptor, minimumFreeBytes: 1 });
  expect(prepared.manifestDigest).toBe(f.manifest.digest);
  expect(prepared.packageHostPath).toBe(join(prepared.rootfs, "opt/packages"));
  for (const path of ["proc", "dev", "code", "code/node_modules", "input", "work", "output", "tmp", "home/sandbox", "dev/shm", ".bunc-old-root"]) {
    expect((await import("node:fs/promises")).lstat(join(prepared.rootfs, path)).then((value) => value.isDirectory())).resolves.toBe(true);
  }
  expect(await openPreparedEnvironment(f.stateRoot, f.descriptor)).toEqual(prepared);
  expect(await inspectPreparedEnvironments(f.stateRoot)).toEqual([prepared]);
  expect(await prepare({ stateRoot: f.stateRoot, layout: f.layout, descriptor: f.descriptor, minimumFreeBytes: 1 })).toEqual(prepared);
});

test("rejects a manifest mismatch without publishing a cache hit", async () => {
  const f = await fixture(), descriptor = { ...f.descriptor, manifestDigest: `sha256:${"0".repeat(64)}` as const };
  await expect(prepare({ stateRoot: f.stateRoot, layout: f.layout, descriptor, minimumFreeBytes: 1 })).rejects.toThrow("does not match expected");
  await expect(openPreparedEnvironment(f.stateRoot, descriptor)).rejects.toThrow("not prepared");
  expect((await import("node:fs/promises")).readdir(join(f.stateRoot, "prepared"))).resolves.toEqual([]);
});

test("rejects unsafe prepared mountpoint parents and non-executable interpreters", async () => {
  const f = await fixture([{ name: "usr/local/bin/bun", data: "bun", mode: 0o644 }]);
  await expect(prepare({ stateRoot: f.stateRoot, layout: f.layout, descriptor: { ...f.descriptor, packagePath: null }, minimumFreeBytes: 1 })).rejects.toThrow("not executable");
  const linked = await fixture([{ name: "usr/local/bin/bun", data: "bun", mode: 0o755 }, { name: "home", type: "symlink", linkname: "/tmp" }]);
  await expect(prepare({ stateRoot: linked.stateRoot, layout: linked.layout, descriptor: { ...linked.descriptor, packagePath: null }, minimumFreeBytes: 1 })).rejects.toThrow("unsafe parent");
  const occupied = await fixture([{ name: "usr/local/bin/bun", data: "bun", mode: 0o755 }, { name: ".bunc-old-root/data", data: "image data" }]);
  await expect(prepare({ stateRoot: occupied.stateRoot, layout: occupied.layout, descriptor: { ...occupied.descriptor, packagePath: null }, minimumFreeBytes: 1 })).rejects.toThrow("must be empty");
});

test("enforces cache capacity and refuses active deletion", async () => {
  const f = await fixture();
  await expect(prepare({ stateRoot: f.stateRoot, layout: f.layout, descriptor: f.descriptor, maxPreparedBytes: 1, minimumFreeBytes: 1 })).rejects.toThrow();
  const prepared = await prepare({ stateRoot: f.stateRoot, layout: f.layout, descriptor: f.descriptor, minimumFreeBytes: 1 });
  const lease = await acquireStateRoot(f.stateRoot);
  await expect(removePreparedEnvironments(lease, [prepared.key], new Set([prepared.key]))).rejects.toThrow("active job");
  expect(await removePreparedEnvironments(lease, [prepared.key], new Set())).toEqual([prepared.key]);
  await lease.release();
  await expect(openPreparedEnvironment(f.stateRoot, f.descriptor)).rejects.toThrow("not prepared");
});

test("detects mutation of protected prepared interpreter metadata", async () => {
  const f = await fixture(), prepared = await prepare({ stateRoot: f.stateRoot, layout: f.layout, descriptor: f.descriptor, minimumFreeBytes: 1 });
  await writeFile(prepared.interpreterHostPath, "changed");
  await expect(openPreparedEnvironment(f.stateRoot, f.descriptor)).rejects.toThrow("metadata changed");
});

test("inspects and explicitly removes bounded interrupted preparations", async () => {
  const f = await fixture();
  const lease = await acquireStateRoot(f.stateRoot), name = `.prepare-${"a".repeat(64)}-${"b".repeat(16)}`;
  await mkdir(join(f.stateRoot, "prepared", name), { mode: 0o700 });
  const inspection = await inspectPreparedCache(f.stateRoot);
  expect(inspection.incomplete).toEqual([name]);
  expect(inspection.entries).toEqual([]);
  expect(await removeIncompletePreparations(lease)).toEqual([name]);
  await lease.release();
});

test("passes explicit preparation limits and rejects work that outlives its deadline", async () => {
  const f = await fixture(); let observed: { timeoutMs: number; memoryBytes: number; diskBytes: number } | undefined;
  const executor: import("../src/sandbox/environment.ts").PreparationExecutor = async (work, limits) => {
    observed = limits;
    await inProcessPreparationExecutor(work, limits);
  };
  await prepareEnvironment({ stateRoot: f.stateRoot, layout: f.layout, descriptor: f.descriptor, minimumFreeBytes: 1, preparationTimeoutMs: 5000, maxPreparationMemoryBytes: 256 * 1024 ** 2, preparationExecutor: executor });
  expect(observed?.timeoutMs).toBe(5000); expect(observed?.memoryBytes).toBe(256 * 1024 ** 2); expect(observed?.diskBytes).toBeGreaterThan(0);

  const other = await fixture();
  await expect(prepareEnvironment({ stateRoot: other.stateRoot, layout: other.layout, descriptor: other.descriptor, minimumFreeBytes: 1, preparationTimeoutMs: 5,
    preparationExecutor: async (_work, limits) => { await new Promise<void>((_resolve, reject) => limits.signal.addEventListener("abort", () => reject(limits.signal.reason), { once: true })); } })).rejects.toThrow("deadline");
  expect((await inspectPreparedCache(other.stateRoot)).incomplete).toEqual([]);
});

test("preserves preparation ownership evidence after executor cleanup failure", async () => {
  const f = await fixture();
  await expect(prepareEnvironment({ stateRoot: f.stateRoot, layout: f.layout, descriptor: f.descriptor, minimumFreeBytes: 1,
    preparationExecutor: async (work) => {
      await writeFile(join(work.staging, ".bunc-preparation-resource.json"), "{}", { mode: 0o600, flag: "wx" });
      throw new Error("cgroup cleanup incomplete");
    } })).rejects.toThrow("cleanup incomplete");
  const cache = await inspectPreparedCache(f.stateRoot);
  expect(cache.entries).toEqual([]); expect(cache.incomplete).toHaveLength(1);
  expect(await Bun.file(join(f.stateRoot, "prepared", cache.incomplete[0]!, ".bunc-preparation-resource.json")).exists()).toBe(true);
});
