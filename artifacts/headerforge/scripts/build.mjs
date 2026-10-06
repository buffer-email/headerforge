import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

execFileSync("pnpm", ["run", "build:vite"], {
  cwd: packageRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    PORT: process.env.PORT ?? "4173",
    BASE_PATH: process.env.BASE_PATH ?? "/",
  },
});
