# Experimental ephemeral code execution

The `sandbox` command executes a short Bun program against supplied files. It
is a foreground, local, offline job runner: one fresh process and scratch
filesystem per request, with structured completion metadata and bounded files.
It does not call a model, run a shell around source, install packages, or retain
a live session. This path is separate from `bunc run` and the OCI RuntimeClass
experiment. It does not implement OCI Runtime Specification conformance.

This is laboratory software for trusted, operator-approved images on disposable
Linux hosts. Namespaces share the outer Linux kernel. The implementation and
its native fork bootstrap have not undergone a security audit. Do not use this
as a production or multitenant security boundary, even though the regression
suite deliberately exercises misbehaving programs.

## Try the disposable lab

Requirements: Bun 1.4.2, a native arm64 or amd64 machine, and Docker or Apple
Container. The launcher creates an outer host with resource limits and broad
privileges so the inner runtime can create namespaces, mounts, cgroups, and
device BPF. Only the image, runtime bundle, and synthetic result directory are
mounted. The first image build requires network access; job execution does not.

```sh
bun run test:sandbox:docker
bun run test:sandbox:docker:standalone
bun run test:sandbox:apple
bun run test:sandbox:apple:standalone
bun run bench:sandbox:docker
```

Logs, doctor output, prepared metadata, result bundles, and `acceptance.json`
are saved under `.bunc-output/sandbox-*/`. The benchmark performs five warmups
and 100 sequential runs each of a no-op and a fixed JSON workload; timings
exclude outer-host startup. Its image
preparation is measured separately. It is a local measurement, not a service
latency guarantee. See [the example request](../examples/execute/request.json).
The [qualification record](SANDBOX_VALIDATION.md) describes measured coverage,
platform limits, and the benchmark method.

## Operator configuration

Run direct commands only inside a suitable disposable Linux environment, as
root. The host needs glibc, util-linux `unshare`, libseccomp, cgroup v2 with
`cgroup.kill`, delegated CPU/memory/PID controllers, permission to attach device
BPF, `openat2`, `close_range`, and namespace/mount support. Unsupported controls
fail closed. No fallback silently disables an isolation mechanism.

The operator provisions a dedicated, empty cgroup parent with the CPU, memory,
and PID controllers enabled in `cgroup.subtree_control`. The lab launcher shows
one arrangement for an isolated container; do not copy its root-cgroup setup
onto a workstation or a systemd-managed production host.

The operator owns the environment, policy, state root, cgroup parent, and result
parent. These paths are never request fields. Protect them from other users and
use a dedicated result parent. The caller may select code, input bytes, and
three bounded execution limits. Do not expose the privileged CLI as an arbitrary
command tool or permit an agent to select its flags.

An environment descriptor pins the **native image manifest digest**, not a tag
or multi-architecture index. Its architecture must match the host:

```json
{
  "schemaVersion": 1,
  "manifestDigest": "sha256:<64 lowercase hexadecimal characters>",
  "architecture": "arm64",
  "interpreter": "/usr/local/bin/bun",
  "packagePath": null,
  "workingDirectory": "/work",
  "uid": 65532,
  "gid": 65532,
  "runtimeFlags": ["--no-install", "--no-env-file", "--config=/code/bunfig.toml"],
  "policyRevision": "offline-v1"
}
```

`packagePath`, when non-null, points to a trusted package directory in the image
mounted read-only at `/code/node_modules`. The interpreter and package paths
are resolved inside the approved image. Runtime flags, identity, and working
directory are fixed by v1. There is no registry fetch or package installation.
Image digest verification establishes content identity, not publisher trust.

```sh
bunc sandbox doctor --experimental-sandbox --cgroup-parent /sys/fs/cgroup/bunc-jobs
bunc sandbox prepare --experimental-sandbox \
  --layout /trusted/image --environment /trusted/environment.json \
  --state-root /var/lib/bunc-sandbox --cgroup-parent /sys/fs/cgroup/bunc-jobs
bunc sandbox run --experimental-sandbox \
  --environment /trusted/environment.json --request /trusted/request.json \
  --state-root /var/lib/bunc-sandbox --cgroup-parent /sys/fs/cgroup/bunc-jobs \
  --result-dir /trusted/results/job-001
bunc sandbox gc --experimental-sandbox \
  --state-root /var/lib/bunc-sandbox --cgroup-parent /sys/fs/cgroup/bunc-jobs
bunc sandbox cache --experimental-sandbox --state-root /var/lib/bunc-sandbox
# Explicitly remove an inactive cache entry by its reported key:
bunc sandbox cache --experimental-sandbox --state-root /var/lib/bunc-sandbox \
  --remove REPORTED_CACHE_KEY
```

Preparation extracts once into a protected staging directory, verifies content,
mountpoints, interpreter identity and capacity, and atomically publishes an
immutable cache entry. A bounded trusted preparation child has separate memory
and deadline controls. Warm jobs reuse the prepared tree and do not unpack it.
The unpacker remains a trusted-image parser, not a hardened hostile-image
service. The operator must additionally bound the outer host's disk and memory.

One advisory kernel lock covers the entire job or preparation per state root.
Concurrent work receives `BUSY`; there is no queue. Multiple state roots do not
provide aggregate admission control. Capacity exhaustion rejects new work;
results are never silently evicted. The dedicated result parent defaults to 256
entries and 1 GiB, requires a 64 MiB free-space reserve, and accounts for live
output reservations under its own admission lock. Its traversal is bounded.
Remove retained results explicitly when no caller needs them. Cache inspection
and removal require the same exclusive state lease; unresolved job journals
pin referenced entries. `gc` also reconciles interrupted preparation resources
before removing incomplete staging directories.

## Request and limits

A request has `schemaVersion: 1`, `code`, optional `inputs`, and optional `limits`.
Each input has a relative `path`, `encoding` (`utf8` or canonical `base64`), and
`data`. Unknown fields, unsafe paths, path conflicts, malformed encodings, and
requests exceeding policy are rejected. The source is staged as `/code/main.ts`.

| Limit | Default | Caller maximum |
| --- | --- | --- |
| Wall time | 5,000 ms | 30,000 ms |
| Job memory, including runtime | 256 MiB | 512 MiB |
| Combined stdout + stderr | 1 MiB | 1 MiB |

The operator may provide a strict policy JSON using `--policy`. Its structure is
exported as `SandboxPolicy` and `DEFAULT_SANDBOX_POLICY` from
`src/sandbox/policy.ts`; unknown fields and invalid ranges are rejected. The
policy revision must match the approved environment descriptor. Requests never
gain permission to change networking, mounts, process identity, or kernel policy.

The fixed default profile also limits source to 1 MiB, decoded inputs to 8 MiB
and 128 files, process/thread count to 64, open descriptors to 256, and CPU
bandwidth to one CPU. A shared 64 MiB/4,096-inode tmpfs backs `/work`, `/output`,
`/tmp`, private home, and `/dev/shm`. Artifacts are limited to 16 MiB and 128
files. Memory and scratch limits overlap where tmpfs pages are charged to the
job; they are not additive memory entitlements. See the policy type for exact
walk, depth, path, setup, and finalization limits.

The root, `/code`, and `/input` are read-only. The guest has an empty network
namespace, no inherited sockets, an empty capability set, `no_new_privs`, a
native syscall allowlist, restricted devices, and private process/mount/IPC/UTS
namespaces. Guest environment variables are fixed; parent secrets are not
inherited. Stdin is `/dev/null`. There is no user namespace or hardware VM
boundary in this implementation.

## Results and cancellation

CLI stdout is one JSON object; it never mixes in program output. A fresh result
bundle contains `result.json`, raw `stdout.bin` and `stderr.bin`, and validated
`artifacts/` files. Stream bytes may be non-UTF-8. Metadata includes hashes,
byte counts, truncation, environment/policy/code/input identity, effective
limits, phase timings, available cgroup counters, and cleanup errors.

Outcomes distinguish `succeeded`, `failed`, `timed_out`, `cancelled`,
`resource_exhausted`, `rejected`, `setup_failed`, and `runtime_failed`. An OOM
classification requires cgroup evidence. A program that catches an `ENOSPC`
error can still succeed. `limitsHit` is evidence, not inference from stderr.
The phase records where the outcome was decided. A successful program can have
failed artifact collection or cleanup; inspect these fields as well.

| CLI exit | Meaning |
| --- | --- |
| 0 | Program succeeded, artifacts complete, cleanup complete |
| 1 | Program failure, cancellation, timeout, or observed resource exhaustion |
| 2 | Rejection, setup/runtime infrastructure failure, or incomplete finalization |

Invalid invocation or failure to reserve the result destination may prevent a
JSON result. Treat that as a transport/infrastructure error. Existing result
directories are never overwritten. The source and input bodies are not retained
in routine result metadata; hashes alone do not make a job reproducible.

After the main process exits, remaining descendants are killed using
`cgroup.kill`. Collection starts only after the cgroup is empty. Descriptor-
anchored `openat2` walks reject symlinks, hardlinks, special files, sparse files,
invalid names, deep trees, and oversized output. Files are copied and hashed;
no guest archive is extracted by the collector. Failed collection publishes no
partial artifact list. Program output and artifacts remain untrusted data;
callers must not interpret them as privileged configuration or instructions.

`SIGTERM` and `SIGINT` request cancellation and cleanup. A native guardian
outside the job cgroup enforces a hard deadline and observes supervisor death.
`SIGKILL` cannot produce a reliable final result. After interruption, `gc`
reconciles protected ownership journals and refuses ambiguous foreign resources.
Unrecoverable records remain quarantined, and cleanup failures never produce
CLI success. This is not a persistent daemon or a resumable session protocol.

## Local SDK

Import the source wrapper from this repository; no public npm SDK is published.
A Bun caller can configure the runner once with trusted operator paths:

```ts
import { createRunner } from "./src/sandbox/sdk.ts";

const runner = createRunner({
  binary: "/usr/local/bin/bunc",
  environment: "/trusted/environment.json",
  policy: "/trusted/policy.json",
  resultsRoot: "/trusted/results",
  stateRoot: "/var/lib/bunc-sandbox",
  cgroupParent: "/sys/fs/cgroup/bunc-jobs",
});
const result = await runner.run({
  schemaVersion: 1,
  code: "await Bun.write('/output/answer.json', JSON.stringify({ answer: 42 }));",
});
if (result.outcome === "succeeded" && result.artifactsComplete) {
  console.log(result.resultDirectory, result.artifacts);
}
```

For the JavaScript distribution, set `binary` to Bun and `binaryArgs` to the
absolute `dist/bunc.js` path. `run(request, { signal })` supports an AbortSignal.
The wrapper validates the result and CLI exit together, returns the result
bundle location, and throws `SandboxInfrastructureError` for transport failures.
It does not retry automatically. The caller can inspect a failed attempt,
generate revised code, and submit a completely fresh job.
