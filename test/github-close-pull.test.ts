import assert from "node:assert/strict";
import { test } from "node:test";
import { withGithub } from "./github-worker-fixture.ts";

await test("CLV-300 close-pr closes the pull request of the run", () =>
  withGithub(async (scene) => {
    scene.plan({
      scores: [],
      prs: [{ number: 7, head: "cloving/run-1", base: "main", state: "OPEN" }],
    });
    const worker = scene.worker({});
    const report = await scene.perform(worker, {
      method: "close-pr",
      payload: { number: 7 },
    });
    assert.equal(report.outcome, "completed", JSON.stringify(report));
    assert.deepEqual(JSON.parse(String(report.result)), {
      number: 7,
      closed: true,
    });
    assert.deepEqual(
      scene.state().calls.filter((call) => call[0] === "pr"),
      [["pr", "close", "7"]],
    );
    assert.equal(scene.state().prs[0]?.["state"], "CLOSED");
  }));

await test("CLV-300 close-pr refuses a payload without a pull request number", () =>
  withGithub(async (scene) => {
    scene.plan({ scores: [] });
    const worker = scene.worker({});
    for (const payload of [{}, { number: 0 }, { number: "7" }]) {
      const report = await scene.perform(worker, {
        method: "close-pr",
        payload,
      });
      assert.equal(report.outcome, "failed");
      assert.equal(report.reason, "invalid-payload");
    }
    assert.deepEqual(
      scene.state().calls.filter((call) => call[0] === "pr"),
      [],
    );
  }));
