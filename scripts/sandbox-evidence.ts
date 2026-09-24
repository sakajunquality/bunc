import { constants } from "node:fs";
import { chown, copyFile, lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Copy lab receipts to the caller's empty mount without changing its ownership. */
export async function exportSandboxEvidence(source: string, destination: string): Promise<void> {
  const owner = await lstat(destination);
  if (!owner.isDirectory() || owner.isSymbolicLink()) throw new Error("Evidence destination must be a real directory");
  if ((await readdir(destination)).length) throw new Error("Evidence destination must be empty");
  const copy = async (from: string, to: string, root = false): Promise<void> => {
    const info = await lstat(from);
    if (info.isSymbolicLink()) throw new Error("Evidence must not contain symbolic links");
    if (info.isDirectory()) {
      if (!root) await mkdir(to, { mode: 0o700 });
      for (const name of await readdir(from)) await copy(join(from, name), join(to, name));
    } else if (info.isFile() && info.nlink === 1) {
      await copyFile(from, to, constants.COPYFILE_EXCL);
    } else throw new Error("Evidence must contain only directories and unlinked regular files");
    // On native Linux, the bind mount belongs to the nonroot CI runner while
    // acceptance runs as root. Return readable private files to that identity.
    if (!root && (info.uid !== owner.uid || info.gid !== owner.gid || process.geteuid?.() === 0)) await chown(to, owner.uid, owner.gid);
  };
  await copy(source, destination, true);
}
