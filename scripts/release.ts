import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import metadata from "../package.json";
import { compileBinary } from "./compile.ts";
import { bunVersion, bunRevision, payloadNames, identity, releaseVersion, verifyAssets, type ReleaseManifest } from "./distribution.ts";

const root = resolve(import.meta.dir, "..");
async function git(...args: string[]) {
  const result = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(result.stdout).text(), new Response(result.stderr).text(), result.exited]);
  if (code) throw new Error(`git ${args[0]} failed: ${stderr}`);
  return stdout.trim();
}
export async function prepareRelease(output = join(root, "dist", "release")) {
  const version = releaseVersion(metadata.version);
  if (Bun.version !== bunVersion || Bun.revision !== bunRevision) throw new Error(`Release preparation requires Bun ${bunVersion} (${bunRevision})`);
  if (await git("status", "--porcelain", "--untracked-files=normal")) throw new Error("Release preparation requires a clean checkout; use an ignored output directory");
  const sourceCommit = await git("rev-parse", "HEAD");
  await mkdir(dirname(output), { recursive: true });
  // Never reuse or remove a caller's existing destination.
  await mkdir(output);
  try {
    for (const arch of ["arm64", "x64"]) await compileBinary(arch, join(output, `bunc-linux-${arch}`));
    const bundle = await Bun.build({ entrypoints: [join(root, "src/runtime.ts")], target: "bun", outdir: output, naming: "bunc.js" });
    if (!bundle.success) throw new AggregateError(bundle.logs, "Release JavaScript bundle failed");
    for (const name of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) await copyFile(join(root, name), join(output, name));
    await copyFile(join(root, "licenses/BUN_LICENSE.md"), join(output, "BUN_LICENSE.md"));
    const manifest: ReleaseManifest = { schemaVersion: 1, version, sourceCommit, bun: { version: bunVersion, revision: bunRevision }, files: {} };
    for (const name of payloadNames) manifest.files[name] = await identity(join(output, name));
    await writeFile(join(output, "release.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    const sums = [];
    for (const name of [...payloadNames, "release.json"]) sums.push(`${(await identity(join(output, name))).sha256}  ${name}`);
    await writeFile(join(output, "SHA256SUMS"), sums.join("\n") + "\n", { flag: "wx" });
    await verifyAssets(output, version, sourceCommit);
    const versionResult = Bun.spawn([process.execPath, join(output, "bunc.js"), "version"], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(versionResult.stdout).text(), new Response(versionResult.stderr).text(), versionResult.exited]);
    if (code || stderr || stdout.trim() !== version) throw new Error("Prepared CLI version mismatch");
    return { directory: output, version, sourceCommit };
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
}
if (import.meta.main) {
  if (process.argv.length > 3) throw new Error("Usage: bun run release:prepare [new-output-directory]");
  console.log(JSON.stringify(await prepareRelease(resolve(process.argv[2] ?? "dist/release"))));
}
