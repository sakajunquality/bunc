import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import assert from "node:assert/strict";
import { compileBinary } from "./compile.ts";

const { values, positionals } = parseArgs({ args: Bun.argv.slice(2), allowPositionals: true, options: {
  standalone: { type: "boolean", default: false }, verify: { type: "boolean", default: false }, layout: { type: "string" }, port: { type: "string", default: "18080" },
} });
const backend = positionals[0];
if (!["docker", "apple"].includes(backend ?? "") || positionals.length !== 1) throw new Error("Usage: bun scripts/lab.ts docker|apple [--standalone] [--verify] [--layout DIRECTORY] [--port 18080]");
const tool = backend === "apple" ? "container" : "docker";
if (!Bun.which(tool)) throw new Error(`${tool} is not installed`);
const repo = resolve(import.meta.dir, ".."), results = join(repo, ".bunc-output", "results");
let here = join(repo, "dist");
const resultName = `${backend}${values.standalone ? "-standalone" : ""}`;
const layout = resolve(values.layout ?? join(repo, ".bunc-output", "image"));
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Port must be between 1024 and 65535");
if ([here, layout].some(path => path.includes(","))) throw new Error("Bind mount paths cannot contain commas");
await mkdir(results, { recursive: true });

async function command(args: string[], required = true) {
  const child = Bun.spawn(args, { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (required && code !== 0) throw new Error(`${args.slice(0, 2).join(" ")} exited ${code}: ${stderr || stdout}`);
  return { stdout, stderr, code };
}
await command(backend === "apple" ? [tool, "system", "status"] : [tool, "info", "--format", "{{.OSType}}"]);
if (!await Bun.file(join(layout, "index.json")).exists()) {
  if (values.layout) throw new Error("The supplied layout has no index.json");
  console.log("Building the demo OCI image with bunko...");
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  const build = await command([process.execPath, "x", "--no-install", "--bun", "@sakajunquality/bunko", "build", join(repo, "examples", "web"), "--base", "oven/bun:1.4.2-distroless", "--platform", `linux/${arch}`, "--push=false", "--oci-layout", layout, "--git-metadata=false"]);
  await Bun.write(join(results, "build.log"), build.stdout + build.stderr);
}
// Pin the disposable Linux host, independent of the image being run inside it.
const hostImage = "docker.io/oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895";
const name = `bunc-${backend}-${process.pid}`;
const options = backend === "apple"
  ? ["--cap-add", "ALL", "--memory", "1G", "--cpus", "2"]
  : ["--privileged", "--memory", "1g", "--cpus", "2", "-p", `127.0.0.1:${port}:8080`];
const mount = (source: string, target: string) => `type=bind,source=${source},target=${target},readonly`;
// Remove the host's Bun installation only inside this disposable environment.
// The application image still provides its own Bun after pivot_root.
const entrypoint = values.standalone
  ? `rm -f /usr/local/bin/bun /usr/local/bin/bunx; if command -v bun >/dev/null 2>&1; then exit 1; fi; echo 'Standalone host has no Bun executable'; touch /outside-marker; exec /runtime/bunc-linux-${process.arch} run /input`
  : "touch /outside-marker; exec bun /runtime/bunc.js run /input";

let endpoint = "", response: unknown, stopped = false;
const began = performance.now();
let requestedStop: (() => void) | undefined;
const stopRequested = new Promise<void>(resolve => { requestedStop = resolve; });
process.on("SIGINT", requestedStop!); process.on("SIGTERM", requestedStop!);
try {
  if (values.standalone) {
    console.log(`Compiling a standalone Linux ${process.arch} executable...`);
    here = await mkdtemp(join(repo, ".bunc-output", "standalone-"));
    await compileBinary(process.arch, join(here, `bunc-linux-${process.arch}`));
  } else {
    const bundle = await Bun.build({ entrypoints: [join(repo, "src", "runtime.ts")], target: "bun", outdir: here, naming: "bunc.js" });
    if (!bundle.success) throw new AggregateError(bundle.logs, "Runtime bundle failed");
  }
  const start = [tool, "run", "-d", "--name", name, ...options, "--env", "OUTER_SECRET_SENTINEL=not-in-image", "--mount", mount(here, "/runtime"), "--mount", mount(layout, "/input"), "--entrypoint", "/bin/sh", hostImage, "-c", entrypoint];
  console.log(`Starting ${name} with ${backend}...`);
  const started = await command(start);
  await Bun.write(join(results, `${resultName}-start.log`), started.stdout + started.stderr);
  if (backend === "apple") {
    const inspect = JSON.parse((await command([tool, "inspect", name])).stdout);
    const ip = inspect[0]?.status?.networks?.[0]?.ipv4Address?.split("/")[0];
    if (!ip || !/^\d+(\.\d+){3}$/.test(ip)) throw new Error("Apple Container did not provide an IPv4 address");
    endpoint = `http://${ip}:8080/`;
  } else endpoint = `http://127.0.0.1:${port}/`;
  let lastError: unknown;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const http = await fetch(endpoint, { signal: AbortSignal.timeout(1000) });
      if (!http.ok) throw new Error(`HTTP ${http.status}`);
      const body = await http.text();
      response = values.verify ? JSON.parse(body) : body;
      lastError = undefined;
      break;
    } catch (error) { lastError = error; await Bun.sleep(250); }
  }
  if (lastError) throw new Error(`App did not become ready: ${lastError}`);
  const startupMs = Math.round(performance.now() - began);
  console.log(`Listening: ${endpoint} (${startupMs} ms including host startup and image unpack)`);
  if (values.verify) {
    const data = response as Record<string, unknown>;
    assert.equal(data.message, "Hello from a bunko image on a Bun runtime");
    assert.equal(data.runtime, "bun"); assert.equal(data.bun, "1.4.2");
    assert.equal(data.pid, 1); assert.equal(data.uid, 65532); assert.equal(data.gid, 65532);
    assert.equal(data.cwd, "/app"); assert.equal(data.hostname, "bunc");
    for (const field of ["isolatedRoot", "writableTmp", "readonlyRoot", "hostEnvironmentAbsent"]) assert.equal(data[field], true, field);
    assert(Array.isArray(data.proc) && data.proc.includes("CapEff:\t0000000000000000")); assert(Array.isArray(data.proc) && data.proc.includes("NoNewPrivs:\t1"));
    assert.equal((await fetch(new URL("/missing", endpoint))).status, 404);
  } else {
    console.log("Press Ctrl-C to stop the app and remove the disposable host.");
    await stopRequested;
  }
  await command([tool, "stop", "-t", "5", name]); stopped = true;
  const output = await command([tool, "logs", name]);
  const logs = output.stdout + output.stderr;
  await Bun.write(join(results, `${resultName}.log`), logs);
  if (values.verify) {
    assert(logs.includes("Demo received SIGTERM"), "App must receive SIGTERM");
    assert(logs.includes('"event":"exit","code":0,"signal":"SIGTERM"'), "App must exit normally after SIGTERM");
    assert(logs.includes('"event":"cleanup","removed":true'), "Runtime must remove its temporary rootfs");
    const launch = logs.split("\n").find(line => line.startsWith('{"event":"launch"'));
    assert(launch, "Runtime must log its execution mode");
    assert.equal(JSON.parse(launch).standalone, values.standalone);
    if (values.standalone) assert(logs.includes("Standalone host has no Bun executable"));
    await Bun.write(join(results, `${resultName}.json`), JSON.stringify({ backend, standalone: values.standalone, endpoint, startupMs, verifiedAt: new Date().toISOString(), launch: launch ? JSON.parse(launch) : null, response, checks: ["HTTP 200", "HTTP 404", "image configuration", "PID 1", "nonroot", "isolated root", "read-only root", "writable tmp", "no host environment", "no effective capabilities", "no_new_privs", "graceful SIGTERM", "rootfs cleanup"], status: "passed" }, null, 2) + "\n");
    console.log(`${backend}: all checks passed. Results: ${results}`);
  }
} catch (error) {
  const output = await command([tool, "logs", name], false);
  await Bun.write(join(results, `${resultName}-failure.log`), output.stdout + output.stderr);
  throw error;
} finally {
  process.off("SIGINT", requestedStop!); process.off("SIGTERM", requestedStop!);
  if (!stopped) await command([tool, "stop", "-t", "5", name], false);
  const removed = await command([tool, "rm", name], false);
  if (values.standalone && removed.code === 0) await rm(here, { recursive: true, force: true });
}
