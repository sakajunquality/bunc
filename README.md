# bunc

An experimental Linux container runtime powered by Bun.

**Bun + OCI images + Linux namespaces.** bunc reads a local OCI image layout,
prepares its root filesystem, and executes the image's original entrypoint using
Bun FFI and Linux syscalls. The included example runs an unchanged
[bunko](https://github.com/sakajunquality/bunko)-built Bun web application.

The name is inspired by runc. **bunc is an experiment, not a drop-in replacement
for runc or a conformant implementation of the OCI Runtime Specification.** Use trusted
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

# Use a standalone bunc executable inside either backend:
bun run demo:docker:standalone
bun run demo:apple:standalone
```

The first run uses the pinned bunko dev dependency to build `examples/web` into
`.bunc-output/image`. The application base is `oven/bun:1.4.2-distroless`; this
initial build needs network access. Subsequent runs reuse that layout. The
runtime itself reads only local image files and does not contact registries.
See [the web example](examples/web/README.md) for both execution modes.

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

## Standalone Linux executables

[bun build --compile](https://bun.com/docs/bundler/executables) embeds bunc's code,
JavaScript dependencies, and Bun runtime into one executable. Build on macOS or
Linux with Bun 1.4.2:

```sh
bun run build:binary arm64  # dist/bin/bunc-linux-arm64
bun run build:binary x64    # dist/bin/bunc-linux-x64
```

Omit the architecture to use the build machine's architecture; the target OS is
always Linux. The compiler may download the corresponding Bun target runtime on
the first build. The output runs without a separate Bun installation or
node_modules. Environment-file and bunfig auto-loading are disabled in the
compiled executable.

Copy the matching binary into a suitable disposable Linux environment and run:

```sh
./bunc-linux-arm64 run /path/to/oci-layout
```

The executable still requires **Linux, glibc, util-linux `unshare`, root privileges,
and permission to create namespaces and mounts**. It is not statically linked,
does not embed `unshare`, and does not provide a Linux VM on macOS. The application
image separately provides its executable and runtime. For the web example, that
means the application's own Bun remains inside its OCI image.

The namespace worker re-executes the same compiled binary, so no extracted
JavaScript entrypoint is needed. The arm64 executable built with Bun 1.4.2 is
approximately 78 MiB; size depends on the compiler and target.

```sh
# Test without a separately installed Bun in the disposable Linux host:
bun run test:docker:standalone
bun run test:apple:standalone
```

These checks remove the outer host's Bun executable, mount only the generated
binary directory and image layout, and verify startup, HTTP, isolation probes,
signal delivery, and cleanup. Each standalone demo compiles into a private
`.bunc-output/standalone-*` directory so simultaneous demos do not replace each
other's running executable. Successful teardown removes that directory. The
macOS demo launcher and build steps themselves still use Bun.

The JavaScript distribution remains available for development:

```sh
bun run build
bun dist/bunc.js run /path/to/oci-layout
# Or from a checkout with dependencies installed:
bun src/runtime.ts run /path/to/oci-layout
```

Release preparation, signed GitHub assets, and installation verification are
documented in [the release guide](docs/RELEASING.md). `package.json` remains private
to prevent accidental npm publication. Generated executables are ignored by Git.

## Kubernetes / kind experiments

[The kind examples](examples/kind/README.md) exercise both a privileged Pod running
bunc inside it and a RuntimeClass whose containerd shim invokes bunc directly.
Run `bun run test:kind` from a source checkout to build the examples, create a
separate disposable cluster, verify both paths, and clean up. The initial
`v0.1.0-alpha.1` release predates this integration.

The RuntimeClass path is an explicit `--experimental-oci` profile with a limited
lifecycle interface, cgroup v2 controls and native seccomp. It requires additional
Linux facilities supplied by the kind node. It is not a general runc replacement;
see the example's requirements and unsupported features before using it.

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

**Not implemented in the image-layout `run` path:** OCI runtime bundles or lifecycle API, registry pull/auth,
rootless/user namespaces, seccomp, a complete capability policy, per-app cgroups,
independent networking/CNI, DNS-file injection, volumes, healthchecks, image
`StopSignal`, exec/attach, emulation, complete tar/xattr/device support, or a
general init/reaper. The app shares its disposable host's network namespace.
The glibc requirement applies to the bunc worker's environment; application
compatibility is limited to what has actually been tested.

Local acceptance has exercised arm64 with both Docker and Apple Container 1.0.0.
Docker acceptance also passed on Linux amd64 in GitHub Actions. The checks cover
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
bun run test:docker:standalone
# On an Apple silicon Mac with Apple Container running:
bun run test:apple
bun run test:apple:standalone
```

Unit tests cover OCI selection, corrupted/missing content, compression and
DiffID validation, whiteouts, traversal rejection, and image symlink handling.
Acceptance results and logs are written to `.bunc-output/results/` and are not
committed. GitHub Actions runs type checking, unit tests, bundling, both Docker execution
modes, and the kind experiment on native Linux amd64 and arm64.

- `src/runtime.ts`: supervisor, image process configuration, signals, cleanup.
- `src/worker.ts`: namespace worker and Linux syscalls.
- `src/rootfs.ts`: rootfs extraction and image path resolution.
- `src/oci/`: local OCI reading adapted from bunko, with no checkout dependency.
- `scripts/lab.ts`: disposable Docker/Apple launcher and acceptance checks.
- `src/oci-runtime/`: the opt-in containerd lifecycle profile and native bootstrap.
- `scripts/kind.ts`, `examples/kind/`: disposable Kubernetes acceptance for both paths.
- `scripts/compile.ts`: standalone Linux arm64/x64 builds.
- `scripts/release.ts`, `scripts/verify-release.ts`: candidate preparation and verification.
- `examples/web/`: the bunko-built example application.

Code and documentation are in English. See [AGENTS.md](AGENTS.md) for contributor
verification requirements.

## License

MIT. OCI reading code was adapted from bunko; attribution is retained in
[NOTICE](NOTICE) and [LICENSE](LICENSE).
