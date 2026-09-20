import { dlopen, ptr, read } from "bun:ffi";
import { mkdirSync, writeFileSync, symlinkSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
export interface Launch { root: string; argv: string[]; env: string[]; cwd: string; uid: number; gid: number; hostname: string; pidFile: string }

/** Runs only in the fresh namespaces created by util-linux unshare. */
export function execute(config: Launch): never {
  // The inherited procfs reports our PID in the supervisor's PID namespace.
  const outerPid = Number(readFileSync("/proc/self/status", "utf8").match(/^Pid:\s+(\d+)$/m)?.[1]);
  if (!Number.isInteger(outerPid) || outerPid <= 1) throw new Error("Cannot resolve the worker PID for signal forwarding");
  const libc = dlopen("libc.so.6", {
    mount: { args: ["ptr", "ptr", "ptr", "u64", "ptr"], returns: "i32" },
    umount2: { args: ["ptr", "i32"], returns: "i32" },
    syscall: { args: ["i64", "ptr", "ptr"], returns: "i64" },
    chdir: { args: ["ptr"], returns: "i32" }, rmdir: { args: ["ptr"], returns: "i32" },
    sethostname: { args: ["ptr", "u64"], returns: "i32" },
    setgroups: { args: ["u64", "ptr"], returns: "i32" },
    setgid: { args: ["u32"], returns: "i32" }, setuid: { args: ["u32"], returns: "i32" },
    prctl: { args: ["i32", "u64", "u64", "u64", "u64"], returns: "i32" },
    execve: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
    __errno_location: { args: [], returns: "ptr" }, strerror: { args: ["i32"], returns: "cstring" },
  }).symbols;
  // Keep every FFI buffer live through execve; no asynchronous work follows pivot_root.
  const buffers: Buffer[] = [];
  const c = (value: string) => { if (value.includes("\0")) throw new Error("NUL in process configuration"); const b = Buffer.from(value + "\0"); buffers.push(b); return ptr(b); };
  const check = (result: number | bigint, call: string) => {
    if (Number(result) < 0) {
      throw new Error(`${call}: ${libc.strerror(read.i32(libc.__errno_location()!))}`);
    }
  };
  const mount = (source: string | null, target: string, type: string | null, flags: number, data: string | null = null) => check(libc.mount(source === null ? null : c(source), c(target), type === null ? null : c(type), flags, data === null ? null : c(data)), `mount ${target}`);
  const directory = (relative: string, mode = 0o755) => {
    let path = config.root;
    for (const part of relative.split("/")) {
      path = join(path, part);
      try { mkdirSync(path, { mode }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Mountpoint is not a directory: ${relative}`);
    }
    return path;
  };
  const MS_BIND = 4096, MS_REC = 16384, MS_PRIVATE = 262144, MS_RDONLY = 1, MS_NOSUID = 2, MS_NODEV = 4, MS_NOEXEC = 8, MS_REMOUNT = 32;
  mount(null, "/", null, MS_REC | MS_PRIVATE);
  mount(config.root, config.root, null, MS_BIND);
  mount("proc", directory("proc"), "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC | MS_RDONLY);
  mount("tmpfs", directory("tmp", 0o1777), "tmpfs", MS_NOSUID | MS_NODEV, "mode=1777,size=64m");
  mount("tmpfs", directory("dev"), "tmpfs", MS_NOSUID | MS_NOEXEC, "mode=755,size=1m");
  for (const name of ["null", "zero", "random", "urandom"]) {
    const target = join(config.root, "dev", name); writeFileSync(target, "");
    mount(`/dev/${name}`, target, null, MS_BIND);
  }
  for (const [name, target] of [["fd", "/proc/self/fd"], ["stdin", "/proc/self/fd/0"], ["stdout", "/proc/self/fd/1"], ["stderr", "/proc/self/fd/2"]]) symlinkSync(target!, join(config.root, "dev", name!));
  mount("tmpfs", directory("dev/shm"), "tmpfs", MS_NOSUID | MS_NODEV | MS_NOEXEC, "mode=1777,size=16m");
  const oldRoot = directory(".old-root");
  check(libc.sethostname(c(config.hostname), Buffer.byteLength(config.hostname)), "sethostname");
  const args = new BigUint64Array([...config.argv.map(arg => BigInt(c(arg))), 0n]);
  const environment = new BigUint64Array([...config.env.map(value => BigInt(c(value))), 0n]);
  const executable = c(config.argv[0]!), cwd = c(config.cwd), root = c(config.root), old = c(oldRoot);
  writeFileSync(config.pidFile, String(outerPid), { mode: 0o600 });
  check(libc.syscall(process.arch === "arm64" ? 41 : 155, root, old), "pivot_root");
  check(libc.chdir(c("/")), "chdir /");
  check(libc.umount2(c("/.old-root"), 2), "detach old root");
  check(libc.rmdir(c("/.old-root")), "remove old root");
  mount(null, "/", null, MS_BIND | MS_REMOUNT | MS_RDONLY);
  check(libc.chdir(cwd), "image WorkingDir");
  check(libc.setgroups(0, null), "clear supplementary groups");
  check(libc.prctl(38, 1, 0, 0, 0), "PR_SET_NO_NEW_PRIVS");
  check(libc.setgid(config.gid), "setgid"); check(libc.setuid(config.uid), "setuid");
  check(libc.execve(executable, ptr(args), ptr(environment)), "execve");
  throw new Error("execve unexpectedly returned");
}
