# bunc

An experimental Linux container runtime powered by Bun.

**Bun + OCI images + Linux namespaces.** bunc reads a local OCI image layout,
prepares its root filesystem, and executes the image's original entrypoint using
Bun FFI and Linux syscalls. The included example runs an unchanged
[bunko](https://github.com/sakajunquality/bunko)-built Bun web application.

The name is inspired by runc. **bunc is an experiment, not a drop-in replacement
for runc or an implementation of the OCI Runtime Specification.** Use trusted
images in a disposable development environment. It is not a production security
boundary; see [SECURITY.md](SECURITY.md).

## Quick start on macOS

You need Bun **1.4.2** and either Docker Desktop or
[Apple Container](https://github.com/apple/container). The app runs in a disposable
Linux environment supplied by your chosen backend.

```sh
git clone https://github.com/sakajunquality/bunc.git
cd bunc
bun install --frozen-lockfile --ignore-scripts

# With Docker Desktop already running:
bun run demo:docker

# Or with Apple Container installed:
container system start
bun run demo:apple
```

The first run uses the pinned bunko dev dependency to build `examples/web` into
`.bunc-output/image`. The application base is `oven/bun:1.4.2-distroless`; this
initial build needs network access. Subsequent runs reuse that layout. The
runtime itself reads only local image files and does not contact registries.

Open the URL printed by the launcher. Docker uses `http://127.0.0.1:18080/`;
Apple Container uses the VM's assigned IPv4 address on port 8080. Press Ctrl-C
to stop the application and remove the disposable host. The image and local
logs remain under the ignored `.bunc-output/` directory.

```sh
# Choose a different Docker host port:
bun scripts/lab.ts docker --port 18082

# Run an existing OCI layout:
bun scripts/lab.ts apple --layout /absolute/path/to/image

# Verify the included example and stop automatically:
bun run test:docker
bun run test:apple
```

The demo launcher expects HTTP success at `/` on port 8080. Its `--verify` mode
also expects the included example's diagnostic JSON. `--port` applies to Docker
only. The lower-level runtime has no HTTP or application-language requirement.
Apple's VM-IP route is used because localhost port forwarding reset connections
in the original local experiment; the cause was not established.

To rebuild the example after editing it, choose a fresh output directory:

```sh
bunx --no-install @sakajunquality/bunko build examples/web \
  --base oven/bun:1.4.2-distroless --platform linux/arm64 \
  --push=false --git-metadata=false --oci-layout .bunc-output/image-next
bun scripts/lab.ts apple --layout .bunc-output/image-next
```

Use `linux/amd64` on an x64 host. bunc executes the native Linux architecture;
it does not provide emulation. The outer Linux host image is independently pinned
by digest in `scripts/lab.ts`.

## Direct execution on Linux

The runtime needs Bun 1.4.2, glibc, util-linux `unshare`, root privileges, and
permission to create namespaces and mounts. Start with the disposable demo
backend above rather than running it as root on a machine you rely on.

Inside a suitable disposable Linux host:

```sh
bun run build
bun dist/bunc.js run /path/to/oci-layout
```

`bun src/runtime.ts run /path/to/oci-layout` also works from a checkout with its
dependencies installed. `bun dist/bunc.js --help` prints the command syntax.
There is no npm or binary release of bunc yet; `package.json` is marked private
to prevent accidental package publication.

## How it works

```text
macOS / Linux: demo launcher (optional)
  └─ Docker Linux host or Apple Container VM
      └─ bunc supervisor (Bun, root)
          ├─ verify OCI metadata, blob digests, and layer DiffIDs
          ├─ unpack layers into a temporary rootfs
          └─ unshare: mount / PID / UTS / IPC namespaces
              └─ worker (Bun + bun:ffi)
                  ├─ mount procfs, tmpfs, and minimal devices
                  ├─ pivot_root and detach the outer root
                  ├─ make the image filesystem read-only
                  ├─ clear groups, set no_new_privs, set UID/GID
                  └─ execve the image Entrypoint + Cmd
                      └─ application as PID 1
```

Bun is multithreaded, so `unshare` supplies the small namespace/fork bootstrap.
The worker performs mounts, root switching, identity changes, and `execve`
through libc with `bun:ffi`. It uses the application image's own executable,
including its own Bun runtime. It does not call Docker, runc, or containerd to
launch the inner application. Docker/Apple supplies the outer Linux environment.

The launcher mounts only the generated runtime directory and selected image
layout, both read-only. It does not mount a Docker socket, the repository's
`.git` directory, or your home directory. It grants the outer Linux host broad
privileges for the experiment (Docker `--privileged`, Apple `--cap-add ALL`) and
allocates 2 CPUs and 1 GiB RAM.

## Current scope

- Local OCI image layouts with sha256-addressed content and native Linux
  arm64/amd64 selection, including nested indexes.
- Plain tar, gzip, and zstd layers; regular files, directories, basic whiteouts,
  opaque directories, symlinks, and hardlinks.
- Original image entrypoint, arguments, environment, and working directory.
- Nonroot image users only; an unspecified user defaults to `65532:65532`.
- Read-only rootfs, private writable `/tmp` and `/dev/shm`, minimal `/dev`,
  private PID/UTS/IPC/mount namespaces, and explicit signal forwarding.
- Bounded unpacking: 512 MiB decoded per layer, 1 GiB cumulative file contents,
  and 100,000 archive entries. Filesystems are copied, not overlay-mounted.

**Not implemented:** OCI runtime bundles or lifecycle API, registry pull/auth,
rootless/user namespaces, seccomp, a complete capability policy, per-app cgroups,
independent networking/CNI, DNS-file injection, volumes, healthchecks, image
`StopSignal`, exec/attach, emulation, complete tar/xattr/device support, or a
general init/reaper. The app shares its disposable host's network namespace.
The glibc requirement applies to the bunc worker's environment; application
compatibility is limited to what has actually been tested.

Local acceptance has exercised arm64 with both Docker and Apple Container 1.0.0.
The GitHub Actions workflow is configured to exercise Docker on Linux amd64;
native amd64 acceptance has not yet been verified. The checks cover
HTTP 200/404, image configuration, PID 1, nonroot execution, root visibility,
read-only rootfs, writable tmp, exclusion of outer environment variables, zero
effective capabilities, `no_new_privs`, graceful SIGTERM, and rootfs cleanup.
These checks demonstrate the example; they are not a sandbox certification.

## Development

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun run build
bun run test:docker
# On an Apple silicon Mac with Apple Container running:
bun run test:apple
```

Unit tests cover OCI selection, corrupted/missing content, compression and
DiffID validation, whiteouts, traversal rejection, and image symlink handling.
Acceptance results and logs are written to `.bunc-output/results/` and are not
committed. A single GitHub Actions job runs type checking, unit tests, bundling,
and the Docker acceptance checks.

- `src/runtime.ts`: supervisor, image process configuration, signals, cleanup.
- `src/worker.ts`: namespace worker and Linux syscalls.
- `src/rootfs.ts`: rootfs extraction and image path resolution.
- `src/oci/`: local OCI reading adapted from bunko, with no checkout dependency.
- `scripts/lab.ts`: disposable Docker/Apple launcher and acceptance checks.
- `examples/web/`: the bunko-built example application.

Code and documentation are in English. See [AGENTS.md](AGENTS.md) for contributor
verification requirements.

## License

MIT. OCI reading code was adapted from bunko; attribution is retained in
[NOTICE](NOTICE) and [LICENSE](LICENSE).
