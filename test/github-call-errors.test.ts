import { githubText } from "../src/daemon/github-calls.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { git, journalKey, resultOf, until } from "./claude-worker-fixture.ts";
import { opened, withGithub } from "./github-worker-fixture.ts";

await test("CLV-082 journals failed gh stderr without sending it to the service", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    const commit = await opened(scene, worker);
    scene.plan({ scores: [], fail: "api GET pull" });
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    assert.equal(report.reason, "github-network-failed");
    const saved = resultOf(
      readFileSync(
        join(scene.journal, journalKey(report.operationId), "result.json"),
        "utf8",
      ),
    );
    assert.equal(saved["detail"], "the fake gh refused api GET pull");
    assert.equal(Object.hasOwn(report, "detail"), false);
    await worker.close();
    scene.reports.length = 0;
    const restarted = scene.unscanned();
    await restarted.scan();
    await until(() =>
      scene.reports.some((item) => item.operationId === report.operationId),
    );
    assert.deepEqual(
      scene.reports.find((item) => item.operationId === report.operationId),
      report,
    );
  }));

await test("CLV-082 retains redacted git stderr with the same git failure reason", () =>
  withGithub(async (scene) => {
    git(scene.repository, [
      "remote",
      "set-url",
      "origin",
      "example-token/private phrase",
    ]);
    const worker = scene.worker({
      environment: { GH_TOKEN: "example-token" },
      privateTexts: ["private phrase"],
    });
    const report = await scene.perform(worker, {
      method: "prepare",
      payload: {},
    });
    const saved = resultOf(
      readFileSync(
        join(scene.journal, journalKey(report.operationId), "result.json"),
        "utf8",
      ),
    );
    assert.equal(report.reason, "git-call-failed");
    assert.match(String(saved["detail"]), /\[hidden\]\/\[hidden\]/);
    assert.doesNotMatch(
      String(saved["detail"]),
      /example-token|private phrase/,
    );
    assert.equal(Object.hasOwn(report, "detail"), false);
  }));

await test("CLV-082 redacts environment secrets and private texts before retaining the stderr tail", () =>
  withGithub(async (scene) => {
    const worker = scene.worker({
      environment: {
        FAKE_GH_STATE: join(scene.directory, "gh-state.json"),
        FAKE_GH_ORIGIN: scene.origin,
        GH_TOKEN: "example-token",
        CLIENT_SECRET: "example-secret",
        DATABASE_PASSWORD: "example-password",
        API_KEY: "example-key",
        EMPTY_TOKEN: "",
        CLOVING_PRIVATE_TEXTS: JSON.stringify([
          "private phrase",
          "private phrase extended",
        ]),
      },
    });
    const commit = await opened(scene, worker);
    const text =
      "example-token example-secret example-password example-key private phrase extended";
    scene.plan({
      scores: [],
      fail: "api GET pull",
      failureText: "discard" + "x".repeat(2_000) + text,
    });
    const report = await scene.perform(worker, {
      method: "merge",
      payload: { number: 1, commit },
    });
    const saved = resultOf(
      readFileSync(
        join(scene.journal, journalKey(report.operationId), "result.json"),
        "utf8",
      ),
    );
    const redacted = "[hidden] [hidden] [hidden] [hidden] [hidden]";
    assert.equal(saved["detail"], ("x".repeat(2_000) + redacted).slice(-2_000));
    assert.equal(report.reason, "github-network-failed");
    assert.doesNotMatch(
      JSON.stringify(report),
      /example-token|private phrase|\[hidden\]/,
    );
  }));

await test("CLV-163 configured private texts ignore case while tokens match exactly", () => {
  assert.equal(
    githubText("ACME Acme extended exacttoken ExactToken", {
      privateTexts: ["Acme", "Acme extended"],
      environment: { API_TOKEN: "ExactToken", CLOVING_PRIVATE_TEXTS: "[]" },
    }),
    "[hidden] [hidden] exacttoken [hidden]",
  );
});
