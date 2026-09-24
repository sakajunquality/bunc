import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { StreamResult } from "./contract.ts";

export type ByteSource = ReadableStream<Uint8Array>;
export interface CaptureOptions {
  onLimit?: () => void;
  signal?: AbortSignal;
  shutdownMs?: number;
}
export interface CapturedOutput {
  stdout: StreamResult;
  stderr: StreamResult;
  limitExceeded: boolean;
}

interface SourceReader extends AsyncIterable<Uint8Array> { cancel(): Promise<void> }

function readerFor(source: ByteSource): SourceReader {
  const reader = source.getReader();
  return {
    async *[Symbol.asyncIterator]() {
      while (true) {
        const item = await reader.read();
        if (item.done) return;
        yield item.value;
      }
    },
    async cancel() { await reader.cancel().catch(() => {}); },
  };
}

/** Capture both byte streams under one combined retained-byte limit. */
export async function captureOutput(stdoutSource: ByteSource, stderrSource: ByteSource, destination: string, limit: number, options: CaptureOptions = {}): Promise<CapturedOutput> {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("stdio limit must be a positive safe integer");
  const shutdownMs = options.shutdownMs ?? 1_000;
  if (!Number.isSafeInteger(shutdownMs) || shutdownMs <= 0) throw new TypeError("shutdownMs must be a positive safe integer");
  const stdoutHandle = await open(join(destination, "stdout.bin"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let stderrHandle;
  try { stderrHandle = await open(join(destination, "stderr.bin"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { await stdoutHandle.close(); throw error; }
  const readers = [readerFor(stdoutSource), readerFor(stderrSource)] as const;
  const done = [false, false];
  const states = [
    { file: "stdout.bin", bytes: 0, truncated: false, hash: createHash("sha256"), handle: stdoutHandle },
    { file: "stderr.bin", bytes: 0, truncated: false, hash: createHash("sha256"), handle: stderrHandle },
  ];
  let retained = 0, exceeded = false, cancellationTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelReaders = () => { for (const reader of readers) void reader.cancel(); };
  const cancelPending = () => {
    for (let index = 0; index < readers.length; index++) if (!done[index]) states[index]!.truncated = true;
    cancelReaders();
  };
  const abort = () => {
    states[0]!.truncated = true; states[1]!.truncated = true;
    cancelReaders();
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const consume = async (index: 0 | 1): Promise<void> => {
    const state = states[index]!;
    try { for await (const value of readers[index]) {
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      const available = Math.max(0, limit - retained);
      const keep = Math.min(available, chunk.byteLength);
      // Reserve bytes synchronously before either stream performs an async write.
      retained += keep;
      if (keep > 0) {
        const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, keep);
        state.hash.update(bytes);
        let offset = 0;
        while (offset < bytes.length) {
          const write = await state.handle.write(bytes, offset, bytes.length - offset, state.bytes + offset);
          if (write.bytesWritten === 0) throw new Error(`Short write to ${state.file}`);
          offset += write.bytesWritten;
        }
        state.bytes += keep;
      }
      if (keep < chunk.byteLength) {
        state.truncated = true;
        if (!exceeded) {
          exceeded = true;
          try { options.onLimit?.(); } catch { /* Termination errors are observed by the supervisor. */ }
          cancellationTimer = setTimeout(cancelPending, shutdownMs);
        }
      }
    } } finally { done[index] = true; }
  };
  try {
    let failed = false, firstError: unknown;
    const guarded = ([0, 1] as const).map(index => consume(index).catch(error => {
      if (!failed) { failed = true; firstError = error; }
      cancelPending();
      throw error;
    }));
    await Promise.allSettled(guarded);
    if (failed) throw firstError;
    await Promise.all(states.map(state => state.handle.sync()));
    return {
      stdout: { file: states[0]!.file, bytes: states[0]!.bytes, truncated: states[0]!.truncated, sha256: `sha256:${states[0]!.hash.digest("hex")}` },
      stderr: { file: states[1]!.file, bytes: states[1]!.bytes, truncated: states[1]!.truncated, sha256: `sha256:${states[1]!.hash.digest("hex")}` },
      limitExceeded: exceeded,
    };
  } finally {
    if (cancellationTimer) clearTimeout(cancellationTimer);
    options.signal?.removeEventListener("abort", abort);
    await Promise.allSettled(states.map(state => state.handle.close()));
  }
}
