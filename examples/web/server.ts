import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
writeFileSync("/tmp/runtime-probe", "writable");
const writableTmp = readFileSync("/tmp/runtime-probe", "utf8") === "writable";
unlinkSync("/tmp/runtime-probe");
const rootMount = readFileSync("/proc/self/mountinfo", "utf8").split("\n").find(line => line.split(" ")[4] === "/");
const server = Bun.serve({
  hostname: "0.0.0.0",
  port: Number(process.env.PORT ?? 8080),
  fetch(request) {
    // Enabled only by the kind lifecycle acceptance test.
    if (process.env.BUNC_TEST_EXIT === "1" && request.method === "POST" && new URL(request.url).pathname === "/exit") {
      setTimeout(() => process.exit(42), 50);
      return new Response("Exiting with code 42");
    }
    if (new URL(request.url).pathname !== "/") return new Response("Not found", { status: 404 });
    return Response.json({
      message: process.env.EXPERIMENT_MESSAGE,
      runtime: "bun", bun: Bun.version, pid: process.pid,
      uid: process.getuid!(), gid: process.getgid!(), cwd: process.cwd(), hostname: hostname(),
      isolatedRoot: !existsSync("/runtime") && !existsSync("/outside-marker"),
      writableTmp, readonlyRoot: rootMount?.split(" ")[5]?.split(",").includes("ro"),
      hostEnvironmentAbsent: !process.env.OUTER_SECRET_SENTINEL,
      cgroup: existsSync("/sys/fs/cgroup/memory.max") ? {
        memoryMax: readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim(),
        cpuMax: readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim(),
      } : undefined,
      proc: readFileSync("/proc/self/status", "utf8").split("\n").filter(line => /^(Name|Pid|PPid|NSpid|Uid|Gid|CapEff|CapBnd|NoNewPrivs|Seccomp):/.test(line)),
    });
  },
});
console.log(`Demo listening on ${server.url}`);
process.on("SIGTERM", () => { console.log("Demo received SIGTERM"); server.stop(true); process.exit(0); });
