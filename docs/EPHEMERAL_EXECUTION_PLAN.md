# Ephemeral execution for agent-generated code

Status: implementation design record. The experimental implementation and its
current supported contract are documented in [SANDBOX.md](SANDBOX.md). The
acceptance matrix below remains the qualification checklist, not a claim that
every fault injection or platform combination has already passed.
Date: 2026-09-23. Repository baseline: `fc16a89`.

## 1. Product decision

bunc should run a short program written by an AI agent, with explicit input,
bounded resources, and a disposable filesystem, then return diagnostics and
artifacts. A job is the primary product abstraction.

The first supported workload is one TypeScript/JavaScript source file executed
by Bun in a prebuilt, operator-approved Linux OCI image. The image is prepared
once; generated code is supplied as data for each job. No image build, package
installation, or registry access happens during a job.

The first useful demonstration is an agent generating a program that reads
JSON, computes a result, and writes JSON plus a small report. A failed attempt
returns a useful error; a corrected attempt starts with fresh state.

Success means that an agent integration can reliably distinguish a program
error, a deadline, an enforced limit, and an infrastructure failure, while the
operator can control what resources each execution receives.

### Scope of the first experimental profile

- Native Linux arm64 and amd64, Bun as the first guest language runtime.
- One source file, bounded file inputs, captured stdout/stderr, file artifacts.
- An immutable approved environment, read-only code/input, private writable data.
- No network, no credentials, no host workspace mounts, no arbitrary guest argv.
- A foreground job with cancellation and bounded setup/execution/finalization.
- No required service daemon. Initially one admitted job per state root.
- Source distribution and compiled executable, consistent with existing bunc.

Deferred: MCP integration, Python, interactive sessions, arbitrary shell jobs,
network brokers, runtime dependency installation, a public hosted service,
multi-tenant scheduling, rootless operation, overlayfs, checkpoint/restore,
GPU support, signed execution attestations, and an npm SDK release.

The design must not require any of these deferred features to make a useful
first job work.

## 2. Security scope and trust boundaries

The current [security policy](../SECURITY.md) remains in effect. bunc is an
experiment for trusted images in disposable Linux hosts. This plan adds tests
and controls for generated programs; it does not establish production isolation,
hostile-image support, or OCI Runtime Specification conformance.

Treat generated source, inputs, stdout/stderr, filenames, and artifacts as
potentially malicious. Trust the operator, approved image preparation, kernel,
supervisor/bootstrap, environment descriptor, and operator policy. The program
may deliberately fork, exhaust memory, forge log messages, inspect descriptors,
attempt networking, or create filesystem objects that attack result collection.

During development, use synthetic data in a disposable Linux environment.
Privileged Docker is a laboratory mechanism, not evidence of a strong host
boundary. Before using sensitive inputs or exposing the feature to untrusted
users, separately review the full deployment, including any outer VM boundary.
No automatic fallback may change the isolation model when a feature is missing.

The trusted caller chooses the approved environment, policy, state root, and
result destination. The agent supplies only the job request. A privileged CLI
must never directly expose its operator flags as agent-controlled tool inputs.
The initial API is not a multi-user authorization service.

The agent cannot select host paths, UID/GID, mount flags, namespace handles,
seccomp rules, environment variables, executable paths, or a network mode.
Requesting more resources than policy permits is a rejection, not an implicit
policy change. Smaller requests must still satisfy tested environment minima.

Outputs are an intentional information-release channel to the trusted caller.
No-network does not stop secrets supplied as inputs from appearing in outputs,
and artifacts or diagnostics are not instructions to the agent or host.

## 3. Existing implementation and reuse decisions

| Current component | Relevant behavior | Planned treatment |
| --- | --- | --- |
| `src/runtime.ts` | Unpacks each run, derives process settings from the image, inherits stdio, supervises exit | Preserve `run`; add a separate experimental job dispatch |
| `src/worker.ts` | Mount/PID/UTS/IPC namespaces, read-only root, nonroot exec | Reuse concepts; this path alone lacks the required job controls |
| `src/rootfs.ts`, `src/oci/` | Digest/DiffID checks, bounded extraction, image path handling | Reuse for trusted environment preparation; strengthen path regressions |
| `src/oci-runtime/seccomp.ts` | Native-ABI filter validation/loading | Extract shared mechanics only when the job profile needs them |
| `src/oci-runtime/cgroup.ts` | Resource/device controls tied to kubelet/containerd paths | Separate generic controls from containerd path interpretation |
| `src/oci-runtime/bootstrap.c` | Native-only execution after fork, double fork for containerd adoption | Do not reuse its detached lifecycle unchanged for foreground jobs |
| `src/oci-runtime/worker.ts` | OCI mounts, capability bounding drop, ready/start gate | Audit useful primitives; avoid exposing general OCI configuration to jobs |
| `scripts/lab.ts` | Disposable Docker/Apple hosts and web acceptance | Add a separate job acceptance launcher; keep the web example |
| `scripts/compile.ts` | Standalone Linux binaries | Include internal job helpers without an external compiler dependency |

Two existing details require care:

1. The image-layout `launch` event precedes worker setup, and guest stderr shares
   its channel. It cannot be treated as proof that controls were applied.
2. The OCI worker writes `ready` before loading seccomp. A job readiness protocol
   must distinguish setup progress from completion of the final exec transition.

Keep existing public behavior while implementing the new path. Avoid a broad
rewrite to merge both workers before there is a tested job profile. Shared
low-level changes must continue to pass the kind experiment.

## 4. Proposed request and result contract

All names and commands below are proposed. Version the JSON contract from its
first implementation and reject unknown fields and unsupported versions.

The operator registers an environment by exact native-platform manifest digest.
The descriptor also fixes the interpreter, package set, working directory,
nonroot identity, runtime flags, and compatible policy revision. Image defaults
such as `Entrypoint`, `Cmd`, `Env`, and `WorkingDir` do not silently override the
job profile. An alias resolves to a descriptor digest before admission.

Example job request:

```json
{
  "schemaVersion": 1,
  "code": "const data = await Bun.file('/input/data.json').json();\nawait Bun.write('/output/result.json', JSON.stringify({ total: data.values.reduce((a, b) => a + b, 0) }));\n",
  "inputs": [
    {
      "path": "data.json",
      "encoding": "utf8",
      "data": "{\"values\":[1,2,3]}"
    }
  ],
  "limits": {
    "timeoutMs": 5000,
    "memoryMiB": 256,
    "stdioBytes": 1048576
  }
}
```

The wire representation accepts UTF-8 or strict base64 file contents. Paths
are relative POSIX paths with a deliberately narrow portable character set.
Reject absolute paths, empty/`.`/`..` components, NUL, backslashes, duplicates,
file/directory conflicts, excessive depth, and prototype-sensitive parser keys.
Use strict runtime type checks, safe integers, bounded parsing, and maps without
prototype inheritance. Do not accept tar input or arbitrary host file references.
V1 request limits contain only `timeoutMs`, `memoryMiB`, and `stdioBytes`;
other controls belong to the operator profile. Omitted values use that profile's
defaults; zero, negative, fractional, or over-ceiling values are rejected.

Operator-side CLI sketch:

```sh
bunc sandbox run --experimental-sandbox \
  --environment /trusted/environments/bun-tools.json \
  --policy /trusted/policies/offline.json \
  --request /staged/request.json \
  --result-dir /trusted/results/request-001
```

Use a fresh exclusive result directory; never overwrite an existing result.
The request reader checks a byte limit before full JSON parsing. A later SDK
accepts bytes/strings and creates this request; it does not turn agent-provided
paths into host mounts. The SDK launches the existing binary without a shell and
does not gain privileges or provision a VM automatically.

Local SDK sketch for M6, with operator configuration outside the agent request:

```ts
const runner = createRunner({
  binary: "/opt/bunc/bunc",
  environment: "/trusted/environments/bun-tools.json",
  policy: "/trusted/policies/offline.json",
  resultsRoot: "/trusted/results",
});
const result = await runner.run(request, { signal: controller.signal });
```

The SDK returns structured job failures without treating them as transport
exceptions. It throws a separate infrastructure error if the binary cannot start
or cannot return a valid result. Aborting requests cooperative supervisor
cancellation first, allowing bounded finalization; a subsequent forced caller
termination must be reported as interrupted, not as a completed cancellation.
The SDK does not automatically retry jobs or parse arbitrary stdout as JSON.
The caller controls the generate/execute/inspect/revise loop.

Result shape, expressed as types to distinguish execution from finalization:

```ts
type Outcome =
  | "succeeded" | "failed" | "timed_out" | "cancelled"
  | "resource_exhausted" | "rejected" | "setup_failed" | "runtime_failed";

interface JobResult {
  schemaVersion: 1;
  runId: string;
  outcome: Outcome;
  phase: "admission" | "preparing" | "executing" | "finalizing";
  exitCode: number | null;
  signal: string | null;
  reason: { code: string; message: string } | null;
  limitsHit: string[];
  stdout: { file: string; bytes: number; truncated: boolean; sha256: string };
  stderr: { file: string; bytes: number; truncated: boolean; sha256: string };
  artifacts: { path: string; file: string; bytes: number; sha256: string }[];
  artifactsComplete: boolean;
  cleanup: "complete" | "incomplete" | "not_needed";
  finalizationErrors: { code: string; message: string }[];
  environmentDigest: string | null;
  policyDigest: string | null;
  codeDigest: string | null;
  inputsDigest: string | null;
  effectiveLimits: Record<string, number> | null;
  metrics: {
    prepareMs: number; executeMs: number; finalizeMs: number;
    cpuUsageUsec: number | null; memoryPeakBytes: number | null;
  };
}
```

An emitted result bundle always contains the two stream files, even if empty.
Invalid invocation or inability to create the result destination can prevent a
bundle; report that through a bounded CLI diagnostic and nonzero exit status.
Never fabricate missing measurements as zero. Filenames in metadata are relative
to the result bundle and are generated by the supervisor.
`phase` identifies where the recorded outcome was decided, not the final state
of the metadata writer. An unexecuted phase has zero elapsed time; a missing
measurement from an interrupted phase is reported in recovery metadata rather
than invented as a completed result.

CLI stdout contains one final JSON result, not program stdout. Program bytes go
to the stream files; CLI stderr is for bounded supervisor diagnostics. Preserve
raw stream bytes, including invalid UTF-8. SDK text decoding is explicit and
must report truncation. Never interpolate guest output into trusted log records.

CLI exit codes: 0 only for successful execution, complete artifact collection,
and complete cleanup; 1 for program failure, deadline, cancellation, or a
confirmed resource termination; 2 for rejection/setup/runtime failures or
incomplete finalization. The JSON outcome retains the original execution result
if collection or cleanup subsequently fails. Caller signal cancellation follows
the same structured contract rather than copying the guest's exit code.

Record the first supervisor-observed terminal trigger and additional evidence.
Do not promise deterministic ordering of simultaneous OOM, exit, and deadline
events. A bare SIGKILL or exit code 137 is insufficient to label a memory limit.
A recovered PID-limit error need not turn an otherwise successful job into a
failure; record the observed limit event. ENOSPC text alone is not trusted proof
of a storage-limit termination.

Freeze a small reason-code vocabulary in M0: `INVALID_REQUEST`, `POLICY_DENIED`,
`BUSY`, `ENVIRONMENT_NOT_PREPARED`, `UNSUPPORTED_HOST`, `SETUP_TIMEOUT`,
`EXEC_FAILED`, `PROGRAM_EXIT`, `PROGRAM_SIGNAL`, `DEADLINE`, `CANCELLED`,
`OOM_KILL`, `STDIO_LIMIT`, `ARTIFACT_INVALID`, `ARTIFACT_LIMIT`,
`COLLECTION_TIMEOUT`, `CLEANUP_INCOMPLETE`, and `SUPERVISOR_INTERRUPTED`.
Artifact/cleanup errors belong in finalization errors when execution already
has an outcome. Human messages supplement stable codes; guest text never sets
a trusted code. Extend the vocabulary only with a defined observation source.

## 5. Resource policy

These are initial test values, not established capacity or performance claims.
Freeze them only after testing the pinned Bun image on both architectures.

| Resource | Proposed default | Operator ceiling / behavior |
| --- | --- | --- |
| Execution wall time | 5 s | 30 s; monotonic timer, hard stop |
| Guest memory | 256 MiB | 512 MiB; below tested minimum is rejected |
| CPU bandwidth | One CPU equivalent | Fixed for v1; not a cumulative CPU-time budget |
| Guest tasks/threads | 64 | Fixed; verify Bun worker/thread requirements |
| Writable filesystem | 64 MiB, 4,096 inodes | One aggregate scratch filesystem |
| stdout + stderr | 1 MiB combined | Terminate on overflow; preserve bounded prefixes |
| Returned artifacts | 16 MiB total, 128 files | Reject oversized collection; no silent partial success |
| Source | 1 MiB UTF-8 | Fixed maximum |
| Inputs | 8 MiB decoded, 128 files | Maximum depth 8; total relative path length 240 bytes |
| Encoded request | 16 MiB | Includes base64/JSON overhead; reject before full parse |
| Open descriptors | 256 | Fixed NOFILE soft/hard limit, tested with Bun |
| Setup deadline | 30 s for a prepared environment | Setup failure; no implicit image preparation |
| Finalization deadline | 5 s | Report incomplete cleanup and quarantine leftovers |

Guest limits cover the worker's startup and the program, with startup overhead
included in the tested memory/task minima. Setup and finalization use separate
operator limits; they are not unlimited extensions to execution time.

Use a dedicated cgroup v2 subtree for each job. Configure memory, swap, tasks,
CPU bandwidth, group OOM behavior, and device restrictions before guest code can
run. Final termination uses `cgroup.kill`; confirm `populated=0` before collection.
Do not substitute a process-group kill for this requirement. The operator must
provide a usable cgroup parent; do not modify unrelated host/systemd hierarchies.
See the [kernel cgroup v2 interface](https://docs.kernel.org/admin-guide/cgroup-v2.html).

The supervisor and cleanup guardian remain outside the guest cgroup. The
operator's outer environment also needs memory/disk limits: request decoding,
image preparation, retained results, and cache pages are not all charged to the
program. Tmpfs pages and Bun heap compete for the job's memory budget where
charged to it; 64 MiB scratch is not an additional 64 MiB memory entitlement.

For v1, an advisory lock held for the job lifetime permits one job per state
root; a second request gets `BUSY`, with no hidden queue. Multiple state roots
are not an aggregate resource limiter. Cache/result storage has operator-owned
byte/entry ceilings and free-space checks. Capacity exhaustion rejects new work;
results are removed only by explicit operator cleanup, not silent eviction.

## 6. Filesystem and execution environment

| Guest path | Access | Source |
| --- | --- | --- |
| `/` | Read-only | Prepared environment rootfs |
| `/code/main.ts` | Read-only | Staged source bytes |
| `/code/node_modules` | Read-only, optional | Approved package set from environment |
| `/input` | Read-only | Private staged input snapshot |
| `/work` | Read/write | Job scratch subdirectory; fixed cwd |
| `/output` | Read/write | Job scratch subdirectory for artifacts |
| `/tmp`, private home, `/dev/shm` | Read/write | Other subdirectories of the same bounded scratch mount |
| `/proc`, minimal `/dev` | Restricted | Job-specific system mounts and standard devices |

The trusted supervisor owns a private mount namespace, makes propagation
private, and retains the bounded scratch mount through collection. The guest
gets its own mount namespace derived from this view. Binding scratch
subdirectories into the guest allows `/output` to survive guest exit without
granting the program access to supervisor state or host result directories.
Verify this topology before implementing collection; a tmpfs owned solely by
an exiting namespace would lose the artifacts.

Stdin is `/dev/null` in v1; there is no interactive input or inherited terminal.
Do not mount host `/sys`, a cgroup administration filesystem, or host `/run`.
Define and test a fixed procfs restriction set for sensitive kernel interfaces
as part of the profile. Read-only procfs alone is not the complete proc policy.
Use only required standard device nodes, backed by the device filter.

Apply `nosuid,nodev` to writable data mounts and test `noexec` there for v1.
`noexec` is not the isolation boundary: interpreters can still read source.
The approved rootfs supplies executable binaries. Libraries needing executable
temporary files or untested native addons may be incompatible and must be
reported as such. Do not weaken mount or syscall policy automatically.

Provision all fixed mountpoints while preparing the environment. Per-job startup
must never create/delete directories in a shared cached rootfs. In particular,
the old-root mountpoint remains an empty prepared directory after detachment;
it must not require mutating the cached base to remove it.

Build a minimal environment explicitly: fixed PATH, private HOME/TMPDIR, locale,
and timezone. Do not inherit host environment or image credential variables.
Invoke the approved Bun executable directly, with `--no-install`,
`--no-env-file`, and an explicit trusted Bun configuration. Validate configuration
and module resolution behavior for the pinned version; compile-time autoload
flags for bunc do not configure the guest's Bun. No `bunx`, package lifecycle
scripts, or shell interpolation is part of job startup.

Use fresh PID/mount/network/IPC/UTS namespaces and an appropriate cgroup view.
The network namespace has no external interfaces/routes and no usable DNS
configuration. There is no host loopback, mounted host Unix socket, inherited
network socket, or proxy environment. Decide and test private loopback behavior
explicitly; v1 keeps it down. No host network fallback is permitted.

Drop supplementary groups, capability sets including bounding/ambient, set
`no_new_privs`, and use a fixed nonzero UID/GID. Load a versioned, deny-by-default
native-ABI seccomp profile tested against Bun, including JIT and thread startup.
An observed syscall trace is a compatibility input, not an automatic allowlist.
The job API cannot provide filters. User namespaces are not part of v1, and the
shared-kernel/rootful limitation must remain visible in the profile description.

## 7. Lifecycle and crash behavior

Normal flow:

```text
validate -> admit -> prepare -> setup -> execute -> stop descendants
         -> capture metrics -> collect -> clean -> publish result
```

1. Bound and validate the request, resolve approved descriptors, and acquire the
   state-root lock. Allocate a generated run ID and private state directory.
2. Stage code/inputs, establish scratch, create the job cgroup, and arm the
   guardian and setup deadline. Journal each acquired resource.
3. Start a supervised native bootstrap; do not orphan the job to containerd.
   Bun is multithreaded, so native-only post-fork handling remains mandatory.
4. Set up namespaces, mounts, identity, and final controls. Start the execution
   clock conservatively immediately before authorizing the final exec transition.
5. Use a dedicated bounded setup/error pipe with close-on-exec semantics plus
   process observation to report exec errors. EOF alone can also mean death;
   never infer successful launch from EOF alone. Keep this channel out of the
   generated program's descriptor table.
6. Drain stdout and stderr concurrently into bounded files. On a terminal
   trigger, stop the complete guest cgroup; on ordinary main-process exit, also
   kill remaining descendants. Background work is not a supported result.
7. Wait for no live guest processes, finish bounded pipe draining, sample final
   counters, and collect artifacts while scratch remains available.
8. Unmount/release per-run resources and remove the cgroup and staged inputs.
   Atomically publish the final metadata with cleanup status.

V1 can execute the program as the job's PID 1. No persistent session is promised;
orphaned/zombie descendants count against the task budget until namespace exit.
The acceptance suite must exercise subprocesses and repeated child exits. Add a
native reaper later only if measured compatibility requires it; cancellation
must already kill the entire job independently of guest signal handling.

A native guardian watches a private supervisor-liveness pipe and a hard
deadline. The guest must not inherit any writer that could keep this pipe alive.
Supervisor disappearance or deadline expiry triggers whole-cgroup termination.
The guardian closes unnecessary descriptors and cannot be controlled through
guest output. Fault injection for supervisor SIGKILL is a release gate, not an
optional improvement. Implementing a watchdog alone does not prove cleanup.

If the supervisor dies, the caller gets process failure and may have no final
result. A proposed `bunc sandbox gc` reconciles journaled abandoned resources
under an exclusive lock, validates ownership and process identity, kills before
removal, and reports recovered runs as interrupted. Never act on PID alone or
directory age alone, follow workload-created symlinks, or touch foreign cgroups.
After a host crash or guardian failure, runtime-only guarantees are weaker; the
outer disposable environment and next-start reconciliation remain necessary.

Do not hide an unmount failure with a successful-looking result. A job may finish
while kernel-blocked tasks prevent timely cleanup. Keep the state quarantined,
return an infrastructure diagnostic, and refuse reuse of affected resources.

## 8. Safe staging, streams, and artifact collection

Input staging copies validated bytes into newly created private regular files,
sets fixed modes/ownership, and seals the view before execution. No shared live
host directory is accepted as input. Digest the staged bytes, not a file that
can subsequently change. Code bytes are never rewritten by a wrapper.

Start draining both output pipes immediately. Enforce one combined byte counter;
the retained split depends on actual stream arrival order. Keep a bounded prefix
of each stream with explicit truncation. On overflow, latch the reason, request
termination, and drain/discard only for a bounded shutdown interval. Do not use
unbounded `Response.text()`, string concatenation, or buffering until process exit.

Collect all supported regular files beneath `/output` only after confirming the
guest has no live writers. Reject symlinks, hardlinked files (`nlink > 1`), FIFOs,
sockets, devices, invalid filenames, over-depth trees, and oversized/sparse files
by logical byte length. Bound traversal entries and directory count as well as
returned files. Do not preserve executable bits, ownership, ACLs, or xattrs.

Walk relative to pinned directory descriptors; use constrained `openat2`/`*at`
operations and verify the opened file with `fstat`. Do not `realpath`-check then
reopen the original path. Output collection should reject links rather than
supporting image-style link resolution. See [openat2](https://www.man7.org/linux/man-pages/man2/openat2.2.html).

Copy verified bytes to a fresh result staging directory, enforce limits while
reading, hash the exact copied bytes, and publish a bounded artifact manifest.
If any output entry is invalid, publish no artifacts, mark collection incomplete,
and preserve execution diagnostics. Valid outputs from a failed/timed-out job
may be returned, clearly associated with that outcome; they are never applied
to the host workspace or executed automatically.

Result collection, input staging, rootfs extraction, and later result export are
separate path trust boundaries. Sharing a string-normalization helper does not
establish safety across all four.

## 9. Prepared environments and caching

First functional milestones may use fresh extraction; the usable v1 includes
explicit environment preparation so normal jobs do not unpack an image.

Proposed operator command: `bunc sandbox prepare --experimental-sandbox ...`.
It reads a trusted local OCI layout, checks the expected manifest/platform and
all relevant content, unpacks in a private temporary directory, provisions fixed
mountpoints, validates the environment contract, and atomically publishes a
prepared entry. Failed or interrupted preparation is never a cache hit.

Identify prepared content using image manifest digest, native architecture,
preparation format/version, and environment descriptor digest. Record derived
filesystem metadata so identical image bytes under a changed preparer do not
silently reuse an incompatible entry. Do not key only by an image tag or label.

Prepared directories are writable only by the trusted preparation process and
mounted read-only for jobs. A manifest digest verifies OCI input content; it does
not detect arbitrary later mutation of an unpacked directory. Cache integrity
therefore relies on protected ownership and exclusive administration in v1.
External cache mutation is outside that trust assumption and requires reprepare.

Initially use explicit bounded cleanup under the same state-root lock, not an
in-memory rootfs store or background LRU. Do not delete an entry referenced by an
active job. Baseline image preparation must have its own time/memory/disk budget;
the existing 1 GiB content cap does not imply a 1 GiB RSS bound.

No overlayfs is needed for this design: immutable rootfs plus a bounded scratch
filesystem covers the first workload. Reconsider overlayfs only when an actual
workload needs rootfs mutation, package environments, or filesystem branching.
None of these implies a process checkpoint/resume guarantee.

## 10. Evidence and observability

The supervisor owns job metadata and metrics. Keep program text and content out
of routine diagnostics; persist source/input only as explicitly retained result
data if an operator later enables that feature. V1 records their digests, which
support identity comparison but do not make unavailable inputs reproducible.

Record requested/effective policy identities, native platform, bunc/guest Bun
versions, environment digest, phase timings, launch outcome, limit evidence, and
cleanup status. Separate controls requested from setup operations completed.
There is no receipt parser that promotes guest stderr into a trusted event.

Unsigned records are adequate for v1. Reproducibility is best-effort: the kernel,
clock, randomness, scheduling, and external environment can affect results.
Signing, if later required, uses a key outside the guest and states exactly
which observations the signer attests; it is not proof of isolation.

## 11. Proposed source layout

```text
src/runtime.ts                  Existing CLI plus experimental dispatch
src/sandbox/
  contract.ts                   Strict request/result types and validation
  policy.ts                     Operator policy and immutable effective plan
  environment.ts                Approved descriptor and preparation
  state.ts                      Admission lock, journal, recovery ownership
  supervisor.ts                 Lifecycle, cancellation, result publication
  streams.ts                    Bounded concurrent byte capture
  files.ts                      Input staging and artifact collection
  worker.ts                     Fixed job filesystem/identity setup
  bootstrap.c                   Foreground native bootstrap and guardian
  cli.ts                        run/prepare/gc/doctor operator commands
src/linux/                      Only primitives actually shared with OCI mode
test/sandbox*.test.ts            Contract and bounded filesystem regressions
scripts/sandbox-lab.ts           Docker/Apple disposable job acceptance
scripts/sandbox-bench.ts         Reproducible cold/warm measurements
examples/execute/                JSON transform/report and failure/retry examples
```

File names are a proposed ownership map, not a requirement to create empty
modules. Do not duplicate the entire OCI worker or expose a generic plugin/backend
framework. Resolve a concrete fixed profile to a typed launch plan once, then
pass that plan to the worker. Any shared primitive retains OCI adapter tests.

## 12. Implementation sequence and merge gates

Each row is a reviewable change or small series. Gates are dependencies, not
estimated delivery dates. Do not advertise the feature as usable before M5.

| Milestone | Work | Required evidence |
| --- | --- | --- |
| M0: execution contract | Strict schema, policy merge/rejection, status/exit semantics, fixtures, threat model | Invalid and over-budget requests cannot construct a launch plan; existing CLI unchanged |
| M1: Linux feasibility | Disposable-host doctor, cgroup parent provisioning, Bun/seccomp compatibility, scratch-retention prototype, guardian/exec protocol | One fixed no-op and a deliberately stalled process demonstrate isolation setup, exec errors, termination, and retained output storage on native Linux |
| M2: bounded execution | Fixed profile worker, cgroups, no network, bounded stream capture, foreground supervisor, cancellation | Success/error/timeout/OOM/output flood/child cleanup pass; absent enforcement prevents execution |
| M3: data and artifacts | Code/input staging, safe artifact walker, result bundle, useful transform/report example | Symlink/FIFO/hardlink/sparse-file attacks fail safely; exact input/output bytes and digests verified |
| M4: crash recovery | Acquisition journal, guardian fault handling, stale-state recovery, finalization failures | Supervisor SIGKILL and setup fault injection leave no live guest; incomplete cleanup never reports CLI success |
| M5: prepared environments | Atomic preparation/cache, immutable mountpoints, ownership/capacity controls, sequential reuse | Warm runs skip extraction; second job sees no first-job state; interrupted preparation and cache cleanup are safe |
| M6: integration and qualification | Local SDK wrapper/example, native CI matrix, standalone mode, benchmark report, updated scope documentation | Three useful workloads, repeated failure/retry cycle, declared platform matrix and experimental release checklist complete |

M1 is deliberately early: if Bun cannot run under a defensible tested profile,
the host lacks usable cgroup facilities, or output cannot survive safe teardown,
resolve those constraints before building a larger API. A partial M2 is internal
lab work; do not ship a convenient command that silently omits mandatory controls.

The first implementation PR should be M0: contract and policy with synthetic
fixtures, without changing the existing worker. The next PR should prove M1 in
the disposable launcher. This separates API decisions from privileged setup.

## 13. Acceptance and adversarial regression matrix

| Area | Essential cases |
| --- | --- |
| Useful jobs | JSON aggregation, text/report generation, binary file roundtrip; source exception and corrected retry |
| Contract | Wrong types, unknown fields, invalid base64, unsafe integers, huge encoded body, duplicate/conflicting paths, policy over-request |
| Identity | Fixed UID/GID; empty supplementary/capability sets; no_new_privs; native seccomp active; parent env sentinel absent |
| Filesystem | Read-only root/code/input; writable scratch; inaccessible outer marker/state/results; no mutation of prepared base |
| Network | Direct IPv4/IPv6, host loopback, DNS/UDP, metadata address, Unix socket and inherited socket attempts |
| Descriptors | No inherited host directory, control pipe, cgroup handle, or unrelated Bun descriptor in the guest |
| Limits | Infinite CPU loop; heap growth; process/thread flood; byte and inode exhaustion; stdout/stderr flood together; descriptors |
| Lifecycle | Immediate exit, exec failure, ignored signals, forked descendants, held-open pipes, cancellation during each phase, PID reuse |
| Collection | `../`-shaped names, absolute/relative symlink chains, hardlinks, FIFOs/sockets, deep trees, sparse/oversized files, output writer at exit |
| Path handling | Whiteout/link interactions, lower-layer replacements, missing paths, symlink loops, concurrent mutation where the boundary permits it |
| Setup faults | Failure after each mount/cgroup/pipe/staging acquisition; missing libseccomp/controller/openat2; read-only or full state filesystem |
| Crash/recovery | Supervisor SIGKILL, guardian failure, stale journal, foreign cgroup/state, PID recycling, interrupted result publication |
| Reuse | Input/output contamination across runs, interrupted prepare, cache contention, attempt to delete active entry, exhausted result capacity |

Negative tests must check host sentinels and resource state, not just a thrown
error or a guest-reported JSON assertion. Network tests use controlled local
listeners/counters inside the disposable lab; absence of public connectivity
alone is not sufficient evidence. Do not include destructive kernel exploits.

Run repository-required `bun run check` and `bun run build` before commits.
Runtime/unpacker/launcher changes also require `bun run test:docker`; exercise
Apple Container when available. Shared OCI changes require `bun run test:kind`.
Add job acceptance for native Linux amd64 and arm64 and for compiled executables.
Keep generated images, fixtures, logs, and measurements under `.bunc-output/`.

The current CI check job is amd64; kind already has a native two-architecture
matrix. Do not describe the new job path as arm64-qualified until its own matrix
passes. Record Apple coverage separately and skip only with an explicit reason.

## 14. Benchmarks and completion criteria

Measure image preparation separately from request execution. Report at least
environment-cold preparation, prepared-rootfs execution, and an end-to-end
macOS laboratory invocation including any VM/container startup. Never compare
one of these with a different competitor timing boundary.

For a pinned small environment, capture 100 sequential warm no-op jobs and a
fixed JSON workload after five explicit warmups. Publish p50/p95/max, CPU time,
available memory counters, supervisor/guardian memory, cache size, and remaining
process/mount/cgroup counts. Disclose architecture, CPU, kernel, filesystem,
outer backend, versions, image digest, limits, and the sampling method.

An initial hypothesis is warm no-op p95 below 500 ms excluding outer-host
startup. This is a target to investigate, not a promised release threshold.
Measure first; if missed, identify the dominant phase before adding pooling,
snapshots, a persistent daemon, or weaker isolation. Qualification does require
no live leftover jobs/mounts/cgroups, no cross-run data, and bounded retained
state over a repeated mixed success/failure workload.

The first experimental feature is complete when M0-M6 gates pass, one agent
integration completes a generate/run/inspect/revise/run loop, the request/result
contract is documented, and unsupported combinations fail explicitly. Keep the
existing experimental security wording; a stronger trust claim needs a separate
review and evidence beyond this acceptance suite.

## 15. Decisions reserved for measured follow-up

- Tune Bun memory/task/descriptor minima and the syscall profile per tested
  architecture, without hiding profile differences.
- Decide whether callers actually need multiple source files, Python, or larger
  binary inputs before expanding the wire format.
- Add concurrency only with admission and aggregate resource accounting.
- Evaluate a reaper only against concrete subprocess compatibility failures.
- Evaluate overlayfs only against workloads needing writable environment state.
- Evaluate a stronger isolation backend/deployment before accepting hostile
  users or sensitive workloads; do not equate an experimental VM lab with that
  review.

These are follow-up decisions, not reasons to leave v1 defaults ambiguous.

## References used for implementation constraints

- [Linux cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html): resource
  control and whole-cgroup termination interfaces.
- [Linux tmpfs](https://docs.kernel.org/filesystems/tmpfs.html): explicitly bound
  bytes and inodes; never rely on default mount sizes for job storage.
- [openat2](https://www.man7.org/linux/man-pages/man2/openat2.2.html): constrained
  resolution relative to directory descriptors.
- [execve](https://www.man7.org/linux/man-pages/man2/execve.2.html): descriptor
  inheritance and close-on-exec behavior.
- Repository files at the stated baseline and the installed pinned Bun CLI help.
  No market performance numbers or unverified incident claims are dependencies
  of this plan.
