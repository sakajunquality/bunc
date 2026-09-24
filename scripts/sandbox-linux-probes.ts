import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnLinuxSandbox, type SandboxLinuxPlan } from "../src/sandbox/linux.ts";
import type { PreparedEnvironment } from "../src/sandbox/environment.ts";

export interface LinuxEngineProbeOptions {
  directory: string;
  cgroupParent: string;
  environment: PreparedEnvironment;
  workerCommand: string[];
}

async function capture(stream: ReadableStream<Uint8Array>) { return new Uint8Array(await new Response(stream).arrayBuffer()); }

/** Direct native-engine probes which cannot pass the public environment contract. */
export async function runLinuxEngineProbes(options: LinuxEngineProbeOptions): Promise<void> {
  const root = await mkdtemp(join(options.directory, "engine-probes-"));
  try {
    for (const mode of ["exec", "setup"] as const) {
      const stateDir = join(root, mode), codeDir = join(stateDir, "code"), inputDir = join(stateDir, "input");
      await mkdir(codeDir, { recursive: true, mode: 0o700 }); await mkdir(inputDir, { mode: 0o700 });
      await writeFile(join(codeDir, "main.ts"), "void 0", { mode: 0o400 }); await writeFile(join(codeDir, "bunfig.toml"), "", { mode: 0o400 });
      const runId = `probe_${mode}_${randomBytes(4).toString("hex")}`;
      const executable = mode === "exec" ? "/bunc-deliberately-missing" : options.environment.interpreter;
      const plan: SandboxLinuxPlan = {
        stateDir, runId, ownerToken: randomBytes(16).toString("hex"), cgroupParent: options.cgroupParent,
        rootfs: mode === "setup" ? join(stateDir, "missing-rootfs") : options.environment.rootfs,
        codeDir, inputDir, scratchDir: join(stateDir, "scratch"), executable,
        argv: mode === "exec" ? [executable] : [executable, ...options.environment.runtimeFlags, "/code/main.ts"],
        env: ["PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/home/sandbox", "TMPDIR=/tmp", "LANG=C.UTF-8", "TZ=UTC"],
        cwd: "/work", uid: 65532, gid: 65532, hostname: "bunc-probe", nofile: 256,
        hardDeadlineMs: 3000, workerCommand: options.workerCommand,
        limits: { memoryBytes: 256 * 1024 ** 2, cpuPeriodMicros: 100_000, cpuQuotaMicros: 100_000,
          pidsMax: 64, scratchBytes: 8 * 1024 ** 2, scratchInodes: 512 },
      };
      const child = await spawnLinuxSandbox(plan), stdout = capture(child.stdout), stderr = capture(child.stderr);
      const setup = await child.setup.then(() => "", error => error instanceof Error ? error.message : String(error));
      assert.match(setup, mode === "exec" ? /exec failed/ : /setup failed/);
      await child.wait(); await Promise.all([stdout, stderr]);
      const cleanup = await child.cleanup();
      assert.equal(cleanup.complete, true, `${mode} probe cleanup: ${cleanup.errors.join("; ")}`);
    }
    const mode = "guardian", stateDir = join(root, mode), codeDir = join(stateDir, "code"), inputDir = join(stateDir, "input");
    await mkdir(codeDir, { recursive: true, mode: 0o700 }); await mkdir(inputDir, { mode: 0o700 });
    await writeFile(join(codeDir, "main.ts"), "import { dlopen } from 'bun:ffi'; const libc=dlopen('libc.so.6',{prctl:{args:['i32','u64','u64','u64','u64'],returns:'i32'}}); if(libc.symbols.prctl(1,0,0,0,0)!==-1) process.exit(77); while (true) {}", { mode: 0o444 }); await writeFile(join(codeDir, "bunfig.toml"), "", { mode: 0o444 });
    await chmod(codeDir, 0o555); await chmod(inputDir, 0o555);
    const runId = `probe_${mode}_${randomBytes(4).toString("hex")}`;
    const plan: SandboxLinuxPlan = {
      stateDir, runId, ownerToken: randomBytes(16).toString("hex"), cgroupParent: options.cgroupParent,
      rootfs: options.environment.rootfs, codeDir, inputDir, scratchDir: join(stateDir, "scratch"),
      executable: options.environment.interpreter,
      argv: [options.environment.interpreter, ...options.environment.runtimeFlags, "/code/main.ts"],
      env: ["PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/home/sandbox", "TMPDIR=/tmp", "LANG=C.UTF-8", "TZ=UTC"],
      cwd: "/work", uid: 65532, gid: 65532, hostname: "bunc-probe", nofile: 256,
      hardDeadlineMs: 10_000, workerCommand: options.workerCommand,
      limits: { memoryBytes: 256 * 1024 ** 2, cpuPeriodMicros: 100_000, cpuQuotaMicros: 100_000,
        pidsMax: 64, scratchBytes: 8 * 1024 ** 2, scratchInodes: 512 },
    };
    const child = await spawnLinuxSandbox(plan), stdout = capture(child.stdout), stderr = capture(child.stderr);
    await child.setup;
    const wait = child.wait(); void wait.catch(() => {});
    const liveDeadline = performance.now() + 1000; let live = false;
    while (performance.now() < liveDeadline) {
      try {
        live = /^populated 1$/m.test(await readFile(join(child.cgroupPath, "cgroup.events"), "utf8"));
        if (live) { process.kill(child.pid, 0); break; }
      } catch {}
      await Bun.sleep(5);
    }
    assert.equal(live, true, "Guardian probe guest must be running before guardian termination");
    process.kill(child.guardianPid, "SIGKILL");
    const emptyDeadline = performance.now() + 2000; let emptied = false;
    while (performance.now() < emptyDeadline) {
      emptied = /^populated 0$/m.test(await readFile(join(child.cgroupPath, "cgroup.events"), "utf8"));
      if (emptied) break;
      await Bun.sleep(5);
    }
    assert.equal(emptied, true, "Guardian SIGKILL must empty the guest cgroup before caller intervention");
    const waitFailure = await wait.then(() => "", error => error instanceof Error ? error.message : String(error));
    assert.match(waitFailure, /guardian exited without process status/);
    await child.stop(); await Promise.all([stdout, stderr]);
    const cleanup = await child.cleanup();
    assert.equal(cleanup.complete, true, `guardian probe cleanup: ${cleanup.errors.join("; ")}`);
  } finally { await rm(root, { recursive: true, force: true }); }
}
