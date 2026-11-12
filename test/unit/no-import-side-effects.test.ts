import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(__dirname, "../..");

// Loading these modules must neither validate the environment nor build connections, so they
// are loaded in a child process with an empty environment (no DB_*, no JWT_SECRET, no .env).
test("app, data-source and jwt plugin can be imported with an empty environment", () => {
  const script = [
    `require(${JSON.stringify(path.join(root, "src/app"))});`,
    `require(${JSON.stringify(path.join(root, "src/data-source"))});`,
    `require(${JSON.stringify(path.join(root, "src/plugins/jwt"))});`,
  ].join("\n");

  const result = spawnSync(
    process.execPath,
    ["--no-experimental-strip-types", "--require", "ts-node/register/transpile-only", "--eval", script],
    {
      cwd: root,
      // Windows needs SystemRoot for the process to start; it carries no application config
      env: process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {},
      encoding: "utf8",
    }
  );

  assert.equal(result.status, 0, `child failed (status ${result.status}):\n${result.stderr}`);
});
