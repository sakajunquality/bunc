import { dlopen, ptr, read } from "bun:ffi";
import { lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareSandboxSeccomp } from "./seccomp.ts";

export interface SandboxWorkerConfig {
  rootfs: string;
  codeDir: string;
  inputDir: string;
  scratchDir: string;
  packageDir?: string;
  executable: string;
  argv: string[];
  env: string[];
  cwd: string;
  uid: number;
  gid: number;
  hostname: string;
  nofile: number;
}

function verifyDirectory(path: string, label: string) {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} is not a safe directory`);
}

/** Runs in fresh namespaces as PID 1. This is an internal entrypoint. */
export function sandboxWorker(stateDir: string): never {
  const setupFd = Number(process.env.BUNC_SANDBOX_SETUP_FD);
  if (setupFd !== 3) throw new Error("Missing sandbox setup descriptor");
  const report = (kind: number, value: number, message = "") => {
    const text = Buffer.from(message.slice(0, 1800));
    const packet = Buffer.alloc(12 + text.length);
    packet.writeInt32LE(kind, 0); packet.writeInt32LE(value, 4); packet.writeUInt32LE(text.length, 8); text.copy(packet, 12);
    let offset = 0;
    while (offset < packet.length) {
      const count = Number(lib.write(setupFd, ptr(packet.subarray(offset)), packet.length - offset));
      if (count < 0 && read.i32(lib.__errno_location()!) === 4) continue;
      if (count <= 0) break;
      offset += count;
    }
  };
  const lib = dlopen("libc.so.6", {
    mount: { args: ["ptr", "ptr", "ptr", "u64", "ptr"], returns: "i32" }, umount2: { args: ["ptr", "i32"], returns: "i32" },
    syscall: { args: ["i64", "ptr", "ptr"], returns: "i64" }, chdir: { args: ["ptr"], returns: "i32" },
    sethostname: { args: ["ptr", "u64"], returns: "i32" }, setgroups: { args: ["u64", "ptr"], returns: "i32" },
    setresgid: { args: ["u32", "u32", "u32"], returns: "i32" }, setresuid: { args: ["u32", "u32", "u32"], returns: "i32" },
    capset: { args: ["ptr", "ptr"], returns: "i32" }, prctl: { args: ["i32", "u64", "u64", "u64", "u64"], returns: "i32" },
    fcntl: { args: ["i32", "i32", "i32"], returns: "i32" },
    close_range: { args: ["u32", "u32", "i32"], returns: "i32" },
    setrlimit: { args: ["i32", "ptr"], returns: "i32" }, execve: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
    write: { args: ["i32", "ptr", "u64"], returns: "i64" }, __errno_location: { args: [], returns: "ptr" },
    strerror: { args: ["i32"], returns: "cstring" }, _exit: { args: ["i32"], returns: "void" },
  }).symbols;
  try {
    const config: SandboxWorkerConfig = JSON.parse(readFileSync(join(stateDir, "worker.json"), "utf8"));
    // Resolve and construct the filter while the host libraries are still
    // visible. Only the native seccomp_load call runs after pivot_root.
    const loadSeccomp = prepareSandboxSeccomp();
    for (const [path, label] of [[config.rootfs, "rootfs"], [config.codeDir, "code"], [config.inputDir, "input"], [config.scratchDir, "scratch"]] as const) verifyDirectory(path, label);
    if (config.packageDir) verifyDirectory(config.packageDir, "package directory");
    const buffers: Buffer[] = [];
    const c = (value: string) => { if (value.includes("\0")) throw new Error("NUL in worker configuration"); const b = Buffer.from(value + "\0"); buffers.push(b); return ptr(b); };
    const errno = () => read.i32(lib.__errno_location()!);
    const check = (result: number | bigint, label: string) => { if (Number(result) < 0) throw new Error(`${label}: ${lib.strerror(errno())}`); };
    const mount = (source: string | null, target: string, type: string | null, flags: number, data: string | null = null) =>
      check(lib.mount(source === null ? null : c(source), c(target), type === null ? null : c(type), flags, data === null ? null : c(data)), `mount ${target}`);
    const rootTarget = (absolute: string) => {
      if (!absolute.startsWith("/") || absolute.includes("..")) throw new Error(`Invalid mount target ${absolute}`);
      const target = join(config.rootfs, absolute);
      verifyDirectory(target, `mount target ${absolute}`);
      return target;
    };
    const BIND = 4096, REC = 16384, PRIVATE = 262144, RO = 1, NOSUID = 2, NODEV = 4, NOEXEC = 8, REMOUNT = 32;
    check(lib.fcntl(setupFd, 2, 1), "mark setup descriptor close-on-exec");
    mount(null, "/", null, REC | PRIVATE);
    mount(config.rootfs, config.rootfs, null, BIND);
    mount("proc", rootTarget("/proc"), "proc", NOSUID | NODEV | NOEXEC, "hidepid=2");
    mount(config.codeDir, rootTarget("/code"), null, BIND | REC);
    mount(null, rootTarget("/code"), null, BIND | REMOUNT | RO | NOSUID | NODEV | NOEXEC);
    mount(config.inputDir, rootTarget("/input"), null, BIND | REC);
    mount(null, rootTarget("/input"), null, BIND | REMOUNT | RO | NOSUID | NODEV | NOEXEC);
    if (config.packageDir) {
      const modules = join(config.rootfs, "code/node_modules"); verifyDirectory(modules, "package mountpoint");
      mount(config.packageDir, modules, null, BIND | REC); mount(null, modules, null, BIND | REMOUNT | RO | NOSUID | NODEV);
    }
    for (const [guest, scratch] of [["/work", "work"], ["/output", "output"], ["/tmp", "tmp"], ["/home/sandbox", "home"]] as const) {
      const source = join(config.scratchDir, scratch); verifyDirectory(source, `scratch ${scratch}`);
      const target = rootTarget(guest); mount(source, target, null, BIND);
      mount(null, target, null, BIND | REMOUNT | NOSUID | NODEV | NOEXEC);
    }
    const dev = rootTarget("/dev"); mount("tmpfs", dev, "tmpfs", NOSUID | NOEXEC, "mode=755,size=1m,nr_inodes=32");
    for (const name of ["null", "zero", "random", "urandom"]) {
      const target = join(dev, name); writeFileSync(target, "", { mode: 0o666, flag: "wx" }); mount(`/dev/${name}`, target, null, BIND);
    }
    for (const [name, target] of [["fd", "/proc/self/fd"], ["stdin", "/proc/self/fd/0"], ["stdout", "/proc/self/fd/1"], ["stderr", "/proc/self/fd/2"]] as const) symlinkSync(target, join(dev, name));
    const shm = join(dev, "shm"); mkdirSync(shm, { mode: 0o1777 });
    mount(join(config.scratchDir, "dev-shm"), shm, null, BIND); mount(null, shm, null, BIND | REMOUNT | NOSUID | NODEV | NOEXEC);
    const maskedDirectories = ["acpi", "asound", "scsi"];
    for (const name of maskedDirectories) {
      const target = join(config.rootfs, "proc", name);
      try { if (lstatSync(target).isDirectory()) mount("tmpfs", target, "tmpfs", RO | NOSUID | NODEV | NOEXEC, "size=4096,nr_inodes=1"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    for (const name of ["kcore", "keys", "latency_stats", "timer_list", "timer_stats", "sched_debug", "sysrq-trigger"]) {
      const target = join(config.rootfs, "proc", name);
      try { if (!lstatSync(target).isDirectory()) mount("/dev/null", target, null, BIND); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    mount("proc", join(config.rootfs, "proc"), "proc", REMOUNT | RO | NOSUID | NODEV | NOEXEC, "hidepid=2");
    check(lib.sethostname(c(config.hostname), Buffer.byteLength(config.hostname)), "sethostname");
    const oldRoot = rootTarget("/.bunc-old-root");
    const args = new BigUint64Array([...config.argv.map(value => BigInt(c(value))), 0n]);
    const environment = new BigUint64Array([...config.env.map(value => BigInt(c(value))), 0n]);
    const executable = c(config.executable), cwd = c(config.cwd), root = c(config.rootfs), old = c(oldRoot);
    check(lib.syscall(process.arch === "arm64" ? 41 : 155, root, old), "pivot_root");
    check(lib.chdir(c("/")), "chdir root"); check(lib.umount2(c("/.bunc-old-root"), 2), "detach old root");
    mount(null, "/", null, BIND | REMOUNT | RO);
    check(lib.chdir(cwd), "working directory");
    check(lib.setrlimit(4, ptr(new BigUint64Array([0n, 0n]))), "setrlimit CORE");
    check(lib.setrlimit(7, ptr(new BigUint64Array([BigInt(config.nofile), BigInt(config.nofile)]))), "setrlimit NOFILE");
    check(lib.setgroups(0, null), "clear supplementary groups");
    for (let capability = 0; capability <= 63; capability++) {
      const result = lib.prctl(24, capability, 0, 0, 0); // PR_CAPBSET_DROP
      if (result < 0 && errno() !== 22) check(result, "drop capability bounding set");
    }
    check(lib.prctl(47, 4, 0, 0, 0), "clear ambient capabilities");
    check(lib.prctl(38, 1, 0, 0, 0), "set no_new_privs");
    check(lib.setresgid(config.gid, config.gid, config.gid), "setresgid");
    // Linux clears the parent-death signal when credentials change. Rearm it
    // after each transition so a killed native guardian cannot orphan PID 1.
    check(lib.prctl(1, 9, 0, 0, 0), "rearm parent-death signal after setresgid");
    check(lib.setresuid(config.uid, config.uid, config.uid), "setresuid");
    check(lib.prctl(1, 9, 0, 0, 0), "rearm parent-death signal after setresuid");
    const capabilityHeader = new Uint32Array([0x20080522, 0]);
    check(lib.capset(ptr(capabilityHeader), ptr(new Uint32Array(6))), "clear capability sets");
    check(lib.close_range(3, 0xffffffff, 4), "mark descriptors close-on-exec");
    loadSeccomp();
    const ready = new Int32Array([82, 0, 0]); // R
    check(lib.write(setupFd, ptr(ready), ready.byteLength), "report ready");
    const result = lib.execve(executable, ptr(args), ptr(environment));
    const execErrno = errno();
    const failed = new Int32Array([70, execErrno, 0]); // F
    lib.write(setupFd, ptr(failed), failed.byteLength);
    if (result >= 0) lib.write(setupFd, ptr(failed), failed.byteLength);
    lib._exit(127);
  } catch (error) {
    report(83, 0, error instanceof Error ? error.message : String(error)); // S
    lib._exit(125);
  }
  throw new Error("unreachable");
}
