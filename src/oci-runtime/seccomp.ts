import { dlopen, ptr } from "bun:ffi";
export interface Seccomp { defaultAction: string; defaultErrnoRet?: number; architectures?: string[]; flags?: string[]; syscalls?: { names: string[]; action: string; errnoRet?: number; args?: { index: number; value: number; valueTwo?: number; op: string }[] }[] }
const operations: Record<string, number> = { SCMP_CMP_NE: 1, SCMP_CMP_LT: 2, SCMP_CMP_LE: 3, SCMP_CMP_EQ: 4, SCMP_CMP_GE: 5, SCMP_CMP_GT: 6, SCMP_CMP_MASKED_EQ: 7 };
export function validateSeccomp(s: Seccomp) {
  if (s.defaultAction !== "SCMP_ACT_ERRNO" || s.flags?.length || (s.syscalls?.length ?? 0) > 1024) throw new Error("Only bounded native-architecture deny-by-default seccomp profiles are supported");
  if (s.defaultErrnoRet !== undefined && (!Number.isInteger(s.defaultErrnoRet) || s.defaultErrnoRet < 1 || s.defaultErrnoRet > 0xffff)) throw new Error("Invalid default seccomp errno");
  const native = process.arch === "arm64" ? "SCMP_ARCH_AARCH64" : "SCMP_ARCH_X86_64";
  if (s.architectures && !s.architectures.includes(native)) throw new Error("seccomp profile does not contain the native architecture");
  for (const rule of s.syscalls ?? []) {
    if (!["SCMP_ACT_ALLOW", "SCMP_ACT_ERRNO"].includes(rule.action) || !rule.names.length || rule.names.some(n => !/^[a-zA-Z0-9_]+$/.test(n)) || (rule.args?.length ?? 0) > 6) throw new Error("Unsupported seccomp rule");
    if (rule.errnoRet !== undefined && (!Number.isInteger(rule.errnoRet) || rule.errnoRet < 0 || rule.errnoRet > 0xffff)) throw new Error("Invalid seccomp errno");
    for (const arg of rule.args ?? []) if (!operations[arg.op] || !Number.isInteger(arg.index) || arg.index < 0 || arg.index > 5 || ![arg.value, arg.valueTwo ?? 0].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error("Unsupported seccomp comparison");
  }
}
export function prepareSeccomp(s: Seccomp): () => void {
  const lib = dlopen("libseccomp.so.2", {
    seccomp_init: { args: ["u32"], returns: "ptr" }, seccomp_release: { args: ["ptr"], returns: "void" },
    seccomp_syscall_resolve_name: { args: ["ptr"], returns: "i32" },
    seccomp_rule_add_array: { args: ["ptr", "u32", "i32", "u32", "ptr"], returns: "i32" }, seccomp_load: { args: ["ptr"], returns: "i32" },
  });
  const ctx = lib.symbols.seccomp_init(0x50000 | (s.defaultErrnoRet ?? 1));
  if (!ctx) throw new Error("seccomp_init failed");
  try {
    for (const rule of s.syscalls ?? []) for (const name of rule.names) {
      const syscall = lib.symbols.seccomp_syscall_resolve_name(ptr(Buffer.from(name + "\0")));
      // Architecture-specific names missing from the native ABI remain denied.
      if (syscall < 0) continue;
      const args = Buffer.alloc((rule.args?.length ?? 0) * 24);
      rule.args?.forEach((a, i) => { args.writeUInt32LE(a.index, i * 24); args.writeUInt32LE(operations[a.op]!, i * 24 + 4); args.writeBigUInt64LE(BigInt(a.value), i * 24 + 8); args.writeBigUInt64LE(BigInt(a.valueTwo ?? 0), i * 24 + 16); });
      const action = rule.action === "SCMP_ACT_ALLOW" ? 0x7fff0000 : 0x50000 | (rule.errnoRet ?? 1);
      const result = lib.symbols.seccomp_rule_add_array(ctx, action, syscall, rule.args?.length ?? 0, args.length ? ptr(args) : null);
      if (result < 0) throw new Error(`seccomp rule ${name} failed: ${result}`);
    }
  } catch (error) { lib.symbols.seccomp_release(ctx); lib.close(); throw error; }
  // Keep the handle alive until exec; releasing it after installing an arbitrary
  // filter could itself require syscalls that the filter has denied.
  return () => { const result = lib.symbols.seccomp_load(ctx); if (result < 0) throw new Error(`seccomp_load failed: ${result}`); };
}
