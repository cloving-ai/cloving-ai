import assert from "node:assert/strict";
import { test } from "node:test";
import { journalKey, until } from "./claude-worker-fixture.ts";
import { githubIntent, withGithub } from "./github-worker-fixture.ts";

const repository = "other/project";
const payload = {
  owner: "other",
  repository: "project",
  number: 42,
  add: ["cloving: in progress"],
  remove: ["cloving: ready", "cloving: blocked"],
};

await test("CLV-200 labels a new improvement in the configured repository without supplied coordinates", () =>
  withGithub(async (scene) => {
    scene.plan({
      scores: [],
      issues: [{ repository: "acme/demo", number: 42, labels: [] }],
    });
    const worker = scene.worker({});
    const report = await scene.perform(worker, {
      method: "label",
      payload: {
        number: 42,
        add: ["cloving: improvement"],
        remove: [],
      },
    });
    assert.equal(report.outcome, "completed", JSON.stringify(report));
    const edit = scene
      .state()
      .calls.find((call) => call[0] === "issue" && call[1] === "edit");
    assert.ok(edit);
    assert.equal(edit[edit.indexOf("--repo") + 1], "acme/demo");
    assert.equal(edit[2], "42");
  }));

await test("CLV-069 labeling creates added and removed labels in the issue repository and is idempotent", () =>
  withGithub(async (scene) => {
    scene.plan({
      scores: [],
      labels: [{ repository, name: "cloving: ready", color: "ffffff" }],
      issues: [{ repository, number: 42, labels: ["cloving: ready", "keep"] }],
    });
    const worker = scene.worker({
      document: () => Promise.resolve(JSON.stringify(payload)),
    });
    const intent = githubIntent({ method: "label" });
    assert.deepEqual(
      await worker.deliver(intent, new AbortController().signal),
      {
        receipt: journalKey(intent.operationId),
        worker: "github",
      },
    );
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    const state = scene.state();
    assert.deepEqual(state.issues, [
      { repository, number: 42, labels: ["keep", "cloving: in progress"] },
    ]);
    assert.deepEqual(
      state.labels.map((label) => label["name"]).sort(),
      [...payload.add, ...payload.remove].sort(),
    );
    assert.ok(
      state.labels.every(
        (label) =>
          label["repository"] === repository &&
          /^[0-9a-f]{6}$/i.test(String(label["color"])),
      ),
    );
    const repeated = await scene.perform(worker, { method: "label", payload });
    assert.equal(repeated.outcome, "completed");
    assert.deepEqual(scene.state().labels, state.labels);
    assert.deepEqual(scene.state().issues, state.issues);
    assert.equal(
      scene
        .state()
        .calls.filter((call) => call[0] === "issue" && call[1] === "edit")
        .length,
      2,
    );
    assert.ok(
      scene
        .state()
        .calls.every((call) => call[call.indexOf("--repo") + 1] === repository),
    );
    assert.ok(
      scene
        .state()
        .calls.filter((call) => call[0] === "label")
        .every((call) => call.includes("--force")),
    );
  }));

await test("CLV-069 labeling rejects malformed issue identities and label lists before calling gh", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    const invalid = [
      { owner: "" },
      { owner: "other/project" },
      { repository: "project/extra" },
      { number: "42" },
      { number: 0 },
      { number: 1.5 },
      { number: 1e20 },
      { add: "cloving: blocked" },
      { add: [1] },
      { remove: null },
      { remove: [""] },
    ];
    for (const change of invalid) {
      const result = await scene.perform(worker, {
        method: "label",
        payload: { ...payload, ...change },
      });
      assert.equal(result.reason, "invalid-payload");
    }
    assert.deepEqual(scene.state().calls, []);
  }));

await test("CLV-069 the fake gh refuses to remove a label absent from that repository", () =>
  withGithub((scene) => {
    assert.throws(
      () =>
        scene.gh([
          "issue",
          "edit",
          "42",
          "--repo",
          repository,
          "--remove-label",
          "missing",
        ]),
      /label does not exist/,
    );
    return Promise.resolve();
  }));

await test("CLV-069 labeling supports removal only and reports failed label creation or issue edits", () =>
  withGithub(async (scene) => {
    scene.plan({
      scores: [],
      issues: [
        { repository, number: 42, labels: ["cloving: in progress", "keep"] },
      ],
    });
    const worker = scene.worker();
    const call = {
      method: "label",
      payload: { ...payload, add: [], remove: ["cloving: in progress"] },
    };
    for (const fail of ["label create", "issue edit"]) {
      scene.plan({ scores: [], fail });
      assert.equal(
        (await scene.perform(worker, call)).reason,
        "github-call-failed",
      );
      assert.deepEqual(scene.state().issues[0]?.["labels"], [
        "cloving: in progress",
        "keep",
      ]);
    }
    scene.plan({ scores: [], fail: "" });
    assert.equal((await scene.perform(worker, call)).outcome, "completed");
    assert.deepEqual(scene.state().issues[0]?.["labels"], ["keep"]);
  }));
