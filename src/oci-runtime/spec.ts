import { validateSeccomp, type Seccomp } from "./seccomp.ts";
export interface Mount { destination: string; source: string; type: string; options?: string[] }
export interface Spec {
  ociVersion: string;
  root: { path: string; readonly?: boolean };
  process: { args: string[]; env?: string[]; cwd: string; terminal?: boolean; noNewPrivileges?: boolean; user: { uid: number; gid: number; additionalGids?: number[] }; capabilities?: Record<string, string[]>; oomScoreAdj?: number; rlimits?: { type: string; hard: number; soft: number }[]; apparmorProfile?: string; selinuxLabel?: string };
  hostname?: string;
  mounts?: Mount[];
  annotations?: Record<string, string>;
  linux: { namespaces: { type: string; path?: string }[]; cgroupsPath?: string; resources?: { devices?: { allow: boolean; access: string }[]; cpu?: { shares?: number; quota?: number; period?: number }; memory?: { limit?: number; swap?: number }; pids?: { limit: number }; unified?: Record<string, string> }; sysctl?: Record<string, string>; seccomp?: Seccomp; maskedPaths?: string[]; readonlyPaths?: string[]; devices?: unknown[]; uidMappings?: unknown[]; gidMappings?: unknown[]; mountLabel?: string };
  hooks?: unknown;
}
const validText = (value: unknown): value is string => typeof value === "string" && !value.includes("\0");
export function validateSpec(value: unknown): asserts value is Spec {
  const s = value as Spec;
  const fail = (message: string): never => { throw new Error(`Experimental OCI profile: ${message}`); };
  const keys = (object: object, allowed: string[], label: string) => {
    for (const key of Object.keys(object)) if (!allowed.includes(key)) fail(`unsupported ${label} field: ${key}`);
  };
  if (!s || !/^1\.[0-3]\.\d+$/.test(s.ociVersion ?? "")) fail("unsupported specification version");
  keys(s, ["ociVersion", "root", "process", "hostname", "mounts", "annotations", "linux", "hooks"], "specification");
  if (!s.root || !validText(s.root.path) || s.root.readonly !== true) fail("a read-only root filesystem is required");
  keys(s.root, ["path", "readonly"], "root");
  const p = s.process;
  if (!p || !Array.isArray(p.args) || !p.args.length || !p.args.every(validText) || !p.args[0]?.startsWith("/")) fail("an absolute executable is required");
  keys(p, ["args", "env", "cwd", "terminal", "noNewPrivileges", "user", "capabilities", "oomScoreAdj", "rlimits", "apparmorProfile", "selinuxLabel"], "process");
  keys(p.user, ["uid", "gid", "additionalGids"], "user");
  if (!validText(p.cwd) || !p.cwd.startsWith("/") || p.env?.some(x => !validText(x) || x.indexOf("=") < 1)) fail("invalid process configuration");
  if (p.terminal || p.noNewPrivileges !== true || p.apparmorProfile || p.selinuxLabel) fail("TTY/LSM profiles are unsupported; noNewPrivileges is required");
  if (![p.user?.uid, p.user?.gid].every(x => Number.isInteger(x) && x > 0 && x <= 0xffffffff)) fail("only nonroot processes are supported");
  if (p.user.additionalGids?.some(x => !Number.isInteger(x) || x < 0 || x > 0xffffffff)) fail("invalid supplementary group");
  const sandbox = s.annotations?.["io.kubernetes.cri.container-type"] === "sandbox";
  if (!sandbox && Object.values(p.capabilities ?? {}).some(list => list.length)) fail("all capabilities must be dropped");
  if (s.hooks || s.linux?.mountLabel || s.linux?.devices?.length || s.linux?.uidMappings || s.linux?.gidMappings) fail("hooks, LSM labels, custom devices and user namespaces are unsupported");
  if (s.linux?.seccomp) validateSeccomp(s.linux.seccomp);
  keys(s.linux, ["namespaces", "cgroupsPath", "resources", "sysctl", "seccomp", "maskedPaths", "readonlyPaths", "devices", "uidMappings", "gidMappings", "mountLabel"], "Linux");
  const ns = s.linux?.namespaces;
  if (!Array.isArray(ns) || new Set(ns.map(n => n.type)).size !== ns.length) fail("invalid namespaces");
  for (const n of ns) {
    keys(n, ["type", "path"], "namespace");
    if ((n.type === "cgroup" && n.path) || !["pid", "mount", "network", "ipc", "uts", "cgroup"].includes(n.type) || (n.path !== undefined && (!validText(n.path) || !n.path.startsWith("/")))) fail("unsupported namespace");
  }
  if (!["pid", "mount"].every(type => ns.some(n => n.type === type && !n.path)) || !["network", "ipc", "uts"].every(type => ns.some(n => n.type === type))) fail("private PID/mount and explicit network/IPC/UTS namespaces are required");
  if (s.hostname && ns.find(n => n.type === "uts")?.path) fail("cannot change a shared UTS hostname");
  for (const [key, val] of Object.entries(s.linux.sysctl ?? {})) {
    if (!["net.ipv4.ip_unprivileged_port_start", "net.ipv4.ping_group_range"].includes(key) || !/^[\d ]+$/.test(val)) fail("unsupported sysctl");
  }
  for (const m of s.mounts ?? []) {
    keys(m, ["destination", "source", "type", "options"], "mount");
    if (!validText(m.destination) || !m.destination.startsWith("/") || m.destination === "/" || m.destination.split("/").includes("..") || !validText(m.source)) fail("invalid mount path");
    if (!["bind", "proc", "tmpfs", "sysfs", "devpts", "mqueue", "cgroup"].includes(m.type)) fail(`unsupported mount type: ${m.type}`);
    if (m.type === "bind" && !m.source.startsWith("/")) fail("bind source must be absolute");
    for (const o of m.options ?? []) if (!/^(ro|rw|bind|rbind|rprivate|nosuid|nodev|noexec|relatime|strictatime|newinstance|mode=\d+|size=\d+[kmg]?|gid=\d+|ptmxmode=\d+)$/.test(o)) fail(`unsupported mount option: ${o}`);
  }
  for (const path of [...s.linux.maskedPaths ?? [], ...s.linux.readonlyPaths ?? []]) if (!validText(path) || !path.startsWith("/") || path.split("/").includes("..")) fail("invalid protected path");
  for (const limit of p.rlimits ?? []) if (limit.type !== "RLIMIT_NOFILE" || ![limit.soft, limit.hard].every(x => Number.isSafeInteger(x) && x >= 0) || limit.soft > limit.hard) fail("unsupported resource limit");
  if (p.oomScoreAdj !== undefined && (!Number.isInteger(p.oomScoreAdj) || p.oomScoreAdj < -1000 || p.oomScoreAdj > 1000)) fail("invalid OOM score adjustment");
  const r = s.linux.resources;
  for (const section of [r?.cpu, r?.memory, r?.pids]) for (const value of Object.values(section ?? {})) if (!Number.isSafeInteger(value) || value < -1) fail("invalid resource value");
  if (r?.cpu?.shares !== undefined && (r.cpu.shares < 2 || r.cpu.shares > 262144)) fail("CPU shares out of range");
  if (r?.cpu?.period !== undefined && (r.cpu.period < 1000 || r.cpu.period > 1000000)) fail("CPU period out of range");
  if (r?.devices?.some(d => d.allow || d.access !== "rwm" || Object.keys(d).some(k => !["allow", "access"].includes(k)))) fail("custom device rules are unsupported");
  for (const key of Object.keys(r ?? {})) if (!["devices", "cpu", "memory", "pids", "unified"].includes(key)) fail(`unsupported resource controller: ${key}`);
  for (const key of Object.keys(r?.cpu ?? {})) if (!["shares", "quota", "period"].includes(key)) fail(`unsupported CPU option: ${key}`);
  for (const key of Object.keys(r?.memory ?? {})) if (!["limit", "swap"].includes(key)) fail(`unsupported memory option: ${key}`);
  for (const [key, val] of Object.entries(r?.unified ?? {})) if (!["memory.oom.group", "memory.swap.max"].includes(key) || !/^(\d+|max)$/.test(val)) fail(`unsupported unified control: ${key}`);
}
