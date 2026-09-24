import { dlopen, ptr } from "bun:ffi";

export const SANDBOX_SECCOMP_REVISION = "bun-native-v1";

// This is a native-ABI profile for the pinned Bun environment. Networking,
// namespace administration, mounts, tracing, kernel modules, BPF and keyrings
// remain denied by the EPERM default action.
export const sandboxAllowedSyscalls = [
  "access", "arch_prctl", "brk", "capget", "capset", "chdir", "chmod", "chown",
  "clock_getres", "clock_gettime", "clock_nanosleep", "close", "close_range",
  "copy_file_range", "dup", "dup2", "dup3", "epoll_create", "epoll_create1", "epoll_ctl", "epoll_pwait", "epoll_pwait2", "epoll_wait",
  "eventfd", "eventfd2", "execve", "exit", "exit_group", "faccessat", "faccessat2", "fadvise64",
  "fallocate", "fchdir", "fchmod", "fchmodat", "fchown", "fchownat", "fcntl", "fdatasync", "flock", "fork",
  "fstat", "fstatfs", "fsync", "ftruncate", "futex", "futex_waitv", "getcwd", "getdents64", "getegid", "geteuid",
  "getgid", "getgroups", "getpeername", "getpgid", "getpid", "getppid", "getpriority", "getrandom", "getresgid",
  "getresuid", "getrlimit", "getrusage", "getsid", "getsockname", "getsockopt", "gettid", "gettimeofday", "getuid",
  "inotify_add_watch", "inotify_init", "inotify_init1", "inotify_rm_watch",
  "ioctl", "kill", "link", "linkat", "lseek", "lstat", "madvise", "memfd_create", "membarrier", "mincore", "mkdir", "mkdirat", "mmap",
  "mprotect", "mremap", "msync", "munmap", "nanosleep", "newfstatat", "open", "openat", "openat2", "pause", "pipe", "pipe2",
  "poll", "ppoll", "pread64", "preadv", "preadv2", "prlimit64", "pselect6", "pwrite64", "pwritev", "pwritev2",
  "read", "readahead", "readlink", "readlinkat", "readv", "rename", "renameat", "renameat2", "restart_syscall", "rseq",
  "rt_sigaction", "rt_sigpending", "rt_sigprocmask", "rt_sigqueueinfo", "rt_sigreturn", "rt_sigsuspend", "rt_sigtimedwait",
  "sched_getaffinity", "sched_getparam", "sched_getscheduler", "sched_yield", "set_robust_list", "set_tid_address", "setitimer",
  "setpgid", "setsid", "setsockopt", "sigaltstack", "signalfd", "signalfd4", "splice", "stat", "statfs", "statx",
  "symlink", "symlinkat", "sync_file_range", "sysinfo", "tee", "tgkill", "timer_create", "timer_delete", "timer_gettime",
  "timer_settime", "timerfd_create", "timerfd_gettime", "timerfd_settime", "times", "tkill", "truncate", "umask", "uname",
  "unlink", "unlinkat", "utimensat", "vfork", "wait4", "waitid", "write", "writev",
] as const;

export function checkSandboxSeccompSupport(): { available: boolean; message: string } {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) return { available: false, message: "requires native Linux amd64/arm64" };
  try {
    const lib = dlopen("libseccomp.so.2", { seccomp_version: { args: [], returns: "ptr" } });
    if (!lib.symbols.seccomp_version()) throw new Error("seccomp_version returned null");
    lib.close(); return { available: true, message: `libseccomp available (${SANDBOX_SECCOMP_REVISION})` };
  }
  catch (error) { return { available: false, message: `libseccomp.so.2 unavailable: ${String(error)}` }; }
}

/** Prepare the fixed filter before entering the final no-allocation setup path. */
export function prepareSandboxSeccomp(): () => void {
  const lib = dlopen("libseccomp.so.2", {
    seccomp_init: { args: ["u32"], returns: "ptr" }, seccomp_release: { args: ["ptr"], returns: "void" },
    seccomp_syscall_resolve_name: { args: ["ptr"], returns: "i32" },
    seccomp_rule_add_array: { args: ["ptr", "u32", "i32", "u32", "ptr"], returns: "i32" },
    seccomp_load: { args: ["ptr"], returns: "i32" },
  });
  const context = lib.symbols.seccomp_init(0x50000 | 1); // SCMP_ACT_ERRNO(EPERM)
  if (!context) { lib.close(); throw new Error("seccomp_init failed"); }
  try {
    for (const name of sandboxAllowedSyscalls) {
      const encoded = Buffer.from(name + "\0");
      const syscall = lib.symbols.seccomp_syscall_resolve_name(ptr(encoded));
      if (syscall < 0) continue; // Names can be architecture-specific.
      const result = lib.symbols.seccomp_rule_add_array(context, 0x7fff0000, syscall, 0, null);
      if (result < 0) throw new Error(`seccomp rule ${name} failed: ${result}`);
    }
    const cloneName = Buffer.from("clone\0"), cloneSyscall = lib.symbols.seccomp_syscall_resolve_name(ptr(cloneName));
    if (cloneSyscall >= 0) {
      // Permit thread/process clone while denying every namespace creation flag.
      const comparison = Buffer.alloc(24);
      comparison.writeUInt32LE(0, 0); comparison.writeUInt32LE(7, 4); // arg 0, SCMP_CMP_MASKED_EQ
      comparison.writeBigUInt64LE(0x7e020000n, 8); comparison.writeBigUInt64LE(0n, 16);
      const result = lib.symbols.seccomp_rule_add_array(context, 0x7fff0000, cloneSyscall, 1, ptr(comparison));
      if (result < 0) throw new Error(`seccomp rule clone failed: ${result}`);
    }
    const clone3Name = Buffer.from("clone3\0"), clone3Syscall = lib.symbols.seccomp_syscall_resolve_name(ptr(clone3Name));
    if (clone3Syscall >= 0) {
      // libc/Bun can fall back to clone when clone3 appears unavailable.
      const result = lib.symbols.seccomp_rule_add_array(context, 0x50000 | 38, clone3Syscall, 0, null);
      if (result < 0) throw new Error(`seccomp rule clone3 failed: ${result}`);
    }
    const prctlName = Buffer.from("prctl\0"), prctlSyscall = lib.symbols.seccomp_syscall_resolve_name(ptr(prctlName));
    if (prctlSyscall >= 0) {
      // The guest may use ordinary runtime prctl operations but cannot clear or
      // replace the guardian parent-death signal (PR_SET_PDEATHSIG = 1).
      const comparison = Buffer.alloc(24);
      comparison.writeUInt32LE(0, 0); comparison.writeUInt32LE(1, 4); // arg 0, SCMP_CMP_NE
      comparison.writeBigUInt64LE(1n, 8);
      const result = lib.symbols.seccomp_rule_add_array(context, 0x7fff0000, prctlSyscall, 1, ptr(comparison));
      if (result < 0) throw new Error(`seccomp rule prctl failed: ${result}`);
    }
  } catch (error) {
    lib.symbols.seccomp_release(context); lib.close(); throw error;
  }
  return () => {
    const result = lib.symbols.seccomp_load(context);
    if (result < 0) throw new Error(`seccomp_load failed: ${result}`);
    // Releasing the context after loading can require denied allocator syscalls.
  };
}
