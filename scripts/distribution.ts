import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, open } from "node:fs/promises";
import { join } from "node:path";

export const bunVersion = "1.4.2";
export const bunRevision = "744846f844374847c902b5e7fd59b4342a51ef99";
export const payloadNames = ["bunc-linux-arm64", "bunc-linux-x64", "bunc.js", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "BUN_LICENSE.md"] as const;
export const assetNames = [...payloadNames, "release.json", "SHA256SUMS"] as const;
export type FileIdentity = { sha256: string; size: number };
export interface ReleaseManifest {
  schemaVersion: 1;
  version: string;
  sourceCommit: string;
  bun: { version: string; revision: string };
  files: Record<string, FileIdentity>;
}

export function releaseVersion(value: string): string {
  const numeric = "(?:0|[1-9][0-9]*)";
  const identifier = `(?:${numeric}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
  if (!new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-${identifier}(?:\\.${identifier})*)?$`).test(value)) throw new Error("Release version must be exact SemVer without build metadata");
  return value;
}
export function validateTag(tag: string, version: string) {
  if (tag !== `v${releaseVersion(version)}`) throw new Error("Release tag must equal v plus package.json version");
}
export function validateSource(ref: string, commit: string) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Expected a full source commit SHA");
  if (ref === "refs/heads/main") return;
  if (ref.startsWith("refs/tags/v")) { releaseVersion(ref.slice("refs/tags/v".length)); return; }
  throw new Error("Signed candidates must come from main or an exact version tag");
}
export function releaseNotes(text: string, version: string): string {
  releaseVersion(version);
  const lines = text.split(/\r?\n/), start = lines.findIndex(line => line === `## ${version}`);
  if (start < 0) throw new Error(`Missing release notes for ${version}`);
  const end = lines.findIndex((line, index) => index > start && /^## /.test(line));
  const notes = lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
  if (!notes) throw new Error("Release notes must not be empty");
  return notes + "\n";
}
export async function identity(path: string): Promise<FileIdentity> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024 ** 2) throw new Error(`Invalid release asset: ${path}`);
  const hash = createHash("sha256"); let size = 0;
  for await (const chunk of createReadStream(path)) {
    size += chunk.length;
    if (size > 256 * 1024 ** 2) throw new Error("Release asset exceeds size limit");
    hash.update(chunk);
  }
  return { sha256: hash.digest("hex"), size };
}
async function smallText(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new Error("Release metadata must be a bounded regular file");
  return readFile(path, "utf8");
}
export async function verifyAssets(directory: string, expectedVersion?: string, expectedCommit?: string): Promise<ReleaseManifest> {
  const names = await readdir(directory);
  if (assetNames.some(name => !names.includes(name)) || names.some(name => ![...assetNames, "PROVENANCE.jsonl"].includes(name as typeof assetNames[number]))) throw new Error("Unexpected or missing release assets");
  const expected = new Map<string, string>();
  for (const line of (await smallText(join(directory, "SHA256SUMS"))).trimEnd().split("\n")) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9_.-]+)$/.exec(line);
    if (!match || ![...payloadNames, "release.json"].includes(match[2] as typeof payloadNames[number]) || expected.has(match[2]!)) throw new Error("Invalid or duplicate checksum entry");
    expected.set(match[2]!, match[1]!);
  }
  const identities: Record<string, FileIdentity> = {};
  for (const name of [...payloadNames, "release.json"]) {
    const actual = await identity(join(directory, name));
    if (expected.get(name) !== actual.sha256) throw new Error(`Checksum mismatch: ${name}`);
    identities[name] = actual;
  }
  const manifest = JSON.parse(await smallText(join(directory, "release.json"))) as ReleaseManifest;
  if (manifest.schemaVersion !== 1 || typeof manifest.version !== "string") throw new Error("Invalid release manifest");
  releaseVersion(manifest.version);
  if (expectedVersion && manifest.version !== expectedVersion) throw new Error("Release version mismatch");
  if (!/^[a-f0-9]{40}$/.test(manifest.sourceCommit) || expectedCommit && manifest.sourceCommit !== expectedCommit) throw new Error("Release source commit mismatch");
  if (manifest.bun?.version !== bunVersion || manifest.bun?.revision !== bunRevision) throw new Error("Release Bun toolchain mismatch");
  if (!manifest.files || Object.keys(manifest.files).sort().join("\n") !== [...payloadNames].sort().join("\n")) throw new Error("Invalid release file inventory");
  for (const name of payloadNames) {
    const actual = identities[name]!;
    if (manifest.files[name]?.sha256 !== actual.sha256 || manifest.files[name]?.size !== actual.size) throw new Error(`Manifest identity mismatch: ${name}`);
  }
  for (const [name, machine] of [["bunc-linux-arm64", 183], ["bunc-linux-x64", 62]] as const) {
    const file = await open(join(directory, name), "r");
    try {
      const header = Buffer.alloc(20); const { bytesRead } = await file.read(header);
      if (bytesRead !== 20 || header.subarray(0, 6).toString("hex") !== "7f454c460201" || header.readUInt16LE(18) !== machine) throw new Error(`Wrong ELF architecture: ${name}`);
    } finally { await file.close(); }
  }
  return manifest;
}
