# Releasing bunc

Releases distribute standalone Linux arm64/x64 executables and a JavaScript
bundle through GitHub Releases. npm and registry publication are not configured.
The root package remains private to prevent accidental npm publication. Runtime
requirements and experimental scope remain those described in README.md.

## Prepare locally

Use exactly Bun 1.4.2, revision `744846f844374847c902b5e7fd59b4342a51ef99`,
with frozen dependencies and a clean checkout:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun run build
bun run release:prepare
```

Preparation creates a **new** `dist/release` directory and refuses existing
files, directories, or symlinks at that path. Use a new output path for another
candidate: `bun run release:prepare .bunc-output/candidate-next`.

| Asset | Contents |
| --- | --- |
| `bunc-linux-arm64` | Standalone Linux arm64 executable |
| `bunc-linux-x64` | Standalone Linux amd64 executable |
| `bunc.js` | JavaScript bundle; also usable when rebuilding with a modified Bun |
| `LICENSE`, `NOTICE` | bunc license and attribution |
| `THIRD_PARTY_NOTICES.md` | Bundled JavaScript dependency licenses |
| `BUN_LICENSE.md` | Upstream Bun licensing information, pinned to the compiler revision |
| `release.json` | Version, source commit, Bun toolchain, payload hashes and sizes |
| `SHA256SUMS` | Checksums for payloads and release.json |
| `PROVENANCE.jsonl` | GitHub-signed build provenance, added by the workflow |

Local preparation checks file inventories, checksums, ELF architectures and the
bundle's version. It does not execute a cross-compiled binary. Native acceptance
runs separately using the **prepared file**, with no rebuild:

```sh
version=$(bun -p 'require("./package.json").version')
commit=$(git rev-parse HEAD)
bun run release:verify dist/release "$version" "$commit"
bun scripts/lab.ts docker --binary dist/release/bunc-linux-arm64 --verify
# On an amd64 host, use bunc-linux-x64 instead.
# Apple silicon also supports: bun scripts/lab.ts apple --binary ... --verify
```

`bunc version` and `bunc --version` report the package version embedded at build
time, without requiring root. Verification without SOURCE_REF checks integrity
and metadata only; it does not establish provenance or image trust.

## Workflow and publication

The Release workflow supports three entry points:

1. Pull requests that change release inputs: unsigned candidate preparation and
   native Docker acceptance on Linux amd64 and arm64. No attestation or publication.
2. Manual dispatch **on main**: the same candidate checks, provenance generation,
   and verification against the exact workflow/ref/commit. The signed candidate
   is uploaded as a workflow artifact; no tag or GitHub Release is created.
3. A pushed `v*` tag: the tag must equal `v` plus package.json's version, have
   matching release notes, and point to a commit reachable from main. After
   validation and signed provenance verification, the workflow creates a draft
   release, downloads its uploaded assets, verifies them again, checks the native
   downloaded CLI version, then publishes the draft.

The native jobs use `ubuntu-24.04` and `ubuntu-24.04-arm`. Both execute the
same prepared bytes after verifying their checksums and source metadata. They
run the example through a disposable privileged Linux host without a separate
host Bun installation. The attestation and publish jobs download those artifacts;
they do not rebuild binaries.

Only the attestation job has OIDC/attestation write permission, and only the
publish job has release write permission. Pull requests never receive those
publication steps. Actions are pinned by commit. Manual dispatches from feature
branches are refused. Provenance verification checks the signer workflow, exact
source ref and source commit, and rejects self-hosted signers. It also exercises
an incorrect-source-ref negative check.

Stable versions are designated latest. Versions containing a prerelease suffix
(such as `0.1.0-alpha.1`) are GitHub prereleases and are not designated latest.
SemVer build metadata is not supported in release version strings.

## Maintainer checklist

1. Update package.json's version and add an exact `## VERSION` section to
   `docs/RELEASE_NOTES.md`. Keep compiler version/revision, workflow pins, and
   `licenses/BUN_LICENSE.md` consistent. Refresh dependency licenses when the
   dependency graph changes. Use a reviewed PR and keep generated assets out of Git.
2. Run frozen installation, checks, build, candidate preparation, and applicable
   Docker/Apple checks. Verify the final PR head and merge only after required CI
   and review findings are resolved.
3. Record the merged main SHA in an ignored `.bunc-output/releases/VERSION/`
   ledger. Dispatch `gh workflow run release.yml --ref main`. Wait for native
   acceptance and provenance verification. Record the run ID and source SHA.
4. Create the matching version tag at that recorded main SHA and push it. Never
   move or reuse a published tag. This is the release trigger, so do it only when
   publication is authorized.
5. Wait for Release to finish. Verify the public download checksums and provenance,
   and run the selected binary's version command only after verification. Record
   the tag's peeled SHA, workflow IDs, binary hashes, and consumer results.
6. Report the release URL and actual available assets. A successful artifact build
   alone does not mean a release has been published.

## Verify and install a published release

Run these commands in a fresh directory on Linux with `gh` and `sha256sum`:

```sh
tag=v0.1.0-alpha.1
repo=sakajunquality/bunc
gh release download "$tag" --repo "$repo"
commit=$(gh api "repos/$repo/commits/$tag" --jq .sha)
for asset in bunc-linux-arm64 bunc-linux-x64 bunc.js LICENSE NOTICE \
  THIRD_PARTY_NOTICES.md BUN_LICENSE.md release.json SHA256SUMS; do
  gh attestation verify "$asset" --bundle PROVENANCE.jsonl --repo "$repo" \
    --signer-workflow "$repo/.github/workflows/release.yml" \
    --source-ref "refs/tags/$tag" --source-digest "$commit" \
    --deny-self-hosted-runners
done
sha256sum --check SHA256SUMS
chmod +x bunc-linux-x64  # choose bunc-linux-arm64 on arm64
./bunc-linux-x64 version
```

Do not execute downloaded bytes before verification. Checksums detect corruption;
provenance establishes the selected workflow and source identity. Neither turns
an experimental container runtime into a production sandbox. Full container
execution still requires Linux, glibc, util-linux `unshare`, and suitable privileges.

## Recovery

Never use asset clobbering, force-push a version tag, or silently reuse a release
name. If a run stops after creating a draft, inspect its source identity and
complete asset inventory. Download and verify the draft exactly as above before
publishing it manually. A rerun deliberately refuses an existing release rather
than replacing its assets. Missing or incorrect assets require a deliberate
recovery decision; do not delete an existing release automatically.

A candidate from a manual main run carries `refs/heads/main` provenance. Published
assets must be built and attested by the tag run and verified with the exact tag
ref. Do not upload the main candidate under a version tag.

## Embedded Bun and rebuilding

Standalone executables include Bun and its linked libraries. The release carries
upstream licensing information; it does not claim that every embedded component
is MIT licensed. Bun's source at the pinned compiler revision is available at
<https://github.com/oven-sh/bun/tree/744846f844374847c902b5e7fd59b4342a51ef99>.
That tree's build instructions and WebKit dependency pin describe rebuilding Bun
with changes. bunc's matching source is identified by release.json and its tag.

To use a locally rebuilt Bun runtime, check out the matching bunc source, install
its frozen dependencies, then use Bun's `--compile-executable-path` option with
the matching native Linux target:

```sh
bun build src/runtime.ts --compile --target=bun-linux-x64 \
  --compile-executable-path=/path/to/rebuilt/bun \
  --no-compile-autoload-dotenv --no-compile-autoload-bunfig --outfile=bunc-custom
```

Alternatively, run the published `bunc.js` using the rebuilt Bun. The modified
binary has different hashes and is not covered by bunc's published attestation.
The production release preparer deliberately requires the pinned official
compiler revision; the direct build command above is for user modifications.
