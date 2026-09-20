import { afterEach, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm, symlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assetNames, payloadNames, bunVersion, bunRevision, identity, verifyAssets, validateTag, validateSource, releaseVersion, releaseNotes, type ReleaseManifest } from "../scripts/distribution.ts";
import { verificationArguments } from "../scripts/verify-release.ts";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
const commit = "a".repeat(40);
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "bunc-release-test-")); directories.push(dir);
  for (const name of payloadNames) {
    const bytes = Buffer.alloc(32); bytes.set(Buffer.from("7f454c460201", "hex"));
    bytes.writeUInt16LE(name.endsWith("arm64") ? 183 : 62, 18);
    await writeFile(join(dir, name), bytes);
  }
  const manifest: ReleaseManifest = { schemaVersion: 1, version: "0.1.0-alpha.1", sourceCommit: commit, bun: { version: bunVersion, revision: bunRevision }, files: {} };
  for (const name of payloadNames) manifest.files[name] = await identity(join(dir, name));
  await writeFile(join(dir, "release.json"), JSON.stringify(manifest));
  await checksums(dir);
  return dir;
}
async function checksums(dir: string) {
  const lines = [];
  for (const name of [...payloadNames, "release.json"]) lines.push(`${(await identity(join(dir, name))).sha256}  ${name}`);
  await writeFile(join(dir, "SHA256SUMS"), lines.join("\n") + "\n");
}
test("accepts stable/prerelease versions and exact matching tags", () => {
  for (const value of ["0.0.0", "1.2.3", "0.1.0-alpha.1"]) expect(releaseVersion(value)).toBe(value);
  validateTag("v0.1.0-alpha.1", "0.1.0-alpha.1");
  for (const value of ["latest", "v1.0.0", "01.2.3", "1.2.3-01", "1.2.3+build", "1.0.0\n"]) expect(() => releaseVersion(value)).toThrow();
  expect(() => validateTag("v1.0.1", "1.0.0")).toThrow("tag");
});
test("restricts signed identities to main/version tags and full commits", () => {
  validateSource("refs/heads/main", commit); validateSource("refs/tags/v0.1.0-alpha.1", commit);
  expect(() => validateSource("refs/heads/feature", commit)).toThrow();
  expect(() => validateSource("refs/heads/main", "abc123")).toThrow();
  const args = verificationArguments("binary", "bundle", "owner/repo", "refs/tags/v0.1.0", commit);
  for (const flag of ["--signer-workflow", "--source-ref", "--source-digest", "--deny-self-hosted-runners"]) expect(args).toContain(flag);
  expect(args).toContain("owner/repo/.github/workflows/release.yml");
});
test("extracts exact version notes without adjacent releases", () => {
  expect(releaseNotes("# Releases\n## 1.0.0\nFirst\n## 0.9.0\nPrevious", "1.0.0")).toBe("First\n");
  expect(() => releaseNotes("## Unreleased\nNext", "1.0.0")).toThrow("Missing");
  expect(() => releaseNotes("## 1.0.0\n", "1.0.0")).toThrow("empty");
});
test("checks complete assets, version, source, toolchain and ELF targets", async () => {
  const dir = await fixture();
  expect((await verifyAssets(dir, "0.1.0-alpha.1", commit)).version).toBe("0.1.0-alpha.1");
  expect(assetNames).toContain("BUN_LICENSE.md");
  await expect(verifyAssets(dir, "0.1.0", commit)).rejects.toThrow("version mismatch");
  await expect(verifyAssets(dir, undefined, "b".repeat(40))).rejects.toThrow("commit mismatch");
});
test("rejects payload tampering before execution", async () => {
  const dir = await fixture(); await writeFile(join(dir, "bunc-linux-arm64"), "tampered");
  await expect(verifyAssets(dir)).rejects.toThrow("Checksum mismatch");
});
test("rejects missing and extra assets", async () => {
  const dir = await fixture(); await writeFile(join(dir, "unexpected"), "extra");
  await expect(verifyAssets(dir)).rejects.toThrow("Unexpected or missing");
  await rm(join(dir, "unexpected")); await rm(join(dir, "LICENSE"));
  await expect(verifyAssets(dir)).rejects.toThrow("Unexpected or missing");
});
test("rejects duplicate and path-shaped checksum entries", async () => {
  const dir = await fixture(), path = join(dir, "SHA256SUMS"), text = await readFile(path, "utf8");
  await writeFile(path, text + text.split("\n")[0] + "\n");
  await expect(verifyAssets(dir)).rejects.toThrow("duplicate");
  await writeFile(path, text.replace("  LICENSE", "  ../LICENSE"));
  await expect(verifyAssets(dir)).rejects.toThrow("checksum entry");
});
test("rejects symlink assets", async () => {
  const dir = await fixture(); await rm(join(dir, "LICENSE")); await symlink("NOTICE", join(dir, "LICENSE"));
  await expect(verifyAssets(dir)).rejects.toThrow("Invalid release asset");
});
test("detects substituted architectures even with rewritten checksums", async () => {
  const dir = await fixture(); await writeFile(join(dir, "bunc-linux-arm64"), await readFile(join(dir, "bunc-linux-x64")));
  const path = join(dir, "release.json"), manifest = JSON.parse(await readFile(path, "utf8"));
  manifest.files["bunc-linux-arm64"] = await identity(join(dir, "bunc-linux-arm64"));
  await writeFile(path, JSON.stringify(manifest)); await checksums(dir);
  await expect(verifyAssets(dir)).rejects.toThrow("Wrong ELF architecture");
});
