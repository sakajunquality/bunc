import { randomBytes, randomUUID, createHash } from "node:crypto";
import { open, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { join } from "node:path";
import { createEmptyJobResult, readRequest, SandboxError, type JobResult, type Outcome, type ReasonCode } from "./contract.ts";
import { DEFAULT_SANDBOX_POLICY, resolveLimits, validatePolicy, type EffectiveLimits } from "./policy.ts";
import { parseEnvironmentDescriptor, openPreparedEnvironment } from "./environment.ts";
import { acquireStateRoot, createJobJournal, StateBusyError, type StateRootLease, type JobJournal, type OwnedResource } from "./state.ts";
import { spawnLinuxSandbox, recoverLinuxSandbox, type LinuxSandboxProcess } from "./linux.ts";
import { stageJobFiles, collectArtifacts } from "./files.ts";
import { captureOutput } from "./streams.ts";
import { readOperatorJSON } from "./operator.ts";
import { reserveResultDirectory, releaseResultReservation, resultReservation } from "./results.ts";

export interface RunJobOptions {
  environment: string;
  policy?: string;
  request: string;
  resultDir: string;
  stateRoot: string;
  cgroupParent: string;
}

function hash(value: unknown) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function message(error: unknown) { return (error instanceof Error ? error.message : String(error)).slice(0, 2000); }

/** Called only after the CLI has replaced itself in a private mount namespace. */
export async function runJob(options: RunJobOptions): Promise<JobResult> {
  if (await readlink("/proc/self/ns/mnt") === await readlink("/proc/1/ns/mnt")) throw new Error("Refusing to mount sandbox resources in init's mount namespace");
  // Reserve the v1 maximum before admission, so even rejection receipts have a
  // bounded destination. Operator policy may only reduce this fixed profile.
  await reserveResultDirectory(options.resultDir, {
    reservedBytes: resultReservation(resolveLimits({ schemaVersion: 1, code: "" }, DEFAULT_SANDBOX_POLICY)),
  });
  const result = createEmptyJobResult(randomUUID());
  const started = performance.now();
  let limits: EffectiveLimits | undefined, lease: StateRootLease | undefined, journal: JobJournal | undefined;
  let processHandle: LinuxSandboxProcess | undefined;
  let resource: Extract<OwnedResource, { kind: "cgroup" }> | undefined;
  let output: ReturnType<typeof captureOutput> | undefined;
  let executionStarted: number | undefined, terminal = false, cancelled = false;
  let deadline: ReturnType<typeof setTimeout> | undefined, setupDeadline: ReturnType<typeof setTimeout> | undefined;
  const streamController = new AbortController();
  const decide = (outcome: Outcome, code: ReasonCode | null, text: string) => {
    if (terminal) return;
    terminal = true; result.outcome = outcome;
    result.reason = code ? { code, message: text } : null;
  };
  const stop = () => { if (processHandle) void processHandle.stop().catch(() => {}); };
  const cancel = () => {
    cancelled = true;
    decide("cancelled", "CANCELLED", "The trusted caller cancelled this job");
    stop();
  };
  const checkCancelled = () => { if (cancelled) throw new SandboxError("CANCELLED", "Job cancelled before execution"); };
  process.on("SIGTERM", cancel); process.on("SIGINT", cancel);
  try {
    const policy = options.policy ? validatePolicy(await readOperatorJSON(options.policy)) : DEFAULT_SANDBOX_POLICY;
    const request = await readRequest(options.request, policy.fixed.requestBytes);
    limits = resolveLimits(request, policy); result.effectiveLimits = limits; result.policyDigest = hash(policy);
    const descriptor = parseEnvironmentDescriptor(await readOperatorJSON(options.environment));
    if (descriptor.policyRevision !== policy.revision) throw new SandboxError("POLICY_DENIED", "Environment and operator policy revisions differ");
    checkCancelled();
    lease = await acquireStateRoot(options.stateRoot);
    let environment;
    try { environment = await openPreparedEnvironment(options.stateRoot, descriptor); }
    catch (error) { throw new SandboxError("ENVIRONMENT_NOT_PREPARED", message(error)); }
    result.environmentDigest = environment.descriptorDigest;
    journal = await createJobJournal(lease, result.runId, environment.key);
    result.phase = "preparing";
    checkCancelled();
    const staged = await stageJobFiles(join(journal.path, "staged"), request, limits, { uid: environment.uid, gid: environment.gid });
    result.codeDigest = staged.codeDigest; result.inputsDigest = staged.inputsDigest;
    const cgroupParent = await realpath(options.cgroupParent);
    resource = { kind: "cgroup", path: join(cgroupParent, `bunc-${result.runId}`), ownerToken: randomBytes(16).toString("hex") };
    // Journal intended ownership before acquiring any kernel resource.
    await journal.record(resource);
    checkCancelled();
    processHandle = await spawnLinuxSandbox({
      stateDir: journal.path, runId: result.runId, ownerToken: resource.ownerToken,
      rootfs: environment.rootfs, codeDir: staged.codeDir, inputDir: staged.inputDir,
      scratchDir: join(journal.path, "scratch"), cgroupParent,
      packageDir: environment.packageHostPath ?? undefined,
      executable: environment.interpreter, argv: [environment.interpreter, ...environment.runtimeFlags, "/code/main.ts"],
      env: ["PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/home/sandbox", "TMPDIR=/tmp", "LANG=C.UTF-8", "TZ=UTC"],
      cwd: environment.workingDirectory, uid: environment.uid, gid: environment.gid, hostname: "bunc-job", nofile: limits.nofile,
      hardDeadlineMs: limits.setupTimeoutMs + limits.timeoutMs + limits.finalizationTimeoutMs,
      limits: { memoryBytes: limits.memoryBytes, scratchBytes: limits.scratchBytes, scratchInodes: limits.scratchInodes,
        pidsMax: limits.pidsMax, cpuQuotaMicros: limits.cpuQuotaMicros, cpuPeriodMicros: limits.cpuPeriodMicros },
    });
    output = captureOutput(processHandle.stdout, processHandle.stderr, options.resultDir, limits.stdioBytes, {
      onLimit: () => { result.limitsHit.push("stdioBytes"); decide("resource_exhausted", "STDIO_LIMIT", "Combined stdout/stderr exceeded the byte budget"); stop(); },
      signal: streamController.signal, shutdownMs: limits.finalizationTimeoutMs,
    });
    // Attach an observer immediately: capture failure must stop the job rather
    // than become an unhandled rejection while the process keeps writing.
    void output.catch(error => { decide("runtime_failed", "SUPERVISOR_INTERRUPTED", `Output capture failed: ${message(error)}`); stop(); });
    setupDeadline = setTimeout(() => { decide("setup_failed", "SETUP_TIMEOUT", "Sandbox setup exceeded its deadline"); stop(); }, limits.setupTimeoutMs);
    if (cancelled) stop();
    await processHandle.setup;
    clearTimeout(setupDeadline); setupDeadline = undefined;
    result.metrics.prepareMs = Math.round(performance.now() - started);
    if (!terminal) result.phase = "executing";
    executionStarted = performance.now();
    deadline = setTimeout(() => { decide("timed_out", "DEADLINE", "Execution exceeded its wall-clock budget"); stop(); }, limits.timeoutMs);
    if (terminal) stop();
    const exited = await processHandle.wait();
    clearTimeout(deadline); deadline = undefined;
    result.metrics.executeMs = Math.round(performance.now() - executionStarted);
    result.exitCode = exited.exitCode;
    result.signal = exited.signal === null ? null : Object.entries(osConstants.signals).find(([, value]) => value === exited.signal)?.[0] ?? `SIG${exited.signal}`;
    await processHandle.stop("main_exit");
    // A short-lived program can exit before its last pipe chunk is consumed.
    // Observe overflow before deciding that a zero exit status was successful.
    const drainDeadline = setTimeout(() => streamController.abort(), limits.finalizationTimeoutMs);
    try { const streams = await output; result.stdout = streams.stdout; result.stderr = streams.stderr; }
    finally { clearTimeout(drainDeadline); }
    const metrics = processHandle.snapshotMetrics();
    result.metrics.cpuUsageUsec = metrics.cpuUsageUsec; result.metrics.memoryPeakBytes = metrics.memoryPeakBytes;
    if ((metrics.pidsDenied ?? 0) > 0) result.limitsHit.push("pidsMax");
    if ((metrics.oomKills ?? 0) > 0) {
      result.limitsHit.push("memoryBytes"); decide("resource_exhausted", "OOM_KILL", "The job cgroup recorded an OOM kill");
    }
    if (!terminal) {
      if (exited.deadline) decide("timed_out", "DEADLINE", "The native guardian enforced the hard deadline");
      else if (exited.exitCode === 0) decide("succeeded", null, "");
      else decide("failed", exited.signal ? "PROGRAM_SIGNAL" : "PROGRAM_EXIT", exited.signal ? `Program terminated by ${exited.signal}` : `Program exited with code ${exited.exitCode}`);
    }
  } catch (error) {
    if (error instanceof StateBusyError) decide("rejected", "BUSY", "Another job or preparation holds the state root");
    else if (error instanceof SandboxError) {
      const rejected = ["INVALID_REQUEST", "POLICY_DENIED", "ENVIRONMENT_NOT_PREPARED"].includes(error.code);
      decide(error.code === "CANCELLED" ? "cancelled" : rejected ? "rejected" : "setup_failed", error.code, message(error));
    } else decide(executionStarted === undefined ? "setup_failed" : "runtime_failed", executionStarted === undefined ? "EXEC_FAILED" : "SUPERVISOR_INTERRUPTED", message(error));
  } finally {
    if (deadline) clearTimeout(deadline); if (setupDeadline) clearTimeout(setupDeadline);
    if (executionStarted === undefined) result.metrics.prepareMs = Math.round(performance.now() - started);
    const finalizationStarted = performance.now();
    let stopped = processHandle === undefined;
    if (processHandle) {
      try { await processHandle.stop(); stopped = true; }
      catch (error) { result.finalizationErrors.push({ code: "CLEANUP_INCOMPLETE", message: message(error) }); }
    }
    if (output) {
      const abort = setTimeout(() => streamController.abort(), limits?.finalizationTimeoutMs ?? 5000);
      try {
        const streams = await output; result.stdout = streams.stdout; result.stderr = streams.stderr;
      } catch (error) {
        result.finalizationErrors.push({ code: "CLEANUP_INCOMPLETE", message: `Output capture: ${message(error)}` });
        // Capture has stopped and closed its handles. Describe the actual
        // retained prefix, never label a partial file with the empty digest.
        for (const stream of [result.stdout, result.stderr]) {
          stream.truncated = true;
          try {
            const handle = await open(join(options.resultDir, stream.file), "r");
            try {
              const info = await handle.stat();
              if (!info.isFile() || info.size > (limits?.stdioBytes ?? 0)) throw new Error("Invalid retained stream after capture failure");
              const bytes = await handle.readFile();
              stream.bytes = bytes.length; stream.sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
            } finally { await handle.close(); }
          } catch (inspectionError) {
            if ((inspectionError as NodeJS.ErrnoException).code !== "ENOENT") result.finalizationErrors.push({ code: "CLEANUP_INCOMPLETE", message: `Stream metadata: ${message(inspectionError)}` });
          }
        }
      }
      finally { clearTimeout(abort); }
    }
    if (processHandle && stopped && limits && executionStarted !== undefined) {
      try {
        result.artifacts = await collectArtifacts(join(processHandle.scratchDir, "output"), options.resultDir, limits, { signal: AbortSignal.timeout(limits.finalizationTimeoutMs) });
        result.artifactsComplete = true;
      } catch (error) {
        result.artifacts = []; result.artifactsComplete = false;
        result.finalizationErrors.push({ code: error instanceof SandboxError ? error.code : "ARTIFACT_INVALID", message: message(error) });
      }
    } else result.artifactsComplete = true;
    let cleaned = true;
    if (processHandle) {
      try {
        const cleanup = await processHandle.cleanup(); cleaned = cleanup.complete;
        for (const error of cleanup.errors) result.finalizationErrors.push({ code: "CLEANUP_INCOMPLETE", message: error });
      } catch (error) { cleaned = false; result.finalizationErrors.push({ code: "CLEANUP_INCOMPLETE", message: message(error) }); }
    } else if (resource) {
      try {
        const recovery = await recoverLinuxSandbox({ cgroupParent: options.cgroupParent, runId: result.runId });
        if (!recovery.complete) throw new Error(recovery.errors.join("; "));
      }
      catch (error) { cleaned = false; result.finalizationErrors.push({ code: "CLEANUP_INCOMPLETE", message: message(error) }); }
    }
    if (journal && cleaned) {
      try {
        if (resource) await journal.release(resource);
        await journal.finish(); await rm(journal.path, { recursive: true });
      } catch (error) { cleaned = false; result.finalizationErrors.push({ code: "CLEANUP_INCOMPLETE", message: message(error) }); }
    }
    result.cleanup = !cleaned ? "incomplete" : journal ? "complete" : "not_needed";
    if (lease) await lease.release();
    process.off("SIGTERM", cancel); process.off("SIGINT", cancel);
    for (const stream of [result.stdout, result.stderr]) {
      try { await writeFile(join(options.resultDir, stream.file), "", { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    result.limitsHit = [...new Set(result.limitsHit)];
    result.metrics.finalizeMs = Math.round(performance.now() - finalizationStarted);
    const temporary = join(options.resultDir, ".result.json.tmp");
    const receipt = await open(temporary, "wx", 0o600);
    try { await receipt.writeFile(JSON.stringify(result, null, 2) + "\n"); await receipt.sync(); }
    finally { await receipt.close(); }
    await rename(temporary, join(options.resultDir, "result.json"));
    const resultDirectory = await open(options.resultDir, "r");
    try { await resultDirectory.sync(); } finally { await resultDirectory.close(); }
    await releaseResultReservation(options.resultDir);
  }
  return result;
}
