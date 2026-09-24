import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile, statfs, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { BlobStore } from "../src/oci/blob-store.ts";
import { LayoutSource, resolveBase } from "../src/oci/source.ts";
import type { JobResult } from "../src/sandbox/contract.ts";
import { openPreparedEnvironment, parseEnvironmentDescriptor } from "../src/sandbox/environment.ts";
import { runLinuxEngineProbes } from "./sandbox-linux-probes.ts";
import { createRunner } from "../src/sandbox/sdk.ts";
import { DEFAULT_SANDBOX_POLICY } from "../src/sandbox/policy.ts";
import { runSandboxStateAcceptance } from "./sandbox-state-acceptance.ts";

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { standalone: { type: "boolean" }, benchmark: { type: "boolean" } } });
const command = values.standalone ? ["/runtime/bunc"] : [process.execPath, "/runtime/bunc.js"];
const lab = "/lab", state = join(lab, "state"), environment = join(lab, "environment.json");
const cgroupParent = "/sys/fs/cgroup/bunc-jobs";
await mkdir(lab, { recursive: true }); await mkdir("/results", { recursive: true });
const platform = { os: "linux" as const, architecture: process.arch === "arm64" ? "arm64" as const : "amd64" as const };
const image = await resolveBase(new LayoutSource("/image"), platform, new BlobStore(join(lab, "metadata")));
// The already-running test harness needs no further host Bun exec. Removing it
// proves standalone supervisors and preparation children re-exec the binary.
if (values.standalone) { await unlink(process.execPath); assert.equal(await Bun.file(process.execPath).exists(), false); }
await writeFile(environment, JSON.stringify({ schemaVersion: 1, manifestDigest: image.descriptor.digest,
  architecture: platform.architecture, interpreter: "/usr/local/bin/bun", packagePath: null,
  workingDirectory: "/work", uid: 65532, gid: 65532,
  runtimeFlags: ["--no-install", "--no-env-file", "--config=/code/bunfig.toml"], policyRevision: "offline-v1",
}));

async function invoke(args: string[]) {
  const child = Bun.spawn([...command, "sandbox", ...args, "--experimental-sandbox"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const hostMemory = { supervisorSampledRssBytes: 0, guardianSampledRssBytes: 0 };
  let pending: Promise<void> | undefined;
  const sample = async () => {
    const rss = async (pid: number) => {
      try { return Number((await readFile(`/proc/${pid}/status`, "utf8")).match(/^VmHWM:\s+(\d+) kB$/m)?.[1] ?? 0) * 1024; }
      catch { return 0; }
    };
    hostMemory.supervisorSampledRssBytes = Math.max(hostMemory.supervisorSampledRssBytes, await rss(child.pid));
    try {
      const children = (await readFile(`/proc/${child.pid}/task/${child.pid}/children`, "utf8")).trim().split(/\s+/).filter(Boolean).map(Number);
      for (const pid of children) hostMemory.guardianSampledRssBytes = Math.max(hostMemory.guardianSampledRssBytes, await rss(pid));
    } catch { /* The short-lived supervisor may already have exited. */ }
  };
  const timer = values.benchmark && args[0] === "run" ? setInterval(() => {
    if (!pending) pending = sample().finally(() => { pending = undefined; });
  }, 5) : undefined;
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code, hostMemory };
  } finally { if (timer) clearInterval(timer); await pending; }
}
const checks: { name: string; ms: number; outcome: string }[] = [];
// Controlled outer-host listener: the guest must not reach a known live target.
let networkRequests = 0;
const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { networkRequests++; return new Response("outer"); } });
await fetch(`http://127.0.0.1:${listener.port}`);
assert.equal(networkRequests, 1);
const doctor = await invoke(["doctor", "--cgroup-parent", cgroupParent]);
assert.equal(doctor.code, 0, `doctor: ${doctor.stderr || doctor.stdout}`);
await writeFile("/results/doctor.json", doctor.stdout);
const begin = performance.now();
const prepare = await invoke(["prepare", "--layout", "/image", "--environment", environment, "--state-root", state]);
assert.equal(prepare.code, 0, `prepare: ${prepare.stderr || prepare.stdout}`);
await writeFile("/results/prepared.json", prepare.stdout);
const preparationMs = performance.now() - begin;
const preparedForProbes = await openPreparedEnvironment(state, parseEnvironmentDescriptor(await readFile(environment)));
await runLinuxEngineProbes({ directory: lab, cgroupParent, environment: preparedForProbes, workerCommand: command });
checks.push({ name: "native-setup-and-exec-failures", ms: 0, outcome: "verified" });
console.log("native-engine-errors: verified");
const jobArgs = (request: string, result: string) => ["run", "--environment", environment, "--state-root", state,
  "--cgroup-parent", cgroupParent, "--request", request, "--result-dir", result];

async function run(name: string, code: string, options: { inputs?: unknown[]; limits?: Record<string, number> } = {}) {
  const request = join(lab, `${name}.json`), destination = join("/results", name);
  await writeFile(request, JSON.stringify({ schemaVersion: 1, code, inputs: options.inputs ?? [], limits: options.limits ?? {} }));
  const started = performance.now();
  const response = await invoke(jobArgs(request, destination));
  let result: JobResult;
  try { result = JSON.parse(response.stdout) as JobResult; }
  catch { throw new Error(`${name}: invalid result (${response.code}): ${response.stdout}\n${response.stderr}`); }
  assert.equal(result.schemaVersion, 1, `${name}: ${response.stdout}`);
  assert.equal(result.cleanup, result.outcome === "rejected" ? "not_needed" : "complete", `${name}: cleanup: ${JSON.stringify(result)}`);
  checks.push({ name, ms: performance.now() - started, outcome: result.outcome });
  console.log(`${name}: ${result.outcome} (${Math.round(checks.at(-1)!.ms)} ms)`);
  return { ...response, result, destination };
}
async function artifact(job: Awaited<ReturnType<typeof run>>, path: string) {
  const entry = job.result.artifacts.find(item => item.path === path);
  assert(entry, `Missing artifact ${path}: ${JSON.stringify(job.result)}`);
  const bytes = await readFile(join(job.destination, entry.file));
  assert.equal(bytes.length, entry.bytes);
  assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, entry.sha256);
  return bytes;
}
const transformed = await run("transform", "const d = await Bun.file('/input/data.json').json(); await Bun.write('/output/result.json', JSON.stringify({sum: d.values.reduce((a,b)=>a+b,0)})); await Bun.write('/output/report.txt','Report: success'); await Bun.write('/output/binary.bin',await Bun.file('/input/binary.bin').arrayBuffer()); console.log('done');", {
  inputs: [{ path: "data.json", encoding: "utf8", data: '{"values":[1,2,3]}' }, { path: "binary.bin", encoding: "base64", data: "AP8BAg==" }],
});
assert.equal(transformed.code, 0, JSON.stringify(transformed.result));
assert.equal(JSON.parse((await artifact(transformed, "result.json")).toString()).sum, 6);
assert.equal((await artifact(transformed, "binary.bin")).toString("hex"), "00ff0102");
assert.equal((await artifact(transformed, "report.txt")).toString(), "Report: success");

const failed = await run("program-error", "throw new Error('synthetic failure')");
assert.equal(failed.result.outcome, "failed"); assert.equal(failed.code, 1);
const retry = await run("corrected-retry", "console.log(2 + 2)");
assert.equal(retry.result.outcome, "succeeded");
const timed = await run("deadline", "while (true) {}", { limits: { timeoutMs: 300 } });
assert.equal(timed.result.outcome, "timed_out");
const flood = await run("stdio-limit", "while (true) { console.log('x'.repeat(65536)); console.error('y'.repeat(65536)); }", { limits: { stdioBytes: 4096 } });
assert.equal(flood.result.outcome, "resource_exhausted");
assert(flood.result.stdout.bytes + flood.result.stderr.bytes <= 4096);
const memory = await run("memory-limit", "const a=[]; while(true) a.push(new Uint8Array(8*1024*1024).fill(7));");
assert.equal(memory.result.outcome, "resource_exhausted", JSON.stringify(memory.result));

const isolation = await run("isolation", `
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dlopen } from 'bun:ffi';
const blocked = (f) => { try { f(); return false; } catch { return true; } };
const s = readFileSync('/proc/self/status','utf8');
const libc = dlopen('libc.so.6',{socket:{args:['i32','i32','i32'],returns:'i32'}});
const sockets = [[1,1],[2,1],[2,2],[10,1],[10,2]].map(([family,type]) => libc.symbols.socket(family,type,0));
const network = await Promise.all(['http://127.0.0.1:${listener.port}','http://[::1]:${listener.port}','http://169.254.169.254'].map(async url => { try { await fetch(url,{signal:AbortSignal.timeout(100)}); return false; } catch { return true; } }));
const result = {uid:process.getuid(),gid:process.getgid(),cwd:process.cwd(),secret:process.env.OUTER_SECRET_SENTINEL??null,
  outer:blocked(()=>readFileSync('/outside-marker')), state:blocked(()=>readFileSync('/lab/state/.lock')),
  root:blocked(()=>writeFileSync('/host-write','x')), code:blocked(()=>writeFileSync('/code/main.ts','x')),
  input:blocked(()=>writeFileSync('/input/extra','x')), status:s, network, sockets,
  stdin:(await Bun.file('/dev/stdin').arrayBuffer()).byteLength,
  fds:readdirSync('/proc/self/fd').map(f=>{try{return require('node:fs').readlinkSync('/proc/self/fd/'+f)}catch{return ''}})};
await Bun.write('/output/isolation.json',JSON.stringify(result));`);
assert.equal(isolation.result.outcome, "succeeded", JSON.stringify(isolation.result));
const probes = JSON.parse((await artifact(isolation, "isolation.json")).toString());
assert.equal(probes.uid, 65532); assert.equal(probes.gid, 65532); assert.equal(probes.cwd, "/work");
assert.equal(probes.secret, null); assert.equal(probes.stdin, 0);
for (const key of ["outer", "state", "root", "code", "input"]) assert.equal(probes[key], true, key);
assert.match(probes.status, /CapEff:\s+0000000000000000/);
assert.match(probes.status, /CapBnd:\s+0000000000000000/);
assert.match(probes.status, /NoNewPrivs:\s+1/); assert.match(probes.status, /Seccomp:\s+2/);
assert(probes.network.every(Boolean));
assert(probes.sockets.every((fd:number)=>fd === -1), "Unix, IPv4/IPv6 TCP and UDP socket creation are all denied");
assert.equal(networkRequests, 1, "Guest never reached the controlled outer listener");
listener.stop(true);
assert(probes.fds.every((fd: string) => !fd.includes("/lab/") && !fd.includes("/sys/fs/cgroup/") && !fd.includes("/runtime/")));

const child = await run("descendant-cleanup", "Bun.spawn([process.execPath,'--no-install','--no-env-file','-e','setInterval(()=>{},1000)'],{stdin:'ignore',stdout:'ignore',stderr:'ignore'}); process.exit(0);");
assert.equal(child.result.outcome, "succeeded", JSON.stringify(child.result));
const tasks = await run("task-limit", "let children=[];try {for(let i=0;i<200;i++){children.push(Bun.spawn([process.execPath,'--no-install','--no-env-file','-e','setInterval(()=>{},1000)'],{stdin:'ignore',stdout:'ignore',stderr:'ignore'}));await Bun.sleep(10);}}catch(e){console.log('task creation stopped');}process.exit(0);", {limits:{memoryMiB:512}});
assert(tasks.result.limitsHit.includes("pidsMax"), JSON.stringify(tasks.result));
const badArtifact = await run("symlink-artifact", "require('node:fs').symlinkSync('/outside-marker','/output/escape');");
assert.equal(badArtifact.code, 2); assert.equal(badArtifact.result.artifactsComplete, false); assert.equal(badArtifact.result.artifacts.length, 0);
const hardlink = await run("hardlink-artifact", "const fs=require('node:fs');fs.writeFileSync('/output/a','a');fs.linkSync('/output/a','/output/b');");
assert.equal(hardlink.code, 2); assert.equal(hardlink.result.artifactsComplete, false);
const sparse = await run("sparse-artifact", "const fs=require('node:fs');const fd=fs.openSync('/output/sparse','w');fs.ftruncateSync(fd,8*1024*1024);fs.closeSync(fd);");
assert.equal(sparse.code, 2); assert.equal(sparse.result.artifactsComplete, false);
const descriptors = await run("descriptor-limit", "const fs=require('node:fs');const held=[];try {while(true)held.push(fs.openSync('/dev/null','r'));} catch(e) {console.log(e.code);} finally {for(const fd of held)fs.closeSync(fd);}");
assert.equal(descriptors.code, 0); assert.match(await readFile(join(descriptors.destination, descriptors.result.stdout.file), "utf8"), /EMFILE/);
const inodes = await run("inode-limit", "const fs=require('node:fs');try {for(let i=0;i<10000;i++)fs.writeFileSync('/work/f'+i,'');}catch(e){console.log(e.code);}");
assert.equal(inodes.code, 0); assert.match(await readFile(join(inodes.destination, inodes.result.stdout.file), "utf8"), /ENOSPC/);
const bytes = await run("scratch-limit", "const fs=require('node:fs');try { const fd=fs.openSync('/work/full','w'); const b=Buffer.alloc(1024*1024);while(true)fs.writeSync(fd,b); } catch(e) { console.log(e.code); }");
assert.equal(bytes.result.outcome, "succeeded");
assert.match(await readFile(join(bytes.destination, bytes.result.stdout.file), "utf8"), /ENOSPC/);
const fresh = await run("fresh-state", "const fs=require('node:fs'); console.log(fs.readdirSync('/work').length); await Bun.write('/output/fresh.txt','fresh');");
assert.equal(fresh.result.outcome, "succeeded"); assert.equal((await readFile(join(fresh.destination, fresh.result.stdout.file), "utf8")).trim(), "0");
const overBudget = await run("policy-rejection", "throw new Error('must never run')", { limits: { timeoutMs: 30001 } });
assert.equal(overBudget.result.outcome, "rejected"); assert.equal(overBudget.result.reason?.code, "POLICY_DENIED");

// An actual caller loop uses the public wrapper and its returned artifact path.
const policy = join(lab, "policy.json"); await writeFile(policy, JSON.stringify(DEFAULT_SANDBOX_POLICY));
const runner = createRunner({ binary: command[0]!, binaryArgs: command.slice(1), environment, policy, resultsRoot: "/results/sdk", stateRoot: state, cgroupParent });
const firstAttempt = await runner.run({ schemaVersion: 1, code: "throw new Error('revise this program')" });
assert.equal(firstAttempt.outcome, "failed");
const revised = await runner.run({ schemaVersion: 1, code: "await Bun.write('/output/answer.json',JSON.stringify({answer:42}));" });
assert.equal(revised.outcome, "succeeded");
assert.equal(JSON.parse(await readFile(join(revised.resultDirectory, revised.artifacts[0]!.file), "utf8")).answer, 42);
checks.push({ name: "sdk-failure-inspect-revise", ms: 0, outcome: "succeeded" });

async function interrupted(name: string, signal: "SIGTERM" | "SIGKILL") {
  const request = join(lab, `${name}.json`), destination = join("/results", name);
  await writeFile(request, JSON.stringify({ schemaVersion: 1, code: "while(true){}", inputs: [], limits: { timeoutMs: 30000 } }));
  const child = Bun.spawn([...command, "sandbox", ...jobArgs(request, destination), "--experimental-sandbox"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
  let running = false;
  for (let i = 0; i < 100; i++) {
    for (const entry of await readdir(cgroupParent, { withFileTypes: true })) if (entry.isDirectory()) {
      try { if ((await readFile(join(cgroupParent, entry.name, "cgroup.procs"), "utf8")).trim()) running = true; } catch {}
    }
    if (running) break;
    await Bun.sleep(20);
  }
  assert(running, `${name}: did not start`);
  await Bun.sleep(100); child.kill(signal);
  const exit = await child.exited;
  const out = await stdout, err = await stderr;
  if (signal === "SIGTERM") {
    const result = JSON.parse(out) as JobResult;
    assert.equal(result.outcome, "cancelled", `${out}\n${err}`); assert.equal(result.cleanup, "complete"); assert.equal(exit, 1);
  } else {
    assert.notEqual(exit, 0);
    const gc = await invoke(["gc", "--state-root", state, "--cgroup-parent", cgroupParent]);
    assert.equal(gc.code, 0, `gc: ${gc.stdout}\n${gc.stderr}`);
  }
  checks.push({ name, ms: 0, outcome: signal === "SIGTERM" ? "cancelled" : "interrupted" });
  console.log(`${name}: verified`);
}
await interrupted("cancellation", "SIGTERM");
await interrupted("supervisor-crash", "SIGKILL");
checks.push(...await runSandboxStateAcceptance({command, environment, stateRoot:state, layout:"/image", labRoot:lab, cgroupParent}));
assert.equal((await readdir(cgroupParent, { withFileTypes: true })).filter(e => e.isDirectory()).length, 0, "No leftover job cgroups");

const warmTimes: number[] = [];
const workloadTimes: number[] = [];
const samples: { workload: string; wallMs: number; cpuUsageUsec: number | null; memoryPeakBytes: number | null; prepareMs: number; executeMs: number; finalizeMs: number; supervisorSampledRssBytes: number; guardianSampledRssBytes: number }[] = [];
if (values.benchmark) {
  for (const workload of ["noop", "json"] as const) {
    for (let i = 0; i < 105; i++) {
      const t = performance.now();
      const job = await run(`benchmark-${workload}-${i}`, workload === "noop" ? "void 0" : "const d=await Bun.file('/input/data.json').json();await Bun.write('/output/result.json',JSON.stringify({sum:d.values.reduce((a,b)=>a+b,0)}));",
        workload === "noop" ? {} : { inputs: [{ path: "data.json", encoding: "utf8", data: JSON.stringify({values: Array.from({length:1000},(_,i)=>i)}) }] });
      assert.equal(job.code, 0);
      const wallMs = performance.now() - t;
      if (i >= 5) {
        (workload === "noop" ? warmTimes : workloadTimes).push(wallMs);
        samples.push({ workload, wallMs, ...job.result.metrics, ...job.hostMemory });
      }
      await rm(job.destination, { recursive: true });
    }
  }
}
warmTimes.sort((a, b) => a - b);
workloadTimes.sort((a,b) => a-b);
const evidence = { schemaVersion: 1, status: "passed", experimental: true, platform, standalone: !!values.standalone,
  backend: process.env.BUNC_LAB_BACKEND, kernel: (await readFile("/proc/sys/kernel/osrelease", "utf8")).trim(),
  bun: Bun.version, image: image.descriptor.digest, preparationMs, checks,
  filesystem: { stateType: (await statfs(lab)).type, resultsType: (await statfs("/results")).type },
  benchmark: warmTimes.length ? { count: warmTimes.length, p50: warmTimes[49], p95: warmTimes[94], max: warmTimes.at(-1),
    json: {count:workloadTimes.length,p50:workloadTimes[49],p95:workloadTimes[94],max:workloadTimes.at(-1)}, samples,
    cacheBytes: JSON.parse(prepare.stdout).sizeBytes,
    remainingCgroups: (await readdir(cgroupParent, {withFileTypes:true})).filter(e=>e.isDirectory()).length,
  } : null,
};
await writeFile("/results/acceptance.json", JSON.stringify(evidence, null, 2) + "\n");
console.log(`Sandbox acceptance passed (${checks.length} checks).`);
