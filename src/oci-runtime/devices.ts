import { dlopen, ptr, read } from "bun:ffi";
import { openSync, closeSync } from "node:fs";

/** cgroup v2 device filter: standard character devices and PTYs, no block devices. */
export function restrictDevices(cgroup: string) {
  const lib = dlopen("libc.so.6", { syscall: { args: ["i64", "i32", "ptr", "u32"], returns: "i64" }, __errno_location: { args: [], returns: "ptr" } });
  // Linux UAPI bpf_insn: code:u8, dst/src:u4, offset:s16, immediate:s32.
  const instructions: [number, number, number, number][] = [
    [0xb7, 0, 0, 0],       // r0 = deny
    [0x61, 0x12, 0, 0],    // r2 = ctx->access_type
    [0x57, 2, 0, 0xffff],  // device type
    [0x55, 2, 13, 2],      // non-character -> exit (17)
    [0x61, 0x12, 4, 0],    // r2 = major
    [0x15, 2, 10, 136],    // PTY -> allow (16)
    [0x15, 2, 7, 5],       // major 5 -> check minor (14)
    [0x55, 2, 9, 1],       // not major 1 -> exit (17)
    [0x61, 0x12, 8, 0],    // r2 = minor
    [0x15, 2, 6, 3],       // null
    [0x15, 2, 5, 5],       // zero
    [0x15, 2, 4, 8],       // random
    [0x15, 2, 3, 9],       // urandom
    [0x05, 0, 3, 0],       // exit
    [0x61, 0x12, 8, 0],    // major 5: minor
    [0x55, 2, 1, 2],       // only ptmx
    [0xb7, 0, 0, 1],       // allow
    [0x95, 0, 0, 0],       // exit
  ];
  const code = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([op, regs, offset, imm], i) => { code[i * 8] = op; code[i * 8 + 1] = regs; code.writeInt16LE(offset, i * 8 + 2); code.writeInt32LE(imm, i * 8 + 4); });
  const license = Buffer.from("GPL\0"), log = Buffer.alloc(65536), attr = Buffer.alloc(72);
  attr.writeUInt32LE(15, 0); attr.writeUInt32LE(instructions.length, 4);
  attr.writeBigUInt64LE(BigInt(ptr(code)), 8); attr.writeBigUInt64LE(BigInt(ptr(license)), 16);
  attr.writeUInt32LE(1, 24); attr.writeUInt32LE(log.length, 28); attr.writeBigUInt64LE(BigInt(ptr(log)), 32); attr.writeUInt32LE(6, 68);
  const syscall = process.arch === "arm64" ? 280 : 321;
  const program = Number(lib.symbols.syscall(syscall, 5, ptr(attr), attr.length));
  if (program < 0) throw new Error(`Cannot load cgroup device filter: errno ${read.i32(lib.symbols.__errno_location()!)} ${log.toString().split("\0")[0]}`);
  const fd = openSync(cgroup, "r");
  try {
    const attach = Buffer.alloc(20); attach.writeUInt32LE(fd, 0); attach.writeUInt32LE(program, 4); attach.writeUInt32LE(6, 8); attach.writeUInt32LE(2, 12);
    if (Number(lib.symbols.syscall(syscall, 8, ptr(attach), attach.length)) < 0) throw new Error(`Cannot attach cgroup device filter: errno ${read.i32(lib.symbols.__errno_location()!)}`);
  } finally { closeSync(fd); closeSync(program); lib.close(); }
}
