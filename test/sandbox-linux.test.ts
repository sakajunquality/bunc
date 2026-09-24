import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorLinuxSandbox, hasCgroupV2, recoverLinuxSandbox, requireCgroupKill } from "../src/sandbox/linux.ts";
import { SANDBOX_SECCOMP_REVISION, sandboxAllowedSyscalls } from "../src/sandbox/seccomp.ts";
import { preparationCompletionError } from "../src/sandbox/preparation.ts";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("fixed Linux sandbox profile", () => {
  test("the deny-default syscall set does not open network or administration escape hatches", () => {
    const allowed = new Set<string>(sandboxAllowedSyscalls);
    for (const syscall of ["socket", "socketpair", "connect", "bind", "listen", "sendto", "recvfrom", "mount", "umount2", "pivot_root", "setns", "unshare", "bpf", "ptrace", "keyctl", "init_module", "prctl"]) {
      expect(allowed.has(syscall)).toBe(false);
    }
    for (const syscall of ["execve", "futex", "mmap", "mprotect", "openat", "read", "write", "wait4"]) expect(allowed.has(syscall)).toBe(true);
    // clone and clone3 have argument/error rules rather than unconditional allows.
    expect(allowed.has("clone")).toBe(false);
    expect(allowed.has("clone3")).toBe(false);
  });

  test("doctor always returns named evidence and the frozen profile revision", () => {
    const report = doctorLinuxSandbox();
    expect(report.seccompRevision).toBe(SANDBOX_SECCOMP_REVISION);
    expect(report.checks.length).toBeGreaterThanOrEqual(5);
    expect(new Set(report.checks.map(check => check.name)).size).toBe(report.checks.length);
    expect(report.ok).toBe(report.checks.every(check => check.ok));
  });

  test("cgroup v2 root detection does not require the non-root cgroup.kill file", () => {
    const root = mkdtempSync(join(tmpdir(), "bunc-cgroup-files-")); temporary.push(root);
    writeFileSync(join(root, "cgroup.controllers"), "cpu memory pids\n");
    expect(hasCgroupV2(root)).toBe(true);
    expect(() => requireCgroupKill(root)).toThrow("cgroup.kill is unavailable");
    const child = join(root, "probe"); mkdirSync(child); writeFileSync(join(child, "cgroup.kill"), "");
    expect(() => requireCgroupKill(child)).not.toThrow();
  });

  test("preparation cleanup failure retains the primary failure and cause", () => {
    const primary = new Error("preparation child failed"), cleanup = new Error("cgroup remained populated");
    const combined = preparationCompletionError(primary, [cleanup], false);
    expect(combined).toBeInstanceOf(AggregateError);
    expect((combined as AggregateError).errors).toEqual([primary, cleanup]);
    expect((combined as Error).cause).toBe(primary);
    expect((combined as Error).message).toContain(primary.message);
    expect(preparationCompletionError(primary, [], false)).toBe(primary);
    expect(preparationCompletionError(undefined, [], true)).toBeUndefined();
    const cleanupOnly = preparationCompletionError(undefined, [cleanup], true) as AggregateError;
    expect(cleanupOnly.errors).toEqual([cleanup]);
  });

  test("recovery rejects traversal before considering a cgroup target", async () => {
    const parent = mkdtempSync(join(tmpdir(), "bunc-cgroup-test-")); temporary.push(parent);
    const result = await recoverLinuxSandbox({ cgroupParent: parent, runId: "../foreign" });
    expect(result.complete).toBe(false);
    expect(result.errors.join(" ")).toContain("Invalid sandbox run ID");
  });

  test("recovery treats an absent exact child as already clean", async () => {
    const parent = mkdtempSync(join(tmpdir(), "bunc-cgroup-test-")); temporary.push(parent);
    expect(await recoverLinuxSandbox({ cgroupParent: parent, runId: "job_123" })).toEqual({ complete: true, errors: [] });
  });
});
