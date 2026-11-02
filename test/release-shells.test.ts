import assert from "node:assert/strict";
import { test } from "node:test";
import {
  prepareShellAttempt,
  releaseWorkflow,
  steps,
} from "./release-fixture.ts";

await test("CLV-175 Linux CI prepares zsh from the architecture's official archive and propagates failures", async () => {
  const workflow = await releaseWorkflow();
  const linuxSteps = steps(workflow, "quality_linux_node");
  const prepare = linuxSteps.findIndex((step) => step.id === "prepare-shells");
  const setup = linuxSteps.findIndex(
    (step) => step.run === "npm run check:setup",
  );
  assert.ok(prepare >= 0 && prepare < setup, "Prepare zsh before setup");
  for (const [architecture, archive] of [
    ["arm64", "https://ports.ubuntu.com/ubuntu-ports"],
    ["x64", "https://archive.ubuntu.com/ubuntu"],
  ] as const)
    for (const [zshStatus, updateStatus, installStatus, status, output] of [
      ["0", "0", "0", 0, ""],
      ["1", "0", "0", 0, "update --error-on=any\ninstall -y zsh\n"],
      ["1", "9", "0", 9, "update --error-on=any\n"],
      ["1", "0", "8", 8, "update --error-on=any\ninstall -y zsh\n"],
    ] as const) {
      const result = prepareShellAttempt(workflow, {
        CLOVING_CI_ARCHITECTURE: architecture,
        EXPECTED_ARCHIVE: archive,
        ZSH_STATUS: zshStatus,
        UPDATE_STATUS: updateStatus,
        INSTALL_STATUS: installStatus,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, status, `${architecture}: ${result.stderr}`);
      assert.equal(result.stdout, output);
    }
});
