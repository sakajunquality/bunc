import { resolve, join } from "node:path";

const root = resolve(import.meta.dir, "..");

export async function compileBinary(arch = process.arch as string, output = join(root, "dist", "bin", `bunc-linux-${arch}`)) {
  if (!["arm64", "x64"].includes(arch)) throw new Error("Usage: bun run build:binary [arm64|x64]");
  const child = Bun.spawn([
    process.execPath, "build", join(root, "src", "runtime.ts"), "--compile", `--target=bun-linux-${arch}`,
    "--minify", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--outfile", output,
  ], { cwd: root, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`Standalone compilation exited ${code}`);
  console.log(`Standalone Linux executable: ${output}`);
}

if (import.meta.main) {
  if (process.argv.length > 3) throw new Error("Usage: bun run build:binary [arm64|x64]");
  await compileBinary(process.argv[2]);
}
