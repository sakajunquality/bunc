# Security scope

bunc is a development experiment for trusted images in disposable Linux hosts.
Do not use it for untrusted workloads, multitenant isolation, or production.

The demo launches a privileged Docker host or an Apple Container VM with all
Linux capabilities. The inner app drops to a nonroot UID/GID, has no effective
capabilities, sets no_new_privs, and uses a read-only rootfs. These measures do
not constitute a complete sandbox: seccomp, rootless operation, per-app cgroups,
a complete capability policy, and network isolation are not implemented.

The unpacker checks archive paths and validates content digests, but is not an
authenticity verifier or a comprehensive hostile-image parser. A valid digest
does not establish that an image is trustworthy. The outer host and all files
selected through --layout must be treated as part of the experiment's trust
boundary. Do not mount sensitive directories or a container-daemon socket.

Automated checks are regression tests for supported behavior, not a security
audit or proof of OCI Runtime Specification compliance. If you report a problem,
use a minimal synthetic reproducer and remove credentials and private image
contents before sharing it.
