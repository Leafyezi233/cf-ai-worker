import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const workerDir = path.join(root, "worker");
export const configPath = path.join(workerDir, "wrangler.toml");
export const localDatabase = "cpg-opensource-local";
export const disabledMessage = "Remote deployment, secret uploads and remote database operations are disabled in this open-source preparation copy.";

export function denyRemote() {
  throw new Error(disabledMessage);
}

export function assertLocalConfig(text = readFileSync(configPath, "utf8")) {
  const required = [
    /^name\s*=\s*"cpg-opensource-local"\s*$/m,
    /^account_id\s*=\s*"00000000000000000000000000000000"\s*$/m,
    /^workers_dev\s*=\s*false\s*$/m,
    /^preview_urls\s*=\s*false\s*$/m,
    /^database_name\s*=\s*"cpg-opensource-local"\s*$/m,
    /^database_id\s*=\s*"00000000-0000-0000-0000-000000000000"\s*$/m,
    /^GATEWAY_BASE_URL\s*=\s*"http:\/\/127\.0\.0\.1:8787"\s*$/m,
    /^VIDEO_REFERENCE_IMAGE_ORIGIN\s*=\s*"http:\/\/127\.0\.0\.1:8788"\s*$/m,
    /^crons\s*=\s*\[\s*\]\s*$/m,
  ];
  if (required.some((pattern) => !pattern.test(text))) {
    throw new Error("Local isolation configuration changed; refusing to invoke Wrangler.");
  }
  const uncommented = text.split(/\r?\n/).map((line) => line.split("#")[0]).join("\n");
  if (/^\s*(?:remote\s*=\s*true|routes?\s*=|\[\[services\]\]|\[env\.)/m.test(uncommented)) {
    throw new Error("Remote bindings, routes and named environments are not allowed in this preparation copy.");
  }
  return true;
}

export function localEnvironment(input = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(input)) {
    if (/^(?:CLOUDFLARE_|CF_|WRANGLER_|D1_DATABASE_ID$|GATEWAY_BASE_URL$|APP_NAME$)|(?:_KEY|_SECRET|_TOKEN|_PASSWORD)$|^(?:TOKEN|SECRET|PASSWORD|API_KEY)$/i.test(key)) continue;
    env[key] = value;
  }
  env.WRANGLER_SEND_METRICS = "false";
  env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";
  env.CLOUDFLARE_INCLUDE_PROCESS_ENV = "false";
  return env;
}

export function localArguments(mode, extra = []) {
  if (extra.length) throw new Error("Extra Wrangler arguments are disabled; local commands use a fixed configuration.");
  if (mode === "dev") return ["dev", "--local", "--config", configPath];
  if (mode === "migrate") return ["d1", "migrations", "apply", localDatabase, "--local", "--config", configPath];
  throw new Error("Only local dev and local migrations are allowed.");
}

function main() {
  const [mode, ...extra] = process.argv.slice(2);
  if (mode === "deny-remote") denyRemote();
  if (mode === "check" && extra.length === 0) {
    assertLocalConfig();
    console.log("[opensource-isolation] Local targets verified. Remote operations remain disabled.");
    return;
  }
  const args = localArguments(mode, extra);
  assertLocalConfig();
  const cli = path.join(workerDir, "node_modules", "wrangler", "bin", "wrangler.js");
  if (!existsSync(cli)) throw new Error("Install this copy's own dependencies before running local Wrangler commands.");
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: workerDir,
    env: localEnvironment(),
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    console.error("[opensource-isolation] " + error.message);
    process.exitCode = 1;
  }
}
