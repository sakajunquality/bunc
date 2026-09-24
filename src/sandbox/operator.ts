import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** Operator files are bounded and are never interpreted as guest authority. */
export async function readOperatorJSON(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 64 * 1024) throw new Error("Operator configuration must be a regular file no larger than 64 KiB");
    const bytes = Buffer.alloc(64 * 1024 + 1);
    let size = 0;
    while (size < bytes.length) {
      const part = await file.read(bytes, size, bytes.length - size, size);
      if (!part.bytesRead) break;
      size += part.bytesRead;
    }
    if (size > 64 * 1024) throw new Error("Operator configuration grew beyond 64 KiB");
    return JSON.parse(bytes.subarray(0, size).toString("utf8"));
  } finally { await file.close(); }
}
