# Repository conventions

Write documentation and code comments in English.

Keep the experimental scope explicit. Do not claim OCI Runtime Specification
conformance, production isolation, or compatibility that has not been tested.

Run `bun run check` and `bun run build` before committing code. Changes to the
runtime, unpacker, or launcher also require `bun run test:docker`; test Apple
Container when available. Keep images, credentials, generated bundles, and local
validation logs under ignored directories.

# Releases

Follow [docs/RELEASING.md](docs/RELEASING.md). Verify prepared assets on both native
architectures, then verify provenance before executing downloaded releases. Never
replace published tags or assets. Keep release evidence in `.bunc-output/`.
