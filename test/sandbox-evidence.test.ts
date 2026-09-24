import { afterEach, expect, test } from "bun:test";
import { chown, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportSandboxEvidence } from "../scripts/sandbox-evidence.ts";

const temporary: string[] = [];
afterEach(async () => { for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bunc-evidence-")); temporary.push(root);
  const source = join(root, "source"), destination = join(root, "destination");
  await mkdir(source, {mode:0o700}); await mkdir(destination, {mode:0o700});
  await mkdir(join(source, "job"), {mode:0o700});
  await writeFile(join(source, "job", "stdout.bin"), Buffer.from([0,255]), {mode:0o600});
  return {root,source,destination};
}
test("exports private result bytes without changing the recipient directory", async () => {
  const {source,destination} = await fixture(), before = await lstat(destination);
  await exportSandboxEvidence(source,destination);
  expect(await readFile(join(destination,"job/stdout.bin"))).toEqual(Buffer.from([0,255]));
  const after = await lstat(destination);
  expect([after.uid,after.gid,after.mode]).toEqual([before.uid,before.gid,before.mode]);
  expect((await lstat(join(destination,"job/stdout.bin"))).mode & 0o777).toBe(0o600);
  await expect(exportSandboxEvidence(source,destination)).rejects.toThrow("empty");
});
test.skipIf(process.platform !== "linux" || process.getuid?.() !== 0)("returns root-produced results to a nonroot Linux runner", async () => {
  const {source,destination} = await fixture();
  await chown(destination,1001,1001);
  await exportSandboxEvidence(source,destination);
  for (const path of [destination,join(destination,"job"),join(destination,"job/stdout.bin")]) {
    const info = await lstat(path); expect([info.uid,info.gid]).toEqual([1001,1001]);
  }
  expect((await lstat(source)).uid).toBe(0);
});
test("refuses symlinked evidence instead of following it during export", async () => {
  const {source,destination} = await fixture();
  await symlink("/etc/passwd",join(source,"link"));
  await expect(exportSandboxEvidence(source,destination)).rejects.toThrow("symbolic links");
  await expect(lstat(join(destination,"link"))).rejects.toThrow();
});
