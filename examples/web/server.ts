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
    if (new URL(request.url).pathname !== "/") return new Response("Not found", { status: 404 });
    return Response.json({
      message: process.env.EXPERIMENT_MESSAGE,
      runtime: "bun", bun: Bun.version, pid: process.pid,
      uid: process.getuid!(), gid: process.getgid!(), cwd: process.cwd(), hostname: hostname(),
      isolatedRoot: !existsSync("/runtime/bunc.js") && !existsSync("/outside-marker"),
      writableTmp, readonlyRoot: rootMount?.split(" ")[5]?.split(",").includes("ro"),
      hostEnvironmentAbsent: !process.env.OUTER_SECRET_SENTINEL,
      proc: readFileSync("/proc/self/status", "utf8").split("\n").filter(line => /^(Name|Pid|PPid|NSpid|Uid|Gid|CapEff|NoNewPrivs):/.test(line)),
    });
  },
});
console.log(`Demo listening on ${server.url}`);
process.on("SIGTERM", () => { console.log("Demo received SIGTERM"); server.stop(true); process.exit(0); });
