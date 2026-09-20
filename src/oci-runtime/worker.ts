import { prepareSeccomp } from "./seccomp.ts";
import { dlopen, ptr, read } from "bun:ffi";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Spec, Mount } from "./spec.ts";

/** Replace only non-directory device aliases without following existing links. */
export function prepareDeviceLinks(directory: string) {
  const parent = lstatSync(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Device directory must not be a symlink");
  for (const [name, target] of [["fd", "/proc/self/fd"], ["stdin", "/proc/self/fd/0"], ["stdout", "/proc/self/fd/1"], ["stderr", "/proc/self/fd/2"], ["ptmx", "/dev/pts/ptmx"]] as const) {
    const link = join(directory, name), existing = lstatSync(link, { throwIfNoEntry: false });
    if (existing?.isDirectory()) throw new Error(`Cannot replace device directory: ${name}`);
    if (existing) unlinkSync(link);
    symlinkSync(target, link);
  }
}

export interface WorkerConfig { spec: Spec; root: string; cgroup: string }
/** Fresh Bun process in the container namespaces. No asynchronous work follows pivot_root. */
export function ociWorker(state: string): never {
  const config: WorkerConfig = JSON.parse(readFileSync(join(state, "worker.json"), "utf8"));
  const { spec, root } = config, p = spec.process;
  const ready = openSync(join(state, "ready"), "wx", 0o600);
  const gate = openSync(join(state, "start.fifo"), "r+");
  const lib = dlopen("libc.so.6", {
    unshare: { args: ["i32"], returns: "i32" },
    mount: { args: ["ptr", "ptr", "ptr", "u64", "ptr"], returns: "i32" }, umount2: { args: ["ptr", "i32"], returns: "i32" },
    syscall: { args: ["i64", "ptr", "ptr"], returns: "i64" }, chdir: { args: ["ptr"], returns: "i32" }, rmdir: { args: ["ptr"], returns: "i32" },
    sethostname: { args: ["ptr", "u64"], returns: "i32" }, setgroups: { args: ["u64", "ptr"], returns: "i32" },
    setgid: { args: ["u32"], returns: "i32" }, setuid: { args: ["u32"], returns: "i32" },
    prctl: { args: ["i32", "u64", "u64", "u64", "u64"], returns: "i32" },
    execve: { args: ["ptr", "ptr", "ptr"], returns: "i32" }, setrlimit: { args: ["i32", "ptr"], returns: "i32" },
    read: { args: ["i32", "ptr", "u64"], returns: "i64" }, write: { args: ["i32", "ptr", "u64"], returns: "i64" },
    __errno_location: { args: [], returns: "ptr" }, strerror: { args: ["i32"], returns: "cstring" },
  }).symbols;
  const buffers: Buffer[] = [];
  const c = (value: string) => { if (value.includes("\0")) throw new Error("NUL in configuration"); const b = Buffer.from(value + "\0"); buffers.push(b); return ptr(b); };
  const check = (n: number | bigint, label: string) => { if (Number(n) < 0) throw new Error(`${label}: ${lib.strerror(read.i32(lib.__errno_location()!))}`); };
  const mount = (source: string | null, target: string, type: string | null, flags: number, data: string | null = null) => check(lib.mount(source === null ? null : c(source), c(target), type === null ? null : c(type), flags, data === null ? null : c(data)), `mount ${target}`);
  const BIND = 4096, REC = 16384, PRIVATE = 262144, RO = 1, REMOUNT = 32;
  // Refuse symlink mountpoints rather than resolving them in the host namespace.
  const target = (path: string, directory = true) => {
    const parts = path.split("/").filter(Boolean); let current = root;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === "..") throw new Error("Parent mount traversal");
      current = join(current, parts[i]!);
      if (!existsSync(current)) {
        if (directory || i < parts.length - 1) mkdirSync(current, { mode: 0o755 }); else writeFileSync(current, "", { flag: "wx" });
      }
      const st = lstatSync(current);
      if (st.isSymbolicLink() || (i < parts.length - 1 && !st.isDirectory())) throw new Error(`Unsafe mountpoint ${path}`);
    }
    return current;
  };
  const applyMount = (m: Mount) => {
    const options = m.options ?? [], bind = m.type === "bind";
    const source = m.type === "cgroup" ? "cgroup2" : m.source;
    const dest = target(m.destination, !bind || statSync(source).isDirectory());
    const flags = (options.includes("ro") ? RO : 0) | (options.includes("nosuid") ? 2 : 0) | (options.includes("nodev") ? 4 : 0) | (options.includes("noexec") ? 8 : 0) | (options.includes("relatime") ? 2097152 : 0) | (options.includes("strictatime") ? 16777216 : 0);
    if (bind) {
      mount(source, dest, null, BIND | (options.includes("rbind") ? REC : 0));
      if (options.includes("rprivate")) mount(null, dest, null, REC | PRIVATE);
      if (flags) mount(null, dest, null, BIND | REMOUNT | flags);
    } else mount(source, dest, m.type === "cgroup" ? "cgroup2" : m.type, flags, options.filter(o => o.includes("=") || o === "newinstance").join(",") || null);
  };
  const loadSeccomp = spec.linux.seccomp ? prepareSeccomp(spec.linux.seccomp) : undefined;
  try {
    writeFileSync(join(config.cgroup, "cgroup.procs"), "0");
    check(lib.unshare(0x2000000), "private cgroup namespace");
    if (p.oomScoreAdj !== undefined) writeFileSync("/proc/self/oom_score_adj", String(p.oomScoreAdj));
    for (const [key, value] of Object.entries(spec.linux.sysctl ?? {})) writeFileSync("/proc/sys/" + key.replaceAll(".", "/"), value);
    mount(null, "/", null, REC | PRIVATE);
    mount(root, root, null, BIND);
    for (const m of spec.mounts ?? []) applyMount(m);
    // A nonroot process with no capabilities receives only these standard devices.
    for (const name of ["null", "zero", "random", "urandom"]) {
      const dest = target(`/dev/${name}`, false); mount(`/dev/${name}`, dest, null, BIND);
    }
    prepareDeviceLinks(join(root, "dev"));
    for (const path of spec.linux.maskedPaths ?? []) {
      const dest = join(root, path);
      if (!existsSync(dest)) continue;
      target(path, statSync(dest).isDirectory());
      if (statSync(dest).isDirectory()) mount("tmpfs", dest, "tmpfs", RO | 2 | 4 | 8, "size=0"); else mount("/dev/null", dest, null, BIND);
    }
    for (const path of spec.linux.readonlyPaths ?? []) {
      const dest = join(root, path); if (!existsSync(dest)) continue;
      target(path, statSync(dest).isDirectory()); mount(dest, dest, null, BIND | REC); mount(null, dest, null, BIND | REMOUNT | RO | 2 | 4 | 8);
    }
    if (spec.hostname) check(lib.sethostname(c(spec.hostname), Buffer.byteLength(spec.hostname)), "sethostname");
    const old = target("/.bunc-old-root"), args = new BigUint64Array([...p.args.map(x => BigInt(c(x))), 0n]);
    const env = new BigUint64Array([...(p.env ?? []).map(x => BigInt(c(x))), 0n]);
    const executable = c(p.args[0]!), cwd = c(p.cwd), groups = new Uint32Array(p.user.additionalGids ?? []);
    check(lib.syscall(process.arch === "arm64" ? 41 : 155, c(root), c(old)), "pivot_root");
    check(lib.chdir(c("/")), "chdir"); check(lib.umount2(c("/.bunc-old-root"), 2), "detach old root"); check(lib.rmdir(c("/.bunc-old-root")), "remove old root");
    mount(null, "/", null, BIND | REMOUNT | RO);
    check(lib.chdir(cwd), "working directory");
    for (const limit of p.rlimits ?? []) check(lib.setrlimit(7, ptr(new BigUint64Array([BigInt(limit.soft), BigInt(limit.hard)]))), "setrlimit");
    check(lib.setgroups(groups.length, groups.length ? ptr(groups) : null), "setgroups");
    for (let cap = 0; cap <= 40; cap++) check(lib.prctl(24, cap, 0, 0, 0), "drop capability bounding set");
    check(lib.prctl(38, 1, 0, 0, 0), "no_new_privs");
    check(lib.setgid(p.user.gid), "setgid"); check(lib.setuid(p.user.uid), "setuid");
    // Ready means setup completed and the container is blocked before exec.
    check(lib.write(ready, c("ready"), 5), "ready");
    const byte = Buffer.alloc(1); let result;
    do { result = Number(lib.read(gate, ptr(byte), 1)); } while (result < 0 && read.i32(lib.__errno_location()!) === 4);
    if (result !== 1 || byte[0] !== 1) throw new Error("Invalid start signal");
    closeSync(gate); closeSync(ready);
    loadSeccomp?.();
    check(lib.execve(executable, ptr(args), ptr(env)), "execve");
    throw new Error("execve unexpectedly returned");
  } catch (error) {
    const message = Buffer.from(`error: ${String(error)}`); lib.write(ready, ptr(message), message.length); throw error;
  }
}
