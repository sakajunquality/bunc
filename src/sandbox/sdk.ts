import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { SandboxError, validateJobResult, validateRequest, type JobRequest, type JobResult } from "./contract.ts";

export interface RunnerOptions {
  binary: string;
  binaryArgs?: readonly string[];
  environment: string;
  policy: string;
  resultsRoot: string;
  stateRoot: string;
  cgroupParent: string;
  cancellationGraceMs?: number;
}
export interface RunOptions { signal?: AbortSignal }
export type RunnerResult = JobResult & { resultDirectory: string };
export interface Runner { run(request: JobRequest, options?: RunOptions): Promise<RunnerResult> }

export class SandboxInfrastructureError extends Error {
  readonly code: "SPAWN_FAILED" | "INVALID_RESULT" | "SUPERVISOR_INTERRUPTED";
  readonly diagnostic?: string;
  constructor(code: SandboxInfrastructureError["code"], message: string, options?: ErrorOptions & { diagnostic?: string }) {
    super(message, options);
    this.name = "SandboxInfrastructureError";
    this.code = code;
    this.diagnostic = options?.diagnostic;
  }
}

function validateOptions(options: RunnerOptions): Readonly<RunnerOptions> {
  if (typeof options.binary !== "string" || !options.binary || options.binary.includes("\0")) throw new TypeError("binary is required");
  for (const [name, value] of Object.entries({ environment: options.environment, policy: options.policy, resultsRoot: options.resultsRoot, stateRoot: options.stateRoot, cgroupParent: options.cgroupParent })) {
    if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) throw new TypeError(`${name} must be an absolute path`);
  }
  if (options.binaryArgs?.some(value => typeof value !== "string" || value.includes("\0"))) throw new TypeError("binaryArgs contains an invalid argument");
  const cancellationGraceMs = options.cancellationGraceMs ?? 6_000;
  if (!Number.isSafeInteger(cancellationGraceMs) || cancellationGraceMs <= 0) throw new TypeError("cancellationGraceMs must be a positive safe integer");
  return Object.freeze({ ...options, binaryArgs: Object.freeze([...(options.binaryArgs ?? [])]), cancellationGraceMs });
}

async function readBounded(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) return Buffer.concat(chunks, total);
      total += item.value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new SandboxInfrastructureError("INVALID_RESULT", "Sandbox CLI output exceeded its transport limit"); }
      chunks.push(Buffer.from(item.value));
    }
  } finally { reader.releaseLock(); }
}

/** Create a local subprocess runner. It never invokes a shell or retries a job. */
export function createRunner(input: RunnerOptions): Runner {
  const options = validateOptions(input);
  return Object.freeze({
    async run(requestValue: JobRequest, runOptions: RunOptions = {}): Promise<RunnerResult> {
      let request: JobRequest;
      try { request = validateRequest(requestValue); }
      catch (error) { if (error instanceof SandboxError) throw error; throw new SandboxInfrastructureError("INVALID_RESULT", "Cannot validate job request", { cause: error }); }
      if (runOptions.signal?.aborted) throw new SandboxInfrastructureError("SUPERVISOR_INTERRUPTED", "The sandbox request was already cancelled", { cause: runOptions.signal.reason });
      await mkdir(options.resultsRoot, { recursive: true, mode: 0o700 });
      const id = randomUUID(), requestPath = join(options.resultsRoot, `.request-${id}.json`), resultDir = join(options.resultsRoot, id);
      const requestFile = await open(requestPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await requestFile.writeFile(JSON.stringify(request)); await requestFile.sync(); }
      finally { await requestFile.close(); }
      let processHandle: ReturnType<typeof Bun.spawn>;
      try {
        processHandle = Bun.spawn([
          options.binary, ...(options.binaryArgs ?? []), "sandbox", "run", "--experimental-sandbox",
          "--environment", options.environment, "--policy", options.policy, "--request", requestPath,
          "--result-dir", resultDir, "--state-root", options.stateRoot, "--cgroup-parent", options.cgroupParent,
        ], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      } catch (error) {
        await rm(requestPath, { force: true });
        throw new SandboxInfrastructureError("SPAWN_FAILED", "Cannot start the bunc sandbox process", { cause: error });
      }
      let forced = false;
      let settled = false;
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        try { processHandle.kill("SIGTERM"); } catch { /* Process may already have exited. */ }
        forceTimer ??= setTimeout(() => {
          if (!settled) { forced = true; try { processHandle.kill("SIGKILL"); } catch { /* Process may have exited. */ } }
        }, options.cancellationGraceMs);
      };
      runOptions.signal?.addEventListener("abort", abort, { once: true });
      if (runOptions.signal?.aborted) abort();
      try {
        const stdoutPipe = processHandle.stdout;
        const stderrPipe = processHandle.stderr;
        if (!(stdoutPipe instanceof ReadableStream) || !(stderrPipe instanceof ReadableStream)) throw new SandboxInfrastructureError("SPAWN_FAILED", "Sandbox CLI pipes were not created");
        const exited = processHandle.exited.then(code => { settled = true; return code; });
        const [stdout, stderr, exitCode] = await Promise.all([
          readBounded(stdoutPipe, 1024 * 1024),
          readBounded(stderrPipe, 64 * 1024),
          exited,
        ]);
        if (forced) throw new SandboxInfrastructureError("SUPERVISOR_INTERRUPTED", "The sandbox supervisor did not finish cancellation before forced termination", { diagnostic: stderr.toString("utf8") });
        let value: unknown;
        try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stdout)); }
        catch (error) { throw new SandboxInfrastructureError("INVALID_RESULT", `Sandbox CLI returned no valid result (exit ${exitCode})`, { cause: error, diagnostic: stderr.toString("utf8") }); }
        try {
          const result = validateJobResult(value);
          const clean = result.cleanup !== "incomplete" && result.artifactsComplete && result.finalizationErrors.length === 0;
          const expectedExit = clean && result.outcome === "succeeded" ? 0 : clean && ["failed", "timed_out", "cancelled", "resource_exhausted"].includes(result.outcome) ? 1 : 2;
          if (exitCode !== expectedExit) throw new Error(`CLI exit ${exitCode} does not match result status ${expectedExit}`);
          return { ...result, resultDirectory: resultDir };
        }
        catch (error) { throw new SandboxInfrastructureError("INVALID_RESULT", `Sandbox CLI returned an invalid result (exit ${exitCode})`, { cause: error, diagnostic: stderr.toString("utf8") }); }
      } catch (error) {
        if (!settled) {
          try { processHandle.kill("SIGKILL"); } catch { /* Process may already have exited. */ }
          await processHandle.exited.catch(() => {});
          settled = true;
        }
        throw error;
      } finally {
        if (forceTimer) clearTimeout(forceTimer);
        runOptions.signal?.removeEventListener("abort", abort);
        await rm(requestPath, { force: true });
      }
    },
  });
}
