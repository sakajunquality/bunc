import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import metadata from "../package.json";
import { validateSource, validateTag, releaseNotes } from "./distribution.ts";

const ref = process.env.GITHUB_REF ?? "", commit = process.env.GITHUB_SHA ?? "";
if (process.env.GITHUB_EVENT_NAME === "pull_request") process.exit(0);
validateSource(ref, commit);
if (ref.startsWith("refs/tags/")) {
  validateTag(ref.slice("refs/tags/".length), metadata.version);
  releaseNotes(await readFile(resolve(import.meta.dir, "../docs/RELEASE_NOTES.md"), "utf8"), metadata.version);
  const child = Bun.spawn(["git", "merge-base", "--is-ancestor", "HEAD", "origin/main"], { stdout: "ignore", stderr: "inherit" });
  if (await child.exited) throw new Error("Release tag must point to a commit on main");
}
