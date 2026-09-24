import { MAX_INPUT_BYTES, MAX_INPUT_FILES, MAX_PATH_BYTES, MAX_PATH_DEPTH, MAX_REQUEST_BYTES, MAX_SOURCE_BYTES, SandboxError, type JobLimits, type JobRequest } from "./contract.ts";

export interface FixedPolicyLimits {
  cpuPeriodMicros: number;
  cpuQuotaMicros: number;
  pidsMax: number;
  scratchBytes: number;
  scratchInodes: number;
  artifactBytes: number;
  artifactFiles: number;
  artifactEntries: number;
  artifactDirectories: number;
  sourceBytes: number;
  inputBytes: number;
  inputFiles: number;
  pathDepth: number;
  pathBytes: number;
  requestBytes: number;
  nofile: number;
  setupTimeoutMs: number;
  finalizationTimeoutMs: number;
}

export interface SandboxPolicy {
  schemaVersion: 1;
  revision: string;
  defaults: Required<JobLimits>;
  maximums: Required<JobLimits>;
  minimums: Required<JobLimits>;
  fixed: FixedPolicyLimits;
}

export interface EffectiveLimits extends FixedPolicyLimits {
  timeoutMs: number;
  memoryBytes: number;
  stdioBytes: number;
}

const MiB = 1024 * 1024;
export const DEFAULT_SANDBOX_POLICY: Readonly<SandboxPolicy> = deepFreeze({
  schemaVersion: 1,
  revision: "offline-v1",
  defaults: { timeoutMs: 5_000, memoryMiB: 256, stdioBytes: MiB },
  maximums: { timeoutMs: 30_000, memoryMiB: 512, stdioBytes: MiB },
  minimums: { timeoutMs: 1, memoryMiB: 128, stdioBytes: 1 },
  fixed: {
    cpuPeriodMicros: 100_000, cpuQuotaMicros: 100_000, pidsMax: 64,
    scratchBytes: 64 * MiB, scratchInodes: 4_096,
    artifactBytes: 16 * MiB, artifactFiles: 128, artifactEntries: 512, artifactDirectories: 128,
    sourceBytes: MAX_SOURCE_BYTES, inputBytes: MAX_INPUT_BYTES, inputFiles: MAX_INPUT_FILES,
    pathDepth: MAX_PATH_DEPTH, pathBytes: MAX_PATH_BYTES, requestBytes: MAX_REQUEST_BYTES,
    nofile: 256, setupTimeoutMs: 30_000, finalizationTimeoutMs: 5_000,
  },
});

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
function denied(message: string): never { throw new SandboxError("POLICY_DENIED", message); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) denied(`${label} must be an object`);
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) if (["__proto__", "prototype", "constructor"].includes(key)) denied(`${label} contains a forbidden key`);
  return result;
}
function known(value: Record<string, unknown>, names: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!names.includes(key)) denied(`unknown ${label} field: ${key}`);
}
function positive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) denied(`${label} must be a positive safe integer`);
  return value as number;
}
const requestedNames = ["timeoutMs", "memoryMiB", "stdioBytes"] as const;
const fixedNames = ["cpuPeriodMicros", "cpuQuotaMicros", "pidsMax", "scratchBytes", "scratchInodes", "artifactBytes", "artifactFiles", "artifactEntries", "artifactDirectories", "sourceBytes", "inputBytes", "inputFiles", "pathDepth", "pathBytes", "requestBytes", "nofile", "setupTimeoutMs", "finalizationTimeoutMs"] as const;

function limits(value: unknown, fallback: Required<JobLimits>, label: string): Required<JobLimits> {
  const source = object(value, label); known(source, requestedNames, label);
  return {
    timeoutMs: source.timeoutMs === undefined ? fallback.timeoutMs : positive(source.timeoutMs, `${label}.timeoutMs`),
    memoryMiB: source.memoryMiB === undefined ? fallback.memoryMiB : positive(source.memoryMiB, `${label}.memoryMiB`),
    stdioBytes: source.stdioBytes === undefined ? fallback.stdioBytes : positive(source.stdioBytes, `${label}.stdioBytes`),
  };
}

export function validatePolicy(value: unknown): SandboxPolicy {
  const source = object(value, "policy"); known(source, ["schemaVersion", "revision", "defaults", "maximums", "minimums", "fixed"], "policy");
  if (source.schemaVersion !== 1) denied("unsupported policy schemaVersion");
  if (typeof source.revision !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(source.revision)) denied("policy revision is invalid");
  const defaults = limits(source.defaults ?? {}, DEFAULT_SANDBOX_POLICY.defaults, "policy.defaults");
  const maximums = limits(source.maximums ?? {}, DEFAULT_SANDBOX_POLICY.maximums, "policy.maximums");
  const minimums = limits(source.minimums ?? {}, DEFAULT_SANDBOX_POLICY.minimums, "policy.minimums");
  const fixedSource = object(source.fixed ?? {}, "policy.fixed"); known(fixedSource, fixedNames, "policy.fixed");
  const fixed = {} as FixedPolicyLimits;
  for (const name of fixedNames) fixed[name] = fixedSource[name] === undefined ? DEFAULT_SANDBOX_POLICY.fixed[name] : positive(fixedSource[name], `policy.fixed.${name}`);
  for (const name of requestedNames) {
    if (minimums[name] > defaults[name] || defaults[name] > maximums[name]) denied(`policy ${name} must satisfy minimum <= default <= maximum`);
    if (minimums[name] < DEFAULT_SANDBOX_POLICY.minimums[name]) denied(`policy ${name} cannot lower the tested v1 minimum`);
    if (maximums[name] > DEFAULT_SANDBOX_POLICY.maximums[name]) denied(`policy ${name} cannot expand the v1 contract maximum`);
  }
  if (fixed.cpuQuotaMicros > fixed.cpuPeriodMicros) denied("v1 CPU quota cannot exceed one CPU equivalent");
  if (fixed.cpuPeriodMicros < 1_000 || fixed.cpuPeriodMicros > 1_000_000) denied("CPU period must be between 1,000 and 1,000,000 microseconds");
  if (maximums.memoryMiB > Math.floor(Number.MAX_SAFE_INTEGER / MiB)) denied("memory maximum cannot be represented safely in bytes");
  if (fixed.sourceBytes > MAX_SOURCE_BYTES || fixed.inputBytes > MAX_INPUT_BYTES || fixed.inputFiles > MAX_INPUT_FILES || fixed.pathDepth > MAX_PATH_DEPTH || fixed.pathBytes > MAX_PATH_BYTES || fixed.requestBytes > MAX_REQUEST_BYTES) denied("policy cannot expand a v1 contract maximum");
  if (fixed.artifactFiles > fixed.artifactEntries || fixed.artifactDirectories > fixed.artifactEntries) denied("artifact counts cannot exceed the entry limit");
  for (const name of fixedNames) if (fixed[name] > DEFAULT_SANDBOX_POLICY.fixed[name]) denied(`policy fixed.${name} cannot expand the v1 profile maximum`);
  return deepFreeze({ schemaVersion: 1, revision: source.revision, defaults, maximums, minimums, fixed }) as SandboxPolicy;
}

export function resolveLimits(request: JobRequest, policy: SandboxPolicy): EffectiveLimits {
  const selected = {
    timeoutMs: request.limits?.timeoutMs ?? policy.defaults.timeoutMs,
    memoryMiB: request.limits?.memoryMiB ?? policy.defaults.memoryMiB,
    stdioBytes: request.limits?.stdioBytes ?? policy.defaults.stdioBytes,
  };
  for (const name of requestedNames) {
    if (selected[name] < policy.minimums[name]) denied(`${name} is below the tested policy minimum`);
    if (selected[name] > policy.maximums[name]) denied(`${name} exceeds the policy maximum`);
  }
  if (Buffer.byteLength(request.code) > policy.fixed.sourceBytes) denied("source exceeds the operator policy");
  if ((request.inputs?.length ?? 0) > policy.fixed.inputFiles) denied("input file count exceeds the operator policy");
  let inputBytes = 0;
  for (const input of request.inputs ?? []) inputBytes += input.encoding === "utf8" ? Buffer.byteLength(input.data) : Buffer.from(input.data, "base64").length;
  if (inputBytes > policy.fixed.inputBytes) denied("decoded inputs exceed the operator policy");
  const memoryBytes = selected.memoryMiB * MiB;
  if (!Number.isSafeInteger(memoryBytes)) denied("memory limit cannot be represented safely in bytes");
  return deepFreeze({ ...policy.fixed, timeoutMs: selected.timeoutMs, memoryBytes, stdioBytes: selected.stdioBytes }) as EffectiveLimits;
}
