import { cc, dlopen, ptr } from "bun:ffi";
import { writeFileSync, unlinkSync, openSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import source from "./bootstrap.c" with { type: "text" };
import type { Spec } from "./spec.ts";

export const namespaceFlags: Record<string, number> = { mount: 0x20000, ipc: 0x8000000, uts: 0x4000000, network: 0x40000000, pid: 0x20000000, cgroup: 0x2000000 };
export function bootstrap(state: string, spec: Spec): number {
  const libc = dlopen("libc.so.6", {
    pipe: { args: ["ptr"], returns: "i32" }, fork: { args: [], returns: "i32" },
    close: { args: ["i32"], returns: "i32" }, setns: { args: ["i32", "i32"], returns: "i32" },
    unshare: { args: ["i32"], returns: "i32" }, write: { args: ["i32", "ptr", "u64"], returns: "i64" },
    read: { args: ["i32", "ptr", "u64"], returns: "i64" }, waitpid: { args: ["i32", "ptr", "i32"], returns: "i32" },
    execve: { args: ["ptr", "ptr", "ptr"], returns: "i32" }, _exit: { args: ["i32"], returns: "void" },
    __errno_location: { args: [], returns: "ptr" }, close_range: { args: ["u32", "u32", "i32"], returns: "i32" },
  });
  const file = join(state, "bootstrap.c"); writeFileSync(file, source, { mode: 0o600, flag: "wx" });
  const library = cc({ source: file, flags: ["-nostdlib"], symbols: { bootstrap: { args: ["ptr", "ptr", "i32", "i32", "ptr", "ptr", "ptr"], returns: "i32" } } });
  unlinkSync(file);
  const fds: number[] = [], buffers: Buffer[] = [];
  const c = (s: string) => { const b = Buffer.from(s + "\0"); buffers.push(b); return BigInt(ptr(b)); };
  try {
    let flags = 0;
    for (const ns of spec.linux.namespaces) {
      if (ns.path) fds.push(openSync(ns.path, "r")); else if (ns.type !== "cgroup") flags |= namespaceFlags[ns.type]!;
    }
    const functions = new BigUint64Array(Object.values(libc.symbols).map(fn => BigInt((fn as unknown as { ptr: number }).ptr)));
    const argv = new BigUint64Array([...[process.execPath, ...Bun.isStandaloneExecutable ? [] : [resolve(process.argv[1]!)], "--oci-worker", state].map(c), 0n]);
    const env = new BigUint64Array([c("PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"), 0n]);
    const namespaces = new Int32Array(fds.length ? fds : [0]);
    const pid = library.symbols.bootstrap(ptr(functions), ptr(namespaces), fds.length, flags, Number(c(process.execPath)), ptr(argv), ptr(env));
    if (pid <= 1) throw new Error(`Namespace bootstrap failed (errno ${-pid})`);
    return pid;
  } finally { for (const fd of fds) closeSync(fd); library.close(); libc.close(); }
}
