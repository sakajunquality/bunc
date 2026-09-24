import { resolve, join } from "node:path";
import { createRunner } from "../../src/sandbox/sdk.ts";
import { validateRequest } from "../../src/sandbox/contract.ts";

const [environment, policy, stateRoot, resultsRoot, cgroupParent = "/sys/fs/cgroup/bunc-jobs"] = Bun.argv.slice(2);
if (!environment || !policy || !stateRoot || !resultsRoot) {
  throw new Error("Usage: bun examples/execute/run.ts ENVIRONMENT POLICY STATE_ROOT RESULTS_ROOT [CGROUP_PARENT]; disposable Linux host only");
}
const runner = createRunner({
  binary: process.execPath,
  binaryArgs: [resolve(import.meta.dir, "../../dist/bunc.js")],
  environment: resolve(environment), policy: resolve(policy),
  stateRoot: resolve(stateRoot), resultsRoot: resolve(resultsRoot), cgroupParent: resolve(cgroupParent),
});
const attempt = await runner.run({ schemaVersion: 1, code: "throw new Error('The first generated program needs revision');" });
console.log({ attempt: attempt.outcome, diagnostics: join(attempt.resultDirectory, attempt.stderr.file) });
if (attempt.outcome !== "failed") throw new Error(`Unexpected first-attempt outcome: ${attempt.outcome}`);
const request = validateRequest(await Bun.file(join(import.meta.dir, "request.json")).json());
const corrected = await runner.run(request);
console.log({ outcome: corrected.outcome, resultDirectory: corrected.resultDirectory, artifacts: corrected.artifacts });
if (corrected.outcome !== "succeeded" || !corrected.artifactsComplete || corrected.cleanup !== "complete") process.exitCode = 1;
