# Ephemeral execution qualification

Date: 2026-09-23. This is an implementation/acceptance record for the experimental
`offline-v1` profile, not a security audit or production isolation claim.

## Local validation

The implementation was exercised on native Linux arm64 inside disposable Docker
Desktop and Apple Container hosts on an Apple M5 development machine, using Bun
1.4.2. The outer host is pinned by digest in `scripts/sandbox-lab.ts` and receives
two CPUs and 2 GiB memory. The inner job defaults to one CPU equivalent, 256 MiB
memory, 64 tasks, 64 MiB scratch, and no network.

- `bun run check`: typecheck plus 93 passing tests; four Linux artifact tests
  are skipped on macOS.
- Full tests in the pinned Linux arm64 host: 97 passing tests, no skips.
- Docker source and standalone sandbox acceptance: 26 checks, including
  native setup/exec errors, guardian failure, data processing, binary artifacts,
  limits, isolation, caller cancellation, supervisor crash, cache management,
  and interrupted preparation recovery.
- Standalone acceptance removes the outer host's Bun executable before calling
  bunc, including its preparation and worker re-exec paths.
- Apple Container standalone sandbox acceptance: the same 26 checks pass,
  including preparation-crash recovery without relying on optional Linux
  checkpoint/restore procfs interfaces.
- Existing image-layout Docker and Apple acceptance pass. The existing kind
  nested and RuntimeClass paths pass, including restart and exit-status checks.
- `bun run build` and `git diff --check` pass.

The CI sandbox matrix is configured for **native Linux amd64 and arm64**,
including source and compiled execution. Native amd64 was not executed on this
local arm64 machine; its CI result remains a separate qualification requirement.
Cross-compilation or emulation is not counted as native runtime validation.

## Regression coverage and fixes

The suite verifies concrete resource state as well as status codes. It checks
that the guest cannot reach a controlled outer-host listener or create Unix,
IPv4, IPv6, TCP, or UDP sockets. Guest identity, capability bounding/effective
sets, `no_new_privs`, seccomp, input/root immutability, fixed environment, stdin,
and inherited descriptor targets are inspected. Job and preparation cgroups
must be empty before cleanup; the acceptance run leaves no job cgroups.

Artifact cases include exact bytes/hashes, nested files, symlinks, hardlinks,
FIFOs, sparse files, invalid paths, and count/byte limits. Prepared-image cases
include whiteouts, cross-layer links, digest mismatch, interpreter mutation,
capacity exhaustion, cache references, and rejection before an oversized layer
body is opened or copied into CAS.

Integration testing found and fixed three implementation-specific problems:

1. Blocking pipe readers could exhaust Bun's I/O worker pool and delay setup
   confirmation until the program exited. Native readiness-based pipe streams
   now preserve the close-on-exec setup/exec distinction without `/proc/cmdline`
   inference.
2. A hardcoded directory-open flag differed on arm64; an error path then closed
   a stale descriptor and masked the original error. Native filesystem constants
   and explicit descriptor ownership are now exercised on Linux.
3. Linux clears the parent-death signal during identity changes. The worker
   rearms it after GID/UID transitions, and seccomp prevents the guest from
   clearing it. A live looping guest is stopped by killing its guardian before
   the caller performs cleanup.

## Benchmark method

`bun run bench:sandbox:docker` performs five warmups and 100 measured sequential
jobs for each of two workloads: a no-op and JSON aggregation of 1,000 integers.
Each sample includes CLI launch, admission, prepared-environment verification,
namespace/cgroup setup, execution, collection, cleanup, and durable result
publication. Outer-host startup and image preparation are excluded from warm
samples. Timings cover request fixture writing as well as the invocation.

The harness stores every timing and available cgroup CPU/memory counter. It also
samples supervisor and guardian high-water RSS every 5 ms. These are sampled
process measurements, may miss short peaks, and include shared pages; they must
not be added together as private physical memory consumption. Cached image size,
remaining cgroup count, kernel, filesystem type IDs, image digest, and outer
invocation duration are recorded separately.

Raw logs, result bundles, and benchmark samples remain under ignored
`.bunc-output/sandbox-*/` directories. Re-run the command for the current source
and machine; the figures below are observations, not performance promises.

## Observed performance

The final run used Linux `6.12.76-linuxkit`, Docker, native arm64, and the
JavaScript distribution. No other bunc validation ran concurrently with this
sample. It remains a shared development machine, not an isolated performance
laboratory. Five warmups were discarded separately for each workload.

| Workload | Samples | p50 | p95 | Maximum | Mean guest cgroup CPU |
| --- | --- | --- | --- | --- | --- |
| No-op | 100 | 140.2 ms | 154.4 ms | 181.2 ms | 14.0 ms |
| JSON aggregation | 100 | 140.2 ms | 153.5 ms | 163.2 ms | 15.1 ms |

Environment-cold preparation took 1,499.7 ms and retained a 104.1 MiB prepared
tree. The maximum observed guest cgroup memory peak was 10.6 MiB. The sampled
supervisor RSS high-water mark was 57.5 MiB and guardian RSS was 26.4 MiB; these
figures overlap through shared pages. Every measured job cleaned up completely,
and the final job cgroup count was zero. The complete outer lab invocation,
including startup, 26 acceptance cases, preparation/recovery, warmups, and the
200 measured jobs, took 38.3 seconds. This is not a single-job cold-start time.

The approved image manifest was
`sha256:1b3012c7df5ba6c43c9f3e8c88d45fe6f4d5c234ca78154e91fe95daa288f30b`.
The local raw record is
`.bunc-output/sandbox-docker-iPzOIm/results/acceptance.json`; its sibling
`lab.json` records the outer host configuration and invocation timing. These
generated files are intentionally ignored by Git.

## Before a release claims this profile

- Require green native amd64 and arm64 CI, including Linux artifact tests and
  standalone acceptance.
- Verify the exact prepared release assets through the existing provenance
  workflow; local builds are not signed release evidence.
- Keep the trusted-image, rootful, disposable-host scope explicit.
- Review any syscall, native ABI, ownership/recovery, or path-handling change
  against the adversarial acceptance cases.
- Treat unsupported controls as admission/setup failures. Never turn a missing
  kernel facility into a weaker silent fallback.

No Python support, network broker, rootless mode, parallel job scheduler,
process snapshots, signed execution receipts, or public SDK package is claimed.
