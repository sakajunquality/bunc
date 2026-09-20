#!/usr/bin/env bun
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, posix } from "node:path";
import { readFileSync } from "node:fs";
import { unpack, imagePath } from "./rootfs.ts";
import { execute, type Launch } from "./worker.ts";

if (["--help", "-h"].includes(process.argv[2] ?? "")) { console.log("Usage: bunc run /path/to/oci-layout\nExperimental Linux container runtime powered by Bun. See README.md for requirements."); process.exit(0); }
if (process.platform !== "linux" || !["arm64", "x64"].includes(process.arch)) throw new Error("This prototype needs Linux arm64/amd64. Use the macOS experiment launcher.");
if (process.argv[2] === "--worker") execute(JSON.parse(await readFile(process.argv[3]!, "utf8")));
if (process.getuid?.() !== 0) throw new Error("This experiment requires root in its disposable Linux environment");
const layout = process.argv[2] === "run" ? process.argv[3] : undefined;
if (!layout) throw new Error("Usage: bunc run /path/to/oci-layout");
const state = await mkdtemp(join(tmpdir(), "bunc-"));
try {
  const image = await unpack(resolve(layout), state), config = image.config;
  const env = new Map((config.Env ?? []).map(value => {
    const split = value.indexOf("="); if (split < 1 || value.includes("\0")) throw new Error("Invalid image environment");
    return [value.slice(0, split), value.slice(split + 1)] as const;
  }));
  const argv = [...config.Entrypoint ?? [], ...config.Cmd ?? []];
  if (!argv.length || argv.some(arg => typeof arg !== "string" || arg.includes("\0"))) throw new Error("Image has no valid Entrypoint/Cmd");
  const cwd = config.WorkingDir || "/";
  if (!cwd.startsWith("/") || !(await stat(await imagePath(image.root, cwd))).isDirectory()) throw new Error("Image WorkingDir must be an existing absolute directory");
  if (!argv[0]!.includes("/")) {
    let executable: string | undefined;
    for (const dir of (env.get("PATH") ?? "/usr/local/bin:/usr/bin:/bin").split(":")) {
      const candidate = posix.resolve(cwd, dir, argv[0]!);
      try { const info = await stat(await imagePath(image.root, candidate)); if (info.isFile() && info.mode & 0o111) { executable = candidate; break; } }
      catch (error) { if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    }
    if (!executable) throw new Error("Entrypoint executable is absent from image PATH");
    argv[0] = executable;
  } else argv[0] = posix.resolve(cwd, argv[0]!);
  const user = config.User || "65532:65532", [userPart, groupPart] = user.split(":");
  let passwd = "";
  try { passwd = await readFile(await imagePath(image.root, "/etc/passwd"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const users = passwd.split("\n").map(line => line.split(":"));
  const match = users.find(parts => parts[0] === userPart || parts[2] === userPart);
  const uid = /^\d+$/.test(userPart!) ? Number(userPart) : Number(match?.[2]);
  let gid = groupPart === undefined ? Number(match?.[3] ?? uid) : Number(groupPart);
  if (groupPart && !/^\d+$/.test(groupPart)) {
    const groups = await readFile(await imagePath(image.root, "/etc/group"), "utf8");
    gid = Number(groups.split("\n").map(line => line.split(":")).find(parts => parts[0] === groupPart)?.[2]);
  }
  if (![uid, gid].every(value => Number.isInteger(value) && value > 0 && value <= 0xffffffff)) throw new Error("Prototype supports nonroot image users only");
  const pidFile = join(state, "worker.pid");
  const launch: Launch = { root: image.root, argv, cwd, env: [...env].map(([key, value]) => `${key}=${value}`), uid, gid, hostname: "bunc", pidFile };
  const launchPath = join(state, "launch.json"); await writeFile(launchPath, JSON.stringify(launch), { mode: 0o600 });
  console.error(JSON.stringify({ event: "launch", image: image.digest, platform: image.platform, argv, cwd, uid, gid, network: "shared with disposable Linux host", rootfs: "read-only", standalone: Bun.isStandaloneExecutable, runtime: "Bun + Linux syscalls; unshare bootstrap" }));
  // Compiled executables contain their entrypoint; argv[1] is not an on-disk script.
  const workerCommand = Bun.isStandaloneExecutable ? [process.execPath] : [process.execPath, resolve(process.argv[1]!)];
  const child = Bun.spawn(["unshare", "--mount", "--pid", "--uts", "--ipc", "--fork", "--kill-child=SIGTERM", ...workerCommand, "--worker", launchPath], { env: { PATH: "/usr/local/bin:/usr/bin:/bin" }, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  let signal: string | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const forward = (name: NodeJS.Signals) => {
    try {
      const pid = Number(readFileSync(pidFile, "utf8"));
      if (!Number.isInteger(pid) || pid <= 1) throw new Error("Invalid worker PID");
      process.kill(pid, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(name);
    }
  };
  const stop = (name: NodeJS.Signals) => { signal = name; forward(name); timer ??= setTimeout(() => forward("SIGKILL"), 2000); };
  const term = () => stop("SIGTERM"), interrupt = () => stop("SIGINT");
  process.on("SIGTERM", term); process.on("SIGINT", interrupt);
  const code = await child.exited;
  process.off("SIGTERM", term); process.off("SIGINT", interrupt); if (timer) clearTimeout(timer);
  console.error(JSON.stringify({ event: "exit", code, signal })); process.exitCode = signal === "SIGINT" ? 130 : signal ? 143 : code;
} finally {
  await rm(state, { recursive: true, force: true });
  console.error(JSON.stringify({ event: "cleanup", removed: true }));
}
