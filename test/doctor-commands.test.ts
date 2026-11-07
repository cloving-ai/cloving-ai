import assert from "node:assert/strict";
import { test } from "node:test";
import { commandLoginObservation } from "../src/cli/doctor-local.ts";
import { check, withDoctorWorkflow } from "./doctor-fixture.ts";

await test("CLV-323 doctor warns with command-gh-no-login for each command that runs gh and names the github methods", () =>
  withDoctorWorkflow(async (scene) => {
    const output = await scene.report({
      CLOVING_COMMANDS: JSON.stringify({
        report: ["/usr/local/bin/cloving", "report", "--json"],
        reviews: ["/opt/homebrew/bin/gh", "issue", "list"],
        improvements: ["/usr/bin/gh"],
      }),
    });
    const shown = check(output, "command-gh-no-login");
    assert.equal(shown["result"], "warn");
    assert.equal(shown["required"], false);
    assert.equal(
      shown["detail"],
      "These commands run gh, but a command gets no GitHub login: improvements, reviews",
    );
    assert.equal(
      shown["fix"],
      "Use the github methods in the workflow, for example issues, review-threads, comment-issue and label. Or give the command its own GH_CONFIG_DIR",
    );
    assert.equal(output.status, 0);
  }));

await test("CLV-323 a command with another executable or no command gives no command-gh-no-login warning", () => {
  for (const text of [
    JSON.stringify({
      report: ["/usr/local/bin/cloving", "report"],
      tool: ["/opt/gh/tool", "gh"],
      wrapper: ["/usr/local/bin/gh-wrapper"],
    }),
    "{}",
    undefined,
  ])
    assert.deepEqual(commandLoginObservation(text), {
      result: "ok",
      detail: "No command runs gh",
    });
  assert.deepEqual(commandLoginObservation('{"reviews": ["gh"]}'), {
    result: "fail",
    detail: "invalid-commands: CLOVING_COMMANDS",
  });
});
