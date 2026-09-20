import { constants, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { dlopen } from "bun:ffi";
import { parseArgs } from "node:util";
import { bootstrap } from "./bootstrap.ts";
import { prepareCgroup, removeCgroup, cgroupPids } from "./cgroup.ts";
import { validateSpec } from "./spec.ts";

interface State { ociVersion: string; id: string; status: "created" | "running" | "stopped"; pid: number; bundle: string; annotations?: Record<string, string>; startTime: string; cgroup: string }
export function processIdentity(pid: number): { startTime: string; live: boolean } | undefined {
  try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" "); return { startTime: fields[19]!, live: !["Z", "X"].includes(fields[0]!) }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function alive(s: State) { const p = processIdentity(s.pid); return !!p?.live && p.startTime === s.startTime; }
function signal(s: State, sig: number) {
  const lib = dlopen("libc.so.6", { syscall: { args: ["i64", "i64", "i64", "ptr", "i64"], returns: "i64" } });
  // pidfd binds the signal to one process even if the PID is recycled after validation.
  const fd = Number(lib.symbols.syscall(434, s.pid, 0, null, 0));
  try {
    if (fd < 0 || !alive(s)) throw new Error("container not running");
    if (Number(lib.symbols.syscall(424, fd, sig, null, 0)) < 0) throw new Error("Cannot signal container process");
  } finally { if (fd >= 0) closeSync(fd); lib.close(); }
}
export async function ociCli(args: string[]) {
  const { values: v, positionals } = parseArgs({ args, allowPositionals: true, options: {
    root: { type: "string", default: "/run/bunc" }, log: { type: "string" }, "log-format": { type: "string" }, "systemd-cgroup": { type: "boolean" },
    "experimental-oci": { type: "boolean" }, bundle: { type: "string" }, "pid-file": { type: "string" }, force: { type: "boolean" }, all: { type: "boolean" }, format: { type: "string" },
  } });
  try {
    if (!v["experimental-oci"]) throw new Error("OCI lifecycle commands require --experimental-oci; use only in a disposable kind lab");
    const [command, id, sig] = positionals;
    if (command === "features") {
      console.log(JSON.stringify({ ociVersionMin: "1.0.0", ociVersionMax: "1.3.0", linux: { namespaces: ["pid", "mount", "network", "ipc", "uts", "cgroup"], cgroup: { v2: true, systemd: false }, seccomp: { enabled: true } }, annotations: { "org.bunc.experimental": "true" } })); return;
    }
    if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(id)) throw new Error("Invalid container ID");
    if (!["create", "start", "state", "kill", "delete", "ps"].includes(command ?? "") || positionals.length > (command === "kill" ? 3 : 2)) throw new Error("Unsupported OCI lifecycle command");
    const parent = resolve(v.root, "bunc-experimental"), dir = join(parent, id), file = join(dir, "state.json");
    const save = (s: State) => { const next = `${file}.${process.pid}`; writeFileSync(next, JSON.stringify(s), { mode: 0o600, flag: "wx" }); renameSync(next, file); };
    if (command === "create") {
      if (!v.bundle || !v["pid-file"]) throw new Error("create requires --bundle and --pid-file");
      const bundle = realpathSync(v.bundle), data = readFileSync(join(bundle, "config.json"));
      if (data.length > 1024 * 1024) throw new Error("OCI configuration exceeds 1 MiB");
      const spec: unknown = JSON.parse(data.toString()); validateSpec(spec);
      if (!spec.linux.cgroupsPath?.endsWith(`:cri-containerd:${id}`)) throw new Error("cgroup must belong to this containerd container");
      const root = realpathSync(resolve(bundle, spec.root.path));
      if (!root.startsWith(bundle + "/")) throw new Error("rootfs must be inside its bundle");
      mkdirSync(parent, { recursive: true, mode: 0o700 }); mkdirSync(dir, { mode: 0o700 });
      let cg: string | undefined, pid: number | undefined, state: State | undefined;
      try {
        cg = prepareCgroup(spec);
        writeFileSync(join(dir, "worker.json"), JSON.stringify({ spec, root, cgroup: cg }), { mode: 0o600, flag: "wx" });
        const fifo = Bun.spawnSync(["mkfifo", "-m", "600", join(dir, "start.fifo")]); if (fifo.exitCode) throw new Error("Cannot create start FIFO");
        pid = bootstrap(dir, spec);
        const identity = processIdentity(pid); if (!identity) throw new Error("Container init exited during bootstrap");
        state = { ociVersion: spec.ociVersion, id, status: "created", pid, bundle, annotations: spec.annotations, startTime: identity.startTime, cgroup: cg };
        save(state);
        let ready = "";
        for (let i = 0; i < 500; i++) {
          if (existsSync(join(dir, "ready"))) ready = readFileSync(join(dir, "ready"), "utf8");
          if (ready === "ready") break;
          if (ready.startsWith("error:") || !alive(state)) throw new Error(ready || "Container init exited before readiness");
          await Bun.sleep(20);
        }
        if (ready !== "ready") throw new Error("Timed out waiting for container setup");
        writeFileSync(v["pid-file"], String(pid), { mode: 0o600, flag: "wx" });
      } catch (error) {
        if (state && alive(state)) { signal(state, 9); for (let i = 0; i < 100 && alive(state); i++) await Bun.sleep(20); }
        if (cg) removeCgroup(cg); rmSync(dir, { recursive: true, force: true }); throw error;
      }
      return;
    }
    if (!existsSync(file)) {
      if (command === "delete" && v.force) return;
      throw new Error(`Container ${id} does not exist`);
    }
    const s: State = JSON.parse(readFileSync(file, "utf8"));
    if (!alive(s)) s.status = "stopped";
    switch (command) {
      case "state": console.log(JSON.stringify({ ociVersion: s.ociVersion, id, status: s.status, pid: s.status === "stopped" ? 0 : s.pid, bundle: s.bundle, annotations: s.annotations })); break;
      case "start": {
        if (s.status !== "created") throw new Error("Container must be created before start");
        mkdirSync(join(dir, "started"), { mode: 0o700 }); // Exactly one start writer.
        const fd = openSync(join(dir, "start.fifo"), constants.O_WRONLY | constants.O_NONBLOCK);
        try { writeFileSync(fd, Buffer.from([1])); } finally { closeSync(fd); }
        s.status = "running"; save(s); break;
      }
      case "kill": {
        const signals: Record<string, number> = { TERM: 15, SIGTERM: 15, KILL: 9, SIGKILL: 9, INT: 2, SIGINT: 2, HUP: 1, SIGHUP: 1, QUIT: 3, SIGQUIT: 3 };
        const value = signals[sig ?? ""] ?? Number(sig);
        if (!Number.isInteger(value) || value < 1 || value > 64) throw new Error("Invalid signal");
        if (v.all) {
          if (value !== 9) throw new Error("--all supports SIGKILL only in the experimental profile");
          // The kernel atomically kills the cgroup, including processes that race
          // with init exit. Empty cgroups succeed during containerd exit cleanup.
          writeFileSync(join(s.cgroup, "cgroup.kill"), "1");
        } else if (alive(s)) signal(s, value); else throw new Error("container not running");
        break;
      }
      case "ps": console.log(JSON.stringify(s.status === "stopped" ? [] : cgroupPids(s.cgroup))); break;
      case "delete": {
        if (s.status !== "stopped" && !v.force) throw new Error("Cannot delete a running container without --force");
        if (alive(s)) signal(s, 9);
        for (let i = 0; i < 250 && alive(s); i++) await Bun.sleep(20);
        if (alive(s)) throw new Error("Container did not stop");
        removeCgroup(s.cgroup); rmSync(dir, { recursive: true }); break;
      }
    }
  } catch (error) {
    if (v.log) writeFileSync(v.log, JSON.stringify({ level: "error", msg: String(error), time: new Date().toISOString() }) + "\n", { flag: "a", mode: 0o600 });
    throw error;
  }
}
