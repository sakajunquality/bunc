import { resolve, join } from "node:path";
import { assetNames, verifyAssets, validateSource, releaseVersion } from "./distribution.ts";

export function verificationArguments(path: string, bundle: string, repository: string, sourceRef: string, commit: string): string[] {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.split("/").some(p => p === "." || p === "..")) throw new Error("Invalid repository");
  validateSource(sourceRef, commit);
  return ["attestation", "verify", path, "--bundle", bundle, "--repo", repository,
    "--signer-workflow", `${repository}/.github/workflows/release.yml`, "--source-ref", sourceRef,
    "--source-digest", commit, "--deny-self-hosted-runners"];
}
export async function verifyProvenance(directory: string, repository: string, ref: string, commit: string) {
  for (const name of assetNames) {
    const child = Bun.spawn(["gh", ...verificationArguments(join(directory, name), join(directory, "PROVENANCE.jsonl"), repository, ref, commit)], { stdout: "ignore", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    try {
      const [, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
      if (code !== 0) throw new Error(`Provenance verification failed: ${name}`);
    } finally { clearTimeout(timer); }
  }
}
if (import.meta.main) {
  const [directory, version, commit, ref] = process.argv.slice(2);
  if (!directory || !version || !commit) throw new Error("Usage: bun run release:verify DIRECTORY VERSION COMMIT [SOURCE_REF]");
  releaseVersion(version);
  if (ref) await verifyProvenance(resolve(directory), process.env.GITHUB_REPOSITORY ?? "sakajunquality/bunc", ref, commit);
  const manifest = await verifyAssets(resolve(directory), version, commit);
  console.log(JSON.stringify({ version: manifest.version, sourceCommit: manifest.sourceCommit, provenance: ref ? "verified" : "not requested" }));
}
