import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { check, savedHarness, withDoctor } from "./doctor-fixture.ts";

for (const shell of ["/bin/bash", "/bin/zsh"]) {
  await test(`CLV-207 default-harness probes saved ${shell} aliases and functions as worker turns run them`, () =>
    withDoctor(async (scene) => {
      const claude = join(scene.root, "bin", "claude");
      const startup = `
alias claude_alias='${claude}'
claude_function() { '${claude}' "$@"; }
alias claude_broken='${join(scene.root, "missing", "claude")}'
`;
      await writeFile(join(scene.root, ".bash_profile"), startup);
      await writeFile(join(scene.root, ".zshrc"), startup);
      for (const [path, result] of [
        ["claude_alias", "ok"],
        ["claude_function", "ok"],
        ["claude_broken", "fail"],
      ] as const) {
        await savedHarness(scene, { kind: "shell", path });
        const selected = check(
          await scene.report({ SHELL: shell }),
          "default-harness",
        );
        assert.equal(
          selected["result"],
          result,
          `${path}: ${String(selected["detail"])}`,
        );
      }
    }));
}
