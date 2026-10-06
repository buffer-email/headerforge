import { execFileSync, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distPublic = path.join(packageRoot, "dist", "public");
const chromium = "/repl/tools/bin/chromium";

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureBuild() {
  if (existsSync(path.join(distPublic, "manifest.json")) && existsSync(path.join(distPublic, "background.js"))) {
    console.info(`Using existing build at ${distPublic}`);
    return;
  }
  console.info("dist/public missing; running scripts/package-extension.mjs ...");
  execFileSync("node", [path.join(packageRoot, "scripts", "package-extension.mjs")], {
    cwd: packageRoot,
    stdio: "inherit",
    env: { ...process.env, PORT: "5173", BASE_PATH: "/" },
  });
  if (!existsSync(path.join(distPublic, "manifest.json"))) {
    fail("Build did not produce dist/public/manifest.json");
  }
}

async function grepBuiltBundle() {
  const files = [path.join(distPublic, "background.js")];
  const assetsDir = path.join(distPublic, "assets");
  if (existsSync(assetsDir)) {
    for (const entry of await readdir(assetsDir)) {
      if (entry.endsWith(".js")) files.push(path.join(assetsDir, entry));
    }
  }
  const offenders = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    if (text.includes("removeAllRules")) offenders.push(path.relative(packageRoot, file));
  }
  if (offenders.length) {
    fail(
      `Forbidden API usage found in built bundle: 'removeAllRules' in ${offenders.join(", ")}. ` +
        `chrome.declarativeNetRequest.updateDynamicRules has no 'removeAllRules' option; ` +
        `enumerate getDynamicRules() ids and pass removeRuleIds instead.`,
    );
  }
  console.info("Bundle scan OK: no 'removeAllRules' in dist/public JS.");
}

function extensionIdFor(absolutePath) {
  const digest = createHash("sha256").update(absolutePath, "utf8").digest();
  let id = "";
  for (let i = 0; i < 16; i += 1) {
    for (const nibble of [digest[i] >> 4, digest[i] & 0x0f]) {
      id += String.fromCharCode(97 + nibble);
    }
  }
  return id;
}

const SEED_HTML = `<!doctype html><html><body><script type="module" src="./seed.js"></script></body></html>`;
const ASSERT_HTML = `<!doctype html><html><body><script type="module" src="./verify.js"></script></body></html>`;

const SEED_JS = `
const config = {
  version: "1.1.0",
  masterEnabled: true,
  activeProfileIds: ["profile-verify"],
  profiles: [
    {
      id: "profile-verify",
      name: "Verify DNR",
      colorTag: "teal",
      enabled: true,
      headers: [
        { id: "h1", enabled: true, type: "request", operation: "set", name: "X-Verify-One", value: "1", resourceTypes: ["xmlhttprequest"] },
        { id: "h2", enabled: true, type: "response", operation: "set", name: "X-Verify-Two", value: "2", resourceTypes: ["xmlhttprequest"] }
      ],
      filters: [{ id: "f1", urlPattern: "https://example.com/*", isRegex: false, resourceTypes: [] }]
    }
  ],
  settings: { theme: "system", showBadgeCount: true, tabScopeDefault: "global", density: "comfortable" }
};
await chrome.storage.local.set({ "headerforge.config": config });
try { chrome.runtime.sendMessage({ type: "CONFIG_UPDATED" }); } catch {}
document.body.textContent = "SEED_OK";
`;

const VERIFY_JS = `
async function main() {
  const deadline = Date.now() + 20000;
  let result = { dynamic: 0, session: 0, synced: false, statusError: undefined };
  while (Date.now() < deadline) {
    try {
      const stored = await chrome.storage.local.get("headerforge.status");
      const status = stored["headerforge.status"];
      const [dyn, ses] = await Promise.all([
        chrome.declarativeNetRequest.getDynamicRules(),
        chrome.declarativeNetRequest.getSessionRules(),
      ]);
      result = {
        dynamic: dyn.length,
        session: ses.length,
        synced: status?.ok === true && typeof status?.syncedAt === "string",
        statusError: status?.error,
      };
      if (result.synced && result.dynamic > 0) break;
    } catch (error) {
      result = { dynamic: 0, session: 0, synced: false, statusError: String(error) };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  document.body.textContent = "VERIFY_DONE " + JSON.stringify(result);
}
main();
`;

async function runChromium(userDataDir, extensionDir, url, budget) {
  const args = [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    `--user-data-dir=${userDataDir}`,
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    `--virtual-time-budget=${budget}`,
    "--dump-dom",
    url,
  ];
  const { stdout } = await execFileAsync(chromium, args, {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180000,
  });
  return stdout;
}

async function main() {
  await ensureBuild();
  await grepBuiltBundle();

  const tmp = await mkdtemp(path.join(os.tmpdir(), "headerforge-verify-"));
  const extensionDir = path.join(tmp, "ext");
  const userDataDir = path.join(tmp, "profile");
  try {
    await cp(distPublic, extensionDir, { recursive: true });
    await writeFile(path.join(extensionDir, "seed.html"), SEED_HTML);
    await writeFile(path.join(extensionDir, "seed.js"), SEED_JS);
    await writeFile(path.join(extensionDir, "verify.html"), ASSERT_HTML);
    await writeFile(path.join(extensionDir, "verify.js"), VERIFY_JS);

    const id = extensionIdFor(path.resolve(extensionDir));
    console.info(`Extension id: ${id}`);

    // Pass 1: seed chrome.storage.local from an extension page; the service
    // worker picks up the change via storage.onChanged and installs rules.
    const seedOut = await runChromium(userDataDir, extensionDir, `chrome-extension://${id}/seed.html`, 25000);
    if (!seedOut.includes("SEED_OK")) {
      fail("Seed page did not report SEED_OK. Is the extension id derivation correct?");
    }
    console.info("Seed OK.");
    await sleep(2000);

    // Pass 2 (retried): read back dynamic/session rules and sync status.
    let lastParsed;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const out = await runChromium(userDataDir, extensionDir, `chrome-extension://${id}/verify.html`, 30000);
      const match = out.match(/VERIFY_DONE (\{[^<]*\})/);
      if (!match) {
        console.info(`Attempt ${attempt}: no VERIFY_DONE marker yet; retrying.`);
        await sleep(1500);
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(match[1]);
      } catch {
        console.info(`Attempt ${attempt}: unparsable result; retrying.`);
        await sleep(1500);
        continue;
      }
      lastParsed = parsed;
      console.info(`Attempt ${attempt}: ${JSON.stringify(parsed)}`);
      if (parsed.synced && parsed.dynamic > 0) break;
      await sleep(1500);
    }

    if (!lastParsed) fail("verify page never reported a result.");
    if (lastParsed.statusError) {
      fail(`Background sync reported error: ${lastParsed.statusError}`);
    }
    if (!lastParsed.synced) fail("headerforge.status never recorded a successful sync.");
    if (!(lastParsed.dynamic > 0)) {
      fail(
        "No dynamic DNR rules installed for an enabled profile. " +
          "This matches the removeAllRules regression (0 rules ever installed).",
      );
    }
    console.info(
      `PASS: verify-dnr dynamicRules=${lastParsed.dynamic} sessionRules=${lastParsed.session} synced=${lastParsed.synced}`,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
