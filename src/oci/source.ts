import { createReadStream } from "node:fs";
import { join } from "node:path";
import { BlobStore } from "./blob-store.ts";
import { descriptor, object, sha256 } from "./digest.ts";
import { media, type BaseImage, type Descriptor, type ImageConfig, type ImageManifest, type Platform } from "./types.ts";

export interface ImageSource {
  root(): Promise<{ descriptor: Descriptor; bytes: Uint8Array; layout?: boolean; layoutDigest?: Descriptor["digest"] }>;
  blob(d: Descriptor): Promise<AsyncIterable<Uint8Array>>;
}

export interface ResolveBaseOptions {
  /** Aggregate compressed layer bytes allowed before any layer body is opened. */
  maxLayerBytes?: number;
}

async function layoutMetadata(path: string, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > limit) throw new Error("Layout metadata exceeds size limit");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

/** A missing local blob is distinct from corrupt content and other filesystem failures. */
export class MissingLayoutBlobError extends Error {
  constructor(readonly directory: string, readonly digest: string, cause: unknown) {
    super(`OCI layout ${JSON.stringify(directory)} does not contain blob ${digest}`, { cause });
    this.name = "MissingLayoutBlobError";
  }
}

function missingLayoutBlob(error: unknown, directory: string, digest: string): never {
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw new MissingLayoutBlobError(directory, digest, error);
  throw error;
}

export class LayoutSource implements ImageSource {
  constructor(readonly directory: string) { }
  async root() {
    const marker = object(JSON.parse((await layoutMetadata(join(this.directory, "oci-layout"), 64 * 1024)).toString()), "OCI layout");
    if (marker.imageLayoutVersion !== "1.0.0") throw new Error("Unsupported OCI layout version");
    const bytes = await layoutMetadata(join(this.directory, "index.json"), 8 * 1024 * 1024);
    return { bytes, descriptor: { mediaType: media.index, digest: sha256(bytes), size: bytes.length } };
  }
  /** The layout envelope is transport metadata, not the image's source index. */
  async baseRoot(): ReturnType<ImageSource["root"]> {
    const root = await this.root();
    const index = object(JSON.parse(Buffer.from(root.bytes).toString()), "OCI layout index");
    if (index.schemaVersion !== 2 || index.mediaType !== undefined && index.mediaType !== media.index || !Array.isArray(index.manifests)) throw new Error("Invalid OCI layout index");
    const candidates = index.manifests.map(descriptor).filter((entry) => !entry.artifactType || [media.config, media.dockerConfig].includes(entry.artifactType as typeof media.config));
    if (candidates.length !== 1) return { ...root, layout: true, layoutDigest: root.descriptor.digest };
    const selected = candidates[0]!;
    const bytes = await layoutMetadata(new BlobStore(this.directory).path(selected.digest), 8 * 1024 * 1024)
      .catch((error) => missingLayoutBlob(error, this.directory, selected.digest));
    if (bytes.length !== selected.size || sha256(bytes) !== selected.digest) throw new Error(`Blob digest/size mismatch: ${selected.digest}`);
    return { descriptor: selected, bytes, layoutDigest: root.descriptor.digest };
  }
  async blob(d: Descriptor) {
    const path = new BlobStore(this.directory).path(d.digest);
    // Open only when consumed: a missing file must reject the reader, even when its
    // caller awaits destination setup before attaching stream error handlers.
    const directory = this.directory;
    return (async function* () {
      try { yield* createReadStream(path); }
      catch (error) { missingLayoutBlob(error, directory, d.digest); }
    })();
  }
}

export function validateImageConfig(value: unknown, platform: Platform, layerCount: number): ImageConfig {
  const config = object(value, "Image config");
  if (config.os !== platform.os || config.architecture !== platform.architecture) throw new Error("Base image platform does not match the requested platform");
  if (config.variant !== undefined && config.variant !== (platform.variant ?? (platform.architecture === "arm64" ? "v8" : undefined))) throw new Error("Base image variant does not match the requested platform");
  const rootfs = object(config.rootfs, "Image rootfs");
  if (rootfs.type !== "layers" || !Array.isArray(rootfs.diff_ids) || rootfs.diff_ids.length !== layerCount) {
    throw new Error("Base rootfs DiffIDs do not match its layers");
  }
  for (const digest of rootfs.diff_ids) descriptor({ digest, size: 0, mediaType: media.tar });
  if (config.history != null) {
    if (!Array.isArray(config.history)) throw new Error("Invalid base history");
    for (const row of config.history) {
      const item = object(row, "History entry");
      for (const key of ["created", "author", "created_by", "comment"]) {
        if (item[key] != null && typeof item[key] !== "string") throw new Error(`Invalid history ${key}`);
      }
      if (item.empty_layer != null && typeof item.empty_layer !== "boolean") throw new Error("Invalid history empty_layer");
    }
    if (config.history.filter((row) => !row.empty_layer).length !== layerCount) throw new Error("Base history does not match its layers");
  }
  if (config.author != null && typeof config.author !== "string") throw new Error("Invalid base author");
  if (config.config != null) {
    const runtime = object(config.config, "Runtime config");
    for (const key of ["Env", "Entrypoint", "Cmd"]) {
      if (runtime[key] != null && (!Array.isArray(runtime[key]) || !(runtime[key] as unknown[]).every((s) => typeof s === "string"))) throw new Error(`Invalid base ${key}`);
    }
    for (const key of ["User", "WorkingDir", "StopSignal"]) {
      if (runtime[key] != null && typeof runtime[key] !== "string") throw new Error(`Invalid base ${key}`);
    }
    if (runtime.Labels != null && !Object.values(object(runtime.Labels, "Base labels")).every((s) => typeof s === "string")) throw new Error("Invalid base labels");
    for (const key of ["ExposedPorts", "Volumes"]) {
      if (runtime[key] != null) {
        for (const item of Object.values(object(runtime[key], `Base ${key}`))) object(item, `Base ${key} entry`);
      }
    }
  }
  return config as unknown as ImageConfig;
}

export async function resolveBase(source: ImageSource, platform: Platform, store: BlobStore, options: ResolveBaseOptions = {}): Promise<BaseImage> {
  if (options.maxLayerBytes !== undefined && (!Number.isSafeInteger(options.maxLayerBytes) || options.maxLayerBytes <= 0)) throw new Error("maxLayerBytes must be a positive safe integer");
  const fail = (error: unknown): never => {
    if (error instanceof MissingLayoutBlobError) throw new Error(`${error.message} required for ${platform.os}/${platform.architecture}; prepare the base again with --platform ${platform.os}/${platform.architecture}, or restore the missing blob`, { cause: error });
    throw error;
  };
  async function* blob(d: Descriptor): AsyncIterable<Uint8Array> {
    try { yield* await source.blob(d); }
    catch (error) { fail(error); }
  }
  const root = await (source instanceof LayoutSource ? source.baseRoot() : source.root()).catch(fail);
  const declared = root.descriptor.platform;
  if (declared && (declared.os !== platform.os || declared.architecture !== platform.architecture || (declared.variant ?? (declared.architecture === "arm64" ? "v8" : undefined)) !== (platform.variant ?? (platform.architecture === "arm64" ? "v8" : undefined)))) throw new Error(`Expected exactly one base for ${platform.os}/${platform.architecture}, found 0`);
  await store.putStream(ReadableBytes(root.bytes), root.descriptor.mediaType, root.descriptor);
  async function metadata(d: Descriptor): Promise<Record<string, unknown>> {
    if (d.size > 8 * 1024 * 1024) throw new Error("Base metadata exceeds size limit");
    if (d.digest !== root.descriptor.digest) await store.putStream(blob(d), d.mediaType, d);
    return object(JSON.parse(Buffer.from(await store.read(d)).toString()), "Base metadata");
  }
  let indexDigest: BaseImage["indexDigest"];
  async function select(d: Descriptor, depth: number): Promise<{ descriptor: Descriptor; manifest: ImageManifest }> {
    if (depth > 8) throw new Error("Base index nesting limit exceeded");
    const value = await metadata(d);
    if (value.schemaVersion !== 2 || (value.mediaType != null && value.mediaType !== d.mediaType)) throw new Error("Unsupported or inconsistent base manifest schema");
    if ([media.index, media.dockerIndex].includes(d.mediaType as typeof media.index)) {
      if (!Array.isArray(value.manifests)) throw new Error("Invalid base index");
      if (!indexDigest && !(depth === 0 && root.layout)) indexDigest = d.digest;
      const candidates = value.manifests.map(descriptor).filter((child) => {
        // OCI 1.1 index entries may carry artifactType; ko and BuildKit set it to the image config media type on
        // ordinary platform images. Only non-image artifacts (attestations, SBOMs, signatures) are skipped here; the
        // selected manifest's config media type is verified below regardless.
        if (child.artifactType && ![media.config, media.dockerConfig].includes(child.artifactType as typeof media.config)) return false;
        if (!child.platform) return true;
        return child.platform.os === platform.os && child.platform.architecture === platform.architecture
          && (child.platform.variant ?? (child.platform.architecture === "arm64" ? "v8" : undefined)) === (platform.variant ?? (platform.architecture === "arm64" ? "v8" : undefined));
      });
      if (candidates.length !== 1) throw new Error(`Expected exactly one base for ${platform.os}/${platform.architecture}, found ${candidates.length}`);
      return select(candidates[0]!, depth + 1);
    }
    if (![media.manifest, media.dockerManifest].includes(d.mediaType as typeof media.manifest) || !Array.isArray(value.layers)) throw new Error("Unsupported base manifest type");
    const config = descriptor(value.config);
    if (![media.config, media.dockerConfig].includes(config.mediaType as typeof media.config)) throw new Error("Base is an artifact, not a runnable image");
    return { descriptor: d, manifest: { schemaVersion: 2, mediaType: d.mediaType, config, layers: value.layers.map(descriptor) } };
  }
  const selected = await select(root.descriptor, 0);
  if (options.maxLayerBytes !== undefined) {
    const layerBytes = selected.manifest.layers.reduce((sum, layer) => sum + layer.size, 0);
    if (!Number.isSafeInteger(layerBytes) || layerBytes > options.maxLayerBytes) throw new Error("Image compressed content exceeds preparation limit");
  }
  const config = validateImageConfig(await metadata(selected.manifest.config), platform, selected.manifest.layers.length);
  const layers: Descriptor[] = [];
  for (const original of selected.manifest.layers) {
    if (original.mediaType === media.zstd && original.size > 2 * 1024 ** 3) throw new Error("Zstd base layer exceeds compressed size limit");
    if (![media.tar, media.gzip, media.dockerGzip, media.zstd].includes(original.mediaType as typeof media.tar)) throw new Error(`Unsupported base layer type: ${original.mediaType}`);
    await store.putStream(blob(original), original.mediaType, original);
    layers.push({ mediaType: original.mediaType === media.dockerGzip ? media.gzip : original.mediaType, digest: original.digest, size: original.size, ...(original.annotations ? { annotations: original.annotations } : {}) });
  }
  return {
    ...selected,
    manifest: { ...selected.manifest, layers },
    config,
    indexDigest,
    ...(root.layoutDigest ? { layoutDigest: root.layoutDigest } : {}),
  };
}

async function* ReadableBytes(bytes: Uint8Array) { yield bytes; }
