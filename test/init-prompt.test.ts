import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { initPrompt } from "../src/cli/init-prompt.ts";

await test("CLV-225 fixed facts snapshot includes the rules, reachable targets and final summary contract", async () => {
  const output = initPrompt({
    version: "1.3.0",
    repository: "<repository>",
    origin: "git@github.com:example/project.git",
    login: "setup-user",
    node: "v26.9.0",
    harnesses: [{ name: "codex", version: "0.100.0", working: true }],
    defaultHarness: "codex",
    worker: "native codex",
    runtime: "<runtime>",
    files: [".cloving/config.json"],
    templates: ["develop: 5 decision points"],
    workflows: [],
  });
  assert.equal(
    output,
    await readFile(
      new URL("./snapshots/init-prompt.md", import.meta.url),
      "utf8",
    ),
  );
});
