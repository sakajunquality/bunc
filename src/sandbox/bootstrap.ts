import { cc, dlopen, ptr } from "bun:ffi";
import { unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import source from "./bootstrap.c" with { type: "text" };

export interface BootstrapResult {
  guardianPid: number;
  pid: number;
  stdoutFd: number;
  stderrFd: number;
  setupFd: number;
  livenessFd: number;
  eventFd: number;
}

export interface BootstrapOptions {
  stateDir: string;
  cgroupProcsFd: number;
  cgroupKillFd: number;
  hardDeadlineMs: number;
  command: string[];
  env: string[];
  namespaceFlags: number;
}

export function bootstrapInternal(options: BootstrapOptions): BootstrapResult {
  const libc = dlopen("libc.so.6", {
    pipe2: { args: ["ptr", "i32"], returns: "i32" }, fork: { args: [], returns: "i32" },
    close: { args: ["i32"], returns: "i32" }, dup2: { args: ["i32", "i32"], returns: "i32" },
    open: { args: ["ptr", "i32", "i32"], returns: "i32" }, unshare: { args: ["i32"], returns: "i32" },
    execve: { args: ["ptr", "ptr", "ptr"], returns: "i32" }, write: { args: ["i32", "ptr", "u64"], returns: "i64" },
    read: { args: ["i32", "ptr", "u64"], returns: "i64" }, waitpid: { args: ["i32", "ptr", "i32"], returns: "i32" },
    poll: { args: ["ptr", "u64", "i32"], returns: "i32" }, clock_gettime: { args: ["i32", "ptr"], returns: "i32" },
    _exit: { args: ["i32"], returns: "void" }, __errno_location: { args: [], returns: "ptr" },
    close_range: { args: ["u32", "u32", "i32"], returns: "i32" },
    prctl: { args: ["i32", "u64", "u64", "u64", "u64"], returns: "i32" },
  });
  const cFile = join(options.stateDir, "sandbox-bootstrap.c");
  writeFileSync(cFile, source, { mode: 0o600, flag: "wx" });
  const library = cc({ source: cFile, flags: ["-nostdlib"], symbols: {
    sandbox_bootstrap: { args: ["ptr", "i32", "ptr", "ptr", "ptr", "i32", "i32", "i64", "ptr"], returns: "i32" },
  } });
  unlinkSync(cFile);
  const buffers: Buffer[] = [];
  const c = (value: string) => { const b = Buffer.from(value + "\0"); buffers.push(b); return BigInt(ptr(b)); };
  if (!options.command.length) throw new Error("Native bootstrap command is empty");
  const argv = new BigUint64Array(options.command.map(c).concat(0n));
  const env = new BigUint64Array([...options.env.map(c), 0n]);
  const functions = new BigUint64Array(Object.values(libc.symbols).map(fn => BigInt((fn as unknown as { ptr: number }).ptr)));
  const out = new Int32Array(7);
  try {
    const result = library.symbols.sandbox_bootstrap(ptr(functions), options.namespaceFlags, Number(c(options.command[0]!)), ptr(argv), ptr(env), options.cgroupProcsFd, options.cgroupKillFd, options.hardDeadlineMs, ptr(out));
    if (result < 0) throw new Error(`Native sandbox bootstrap failed (errno ${-result})`);
    return { guardianPid: out[0]!, pid: out[1]!, stdoutFd: out[2]!, stderrFd: out[3]!, setupFd: out[4]!, livenessFd: out[5]!, eventFd: out[6]! };
  } finally { library.close(); libc.close(); }
}


export function bootstrapSandbox(stateDir: string, cgroupProcsFd: number, cgroupKillFd: number, hardDeadlineMs: number, workerCommand?: string[]): BootstrapResult {
  const entrypoint = workerCommand ?? (Bun.isStandaloneExecutable ? [process.execPath] : [process.execPath, resolve(process.argv[1]!)]);
  return bootstrapInternal({
    stateDir, cgroupProcsFd, cgroupKillFd, hardDeadlineMs,
    command: [...entrypoint, "--sandbox-worker", stateDir],
    env: ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "BUNC_SANDBOX_SETUP_FD=3"],
    namespaceFlags: 0x20000000 | 0x40000000 | 0x08000000 | 0x04000000 | 0x02000000,
  });
}
