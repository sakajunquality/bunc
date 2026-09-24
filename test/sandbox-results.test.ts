import { afterEach, expect, test } from "bun:test";
import { chmod, link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertResultCapacity, releaseResultReservation, reserveResultDirectory, resultReservation } from "../src/sandbox/results.ts";
import { DEFAULT_SANDBOX_POLICY, resolveLimits } from "../src/sandbox/policy.ts";
import { validateRequest } from "../src/sandbox/contract.ts";

const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });
async function directory() { const path = await mkdtemp(join(tmpdir(), "bunc-results-")); temporary.push(path); return path; }

test("accounts retained logical bytes and reserves the requested result", async () => {
  const root = await directory(); await mkdir(join(root, "old")); await writeFile(join(root, "old", "stdout.bin"), "1234");
  const capacity = await assertResultCapacity(join(root, "new"), { reservedBytes: 10, minFreeBytes: 0, maxStoredBytes: 20 });
  expect(capacity).toMatchObject({ resultsRoot: root, siblings: 1, entries: 2, storedBytes: 4, reservedBytes: 10 });
});

test("reservation covers streams, artifacts, and bounded metadata", () => {
  const limits = resolveLimits(validateRequest({ schemaVersion: 1, code: "" }), DEFAULT_SANDBOX_POLICY);
  expect(resultReservation(limits)).toBe(limits.stdioBytes + limits.artifactBytes + 1024 * 1024);
});

test("rejects existing targets and exhausted sibling or byte capacity", async () => {
  const root = await directory(); await mkdir(join(root, "old")); await writeFile(join(root, "old", "data"), "12345");
  await expect(assertResultCapacity(join(root, "old"), { reservedBytes: 1, minFreeBytes: 0 })).rejects.toThrow("already exists");
  await expect(assertResultCapacity(join(root, "new"), { reservedBytes: 1, minFreeBytes: 0, maxSiblings: 1 })).rejects.toThrow("sibling capacity");
  await expect(assertResultCapacity(join(root, "new"), { reservedBytes: 6, minFreeBytes: 0, maxStoredBytes: 10 })).rejects.toThrow("cannot admit");
});

test("refuses links, hardlinks, special entries, and unsafe roots", async () => {
  const root = await directory(), outside = join(await directory(), "outside"); await writeFile(outside, "x");
  await symlink(outside, join(root, "link"));
  await expect(assertResultCapacity(join(root, "new"), { reservedBytes: 1, minFreeBytes: 0 })).rejects.toThrow("symbolic link");
  await rm(join(root, "link")); await writeFile(join(root, "one"), "x"); await link(join(root, "one"), join(root, "two"));
  await expect(assertResultCapacity(join(root, "new"), { reservedBytes: 1, minFreeBytes: 0 })).rejects.toThrow("hardlinked");
  await rm(join(root, "one")); await rm(join(root, "two"));
  expect(Bun.spawnSync(["mkfifo", join(root, "pipe")]).exitCode).toBe(0);
  await expect(assertResultCapacity(join(root, "new"), { reservedBytes: 1, minFreeBytes: 0 })).rejects.toThrow("special file");
  await rm(join(root, "pipe")); await chmod(root, 0o777);
  await expect(assertResultCapacity(join(root, "new"), { reservedBytes: 1, minFreeBytes: 0 })).rejects.toThrow("must not be");
});

test("bounds traversal entry count and depth", async () => {
  const root = await directory(); await mkdir(join(root, "a")); await mkdir(join(root, "a", "b")); await writeFile(join(root, "a", "b", "x"), "x");
  await expect(assertResultCapacity(join(root, "new"), { reservedBytes: 1, minFreeBytes: 0, maxEntries: 2 })).rejects.toThrow("entry scan");
  await expect(assertResultCapacity(join(root, "new"), { reservedBytes: 1, minFreeBytes: 0, maxDepth: 1 })).rejects.toThrow("depth");
});

test("atomically creates and accounts a live result reservation", async () => {
  const root = await directory(), first = join(root, "first"), second = join(root, "second");
  await reserveResultDirectory(first, { reservedBytes: 10, minFreeBytes: 0, maxStoredBytes: 19 });
  expect(await Bun.file(join(first, ".bunc-reservation")).text()).toBe("10\n");
  await expect(reserveResultDirectory(second, { reservedBytes: 10, minFreeBytes: 0, maxStoredBytes: 19 })).rejects.toThrow("cannot admit");
  expect(await Bun.file(second).exists()).toBe(false);
  await releaseResultReservation(first);
  expect(await Bun.file(join(first, ".bunc-reservation")).exists()).toBe(false);
});
