import assert from "node:assert/strict";
import { test } from "node:test";
import { shellBlock, shellEntries } from "../src/agent-harness-shell.ts";
import { discoverHarnesses } from "../src/agent-harnesses.ts";
import { withHarnesses } from "./agent-harness-fixture.ts";

await test("CLV-208 shell frames require both markers for every name", () => {
  assert.equal(shellBlock("banner\n", 0), null);
  assert.equal(shellBlock("__CLOVING_HARNESS_START_0__\nfunction", 0), null);
  assert.equal(shellEntries("banner\n", ["codex"]), null);
  const block =
    "__CLOVING_HARNESS_START_0__\nfile\n\n__CLOVING_HARNESS_END_0__\n";
  assert.deepEqual(shellEntries(block, ["codex"]), []);
  assert.equal(shellEntries(block, ["codex", "claude"]), null);
});

await test("CLV-208 incomplete discovery and probe frames cannot report success", () =>
  withHarnesses(async (scene) => {
    await scene.startup("exit 0\n");
    const discovery = await discoverHarnesses(scene.options);
    assert.equal(discovery.shellReason, "shell-protocol");
    assert.deepEqual(discovery.entries, []);
    await scene.startup('codex() { exec /bin/echo "codex-cli 0.1.0"; }\n');
    const probe = await discoverHarnesses(scene.options);
    assert.equal(probe.entries[0]?.reason, "shell-protocol");
    assert.equal(probe.entries[0].working, false);
  }));
