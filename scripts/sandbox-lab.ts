import { parseArgs } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { cpus } from "node:os";
import { compileBinary } from "./compile.ts";

const { values, positionals } = parseArgs({ args: Bun.argv.slice(2), allowPositionals: true, options: {
  standalone: { type: "boolean", default: false }, layout: { type: "string" }, benchmark: { type: "boolean", default: false },
} });
const backend = positionals[0];
if (!["docker", "apple"].includes(backend ?? "") || positionals.length !== 1) throw new Error("Usage: bun scripts/sandbox-lab.ts docker|apple [--standalone] [--layout PATH] [--benchmark]");
const tool = backend === "apple" ? "container" : "docker";
if (!Bun.which(tool)) throw new Error(`${tool} is not installed`);
const repo = resolve(import.meta.dir, ".."), output = join(repo, ".bunc-output");
await mkdir(output, { recursive: true });
const work = await mkdtemp(join(output, `sandbox-${backend}-`));
const runtime = join(work, "runtime"), results = join(work, "results");
await mkdir(runtime); await mkdir(results);
const layout = resolve(values.layout ?? join(work, "image"));
const name = `bunc-sandbox-${backend}-${process.pid}`;
const hostImage = "docker.io/oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895";

async function command(args: string[], required = true) {
  const child = Bun.spawn(args, { cwd: repo, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (required && code !== 0) throw new Error(`${args.slice(0, 2).join(" ")} exited ${code}: ${stderr || stdout}`);
  return { stdout, stderr, code };
}
await command(backend === "apple" ? [tool, "system", "status"] : [tool, "info", "--format", "{{.OSType}}"]);
if (!await Bun.file(join(layout, "index.json")).exists()) {
  if (values.layout) throw new Error("The supplied layout has no index.json");
  console.log("Preparing the trusted bunko example image...");
  const build = await command([process.execPath, "x", "--no-install", "--bun", "@sakajunquality/bunko", "build", join(repo, "examples/web"), "--base", "oven/bun:1.4.2-distroless", "--platform", `linux/${process.arch === "arm64" ? "arm64" : "amd64"}`, "--push=false", "--oci-layout", layout, "--git-metadata=false"]);
  await writeFile(join(work, "image-build.log"), build.stdout + build.stderr);
}
for (const [entry, filename] of [["src/runtime.ts", "bunc.js"], ["scripts/sandbox-acceptance.ts", "acceptance.js"]]) {
  const build = await Bun.build({ entrypoints: [join(repo, entry!)], target: "bun", outdir: runtime, naming: filename! });
  if (!build.success) throw new AggregateError(build.logs, `Cannot build ${entry}`);
}
if (values.standalone) await compileBinary(process.arch, join(runtime, "bunc"));

// This script only changes the cgroup namespace of the disposable test host.
// Run acceptance as init's successor: future docker exec processes cannot enter
// a domain whose controllers are enabled and whose processes were moved out.
const entrypoint = [
  "set -eu",
  "mkdir -p /sys/fs/cgroup/bunc-control",
  "echo $$ > /sys/fs/cgroup/bunc-control/cgroup.procs",
  "echo '+cpu +memory +pids' > /sys/fs/cgroup/cgroup.subtree_control",
  "mkdir /sys/fs/cgroup/bunc-jobs",
  "echo '+cpu +memory +pids' > /sys/fs/cgroup/bunc-jobs/cgroup.subtree_control",
  "touch /outside-marker",
  `exec bun /runtime/acceptance.js${values.standalone ? " --standalone" : ""}${values.benchmark ? " --benchmark" : ""}`,
].join("\n");
const mount = (source: string, target: string, readonly = true) => {
  if (source.includes(",")) throw new Error("Mount source cannot contain commas");
  return `type=bind,source=${source},target=${target}${readonly ? ",readonly" : ""}`;
};
const platformOptions = backend === "apple" ? ["--cap-add", "ALL", "--memory", "2G", "--cpus", "2"]
  : ["--privileged", "--cgroupns=private", "--memory", "2g", "--cpus", "2"];
const cancel = () => { void command([tool, "stop", "-t", "3", name], false); };
process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
try {
  console.log(`Running experimental sandbox acceptance with ${backend}${values.standalone ? " (standalone)" : ""}...`);
  const invocationStarted = performance.now();
  const child = Bun.spawn([tool, "run", "--name", name, ...platformOptions,
    "--env", "OUTER_SECRET_SENTINEL=not-in-job", "--env", `BUNC_LAB_BACKEND=${backend}`,
    "--mount", mount(runtime, "/runtime"), "--mount", mount(layout, "/image"),
    "--mount", mount(results, "/evidence", false), "--entrypoint", "/bin/sh", hostImage, "-c", entrypoint,
  ], { cwd: repo, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(cancel, values.benchmark ? 600_000 : 300_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    await writeFile(join(work, "acceptance.log"), stdout + stderr);
    await writeFile(join(work, "lab.json"), JSON.stringify({ backend, standalone: values.standalone, benchmark: values.benchmark,
      architecture: process.arch, bun: Bun.version, hostImage, memoryBytes: 2 * 1024 ** 3, cpus: 2,
      hostCpu: cpus()[0]?.model ?? "unknown",
      outerInvocationMs: performance.now() - invocationStarted, exitCode: code }, null, 2) + "\n");
    if (stdout) process.stdout.write(stdout); if (stderr) process.stderr.write(stderr);
    if (code !== 0) throw new Error(`Sandbox acceptance failed (${code}); evidence: ${work}`);
    console.log(`Sandbox evidence: ${work}`);
  } finally { clearTimeout(timeout); }
} finally {
  process.off("SIGINT", cancel); process.off("SIGTERM", cancel);
  await command([tool, "stop", "-t", "3", name], false);
  await command([tool, "rm", name], false);
  await rm(runtime, { recursive: true, force: true });
}
