import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { EffectiveLimits } from "./policy.ts";

export const REQUEST_SCHEMA_VERSION = 1 as const;
export const RESULT_SCHEMA_VERSION = 1 as const;
export const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
export const MAX_SOURCE_BYTES = 1024 * 1024;
export const MAX_INPUT_BYTES = 8 * 1024 * 1024;
export const MAX_INPUT_FILES = 128;
export const MAX_PATH_DEPTH = 8;
export const MAX_PATH_BYTES = 240;

export type ReasonCode =
  | "INVALID_REQUEST" | "POLICY_DENIED" | "BUSY"
  | "ENVIRONMENT_NOT_PREPARED" | "UNSUPPORTED_HOST" | "SETUP_TIMEOUT"
  | "EXEC_FAILED" | "PROGRAM_EXIT" | "PROGRAM_SIGNAL" | "DEADLINE"
  | "CANCELLED" | "OOM_KILL" | "STDIO_LIMIT" | "ARTIFACT_INVALID"
  | "ARTIFACT_LIMIT" | "COLLECTION_TIMEOUT" | "CLEANUP_INCOMPLETE"
  | "SUPERVISOR_INTERRUPTED";

export class SandboxError extends Error {
  readonly code: ReasonCode;
  constructor(code: ReasonCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SandboxError";
    this.code = code;
  }
}

export interface JobLimits {
  timeoutMs?: number;
  memoryMiB?: number;
  stdioBytes?: number;
}

export interface InputFile {
  path: string;
  encoding: "utf8" | "base64";
  data: string;
}

export interface JobRequest {
  schemaVersion: 1;
  code: string;
  inputs?: InputFile[];
  limits?: JobLimits;
}

export type Outcome = "succeeded" | "failed" | "timed_out" | "cancelled" | "resource_exhausted" | "rejected" | "setup_failed" | "runtime_failed";
export type JobPhase = "admission" | "preparing" | "executing" | "finalizing";
export type CleanupStatus = "complete" | "incomplete" | "not_needed";

export interface FailureReason { code: ReasonCode; message: string }
export interface StreamResult { file: string; bytes: number; truncated: boolean; sha256: string }
export interface Artifact { path: string; file: string; bytes: number; sha256: string }
export interface JobMetrics {
  prepareMs: number;
  executeMs: number;
  finalizeMs: number;
  cpuUsageUsec: number | null;
  memoryPeakBytes: number | null;
}

export interface JobResult {
  schemaVersion: 1;
  runId: string;
  outcome: Outcome;
  phase: JobPhase;
  exitCode: number | null;
  signal: string | null;
  reason: FailureReason | null;
  limitsHit: string[];
  stdout: StreamResult;
  stderr: StreamResult;
  artifacts: Artifact[];
  artifactsComplete: boolean;
  cleanup: CleanupStatus;
  finalizationErrors: FailureReason[];
  environmentDigest: string | null;
  policyDigest: string | null;
  codeDigest: string | null;
  inputsDigest: string | null;
  effectiveLimits: EffectiveLimits | null;
  metrics: JobMetrics;
}

const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);
const componentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const outcomes = new Set<Outcome>(["succeeded", "failed", "timed_out", "cancelled", "resource_exhausted", "rejected", "setup_failed", "runtime_failed"]);
const phases = new Set<JobPhase>(["admission", "preparing", "executing", "finalizing"]);
const cleanupStatuses = new Set<CleanupStatus>(["complete", "incomplete", "not_needed"]);
export const reasonCodes = new Set<ReasonCode>(["INVALID_REQUEST", "POLICY_DENIED", "BUSY", "ENVIRONMENT_NOT_PREPARED", "UNSUPPORTED_HOST", "SETUP_TIMEOUT", "EXEC_FAILED", "PROGRAM_EXIT", "PROGRAM_SIGNAL", "DEADLINE", "CANCELLED", "OOM_KILL", "STDIO_LIMIT", "ARTIFACT_INVALID", "ARTIFACT_LIMIT", "COLLECTION_TIMEOUT", "CLEANUP_INCOMPLETE", "SUPERVISOR_INTERRUPTED"]);

function fail(message: string): never { throw new SandboxError("INVALID_REQUEST", message); }
function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const object = value as Record<string, unknown>;
  for (const key of Object.keys(object)) if (forbiddenKeys.has(key)) fail(`${label} contains a forbidden key`);
  return object;
}
function keys(object: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(object)) if (!allowed.includes(key)) fail(`unknown ${label} field: ${key}`);
}
function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) fail(`${label} must be a positive safe integer`);
  return value as number;
}
function wellFormed(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.isWellFormed()) fail(`${label} must be well-formed Unicode text`);
  return value;
}

export function validateRelativePath(value: unknown, label = "path", limits = { depth: MAX_PATH_DEPTH, bytes: MAX_PATH_BYTES }): string {
  const path = wellFormed(value, label);
  if (!path || path.startsWith("/") || path.endsWith("/") || path.includes("\\") || path.includes("\0")) fail(`${label} is not a safe relative POSIX path`);
  const parts = path.split("/");
  if (parts.length > limits.depth || Buffer.byteLength(path) > limits.bytes) fail(`${label} exceeds its path limit`);
  for (const part of parts) {
    if (part === "." || part === ".." || forbiddenKeys.has(part) || !componentPattern.test(part)) fail(`${label} contains an invalid component`);
  }
  return path;
}

export function decodeInput(input: InputFile): Buffer {
  if (input.encoding === "utf8") return Buffer.from(input.data);
  if (input.data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data)) fail(`input ${input.path} is not strict base64`);
  const decoded = Buffer.from(input.data, "base64");
  if (decoded.toString("base64") !== input.data) fail(`input ${input.path} is not canonical base64`);
  return decoded;
}

export function validateRequest(value: unknown): JobRequest {
  const object = record(value, "request");
  keys(object, ["schemaVersion", "code", "inputs", "limits"], "request");
  if (object.schemaVersion !== REQUEST_SCHEMA_VERSION) fail("unsupported request schemaVersion");
  const code = wellFormed(object.code, "code");
  if (Buffer.byteLength(code) > MAX_SOURCE_BYTES) fail("code exceeds 1 MiB");
  let inputs: InputFile[] | undefined;
  if (object.inputs !== undefined) {
    if (!Array.isArray(object.inputs) || object.inputs.length > MAX_INPUT_FILES) fail(`inputs must contain at most ${MAX_INPUT_FILES} files`);
    inputs = [];
    const paths = new Set<string>();
    let decodedBytes = 0;
    for (let index = 0; index < object.inputs.length; index++) {
      const entry = record(object.inputs[index], `inputs[${index}]`);
      keys(entry, ["path", "encoding", "data"], `inputs[${index}]`);
      const path = validateRelativePath(entry.path, `inputs[${index}].path`);
      if (paths.has(path)) fail(`duplicate input path: ${path}`);
      for (const existing of paths) if (existing.startsWith(path + "/") || path.startsWith(existing + "/")) fail(`input file/directory conflict: ${path}`);
      if (entry.encoding !== "utf8" && entry.encoding !== "base64") fail(`inputs[${index}].encoding must be utf8 or base64`);
      const data = wellFormed(entry.data, `inputs[${index}].data`);
      const input = { path, encoding: entry.encoding, data } as InputFile;
      decodedBytes += decodeInput(input).length;
      if (decodedBytes > MAX_INPUT_BYTES) fail("decoded inputs exceed 8 MiB");
      paths.add(path);
      inputs.push(input);
    }
  }
  let limits: JobLimits | undefined;
  if (object.limits !== undefined) {
    const source = record(object.limits, "limits");
    keys(source, ["timeoutMs", "memoryMiB", "stdioBytes"], "limits");
    limits = {};
    if (source.timeoutMs !== undefined) limits.timeoutMs = positiveInteger(source.timeoutMs, "limits.timeoutMs");
    if (source.memoryMiB !== undefined) limits.memoryMiB = positiveInteger(source.memoryMiB, "limits.memoryMiB");
    if (source.stdioBytes !== undefined) limits.stdioBytes = positiveInteger(source.stdioBytes, "limits.stdioBytes");
  }
  const request = Object.freeze({ schemaVersion: 1, code, ...(inputs === undefined ? {} : { inputs: Object.freeze(inputs.map(input => Object.freeze(input))) }), ...(limits === undefined ? {} : { limits: Object.freeze(limits) }) }) as JobRequest;
  if (Buffer.byteLength(JSON.stringify(request)) > MAX_REQUEST_BYTES) fail(`encoded request exceeds ${MAX_REQUEST_BYTES} bytes`);
  return request;
}

export async function readRequest(path: string, maxBytes = MAX_REQUEST_BYTES): Promise<JobRequest> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) fail("request byte limit must be a positive safe integer");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) fail("request must be a regular file");
    if (stat.size > maxBytes) fail(`encoded request exceeds ${maxBytes} bytes`);
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) fail(`encoded request exceeds ${maxBytes} bytes`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total))); }
    catch { fail("request is not valid JSON"); }
    return validateRequest(parsed);
  } finally { await handle.close(); }
}

function resultFail(message: string): never { throw new SandboxError("SUPERVISOR_INTERRUPTED", `Invalid sandbox result: ${message}`); }
function resultRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) resultFail(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function resultKeys(object: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(object)) if (forbiddenKeys.has(key) || !allowed.includes(key)) resultFail(`unknown ${label} field: ${key}`);
}
function nonnegative(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) resultFail(`${label} must be a nonnegative safe integer`);
  return value as number;
}
function validateReason(value: unknown, label: string): FailureReason {
  const object = resultRecord(value, label); resultKeys(object, ["code", "message"], label);
  if (!reasonCodes.has(object.code as ReasonCode) || typeof object.message !== "string" || !object.message.isWellFormed()) resultFail(`${label} is invalid`);
  return { code: object.code as ReasonCode, message: object.message };
}
function validateStream(value: unknown, label: string): StreamResult {
  const object = resultRecord(value, label); resultKeys(object, ["file", "bytes", "truncated", "sha256"], label);
  if (typeof object.file !== "string" || typeof object.truncated !== "boolean" || typeof object.sha256 !== "string" || !digestPattern.test(object.sha256)) resultFail(`${label} is invalid`);
  return { file: validateRelativeResultPath(object.file, `${label}.file`), bytes: nonnegative(object.bytes, `${label}.bytes`), truncated: object.truncated, sha256: object.sha256 };
}
function validateRelativeResultPath(value: string, label: string): string {
  if (!value || value.startsWith("/") || value.includes("\\") || value.includes("\0") || value.split("/").some(part => !part || part === "." || part === "..")) resultFail(`${label} is unsafe`);
  return value;
}

export function validateJobResult(value: unknown): JobResult {
  const object = resultRecord(value, "result");
  const fields = ["schemaVersion", "runId", "outcome", "phase", "exitCode", "signal", "reason", "limitsHit", "stdout", "stderr", "artifacts", "artifactsComplete", "cleanup", "finalizationErrors", "environmentDigest", "policyDigest", "codeDigest", "inputsDigest", "effectiveLimits", "metrics"];
  resultKeys(object, fields, "result");
  if (object.schemaVersion !== 1 || typeof object.runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(object.runId)) resultFail("schemaVersion or runId is invalid");
  if (!outcomes.has(object.outcome as Outcome) || !phases.has(object.phase as JobPhase)) resultFail("outcome or phase is invalid");
  if (object.exitCode !== null && (!Number.isInteger(object.exitCode) || (object.exitCode as number) < 0 || (object.exitCode as number) > 255)) resultFail("exitCode is invalid");
  if (object.signal !== null && typeof object.signal !== "string") resultFail("signal is invalid");
  if (!Array.isArray(object.limitsHit) || !object.limitsHit.every(item => typeof item === "string")) resultFail("limitsHit is invalid");
  if (!Array.isArray(object.artifacts) || !Array.isArray(object.finalizationErrors) || typeof object.artifactsComplete !== "boolean" || !cleanupStatuses.has(object.cleanup as CleanupStatus)) resultFail("finalization fields are invalid");
  const stdout = validateStream(object.stdout, "stdout"), stderr = validateStream(object.stderr, "stderr");
  if (stdout.file !== "stdout.bin" || stderr.file !== "stderr.bin") resultFail("stream filenames are invalid");
  const reason = object.reason === null ? null : validateReason(object.reason, "reason");
  if ((object.outcome === "succeeded") !== (reason === null)) resultFail("reason does not match outcome");
  const finalizationErrors = object.finalizationErrors.map((item, index) => validateReason(item, `finalizationErrors[${index}]`));
  const artifactPaths = new Set<string>();
  const artifacts = object.artifacts.map((item, index): Artifact => {
    const artifact = resultRecord(item, `artifacts[${index}]`); resultKeys(artifact, ["path", "file", "bytes", "sha256"], `artifacts[${index}]`);
    if (typeof artifact.path !== "string" || typeof artifact.file !== "string" || typeof artifact.sha256 !== "string" || !digestPattern.test(artifact.sha256)) resultFail(`artifacts[${index}] is invalid`);
    const path = validateRelativeResultPath(artifact.path, `artifacts[${index}].path`), file = validateRelativeResultPath(artifact.file, `artifacts[${index}].file`);
    if (artifactPaths.has(path) || file !== `artifacts/${path}`) resultFail(`artifacts[${index}] path mapping is invalid`);
    artifactPaths.add(path);
    return { path, file, bytes: nonnegative(artifact.bytes, `artifacts[${index}].bytes`), sha256: artifact.sha256 };
  });
  for (const field of ["environmentDigest", "policyDigest", "codeDigest", "inputsDigest"] as const) if (object[field] !== null && (typeof object[field] !== "string" || !digestPattern.test(object[field] as string))) resultFail(`${field} is invalid`);
  const metrics = resultRecord(object.metrics, "metrics"); resultKeys(metrics, ["prepareMs", "executeMs", "finalizeMs", "cpuUsageUsec", "memoryPeakBytes"], "metrics");
  for (const field of ["prepareMs", "executeMs", "finalizeMs"] as const) nonnegative(metrics[field], `metrics.${field}`);
  for (const field of ["cpuUsageUsec", "memoryPeakBytes"] as const) if (metrics[field] !== null) nonnegative(metrics[field], `metrics.${field}`);
  if (object.effectiveLimits !== null) {
    const effective = resultRecord(object.effectiveLimits, "effectiveLimits");
    resultKeys(effective, ["timeoutMs", "memoryBytes", "stdioBytes", "cpuPeriodMicros", "cpuQuotaMicros", "pidsMax", "scratchBytes", "scratchInodes", "artifactBytes", "artifactFiles", "artifactEntries", "artifactDirectories", "sourceBytes", "inputBytes", "inputFiles", "pathDepth", "pathBytes", "requestBytes", "nofile", "setupTimeoutMs", "finalizationTimeoutMs"], "effectiveLimits");
    if (Object.keys(effective).length !== 21) resultFail("effectiveLimits is incomplete");
    for (const item of Object.values(effective)) if (!Number.isSafeInteger(item) || (item as number) <= 0) resultFail("effectiveLimits is invalid");
  }
  return { ...object, stdout, stderr, reason, artifacts, finalizationErrors } as unknown as JobResult;
}

const emptyDigest = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
export function createEmptyJobResult(runId: string, effectiveLimits: EffectiveLimits | null = null): JobResult {
  return {
    schemaVersion: 1, runId, outcome: "setup_failed", phase: "admission", exitCode: null, signal: null,
    reason: null, limitsHit: [],
    stdout: { file: "stdout.bin", bytes: 0, truncated: false, sha256: emptyDigest },
    stderr: { file: "stderr.bin", bytes: 0, truncated: false, sha256: emptyDigest },
    artifacts: [], artifactsComplete: false, cleanup: "not_needed", finalizationErrors: [],
    environmentDigest: null, policyDigest: null, codeDigest: null, inputsDigest: null, effectiveLimits,
    metrics: { prepareMs: 0, executeMs: 0, finalizeMs: 0, cpuUsageUsec: null, memoryPeakBytes: null },
  };
}
