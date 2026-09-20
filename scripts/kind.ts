import { mkdtemp, mkdir, cp, copyFile, chmod, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { compileBinary } from "./compile.ts";

const repo = resolve(import.meta.dir, "..");
await mkdir(join(repo, ".bunc-output"), { recursive: true });
const output = await mkdtemp(join(repo, ".bunc-output", "kind-"));
const name = `bunc-test-${process.pid}`, node = `${name}-control-plane`, kubeconfig = join(output, "kubeconfig");
const nodeImage = "kindest/node:v1.34.11@sha256:44e222ee2132dab25ff87301682f89eb82c7880ea3a1bf543bfe9708fd08d67d";
const hashes: Record<string, string> = {
  "darwin-arm64": "0c8c7dbe5e23594a198b786c4bc13dacc101fa6196b0cb0b23a1ca44e61f4b4f",
  "darwin-amd64": "5a99f26f57246dc9319dd294803313197a0f34d33c525b3ea8b655db5916ece0",
  "linux-arm64": "20022bee6cfcd5086cb7234d218e3454e6090022f2a8f55d1fa7fcf42c3867a2",
  "linux-amd64": "aee6151561422756b764a4ae28e7f44cda5af5a9eead3cc9985112b1de8d8e0d",
};
async function run(args: string[], allowFailure = false) {
  const p = Bun.spawn(args, { cwd: repo, env: { ...process.env, KIND_EXPERIMENTAL_PROVIDER: "docker" }, stdout: "pipe", stderr: "pipe", timeout: 300000 });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code && !allowFailure) throw new Error(`${args.slice(0, 3).join(" ")} exited ${code}: ${err || out}`);
  return { out, err, code };
}
const kubectl = Bun.which("kubectl");
if (!kubectl || !Bun.which("docker")) throw new Error("The kind lab requires kubectl and a running Docker daemon");
const k = (...args: string[]) => [kubectl, "--kubeconfig", kubeconfig, "--context", `kind-${name}`, ...args];
const d = (...args: string[]) => ["docker", "exec", node, ...args];
const key = `${process.platform}-${process.arch === "arm64" ? "arm64" : "amd64"}`;
const hash = hashes[key]; if (!hash) throw new Error("Unsupported kind host architecture");
await run(["docker", "info"]);
const kind = join(output, "kind");
const download = await fetch(`https://github.com/kubernetes-sigs/kind/releases/download/v0.33.0/kind-${key}`, { signal: AbortSignal.timeout(120000) });
if (!download.ok) throw new Error(`kind download failed: ${download.status}`);
const bytes = new Uint8Array(await download.arrayBuffer());
assert.equal(createHash("sha256").update(bytes).digest("hex"), hash, "kind executable checksum");
await Bun.write(kind, bytes); await chmod(kind, 0o755);
const host = (await run(["docker", "info", "--format", "{{.Architecture}}"])).out.trim();
assert.equal(host === "aarch64" || host === "arm64" ? "arm64" : "x64", process.arch, "Docker must use the native architecture");
const binary = join(output, "bunc");
await compileBinary(process.arch, binary);
console.log("Building the unchanged bunko image for both kind paths...");
const layout = join(output, "layout"), archive = join(output, "web.tar");
const build = await run([process.execPath, "x", "--no-install", "--bun", "@sakajunquality/bunko", "build", "examples/web", "--base", "oven/bun:1.4.2-distroless", "--platform", `linux/${process.arch === "arm64" ? "arm64" : "amd64"}`, "--push=false", "--repo", "docker.io/library/bunc-web", "--bare", "--git-metadata=false", "--tarball", archive, "--oci-layout", layout]);
await Bun.write(join(output, "build.log"), build.out + build.err);
const archiveManifest = JSON.parse((await run(["tar", "-xOf", archive, "manifest.json"])).out);
const image = archiveManifest[0].RepoTags[0] as string;
const nestedTag = `docker.io/library/bunc-nested:${name}`;
const context = join(output, "nested"); await mkdir(context); await copyFile(binary, join(context, "bunc")); await cp(layout, join(context, "layout"), { recursive: true });
const nestedBuild = await run(["docker", "build", "-f", "examples/kind/Dockerfile", "-t", nestedTag, context]);
await Bun.write(join(output, "nested-build.log"), nestedBuild.out + nestedBuild.err);
let ownsCluster = false;
const forwards: Bun.Subprocess[] = [];
try {
  const existing = (await run([kind, "get", "clusters"])).out.trim().split("\n");
  assert(!existing.includes(name), "Refusing to modify an existing cluster");
  // Set ownership before creation so a partially created cluster is also cleaned up.
  ownsCluster = true;
  console.log(`Creating disposable kind cluster ${name}...`);
  const created = await run([kind, "create", "cluster", "--name", name, "--kubeconfig", kubeconfig, "--image", nodeImage, "--wait", "120s"]);
  await Bun.write(join(output, "cluster.log"), created.out + created.err);
  await run([kind, "load", "image-archive", archive, "--name", name]);
  await run(d("ctr", "-n", "k8s.io", "images", "tag", image, "docker.io/library/bunc-web:kind"));
  await run([kind, "load", "docker-image", nestedTag, "--name", name]);
  await run(["docker", "cp", binary, `${node}:/usr/local/bin/bunc`]);
  await run(["docker", "cp", join(repo, "examples/kind/bunc-oci"), `${node}:/usr/local/bin/bunc-oci`]);
  const patch = await readFile(join(repo, "examples/kind/containerd.toml"), "utf8");
  await Bun.write(join(output, "containerd.patch"), patch);
  await run(["docker", "cp", join(output, "containerd.patch"), `${node}:/etc/containerd/bunc.patch`]);
  await run(d("sh", "-ec", "cat /etc/containerd/bunc.patch >> /etc/containerd/config.toml; systemctl restart containerd"));
  await run(k("wait", "--for=condition=Ready", "node", node, "--timeout=60s"));
  const nested = (await readFile(join(repo, "examples/kind/nested.yaml"), "utf8")).replace("docker.io/library/bunc-nested:kind", nestedTag);
  await Bun.write(join(output, "nested.yaml"), nested);
  await run(k("apply", "-f", join(output, "nested.yaml")));
  await run(k("apply", "-f", join(repo, "examples/kind/runtimeclass.yaml")));
  const responses: Record<string, unknown> = {};
  async function endpoint(pod: string) {
    const p = Bun.spawn(k("port-forward", `pod/${pod}`, ":8080", "--address", "127.0.0.1"), { stdout: "pipe", stderr: "pipe" }); forwards.push(p);
    // Keep stderr drained and preserve diagnostics without using the default kubeconfig.
    const errors = new Response(p.stderr).text();
    void errors.then(text => Bun.write(join(output, `${pod}-port-forward.log`), text));
    const reader = p.stdout.getReader(); let text = "";
    const timer = setTimeout(() => p.kill(), 15000);
    try {
      while (true) {
        const part = await reader.read(); if (part.done) throw new Error(`port-forward stopped: ${await errors}`);
        text += new TextDecoder().decode(part.value);
        const port = text.match(/Forwarding from 127\.0\.0\.1:(\d+)/)?.[1];
        if (port) { void (async () => { while (!(await reader.read()).done) {} })(); return `http://127.0.0.1:${port}`; }
      }
    } finally { clearTimeout(timer); }
  }
  for (const pod of ["bunc-nested", "bunc-web"]) {
    await run(k("wait", "--for=condition=Ready", `pod/${pod}`, "--timeout=120s"));
    const url = await endpoint(pod), response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200); const data = await response.json() as Record<string, unknown>; responses[pod] = data;
    assert.equal(data.bun, "1.4.2"); assert.equal(data.pid, 1); assert.equal(data.uid, 65532); assert.equal(data.gid, 65532);
    assert.equal(data.cwd, "/app"); assert.equal(data.hostname, pod === "bunc-nested" ? "bunc" : "bunc-web");
    for (const key of ["isolatedRoot", "writableTmp", "readonlyRoot", "hostEnvironmentAbsent"]) assert.equal(data[key], true, key);
    assert((data.proc as string[]).includes("CapEff:\t0000000000000000")); assert((data.proc as string[]).includes("NoNewPrivs:\t1"));
    assert.equal((await fetch(`${url}/missing`)).status, 404);
    await Bun.write(join(output, `${pod}.log`), (await run(k("logs", pod))).out);
    console.log(`${pod}: HTTP, namespaces, nonroot and read-only root verified`);
    if (pod === "bunc-web") {
      assert((data.proc as string[]).includes("CapBnd:\t0000000000000000"));
      assert((data.proc as string[]).includes("Seccomp:\t2"));
      assert.deepEqual(data.cgroup, { memoryMax: "268435456", cpuMax: "50000 100000" });
      assert.equal((await fetch(`${url}/exit`, { method: "POST" })).status, 200);
      let restarted = false;
      for (let i = 0; i < 120; i++) {
        const status = JSON.parse((await run(k("get", "pod", pod, "-o", "json"))).out).status.containerStatuses?.[0];
        if (status?.restartCount >= 1 && status.ready) { assert.equal(status.lastState.terminated.exitCode, 42); restarted = true; break; }
        await Bun.sleep(500);
      }
      assert(restarted, "Kubernetes must observe exit 42 and restart the container");
      const restartedURL = await endpoint(pod);
      assert.equal((await fetch(restartedURL)).status, 200);
      console.log("RuntimeClass: real exit status 42 and Kubernetes restart verified");
    }
  }
  const states = (await run(d("sh", "-c", "cat /run/containerd/runc/k8s.io/bunc-experimental/*/state.json"))).out;
  await Bun.write(join(output, "states.jsonl"), states.replaceAll("}{", "}\n{"));
  // Evidence that the app and sandbox are bunc init processes, not a runc fallback.
  assert(states.includes('"io.kubernetes.cri.container-type":"sandbox"'));
  assert(states.includes('"io.kubernetes.cri.container-type":"container"'));
  await run(k("delete", "pod", "bunc-web", "bunc-nested", "--wait=true", "--timeout=60s"));
  let cleaned = false;
  for (let i = 0; i < 60; i++) {
    const leftovers = (await run(d("find", "/run/containerd/runc/k8s.io/bunc-experimental", "-mindepth", "1", "-maxdepth", "1"))).out.trim();
    if (!leftovers) { cleaned = true; break; } await Bun.sleep(500);
  }
  assert(cleaned, "Pod deletion must clean bunc state");
  await Bun.write(join(output, "result.json"), JSON.stringify({ status: "passed", arch: process.arch, nodeImage, responses, checks: ["nested Pod", "RuntimeClass sandbox and app", "HTTP 200/404", "nonroot", "PID 1", "read-only root", "no effective capabilities", "no_new_privs", "exit 42", "restart", "delete cleanup"] }, null, 2));
  console.log(`kind: both paths passed. Evidence: ${output}`);
} catch (error) {
  if (ownsCluster) {
    for (const [label, args] of [["events", k("get", "events", "--sort-by=.lastTimestamp")], ["pods", k("get", "pods", "-o", "yaml")], ["containerd", d("journalctl", "-u", "containerd", "--no-pager", "-n", "150")]] as const) {
      const result = await run([...args], true); await Bun.write(join(output, `${label}-failure.log`), result.out + result.err);
    }
  }
  throw error;
} finally {
  for (const p of forwards) { p.kill(); await p.exited; }
  if (ownsCluster) await run([kind, "delete", "cluster", "--name", name]);
  await run(["docker", "image", "rm", nestedTag], true);
}
