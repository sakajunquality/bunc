import { parseArgs } from "node:util";
import { resolve, join, basename, dirname } from "node:path";
import { lstat, realpath, rm } from "node:fs/promises";
import { dlopen, ptr, read } from "bun:ffi";
import { prepareEnvironment, parseEnvironmentDescriptor, inspectPreparedCache, removeIncompletePreparations, removePreparedEnvironments } from "./environment.ts";
import { acquireStateRoot, recoverAbandonedJobs, preparedEnvironmentReferences } from "./state.ts";
import { doctorLinuxSandbox, recoverLinuxSandbox } from "./linux.ts";
import { runJob } from "./supervisor.ts";
import { readOperatorJSON } from "./operator.ts";
import { createPreparationExecutor, recoverPreparationResources } from "./preparation.ts";

export const sandboxHelp = `Usage:
  bunc sandbox doctor --experimental-sandbox [--cgroup-parent PATH]
  bunc sandbox prepare --experimental-sandbox --layout PATH --environment FILE [--state-root PATH]
  bunc sandbox run --experimental-sandbox --environment FILE --request FILE --result-dir PATH [--policy FILE] [--state-root PATH] [--cgroup-parent PATH]
  bunc sandbox gc --experimental-sandbox [--state-root PATH] [--cgroup-parent PATH]
  bunc sandbox cache --experimental-sandbox [--state-root PATH] [--remove KEY]

Experimental offline Bun jobs for disposable Linux laboratories.
No production isolation or hostile-image compatibility is claimed.
The trusted operator configures paths; an agent supplies only request JSON.
`;

/** Replace this process so caller cancellation reaches the actual supervisor. */
function enterPrivateMountNamespace(args: string[]): never {
  const unshare = Bun.which("unshare");
  if (!unshare) throw new Error("Sandbox requires util-linux unshare");
  const entrypoint = Bun.isStandaloneExecutable ? [process.execPath] : [process.execPath, resolve(process.argv[1]!)];
  const argv = [unshare, "--mount", "--propagation", "private", ...entrypoint, "--sandbox-supervisor", ...args];
  const lib = dlopen("libc.so.6", {
    execve: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
    __errno_location: { args: [], returns: "ptr" }, strerror: { args: ["i32"], returns: "cstring" },
  });
  const buffers: Buffer[] = [];
  const c = (value: string) => { if (value.includes("\0")) throw new Error("NUL in supervisor arguments"); const b = Buffer.from(value + "\0"); buffers.push(b); return BigInt(ptr(b)); };
  const argumentsArray = new BigUint64Array([...argv.map(c), 0n]);
  // The supervisor needs only the executable search path. Guest environment is
  // independently defined by its approved fixed profile.
  const environmentArray = new BigUint64Array([c("PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"), 0n]);
  lib.symbols.execve(c(unshare), ptr(argumentsArray), ptr(environmentArray));
  const message = lib.symbols.strerror(read.i32(lib.symbols.__errno_location()!));
  throw new Error(`Cannot start private mount supervisor: ${message}`);
}

export async function sandboxCli(args: string[], privateMount = false): Promise<number> {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) { console.log(sandboxHelp); return 0; }
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    "experimental-sandbox": { type: "boolean" }, environment: { type: "string" }, policy: { type: "string" },
    layout: { type: "string" }, request: { type: "string" }, "result-dir": { type: "string" },
    "state-root": { type: "string", default: "/var/lib/bunc-sandbox" },
    "cgroup-parent": { type: "string", default: "/sys/fs/cgroup/bunc-jobs" },
    remove: { type: "string", multiple: true },
  } });
  if (!values["experimental-sandbox"]) throw new Error("Sandbox commands require --experimental-sandbox; use only in a disposable Linux laboratory");
  if (process.platform !== "linux" || !["arm64", "x64"].includes(process.arch) || process.getuid?.() !== 0) throw new Error("Experimental sandbox requires root in a native Linux arm64/amd64 disposable host");
  const command = positionals[0];
  if (positionals.length !== 1 || !["doctor", "prepare", "run", "gc", "cache"].includes(command ?? "")) throw new Error("Unknown sandbox command");
  if (values.remove && command !== "cache") throw new Error("--remove is only supported by sandbox cache");
  const stateRoot = resolve(values["state-root"]), cgroupParent = resolve(values["cgroup-parent"]);
  if (command === "doctor") {
    const report = doctorLinuxSandbox({ cgroupParent });
    console.log(JSON.stringify(report));
    return report.ok ? 0 : 2;
  }
  if (command === "prepare") {
    if (!values.environment || !values.layout) throw new Error("prepare requires --environment and --layout");
    const descriptor = parseEnvironmentDescriptor(await readOperatorJSON(resolve(values.environment)));
    const prepared = await prepareEnvironment({ descriptor, layout: resolve(values.layout), stateRoot, preparationExecutor: createPreparationExecutor(cgroupParent) });
    console.log(JSON.stringify(prepared)); return 0;
  }
  if (command === "run") {
    if (!values.environment || !values.request || !values["result-dir"]) throw new Error("run requires --environment, --request and --result-dir");
    if (!privateMount) enterPrivateMountNamespace(args);
    const result = await runJob({ environment: resolve(values.environment), policy: values.policy ? resolve(values.policy) : undefined,
      request: resolve(values.request), resultDir: resolve(values["result-dir"]), stateRoot, cgroupParent });
    console.log(JSON.stringify(result));
    if (result.cleanup === "incomplete" || !result.artifactsComplete || result.finalizationErrors.length) return 2;
    if (result.outcome === "succeeded") return 0;
    return ["failed", "timed_out", "cancelled", "resource_exhausted"].includes(result.outcome) ? 1 : 2;
  }
  const lease = await acquireStateRoot(stateRoot);
  try {
    if (command === "cache") {
      // The exclusive lifetime lease excludes active jobs/preparations. Do not
      // remove an entry referenced by an unresolved crash journal.
      const activeKeys = await preparedEnvironmentReferences(lease);
      const removed = values.remove ? await removePreparedEnvironments(lease, values.remove, activeKeys) : [];
      console.log(JSON.stringify({ removed, ...await inspectPreparedCache(stateRoot) })); return 0;
    }
    const parent = await realpath(cgroupParent);
    const preparationRecovery = await recoverPreparationResources({ stateRoot, cgroupParent: parent });
    if (!preparationRecovery.complete) throw new Error(`Preparation recovery incomplete: ${preparationRecovery.errors.join("; ")}`);
    const incompletePreparations = await removeIncompletePreparations(lease);
    const recovered = await recoverAbandonedJobs(lease, { async cleanupCgroup(resource) {
      const name = basename(resource.path);
      if (dirname(resource.path) !== parent || !/^bunc-[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error("Refusing foreign cgroup in journal");
      // A crash can occur after recording intent but before acquisition. There
      // is no kernel resource to remove if that exact path is already absent.
      try { await lstat(resource.path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      const runId = name.slice(5), jobDir = join(stateRoot, "jobs", runId);
      const config = await readOperatorJSON(join(jobDir, "worker.json")) as { ownerToken?: string; runId?: string; cgroupParent?: string };
      if (config.ownerToken !== resource.ownerToken || config.runId !== runId || config.cgroupParent !== parent) throw new Error("Cgroup ownership record mismatch");
      const cleanup = await recoverLinuxSandbox({ cgroupParent: parent, runId });
      if (!cleanup.complete) throw new Error(cleanup.errors.join("; "));
    } });
    for (const item of recovered) if (item.status === "recovered") await rm(join(stateRoot, "jobs", item.runId), { recursive: true });
    console.log(JSON.stringify({ recovered, incompletePreparations }));
    return recovered.some(item => item.status === "quarantined" || item.status === "active") ? 2 : 0;
  } finally { await lease.release(); }
}
