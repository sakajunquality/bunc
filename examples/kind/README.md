# bunc on kind

These are two different experiments. Both run the same bunko-built Bun web app:

| Path | What starts the application | Privilege boundary |
| --- | --- | --- |
| Nested Pod | A standalone bunc binary inside a normal Kubernetes Pod reads an OCI image layout | The outer Pod is privileged; its normal containerd/runc runtime supplies the host |
| RuntimeClass | containerd's runc-v2 shim calls bunc's experimental lifecycle commands with an OCI runtime bundle | bunc runs on the disposable kind node and starts both the sandbox and application |

Neither path is a production sandbox or a claim of OCI Runtime Specification
conformance. Do not install this handler on an existing cluster. Use trusted
images and the disposable cluster created by the script. The default runc handler
continues to run Kubernetes system Pods.

This integration is available from source; the initial `v0.1.0-alpha.1` release
predates the OCI lifecycle interface.

## Run both acceptance paths

Requirements: Bun 1.4.2, Docker with a native Linux arm64/amd64 engine, `kubectl`,
and network access for the first image/tool downloads. Use a kubectl version
compatible with Kubernetes 1.34. Allow several GiB of Docker memory and disk space.
Apple Container is supported by the separate web demo, but this kind experiment
uses Docker as its node provider.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run test:kind
```

The script downloads kind v0.33.0, checks its pinned SHA-256 before execution,
and uses a digest-pinned Kubernetes v1.34.11 node. It compiles bunc, builds the web
image with bunko, and loads images locally without pushing to a registry. The
nested image contains the compiled binary and OCI layout; its outer Bun executable
is removed. The RuntimeClass app uses the original bunko image directly, without
wrapping its entrypoint or adding bunc to the image.

Each run creates a uniquely named cluster and a separate kubeconfig under
`.bunc-output/kind-*`. Every kubectl command selects that kubeconfig and context.
Your default kubeconfig and existing clusters are not changed. The script deletes
its cluster and its uniquely tagged nested image in `finally`; build products,
logs, downloaded tools and validation evidence stay in the ignored output folder.
An interrupted process that cannot run its cleanup may leave its named cluster;
inspect the printed name before deleting it with kind.

The acceptance check covers:

- HTTP 200/404 through Kubernetes port forwarding, for both paths.
- Image arguments, working directory, Bun version, nonroot UID/GID, PID 1,
  hostname, read-only root, writable tmp, zero effective capabilities and
  `no_new_privs`.
- RuntimeClass application exit code 42, reported by containerd to Kubernetes,
  followed by a Kubernetes restart and another successful HTTP request.
- State records for both the bunc sandbox and app, and removal after Pod deletion.

The test-only `/exit` endpoint requires `BUNC_TEST_EXIT=1` and POST. The
RuntimeClass manifest enables it to verify exit reporting. Remove that environment
variable when adapting the example. No lifecycle commands are delegated to runc.

## Files

- `nested.yaml`: the privileged outer Pod; no RuntimeClass is needed.
- `Dockerfile`: the nested image, built from the script's generated context.
- `runtimeclass.yaml`: RuntimeClass and a nonroot app with dropped capabilities,
  RuntimeDefault seccomp, read-only root, bounded CPU/memory and an emptyDir tmp.
- `containerd.toml`: handler configuration appended only inside the disposable node.
- `bunc-oci`: node-local wrapper that explicitly opts in with `--experimental-oci`.

Do not apply the RuntimeClass manifest alone to an arbitrary cluster. The handler
binary, wrapper and containerd configuration must first exist on its nodes. The
script installs them only in the node it owns. No host Docker socket or host home
folder is mounted into either application.

## Experimental lifecycle profile

`bunc --experimental-oci` accepts the subset used by these examples:
`create`, `start`, `state`, `kill`, `delete`, `ps`, and `features`.
containerd supplies the rootfs and process configuration; bunc does not unpack an
image in this mode. The existing `bunc run OCI_LAYOUT` path is unchanged.

Bun's embedded C compiler builds a small header-free bootstrap in the private
state directory. After `fork`, only libc calls execute; the child joins/creates
namespaces and immediately execs the standalone bunc worker. A double fork lets
containerd's subreaper adopt the real init PID. No compiler executable, runc
fallback or supervisor that fabricates exit codes is used. The worker sets up
mounts, pivots the root, drops capabilities and identity, and blocks on a FIFO
until `start`. Signals use pidfds and a recorded process start time to avoid
signalling a recycled PID.

The profile requires Linux glibc, cgroup v2, kernel BPF device filtering,
`libseccomp.so.2`, util-linux/coreutils (`mkfifo`), nonroot processes, private PID
and mount namespaces, explicit network/IPC/UTS namespaces, no_new_privs and a
read-only root. The supplied kind node provides these dependencies. It implements:

- Joining containerd/CNI's sandbox namespaces and bind mounting DNS/hosts files.
  CNI itself remains containerd's responsibility.
- Validated proc/tmpfs/devpts/mqueue/sysfs/cgroup and bind mounts; symlink
  mountpoints and unknown mount options are rejected.
- Masked and read-only paths, cleared capability bounding/effective sets, numeric
  supplementary groups, and an optional NOFILE resource limit.
- Native-ABI, deny-by-default seccomp through libseccomp, including argument
  comparisons. Compatibility ABIs remain denied. Unknown native syscall names
  remain denied; permissive default actions and unsupported rules are rejected.
- A cgroupfs child beneath kubelet's existing pod slice, CPU weight/quota,
  memory/swap/pids limits and the narrow unified controls used by containerd.
  The handler accepts containerd's systemd-style cgroup path but does not manage
  systemd units or provide a general systemd cgroup driver.
- A cgroup v2 BPF device filter allowing only standard character devices and PTYs.
  No block devices or custom OCI device rules are accepted.

The sandbox's requested capabilities are also dropped; the tested pause image
requires none. This is a deliberately stricter lab policy, not general OCI
capability compatibility. Root containers, rootless/user namespaces, custom
hooks/devices, TTY/exec/attach, update/pause/checkpoint, arbitrary LSM profiles,
and arbitrary resource controllers are not supported. Unsupported fields are
rejected rather than treated as implemented. No general init/reaper is provided
inside the application namespace: applications must reap their own children.

The implementation and examples are for controlled development only. Passing
these tests does not validate a hostile-image security boundary.
