import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fakeStepBridge,
  type ScenarioRequest,
} from "cloving/workflows/testing";
import { release } from "./release.ts";
import { releaseTask } from "./release/input.ts";
import { refusalTests } from "./release/refusal-tests.ts";
import {
  accepted,
  approvals,
  asked,
  commit,
  completed,
  decisionPrompts,
  denials,
  effects,
  input,
  merged,
  methods,
  notes,
  payloads,
  pending,
  prompts,
  pullStates,
  ready,
  rejectedReview,
  reported,
  selection,
  waitInputs,
  waits,
} from "./release/scenarios.ts";
import { versionPrompt } from "./release/version.ts";

const publishPrompt =
  "Publish v1.7.0?\n\nThe version pull request #650 (pull/650) is merged. Approve to push the tag v1.7.0 on its merge commit. The tag CI then publishes the package and creates the release. Deny to stop the release with no tag.";

await test("CLV-304 release with merged pull requests, an accepted version pull request, an approval and a published status ends with the tag", async () => {
  using bridge = fakeStepBridge({
    effects: effects(),
    commandWaits: waits(),
    decisions: approvals(),
  });
  assert.deepEqual(await release(input), {
    kind: "handoff_requested",
    cycleId: "release-1",
    promotionId: "v1.7.0",
    report: "Published v1.7.0 from pull request #650.",
  });
  assert.deepEqual(
    methods(bridge.requests),
    ["wait release-pulls", "sleep", "prepare", "run-turn", "open-pr"].concat(
      accepted(),
      ["merge"],
      asked(),
      ["run:push-tag", "wait release-status", "sleep"],
    ),
  );
  assert.deepEqual(waitInputs(bridge.requests), [
    {
      name: "release-pulls",
      input: { check: "pulls", pullRequests: [641, 643] },
    },
    {
      name: "release-status",
      input: {
        check: "release",
        version: "1.7.0",
        tag: "v1.7.0",
        commit: merged,
      },
    },
  ]);
  const [prompt] = prompts(bridge.requests);
  assert.match(
    String(prompt),
    /^Prepare the release v1\.7\.0 in this worktree/,
  );
  assert.match(String(prompt), /package\.json and in the lock file to 1\.7\.0/);
  assert.match(String(prompt), /merged since the last tag/);
  assert.deepEqual(payloads(bridge.requests, "open-pr"), [
    {
      title: "Release v1.7.0",
      body: `Set the version to 1.7.0 for the release v1.7.0.\n\n## Release notes\n\n${notes}`,
      replaceBody: true,
    },
  ]);
  assert.deepEqual(payloads(bridge.requests, "run:push-tag"), [
    { version: "1.7.0", tag: "v1.7.0", pullRequest: 650 },
  ]);
  assert.deepEqual(
    decisionPrompts(bridge.requests).filter((text) =>
      text.startsWith("Publish"),
    ),
    asked().map(() => publishPrompt),
  );
});

await test("CLV-304 a listed pull request that is not merged before the limit or that closed with no merge blocks the release before the version turn", async () => {
  for (const [answer, reason] of [
    [
      { kind: "timed-out" as const, reason: "command-wait-timeout" },
      "pull-requests-not-merged",
    ],
    [
      pullStates([
        [641, "merged"],
        [643, "closed"],
      ]),
      "pull-request-closed: #643",
    ],
    [{ kind: "failed" as const, reason: "command-failed" }, "command-failed"],
  ] as const) {
    using bridge = fakeStepBridge({
      effects: effects(),
      commandWaits: { "release-pulls": [pending, answer] },
      decisions: approvals(),
    });
    assert.deepEqual(await release(input), {
      kind: "blocked",
      cycleId: "release-1",
      reason,
      evidenceId: "pulls",
    });
    assert.deepEqual(methods(bridge.requests), ["wait release-pulls", "sleep"]);
  }
});

await test("CLV-304 a release with no listed pull requests starts the version turn at once", async () => {
  using bridge = fakeStepBridge({
    effects: effects(),
    commandWaits: { "release-status": waits()["release-status"] },
    decisions: approvals(),
  });
  const outcome = await release({ ...input, input: { version: "1.7.0" } });
  assert.equal(outcome.kind, "handoff_requested");
  assert.deepEqual(methods(bridge.requests).slice(0, 2), [
    "prepare",
    "run-turn",
  ]);
});

await test("CLV-304 a denied publish decision pushes no tag", async () => {
  using bridge = fakeStepBridge({
    effects: effects(),
    commandWaits: waits(),
    decisions: denials(),
  });
  const outcome = await release(input);
  const person = selection.publish === "person";
  assert.deepEqual(
    outcome,
    person
      ? {
          kind: "blocked",
          cycleId: "release-1",
          reason: "publish-denied",
          evidenceId: "publish",
        }
      : {
          kind: "handoff_requested",
          cycleId: "release-1",
          promotionId: "v1.7.0",
          report: "Published v1.7.0 from pull request #650.",
        },
  );
  assert.deepEqual(
    payloads(bridge.requests, "run:push-tag").length,
    person ? 0 : 1,
  );
  assert.equal(
    methods(bridge.requests).includes("wait release-status"),
    !person,
  );
});

await test("CLV-304 a failed tag CI blocks the release with the CI output", async () => {
  const long = `${"x".repeat(300)} npm ERR! 403 Forbidden`;
  for (const [status, reason] of [
    [
      {
        state: "failed",
        output: "Job publish failed: npm ERR! 403 Forbidden\n",
      },
      "tag-ci-failed: Job publish failed: npm ERR! 403 Forbidden",
    ],
    [{ state: "failed", output: long }, `tag-ci-failed: ${long.slice(-240)}`],
    [{ state: "failed", output: " " }, "tag-ci-failed"],
  ] as const) {
    using bridge = fakeStepBridge({
      effects: effects(),
      commandWaits: waits(status),
      decisions: approvals(),
    });
    assert.deepEqual(await release(input), {
      kind: "blocked",
      cycleId: "release-1",
      reason,
      evidenceId: "tag",
    });
    assert.equal(methods(bridge.requests).at(-2), "wait release-status");
  }
});

await test("CLV-304 a tag CI that does not publish before the limit or an invalid status blocks the release", async () => {
  for (const [answer, reason, evidenceId] of [
    [
      { kind: "timed-out" as const, reason: "command-wait-timeout" },
      "release-not-published",
      "tag",
    ],
    [
      { kind: "refused" as const, reason: "command-wait-unknown" },
      "command-wait-unknown",
      "tag",
    ],
    [ready({ state: "running" }), "invalid-release-status", "release"],
    [ready({ state: "failed" }), "invalid-release-status", "release"],
    [ready("published"), "invalid-release-status", "release"],
  ] as const) {
    using bridge = fakeStepBridge({
      effects: effects(),
      commandWaits: { ...waits(), "release-status": [answer] },
      decisions: approvals(),
    });
    assert.deepEqual(await release(input), {
      kind: "blocked",
      cycleId: "release-1",
      reason,
      evidenceId,
    });
    assert.equal(methods(bridge.requests).at(-1), "wait release-status");
  }
});

await test("CLV-304 a rejected review or a failed CI gives its output to the next version turn", async () => {
  using bridge = fakeStepBridge({
    effects: {
      ...effects(2),
      "github merge": [
        completed({ reason: "ci-failed", output: "Output of ci-failed." }),
        completed({ number: 650, commit, merged }),
      ],
    },
    commandWaits: waits(),
    decisions: approvals(2),
  });
  assert.equal((await release(input)).kind, "handoff_requested");
  const [first, second] = prompts(bridge.requests);
  assert.doesNotMatch(String(first), /fix round/);
  assert.match(
    String(second),
    /This is fix round 2\. Address ci-failed, then commit the fix\. Keep the version 1\.7\.0\.\n\nOutput:\nOutput of ci-failed\.$/,
  );
  assert.equal(payloads(bridge.requests, "run:push-tag").length, 1);
});

await test("CLV-304 the version pull request blocks after three rounds or at once on a reason that a turn cannot fix", async () => {
  for (const [reasons, reason, evidenceId, turns] of [
    [
      ["check-failed", "ci-failed", "check-failed"],
      "check-failed",
      "version",
      3,
    ],
    [["ci-pending"], "ci-pending", "merge", 1],
    [["ci-failed-quiet"], "ci-failed-quiet", "merge", 1],
  ] as const) {
    using bridge = fakeStepBridge({
      effects: {
        ...effects(3),
        "github merge": reasons.map((name) =>
          completed({
            reason: name.replace("-quiet", ""),
            output: name.endsWith("-quiet") ? "" : `Output of ${name}.`,
          }),
        ),
      },
      commandWaits: waits(),
      decisions: approvals(3),
    });
    assert.deepEqual(await release(input), {
      kind: "blocked",
      cycleId: "release-1",
      reason: reason.replace("-quiet", ""),
      evidenceId,
    });
    assert.equal(prompts(bridge.requests).length, turns);
    assert.deepEqual(payloads(bridge.requests, "run:push-tag"), []);
  }
});

await test("CLV-304 a rejected review with feedback starts another version turn", async () => {
  const rejected = rejectedReview();
  const revised = "- Add the release template and its notes (#641).";
  using bridge = fakeStepBridge({
    effects: Object.assign(rejected.effects, {
      "claude run-turn": [
        reported(),
        reported(`Set the version 1.7.0.\n\nRelease notes:\n${revised}`),
      ],
    }),
    commandWaits: waits(),
    decisions: rejected.decisions,
  });
  assert.equal((await release(input)).kind, "handoff_requested");
  const [, second] = prompts(bridge.requests);
  assert.match(
    String(second),
    /Address review-changes, then commit the fix\.[\s\S]*\nOutput:\nFix the notes\.$/,
  );
  assert.deepEqual(payloads(bridge.requests, "open-pr").at(1), {
    title: "Release v1.7.0",
    body: `Set the version to 1.7.0 for the release v1.7.0.\n\n## Release notes\n\n${revised}`,
    replaceBody: true,
  });
});

await test("CLV-304 the version turn lists the first-parent history, so the notes name squash and rebase merges", () => {
  const prompt = versionPrompt({
    task: releaseTask(input),
    base: "main",
    round: 1,
    feedback: null,
  });
  assert.match(
    prompt,
    /git log --first-parent --format=%B <last tag>\.\.origin\/main\. This list holds merge commits, squash merges and rebase merges\./,
  );
  assert.doesNotMatch(prompt, /--merges|gh pr list/);
});

await test("CLV-304 payloads reads the JSON payloads of one method, booleans too", () => {
  const sent = (payload: string): ScenarioRequest => [
    "effect",
    {
      scope: { phase: "publish", operation: "push-tag", round: 1 },
      capability: "command",
      method: "run:push-tag",
      target: "release-1",
      payload,
      units: 1,
    },
  ];
  assert.deepEqual(
    payloads(
      [sent("[null, 1]"), sent('{"tag": ["v1.7.0"]}'), sent("[true]")],
      "run:push-tag",
    ),
    [[null, 1], { tag: ["v1.7.0"] }, [true]],
  );
  assert.deepEqual(payloads([sent("[true]")], "open-pr"), []);
});

await test("CLV-304 an invalid version or pull request list blocks the release before any request", async () => {
  for (const given of [
    { version: "v1.7.0" },
    { version: "1.7" },
    { version: "01.7.0" },
    { version: "1.7.0", pullRequests: "641, 0" },
    { version: "1.7.0", pullRequests: "641, 641" },
    { version: "1.7.0", pullRequests: " , " },
    { version: "1.7.0", pullRequests: "#641 main" },
  ]) {
    using bridge = fakeStepBridge({
      effects: effects(),
      decisions: approvals(),
    });
    assert.deepEqual(await release({ ...input, input: given }), {
      kind: "blocked",
      cycleId: "release-1",
      reason: "invalid-release-input",
      evidenceId: "release",
    });
    assert.deepEqual(bridge.requests, []);
  }
});

for (const scenario of refusalTests) await test(scenario.name, scenario.run);
