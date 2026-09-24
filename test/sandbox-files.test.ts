import { afterEach, expect, test } from "bun:test";
import { link, mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectArtifacts, stageJobFiles } from "../src/sandbox/files.ts";
import { validateRequest } from "../src/sandbox/contract.ts";
import { DEFAULT_SANDBOX_POLICY, resolveLimits } from "../src/sandbox/policy.ts";

const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) { Bun.spawnSync(["chmod", "-R", "u+w", path]); await rm(path, { recursive: true, force: true }); } });
async function directory() { const path = await mkdtemp(join(tmpdir(), "bunc-files-")); temporary.push(path); return path; }
const limits = resolveLimits(validateRequest({ schemaVersion: 1, code: "" }), DEFAULT_SANDBOX_POLICY);

test("stages exact code and decoded input bytes into an immutable tree", async () => {
  const parent = await directory(), root = join(parent, "staged");
  const request = validateRequest({ schemaVersion: 1, code: "// exact\n", inputs: [{ path: "nested/data.bin", encoding: "base64", data: "AP8=" }] });
  const staged = await stageJobFiles(root, request, limits);
  expect(await readFile(join(staged.codeDir, "main.ts"))).toEqual(Buffer.from("// exact\n"));
  expect(await readFile(join(staged.codeDir, "bunfig.toml"))).toEqual(Buffer.alloc(0));
  expect(await readFile(join(staged.inputDir, "nested/data.bin"))).toEqual(Buffer.from([0, 255]));
  expect(staged.codeDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(staged.inputsDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
});

test("staging fails closed and removes partial state", async () => {
  const parent = await directory(), root = join(parent, "staged");
  const request = validateRequest({ schemaVersion: 1, code: "too large" });
  await expect(stageJobFiles(root, request, { ...limits, sourceBytes: 2 })).rejects.toThrow("source limit");
  expect(await Bun.file(root).exists()).toBe(false);
});

test.skipIf(process.platform !== "linux")("collects regular artifacts through descriptor-relative opens", async () => {
  const parent = await directory(), output = join(parent, "output"), result = join(parent, "result");
  await mkdir(join(output, "nested"), { recursive: true }); await mkdir(result);
  await writeFile(join(output, "nested", "value.bin"), Buffer.from([0, 1, 2]));
  const artifacts = await collectArtifacts(output, result, limits);
  expect(artifacts).toEqual([{ path: "nested/value.bin", file: "artifacts/nested/value.bin", bytes: 3, sha256: expect.stringMatching(/^sha256:/) }]);
  expect(await readFile(join(result, artifacts[0]!.file))).toEqual(Buffer.from([0, 1, 2]));
});

test.skipIf(process.platform !== "linux")("rejects symlinks and publishes no partial artifact tree", async () => {
  const parent = await directory(), output = join(parent, "output"), result = join(parent, "result");
  await mkdir(output); await mkdir(result); await writeFile(join(parent, "outside"), "secret"); await symlink(join(parent, "outside"), join(output, "leak"));
  await expect(collectArtifacts(output, result, limits)).rejects.toThrow("safely open");
  expect(await Bun.file(join(result, "artifacts")).exists()).toBe(false);
});

test.skipIf(process.platform !== "linux")("rejects hardlinked artifacts", async () => {
  const parent = await directory(), output = join(parent, "output"), result = join(parent, "result");
  await mkdir(output); await mkdir(result); await writeFile(join(output, "one"), "x"); await link(join(output, "one"), join(output, "two"));
  await expect(collectArtifacts(output, result, limits)).rejects.toThrow("Hardlinked");
});

test.skipIf(process.platform !== "linux")("rejects FIFOs and sparse files without opening them as data", async () => {
  const parent = await directory(), output = join(parent, "output"), result = join(parent, "result");
  await mkdir(output); await mkdir(result);
  expect(Bun.spawnSync(["mkfifo", join(output, "pipe")]).exitCode).toBe(0);
  await expect(collectArtifacts(output, result, limits)).rejects.toThrow("regular file");
  await rm(join(output, "pipe")); await mkdir(join(result, "retry"));
  await writeFile(join(output, "sparse"), ""); await truncate(join(output, "sparse"), 1024 * 1024);
  await expect(collectArtifacts(output, join(result, "retry"), limits)).rejects.toThrow("Sparse");
});
