import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(__dirname, "../..");

// Loading these modules must neither validate the environment, read .env, nor build
// connections. They are loaded in a child process with an empty environment, started from an
// empty directory (so no .env can be found by accident) and the environment's keys must be
// identical before and after: DOTENV_CONFIG_PATH points at a file with a sentinel key, so a
// dotenv/config import anywhere in the graph would add it.
test("app, data-source and jwt plugin can be imported with an empty environment", () => {
  const modules = ["src/app", "src/data-source", "src/plugins/jwt"].map((m) => path.join(root, m));
  const script = [
    `const before = Object.keys(process.env).sort();`,
    ...modules.map((m) => `require(${JSON.stringify(m)});`),
    `const after = Object.keys(process.env).sort();`,
    `if (JSON.stringify(before) !== JSON.stringify(after)) {`,
    `  console.error("importing modified process.env: " + JSON.stringify({ before, after }));`,
    `  process.exit(2);`,
    `}`,
  ].join("\n");

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gcm-import-"));
  try {
    const dotenvFile = path.join(cwd, "sentinel.env");
    fs.writeFileSync(dotenvFile, "GCM_DOTENV_SENTINEL=1\n");
    const result = spawnSync(
      process.execPath,
      ["--no-experimental-strip-types", "--require", require.resolve("ts-node/register/transpile-only"), "--eval", script],
      {
        cwd,
        env: {
          // Decorators need the repo's tsconfig; ts-node would not find it from the empty cwd
          DOTENV_CONFIG_PATH: dotenvFile,
          TS_NODE_PROJECT: path.join(root, "tsconfig.json"),
          // Windows needs SystemRoot for the process to start; it carries no application config
          ...(process.platform === "win32" && process.env.SystemRoot
            ? { SystemRoot: process.env.SystemRoot }
            : {}),
        },
        encoding: "utf8",
      }
    );

    assert.equal(result.status, 0, `child failed (status ${result.status}):\n${result.stderr}`);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
