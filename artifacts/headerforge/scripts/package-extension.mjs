import { execFileSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(packageRoot, "dist");
const extensionRoot = path.join(distRoot, "public");
const archivePath = path.join(distRoot, "headerforge-chromium.zip");

await rm(distRoot, { recursive: true, force: true });
await mkdir(distRoot, { recursive: true });
execFileSync("pnpm", ["run", "build"], {
  cwd: packageRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    PORT: process.env.PORT ?? "4173",
    BASE_PATH: process.env.BASE_PATH ?? "/",
  },
});
execFileSync("zip", ["-qr", archivePath, "."], {
  cwd: extensionRoot,
  stdio: "inherit",
});
console.info(`Created ${archivePath}`);
