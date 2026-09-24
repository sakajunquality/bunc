import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorLinuxSandbox, recoverLinuxSandbox } from "../src/sandbox/linux.ts";
import { SANDBOX_SECCOMP_REVISION, sandboxAllowedSyscalls } from "../src/sandbox/seccomp.ts";

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
