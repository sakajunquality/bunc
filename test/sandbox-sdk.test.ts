import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRunner } from "../src/sandbox/sdk.ts";

const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });
async function directory() { const path = await mkdtemp(join(tmpdir(), "bunc-sdk-")); temporary.push(path); return path; }
const runnerOptions = (root: string, script: string) => ({ binary: process.execPath, binaryArgs: [script], environment: "/trusted/environment.json", policy: "/trusted/policy.json", resultsRoot: join(root, "results"), stateRoot: "/run/bunc", cgroupParent: "/sys/fs/cgroup/bunc" });
const failureResultScript = (exitCode: number) => `
  import { basename } from "node:path";
  const value = (name) => Bun.argv[Bun.argv.indexOf(name) + 1];
  const runId = basename(value("--result-dir"));
  console.log(JSON.stringify({
    schemaVersion: 1, runId, outcome: "failed", phase: "executing", exitCode: 1, signal: null,
    reason: { code: "PROGRAM_EXIT", message: "Program exited with status 1" }, limitsHit: [],
    stdout: { file: "stdout.bin", bytes: 0, truncated: false, sha256: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
    stderr: { file: "stderr.bin", bytes: 0, truncated: false, sha256: "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
    artifacts: [], artifactsComplete: true, cleanup: "complete", finalizationErrors: [],
    environmentDigest: null, policyDigest: null, codeDigest: null, inputsDigest: null, effectiveLimits: null,
    metrics: { prepareMs: 0, executeMs: 1, finalizeMs: 0, cpuUsageUsec: null, memoryPeakBytes: null }
  }));
  process.exit(${exitCode});
`;

test("returns a structured job failure even when the CLI exits nonzero", async () => {
  const root = await directory(), script = join(root, "fake-cli.ts");
  await writeFile(script, failureResultScript(1));
  const runner = createRunner(runnerOptions(root, script));
  const result = await runner.run({ schemaVersion: 1, code: "throw new Error()" });
  expect(result.outcome).toBe("failed");
  expect(result.reason?.code).toBe("PROGRAM_EXIT");
  expect(result.resultDirectory.startsWith(join(root, "results"))).toBe(true);
});

test("validates requests before starting a subprocess", async () => {
  const root = await directory();
  const runner = createRunner({ binary: "/definitely/missing", environment: "/e", policy: "/p", resultsRoot: root, stateRoot: "/s", cgroupParent: "/c" });
  await expect(runner.run({ schemaVersion: 1, code: "", limits: { timeoutMs: 0 } } as never)).rejects.toThrow("positive safe integer");
});

test("does not launch an already-aborted request", async () => {
  const root = await directory(), controller = new AbortController(); controller.abort("stop");
  const runner = createRunner({ binary: "/definitely/missing", environment: "/e", policy: "/p", resultsRoot: join(root, "results"), stateRoot: "/s", cgroupParent: "/c" });
  await expect(runner.run({ schemaVersion: 1, code: "" }, { signal: controller.signal })).rejects.toMatchObject({ code: "SUPERVISOR_INTERRUPTED" });
  expect(await Bun.file(join(root, "results")).exists()).toBe(false);
});

test("rejects a structured result whose process exit status disagrees", async () => {
  const root = await directory(), script = join(root, "fake-cli.ts"); await writeFile(script, failureResultScript(0));
  await expect(createRunner(runnerOptions(root, script)).run({ schemaVersion: 1, code: "" })).rejects.toMatchObject({ code: "INVALID_RESULT" });
});

test("bounds invalid CLI output and reaps the subprocess", async () => {
  const root = await directory(), script = join(root, "flood.ts");
  await writeFile(script, `process.stdout.write("x".repeat(1024 * 1024 + 1)); setInterval(() => {}, 1000);`);
  await expect(createRunner(runnerOptions(root, script)).run({ schemaVersion: 1, code: "" })).rejects.toMatchObject({ code: "INVALID_RESULT" });
});
