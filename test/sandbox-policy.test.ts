import { expect, test } from "bun:test";
import { DEFAULT_SANDBOX_POLICY, resolveLimits, validatePolicy } from "../src/sandbox/policy.ts";
import { validateRequest } from "../src/sandbox/contract.ts";

test("resolves the frozen offline profile defaults", () => {
  const request = validateRequest({ schemaVersion: 1, code: "" });
  const limits = resolveLimits(request, DEFAULT_SANDBOX_POLICY);
  expect(limits.timeoutMs).toBe(5_000);
  expect(limits.memoryBytes).toBe(256 * 1024 * 1024);
  expect(limits.stdioBytes).toBe(1024 * 1024);
  expect(limits.pidsMax).toBe(64);
  expect(limits.scratchBytes).toBe(64 * 1024 * 1024);
  expect(Object.isFrozen(limits)).toBe(true);
});

test("merges a smaller request without mutating policy", () => {
  const request = validateRequest({ schemaVersion: 1, code: "", limits: { timeoutMs: 200, memoryMiB: 128, stdioBytes: 100 } });
  expect(resolveLimits(request, DEFAULT_SANDBOX_POLICY)).toMatchObject({ timeoutMs: 200, memoryBytes: 128 * 1024 * 1024, stdioBytes: 100 });
});

test("rejects requests outside policy minima and maxima", () => {
  expect(() => resolveLimits(validateRequest({ schemaVersion: 1, code: "", limits: { memoryMiB: 127 } }), DEFAULT_SANDBOX_POLICY)).toThrow("below");
  expect(() => resolveLimits(validateRequest({ schemaVersion: 1, code: "", limits: { timeoutMs: 30_001 } }), DEFAULT_SANDBOX_POLICY)).toThrow("exceeds");
});

test("strict policy parsing cannot expand the v1 profile", () => {
  expect(validatePolicy({ schemaVersion: 1, revision: "offline-v1" })).toEqual(DEFAULT_SANDBOX_POLICY);
  expect(() => validatePolicy({ schemaVersion: 1, revision: "offline-v1", unknown: 1 })).toThrow("unknown");
  expect(() => validatePolicy({ schemaVersion: 1, revision: "offline-v1", maximums: { memoryMiB: 513 } })).toThrow("cannot expand");
  expect(() => validatePolicy({ schemaVersion: 1, revision: "offline-v1", fixed: { pidsMax: 65 } })).toThrow("cannot expand");
  expect(() => validatePolicy({ schemaVersion: 1, revision: "offline-v1", defaults: { timeoutMs: 20 }, minimums: { timeoutMs: 30 } })).toThrow("minimum");
});
