import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireStateRoot, createJobJournal, currentProcessIdentity, inspectState, parseJobJournal, preparedEnvironmentReferences, processIdentityMatches, recoverAbandonedJobs, StateBusyError } from "../src/sandbox/state.ts";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function temporary() { const path = await mkdtemp(join(tmpdir(), "bunc-state-test-")); directories.push(path); return path; }
const environmentKey = "a".repeat(64);

test("holds an exclusive reusable state-root lease and does not inherit its lock descriptor", async () => {
  const parent = await temporary(), root = join(parent, "state");
  const first = await acquireStateRoot(root);
  await expect(acquireStateRoot(root)).rejects.toBeInstanceOf(StateBusyError);
  const child = Bun.spawn([process.execPath, "-e", `const fs=require('fs'),p=process.platform==='linux'?'/proc/self/fd':'/dev/fd';for(const n of fs.readdirSync(p)){try{if(fs.readlinkSync(p+'/'+n).endsWith('/.lock'))process.exit(9)}catch{}}`]);
  expect(await child.exited).toBe(0);
  await first.release();
  const second = await acquireStateRoot(root);
  expect(second.owner).toEqual(currentProcessIdentity());
  await second.release();
});

test("rejects symlink and broadly accessible state roots", async () => {
  const parent = await temporary(), target = join(parent, "target"), link = join(parent, "link");
  await mkdir(target, { mode: 0o700 }); await symlink(target, link);
  await expect(acquireStateRoot(link)).rejects.toThrow("real directory");
  const open = join(parent, "open"); await mkdir(open, { mode: 0o755 });
  await expect(acquireStateRoot(open)).rejects.toThrow("permissions");
});

test("journals acquisitions atomically and requires release before completion", async () => {
  const parent = await temporary(), lease = await acquireStateRoot(join(parent, "state"));
  const journal = await createJobJournal(lease, "550e8400-e29b-41d4-a716-446655440000", environmentKey);
  const cgroup = { kind: "cgroup" as const, path: "/sys/fs/cgroup/bunc-jobs/bunc-550e8400-e29b-41d4-a716-446655440000", ownerToken: "b".repeat(32) };
  await journal.record(cgroup);
  expect(await preparedEnvironmentReferences(lease)).toEqual(new Set([environmentKey]));
  await expect(journal.finish()).rejects.toThrow("acquired resources");
  expect(parseJobJournal(JSON.parse(await readFile(join(journal.path, "journal.json"), "utf8"))).resources).toEqual([cgroup]);
  await journal.release(cgroup); await journal.finish();
  expect(await preparedEnvironmentReferences(lease)).toEqual(new Set());
  expect((await inspectState(lease.root)).jobs[0]?.status).toBe("complete");
  await lease.release();
});

test("rejects unknown journal fields and unsafe resource paths", () => {
  const now = new Date().toISOString(), owner = currentProcessIdentity();
  expect(() => parseJobJournal({ schemaVersion: 1, runId: "job", owner, environmentKey, status: "active", resources: [], createdAt: now, updatedAt: now, recoveryErrors: [], surprise: true })).toThrow("unknown field");
  expect(() => parseJobJournal({ schemaVersion: 1, runId: "job", owner, environmentKey, status: "active", resources: [{ kind: "cgroup", path: "relative", ownerToken: "b".repeat(32) }], createdAt: now, updatedAt: now, recoveryErrors: [] })).toThrow("resource");
});

test("recovery uses process identity and preserves cleanup failures", async () => {
  const parent = await temporary(), lease = await acquireStateRoot(join(parent, "state"));
  const journal = await createJobJournal(lease, "abandoned", environmentKey);
  const cgroup = { kind: "cgroup" as const, path: "/sys/fs/cgroup/bunc-jobs/bunc-abandoned", ownerToken: "c".repeat(32) };
  const mount = { kind: "mount" as const, path: "/run/bunc/abandoned", ownerToken: "d".repeat(32) };
  await journal.record(cgroup); await journal.record(mount);
  const path = join(journal.path, "journal.json"), value = JSON.parse(await readFile(path, "utf8"));
  value.owner.startTime = `${value.owner.startTime}-reused`;
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  expect(processIdentityMatches(value.owner)).toBe(false);
  const order: string[] = [];
  const failed = await recoverAbandonedJobs(lease, {
    async cleanupCgroup(resource) { order.push(resource.kind); },
    async cleanupMount(resource) { order.push(resource.kind); throw new Error("still mounted"); },
  });
  expect(order).toEqual(["mount", "cgroup"]);
  expect(failed).toEqual([{ runId: "abandoned", status: "quarantined", errors: ["mount: still mounted"] }]);
  expect(parseJobJournal(JSON.parse(await readFile(path, "utf8"))).resources).toHaveLength(2);
  await lease.release();
});

test("recovery leaves a journal owned by the same process identity active", async () => {
  const parent = await temporary(), lease = await acquireStateRoot(join(parent, "state"));
  await createJobJournal(lease, "active", environmentKey);
  let called = false;
  expect(await recoverAbandonedJobs(lease, { async cleanupCgroup() { called = true; } })).toEqual([{ runId: "active", status: "active", errors: [] }]);
  expect(called).toBe(false);
  await lease.release();
});
