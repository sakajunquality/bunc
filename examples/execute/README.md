# Ephemeral Bun jobs

This example is a request for the experimental offline job path. The operator
approves a local Bun image; the caller supplies TypeScript/JavaScript source and
small input files. Every invocation gets fresh writable storage. Only bounded
stdout, stderr, verified `/output` files, and supervisor metadata are retained.

Run the disposable acceptance lab from the repository root:

```sh
bun run test:sandbox:docker
# Or, with Apple Container running:
bun run test:sandbox:apple
```

The lab prepares a native Bun environment, exercises JSON aggregation, text
reports, binary roundtrips, failure/retry, cancellation, limits, hostile artifact
names, and crash recovery. Evidence stays under `.bunc-output/sandbox-*/`.
It runs synthetic programs in a privileged disposable outer host; do not attach
sensitive host paths, credentials, or a Docker socket.

[`request.json`](request.json) sums a supplied JSON array and writes
`result.json` and `report.txt`. See [the operator and SDK guide](../../docs/SANDBOX.md)
for direct invocation and the trust boundary.

After `bun run build` and operator preparation inside a disposable Linux host,
[`run.ts`](run.ts) demonstrates a failed attempt followed by the corrected
request through the local SDK:

```sh
bun examples/execute/run.ts /trusted/environment.json /trusted/policy.json \
  /var/lib/bunc-sandbox /trusted/results /sys/fs/cgroup/bunc-jobs
```

The caller owns revision; the runner does not call a model or retry implicitly.
