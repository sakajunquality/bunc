# Security scope

bunc is a development experiment for trusted images in disposable Linux hosts.
Do not use it for untrusted workloads, multitenant isolation, or production.

The image-layout demo launches a privileged Docker host or an Apple Container VM with all
Linux capabilities. The inner app drops to a nonroot UID/GID, has no effective
capabilities, sets no_new_privs, and uses a read-only rootfs. These measures do
not constitute a complete sandbox: seccomp, rootless operation, per-app cgroups,
a complete capability policy, and network isolation are not implemented.

The unpacker checks archive paths and validates content digests, but is not an
authenticity verifier or a comprehensive hostile-image parser. A valid digest
does not establish that an image is trustworthy. The outer host and all files
selected through --layout must be treated as part of the experiment's trust
boundary. Do not mount sensitive directories or a container-daemon socket.

The separate kind RuntimeClass experiment adds a bounded native seccomp profile,
cgroup v2 resource/device controls, and containerd-provided namespace and mount
configuration. These additions do not establish a production security boundary.
It intentionally supports only nonroot, read-only-root workloads in a disposable
node. The bootstrap forks from a multithreaded Bun process and executes only
native libc calls before exec; this remains experimental. Never configure the
handler as a cluster's default runtime or install it on a shared/production node.
See [the supported profile](examples/kind/README.md).

Automated checks are regression tests for supported behavior, not a security
audit or proof of OCI Runtime Specification compliance. If you report a problem,
use a minimal synthetic reproducer and remove credentials and private image
contents before sharing it.
