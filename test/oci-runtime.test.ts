import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareDeviceLinks } from "../src/oci-runtime/worker.ts";
import { describe, expect, test } from "bun:test";
import { validateSpec, type Spec } from "../src/oci-runtime/spec.ts";
import { cgroupPath } from "../src/oci-runtime/cgroup.ts";
import { validateSeccomp } from "../src/oci-runtime/seccomp.ts";
const minimal = (): Spec => ({
  ociVersion: "1.3.0", root: { path: "rootfs", readonly: true },
  process: { args: ["/bin/app"], cwd: "/", user: { uid: 65532, gid: 65532 }, noNewPrivileges: true, capabilities: {} },
  linux: { namespaces: ["pid", "mount", "network", "ipc", "uts"].map(type => ({ type })) },
});
describe("experimental OCI profile", () => {
  test("accepts nonroot read-only workloads and joins sandbox namespaces", () => {
    const s = minimal(); s.linux.namespaces.find(n => n.type === "network")!.path = "/proc/123/ns/net";
    expect(() => validateSpec(s)).not.toThrow();
  });
  test.each(["root", "writable", "capabilities", "tty", "newprivs", "hooks", "devices", "userns", "sharedpid", "mountescape", "mountpropagation", "unknownfield", "negativecpu"])("rejects unsupported policy: %s", kind => {
    const s = minimal();
    switch (kind) {
      case "root": s.process.user.uid = 0; break;
      case "writable": s.root.readonly = false; break;
      case "capabilities": s.process.capabilities = { effective: ["CAP_SYS_ADMIN"] }; break;
      case "tty": s.process.terminal = true; break;
      case "newprivs": s.process.noNewPrivileges = false; break;
      case "hooks": s.hooks = {}; break;
      case "devices": s.linux.devices = [{}]; break;
      case "userns": s.linux.namespaces.push({ type: "user" }); break;
      case "sharedpid": s.linux.namespaces[0]!.path = "/proc/1/ns/pid"; break;
      case "mountescape": s.mounts = [{ type: "bind", source: "/tmp", destination: "/../../host" }]; break;
      case "mountpropagation": s.mounts = [{ type: "bind", source: "/tmp", destination: "/tmp", options: ["rshared"] }]; break;
      case "unknownfield": Object.assign(s.process, { scheduler: {} }); break;
      case "negativecpu": s.linux.resources = { cpu: { quota: -2 } }; break;
    }
    expect(() => validateSpec(s)).toThrow();
  });
  test("rejects mounting a parent cgroup namespace", () => {
    const s = minimal(); s.linux.namespaces.push({ type: "cgroup", path: "/proc/1/ns/cgroup" });
    expect(() => validateSpec(s)).toThrow();
  });
  test("cgroup path expands the kubelet slice hierarchy without traversal", () => {
    expect(cgroupPath("kubelet-kubepods-pod123.slice:cri-containerd:abc")).toBe("/sys/fs/cgroup/kubelet.slice/kubelet-kubepods.slice/kubelet-kubepods-pod123.slice/cri-containerd-abc.scope");
    for (const value of ["/../../sys", "foo.slice:../bar:abc", "foo.slice:bar:a/b", "foo:bar:baz"]) expect(() => cgroupPath(value)).toThrow();
  });
  test("seccomp rejects permissive defaults, unknown operations and unsafe integers", () => {
    expect(() => validateSeccomp({ defaultAction: "SCMP_ACT_ALLOW" })).toThrow();
    expect(() => validateSeccomp({ defaultAction: "SCMP_ACT_ERRNO", syscalls: [{ names: ["clone"], action: "SCMP_ACT_ALLOW", args: [{ index: 0, value: 1, op: "unknown" }] }] })).toThrow();
    expect(() => validateSeccomp({ defaultAction: "SCMP_ACT_ERRNO", syscalls: [{ names: ["clone"], action: "SCMP_ACT_ALLOW", args: [{ index: 0, value: 2 ** 64, op: "SCMP_CMP_EQ" }] }] })).toThrow();
  });
});


describe("existing device aliases", () => {
  test("replaces regular files and dangling links without touching their targets", () => {
    const root = mkdtempSync(join(tmpdir(), "bunc-device-test-")), dev = join(root, "dev");
    try {
      mkdirSync(dev);
      writeFileSync(join(root, "outside"), "preserve");
      writeFileSync(join(dev, "stdin"), "old entry");
      symlinkSync("/missing-device-target", join(dev, "stdout"));
      symlinkSync(join(root, "outside"), join(dev, "stderr"));
      prepareDeviceLinks(dev);
      prepareDeviceLinks(dev);
      expect(readlinkSync(join(dev, "stdin"))).toBe("/proc/self/fd/0");
      expect(readlinkSync(join(dev, "stdout"))).toBe("/proc/self/fd/1");
      expect(readlinkSync(join(dev, "stderr"))).toBe("/proc/self/fd/2");
      expect(readFileSync(join(root, "outside"), "utf8")).toBe("preserve");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("refuses directories and a symlinked device parent", () => {
    const root = mkdtempSync(join(tmpdir(), "bunc-device-test-")), dev = join(root, "dev");
    try {
      mkdirSync(dev); mkdirSync(join(dev, "fd")); writeFileSync(join(dev, "fd", "keep"), "preserve");
      expect(() => prepareDeviceLinks(dev)).toThrow("Cannot replace device directory");
      expect(readFileSync(join(dev, "fd", "keep"), "utf8")).toBe("preserve");
      symlinkSync(dev, join(root, "alias"));
      expect(() => prepareDeviceLinks(join(root, "alias"))).toThrow("Device directory must not be a symlink");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
