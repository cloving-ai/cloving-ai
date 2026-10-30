import assert from "node:assert/strict";
import { test } from "node:test";
import {
  shellBlock,
  shellEntries,
  shellProbeScript,
} from "../src/agent-harness-shell.ts";
import { discoverHarnesses, probeHarness } from "../src/agent-harnesses.ts";
import { withHarnesses } from "./agent-harness-fixture.ts";

await test("CLV-208 shell probing avoids nested conditionals", () => {
  let depth = 0;
  for (const line of shellProbeScript.split("\n")) {
    if (/^\s*if\b/.test(line)) depth += 1;
    assert.ok(depth <= 1, `Nested shell conditional: ${line.trim()}`);
    if (/^\s*fi\b/.test(line)) depth -= 1;
  }
  assert.equal(depth, 0);
});

for (const shell of ["/bin/zsh", "/bin/bash"]) {
  for (const name of ["probe_zsh", "probe_bash"]) {
    await test(`CLV-208 ${shell} preserves a user function named ${name}`, () =>
      withHarnesses(async (scene) => {
        await scene.startup(`${name}() { printf 'Other 1.2\\n'; }\n`);
        const result = await probeHarness(name, {
          env: { ...scene.options.env, SHELL: shell },
        });
        assert.equal(result.shellReason, null);
        assert.deepEqual(result.entries, [
          {
            name,
            kind: "shell",
            shellMode: "login",
            path: name,
            version: "Other 1.2",
            working: true,
            reason: null,
          },
        ]);
      }));
  }
}

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
