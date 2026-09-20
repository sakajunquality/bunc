import { restrictDevices } from "./devices.ts";
import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Spec } from "./spec.ts";

export function cgroupPath(value: string): string {
  // containerd uses systemd's slice:prefix:name notation even in the lab.
  const parts = value.split(":");
  if (parts.length !== 3 || !parts.every(s => /^[a-zA-Z0-9_.-]+$/.test(s)) || !parts[0]!.endsWith(".slice")) throw new Error("Only systemd-style containerd cgroup paths are supported");
  const stem = parts[0]!.slice(0, -6), segments = stem.split("-");
  return join("/sys/fs/cgroup", ...segments.map((_, i) => segments.slice(0, i + 1).join("-") + ".slice"), `${parts[1]}-${parts[2]}.scope`);
}
export function prepareCgroup(spec: Spec): string {
  if (!existsSync("/sys/fs/cgroup/cgroup.controllers")) throw new Error("Experimental OCI mode requires cgroup v2");
  const path = cgroupPath(spec.linux.cgroupsPath ?? "");
  // The lab uses a cgroupfs child of the pod slice prepared by kubelet.
  writeFileSync(join(dirname(path), "cgroup.subtree_control"), "+cpu +memory +pids");
  mkdirSync(path); // Never reuse an existing container cgroup.
  try {
    const r = spec.linux.resources;
    const write = (name: string, value: string | number) => writeFileSync(join(path, name), String(value));
    if (r?.cpu?.shares !== undefined) write("cpu.weight", Math.max(1, Math.min(10000, 1 + Math.floor((r.cpu.shares - 2) * 9999 / 262142))));
    if (r?.cpu?.quota !== undefined || r?.cpu?.period !== undefined) write("cpu.max", `${(r.cpu.quota ?? -1) <= 0 ? "max" : r.cpu.quota} ${r.cpu.period ?? 100000}`);
    if (r?.memory?.limit !== undefined) write("memory.max", r.memory.limit <= 0 ? "max" : r.memory.limit);
    if (r?.memory?.swap !== undefined) {
      if (r.memory.swap >= 0 && r.memory.limit === undefined) throw new Error("Swap requires a memory limit");
      write("memory.swap.max", r.memory.swap < 0 ? "max" : Math.max(0, r.memory.swap - r.memory.limit!));
    }
    if (r?.pids) write("pids.max", r.pids.limit <= 0 ? "max" : r.pids.limit);
    for (const [name, value] of Object.entries(r?.unified ?? {})) write(name, value);
    restrictDevices(path);
    return path;
  } catch (error) { rmdirSync(path); throw error; }
}
export function removeCgroup(path: string) {
  try { rmdirSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
export function cgroupPids(path: string): number[] {
  return readFileSync(join(path, "cgroup.procs"), "utf8").trim().split("\n").filter(Boolean).map(Number);
}
