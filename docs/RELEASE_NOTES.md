# Release notes

## 0.1.0-alpha.1

First experimental release of bunc, a Linux container runtime powered by Bun.

- Run a local bunko-produced OCI image with its original entrypoint, environment,
  and working directory.
- Download standalone Linux arm64 and x64 executables; no separate host Bun
  installation is needed. Linux, glibc, util-linux `unshare`, and suitable root
  privileges are still required.
- Try the included Bun web app through Docker or Apple Container on macOS.
- Verify release checksums and GitHub build provenance before execution.

This alpha is for trusted images in disposable development environments. It is
not a production sandbox or an OCI Runtime Specification implementation. See
SECURITY.md and the README for supported behavior and current limitations.
