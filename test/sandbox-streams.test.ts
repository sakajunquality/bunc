import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureOutput } from "../src/sandbox/streams.ts";

const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });
async function directory() { const path = await mkdtemp(join(tmpdir(), "bunc-streams-")); temporary.push(path); return path; }
const source = (...chunks: Uint8Array[]) => new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });

test("captures raw stdout and stderr with exact digests", async () => {
  const root = await directory();
  const result = await captureOutput(source(Uint8Array.of(0xff, 0, 1)), source(Buffer.from("err")), root, 20);
  expect(await readFile(join(root, "stdout.bin"))).toEqual(Buffer.from([0xff, 0, 1]));
  expect(await readFile(join(root, "stderr.bin"))).toEqual(Buffer.from("err"));
  expect(result.stdout.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(result.limitExceeded).toBe(false);
});

test("enforces one combined limit and latches overflow once", async () => {
  const root = await directory(); let limited = 0;
  const result = await captureOutput(source(Buffer.from("abcdef")), source(Buffer.from("uvwxyz")), root, 7, { onLimit: () => { limited++; } });
  expect(result.stdout.bytes + result.stderr.bytes).toBe(7);
  expect(result.stdout.truncated || result.stderr.truncated).toBe(true);
  expect(result.limitExceeded).toBe(true);
  expect(limited).toBe(1);
});

test("creates both empty stream files", async () => {
  const root = await directory();
  const result = await captureOutput(source(), source(), root, 1);
  expect(result.stdout.bytes).toBe(0); expect(result.stderr.bytes).toBe(0);
  expect(await readFile(join(root, "stdout.bin"))).toEqual(Buffer.alloc(0));
  expect(await readFile(join(root, "stderr.bin"))).toEqual(Buffer.alloc(0));
});

test("cancels held-open streams after a bounded overflow interval", async () => {
  const root = await directory(); let cancelled = false;
  const held = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from("overflow")); }, cancel() { cancelled = true; } });
  const result = await captureOutput(held, source(), root, 2, { shutdownMs: 5 });
  expect(result.limitExceeded).toBe(true);
  expect(result.stdout.bytes).toBe(2);
  expect(cancelled).toBe(true);
});

test("cancels and settles the peer before rejecting a capture error", async () => {
  const root = await directory(); let peerCancelled = false;
  const failing = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error("read failed")); } });
  const held = new ReadableStream<Uint8Array>({ cancel() { peerCancelled = true; } });
  await expect(captureOutput(failing, held, root, 10)).rejects.toThrow("read failed");
  expect(peerCancelled).toBe(true);
  // Both handles have closed before rejection, so a second exclusive capture
  // fails only because the completed files exist, never from a late writer.
  await expect(captureOutput(source(), source(), root, 10)).rejects.toThrow("exist");
});
