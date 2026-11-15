import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { root, configPath, assertLocalConfig, localArguments, localEnvironment, disabledMessage } from "./opensource-isolation.mjs";

const config = readFileSync(configPath, "utf8");
const run = (relative, args = [], extraEnv = {}) => spawnSync(process.execPath, [path.join(root, relative), ...args], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, ...extraEnv },
  timeout: 15000,
});

test("the copied config accepts only its local account and resources", () => {
  assert.equal(assertLocalConfig(config), true);
  for (const [before, after] of [
    ["00000000000000000000000000000000", "ffffffffffffffffffffffffffffffff"],
    ["00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff"],
    ['name = "cpg-opensource-local"', 'name = "unexpected-worker"'],
    ['http://127.0.0.1:8787', 'https://unexpected.invalid'],
    ['remote = false', 'remote = true'],
  ]) assert.throws(() => assertLocalConfig(config.replace(before, after)));
});

test("remote routes, service bindings and named environments fail closed", () => {
  for (const extra of ['route = "unexpected.invalid/*"', '[[services]]', '[env.production]']) {
    assert.throws(() => assertLocalConfig(config + '\n' + extra + '\n'));
  }
});

test("local child processes do not inherit cloud or upstream credentials", () => {
  const env = localEnvironment({ PATH: "keep-path", SystemRoot: "keep-system", CLOUDFLARE_API_TOKEN: "test-only", CF_API_KEY: "test-only", OPENAI_API_KEY: "test-only", ADMIN_SECRET: "test-only", SESSION_SECRET: "test-only", ENCRYPTION_KEY: "test-only", D1_DATABASE_ID: "test-only", GATEWAY_BASE_URL: "test-only", WRANGLER_ENV: "production" });
  assert.equal(env.PATH, "keep-path");
  assert.equal(env.SystemRoot, "keep-system");
  for (const key of ["CLOUDFLARE_API_TOKEN", "CF_API_KEY", "OPENAI_API_KEY", "ADMIN_SECRET", "SESSION_SECRET", "ENCRYPTION_KEY", "D1_DATABASE_ID", "GATEWAY_BASE_URL", "WRANGLER_ENV"]) assert.equal(env[key], undefined);
  assert.equal(env.CLOUDFLARE_INCLUDE_PROCESS_ENV, "false");
  assert.equal(env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV, "false");
  assert.equal(env.WRANGLER_SEND_METRICS, "false");
});

test("Wrangler plans are fixed to local mode and reject argument injection", () => {
  for (const mode of ["dev", "migrate"]) {
    const args = localArguments(mode);
    assert.ok(args.includes("--local"));
    assert.equal(args.at(-1), configPath);
    assert.ok(!args.includes("--remote"));
    for (const extra of [["--remote"], ["--env", "production"], ["--config", "other.toml"]]) assert.throws(() => localArguments(mode, extra));
  }
  assert.throws(() => localArguments("deploy"));
});

test("both workspace manifests block every existing remote npm entrypoint", () => {
  for (const relative of ["package.json", "worker/package.json"]) {
    const manifest = JSON.parse(readFileSync(path.join(root, relative), "utf8"));
    for (const key of ["deploy", "deploy:worker", "db:migrate:remote"]) {
      const command = manifest.scripts[key];
      if (!command) continue;
      const parts = command.split(" ");
      assert.equal(parts[0], "node");
      assert.equal(parts.at(-1), "deny-remote");
      const script = path.resolve(path.dirname(path.join(root, relative)), parts[1]);
      const result = spawnSync(process.execPath, [script, ...parts.slice(2)], { cwd: root, encoding: "utf8", timeout: 15000 });
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes(disabledMessage));
    }
  }
});

test("direct deployment script refuses before doing any deployment work", () => {
  const result = run("scripts/deploy.mjs", [], { CLOUDFLARE_API_TOKEN: "test-only" });
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes(disabledMessage));
  assert.ok(!result.stdout.includes("Loaded deploy env"));
  assert.ok(!result.stdout.includes("Building web dashboard"));
});

test("build preparation cannot reinject inherited deployment targets", () => {
  const before = readFileSync(configPath);
  const result = run("scripts/prepare-config.mjs", [], { D1_DATABASE_ID: "ffffffff-ffff-ffff-ffff-ffffffffffff", GATEWAY_BASE_URL: "https://unexpected.invalid", APP_NAME: "unexpected-app" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("environment overrides are ignored"));
  assert.deepEqual(readFileSync(configPath), before);
});

test("CLI rejects remote options without starting Wrangler", () => {
  const result = run("scripts/opensource-isolation.mjs", ["dev", "--remote"]);
  assert.equal(result.status, 1);
  assert.ok(result.stderr.includes("Extra Wrangler arguments are disabled"));
});

test("local credentials and state remain ignored while the example contains no values", () => {
  const template = readFileSync(path.join(root, "worker/.dev.vars.example"), "utf8");
  for (const key of ["ADMIN_SECRET", "SESSION_SECRET", "ENCRYPTION_KEY"]) {
    assert.ok(template.split(/\r?\n/).includes(key + "="));
  }
  if (!existsSync(path.join(root, ".git"))) return;
  for (const relative of ["deploy.env", ".env.local", "worker/.dev.vars", ".wrangler/state.db", "worker/.wrangler/state.db", "node_modules/package.json"]) {
    const result = spawnSync("git", ["check-ignore", "--no-index", "--quiet", "--", relative], { cwd: root, encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 0, relative + ": " + result.stderr);
  }
});
