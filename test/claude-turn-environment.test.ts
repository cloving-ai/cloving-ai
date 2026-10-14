import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startTurn } from "../src/daemon/claude-turn.ts";

const names = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
];
const script = `
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const folder = process.env.GH_CONFIG_DIR;
const names = ${JSON.stringify(names)};
const result = { folder, entries: folder ? readdirSync(folder) : null, tokens: names.filter((name) => name in process.env) };
if (folder) writeFileSync(join(folder, "hosts.yml"), "left over from a turn");
process.stdout.write(JSON.stringify({ type: "result", result: JSON.stringify(result) }) + "\\n");
`;

await test("CLV-075 each Claude turn starts with empty gh configuration and no GitHub tokens", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cloving-turn-env-"));
  const saved = { ...process.env };
  try {
    const config = join(directory, "original");
    mkdirSync(config);
    writeFileSync(join(config, "hosts.yml"), "operator credential");
    process.env["GH_CONFIG_DIR"] = config;
    for (const name of names) process.env[name] = "test-credential";
    for (let turn = 0; turn < 2; turn += 1) {
      const running = startTurn({
        command: [process.execPath, "--input-type=module", "-e", script],
        directory,
        folder: directory,
        prompt: "Research",
      });
      const ended = await running.ended;
      assert.equal(ended.exitCode, 0);
      const result: unknown = JSON.parse(String(ended.result?.text));
      assert.deepEqual(Reflect.get(Object(result), "tokens"), []);
      assert.deepEqual(Reflect.get(Object(result), "entries"), []);
      assert.notEqual(Reflect.get(Object(result), "folder"), config);
    }
  } finally {
    process.env = saved;
    rmSync(directory, { recursive: true, force: true });
  }
});
