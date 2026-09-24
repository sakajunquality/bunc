import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SandboxError, readRequest, validateRequest } from "../src/sandbox/contract.ts";

const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });
async function directory() { const path = await mkdtemp(join(tmpdir(), "bunc-contract-")); temporary.push(path); return path; }

test("validates and freezes the versioned request contract", () => {
  const request = validateRequest({ schemaVersion: 1, code: "console.log('ok')", inputs: [{ path: "data/value.bin", encoding: "base64", data: "AP8=" }], limits: { timeoutMs: 10, memoryMiB: 128, stdioBytes: 20 } });
  expect(request.inputs?.[0]?.path).toBe("data/value.bin");
  expect(Object.isFrozen(request)).toBe(true);
  expect(Object.isFrozen(request.inputs)).toBe(true);
});

test("rejects unknown, prototype-sensitive, and unsafe request fields", () => {
  for (const value of [
    { schemaVersion: 2, code: "" },
    { schemaVersion: 1, code: "", extra: true },
    JSON.parse('{"schemaVersion":1,"code":"","__proto__":{}}'),
    { schemaVersion: 1, code: "", inputs: [{ path: "../secret", encoding: "utf8", data: "x" }] },
    { schemaVersion: 1, code: "", inputs: [{ path: "a", encoding: "utf8", data: "x" }, { path: "a/b", encoding: "utf8", data: "x" }] },
  ]) expect(() => validateRequest(value)).toThrow(SandboxError);
});

test("rejects noncanonical base64 and unsafe numeric limits", () => {
  expect(() => validateRequest({ schemaVersion: 1, code: "", inputs: [{ path: "x", encoding: "base64", data: "YQ" }] })).toThrow("strict base64");
  for (const timeoutMs of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => validateRequest({ schemaVersion: 1, code: "", limits: { timeoutMs } })).toThrow("positive safe integer");
});

test("bounds the encoded form of direct SDK requests", () => {
  expect(() => validateRequest({ schemaVersion: 1, code: "", inputs: [{ path: "data", encoding: "utf8", data: "\0".repeat(3 * 1024 * 1024) }] })).toThrow("encoded request exceeds");
});

test("bounds request bytes before parsing and refuses a symlink", async () => {
  const root = await directory(), request = join(root, "request.json");
  await writeFile(request, JSON.stringify({ schemaVersion: 1, code: "123456" }));
  await expect(readRequest(request, 8)).rejects.toThrow("exceeds");
  const link = join(root, "link.json"); await symlink(request, link);
  await expect(readRequest(link)).rejects.toThrow();
});

test("rejects malformed UTF-8 JSON", async () => {
  const root = await directory(), request = join(root, "request.json");
  await writeFile(request, Buffer.from([0x7b, 0x22, 0x80, 0x22, 0x3a, 0x31, 0x7d]));
  await expect(readRequest(request)).rejects.toThrow("valid JSON");
});
