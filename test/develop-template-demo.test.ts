import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import { runScenario } from "../src/testing.ts";
import {
  automatic,
  configurationErrors,
  developManifest,
} from "./develop-template-fixture.ts";
import { configuredDevelopFiles } from "./develop-template-options-fixture.ts";
import { loadWorkflowFolders } from "./candidate-package-fixture.ts";
import { folderInput } from "./workflow-folder-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import {
  commit,
  completed,
  effects,
  input,
} from "./develop-template-flow-fixture.ts";
import type { ScenarioRequest } from "../src/testing.ts";
import type { ProtectedResult } from "../src/step-bridge.ts";

const template = fileURLToPath(
  new URL("../templates/develop", import.meta.url),
);
const demo = { ...automatic, demo: "record" };
const developed: ProtectedResult = completed({
  summary: "Implemented.\nTicket status: complete",
});
const recorded = completed({
  summary: "Recorded 42 seconds.\nDemo status: recorded",
  demoStatus: "recorded",
});
const failedDemo = completed({
  summary: "The scene did not start.\nDemo status: failed",
  demoStatus: "failed",
});
const attached = completed({ number: 7, url: "https://github.com/acme/demo" });
const uploadFailed: ProtectedResult = {
  kind: "failed",
  operationId: "attach",
  reason: "github-network-failed",
};

function effectRequests(requests: readonly ScenarioRequest[]) {
  return requests.flatMap((request) =>
    request[0] === "effect" ? [request[1]] : [],
  );
}

async function demoRun(results: {
  readonly turns: readonly ProtectedResult[];
  readonly uploads: readonly ProtectedResult[];
}) {
  assert.deepEqual(configurationErrors(await developManifest(), demo), []);
  return await withFiles(
    await configuredDevelopFiles(template, demo),
    async (directory) =>
      await runScenario({
        workflow: join(directory, "repo/.cloving/workflows/develop.ts"),
        exportName: "develop",
        input,
        effects: {
          ...effects(),
          "claude run-turn": [developed].concat(results.turns),
          "github attach-asset": results.uploads,
        },
        effectLimit: 99,
      }),
  );
}

const merged = {
  kind: "handoff_requested",
  cycleId: input.cycleId,
  promotionId: "pull-request-7",
  ticketStatus: "complete",
};
const blocked = {
  kind: "blocked",
  cycleId: input.cycleId,
  reason: "demo-failed",
  evidenceId: "demo",
};

await test("CLV-315 the default configuration records no demo and uploads nothing", async () => {
  await withFiles(
    await configuredDevelopFiles(template, automatic),
    async (directory) => {
      const result = await runScenario({
        workflow: join(directory, "repo/.cloving/workflows/develop.ts"),
        exportName: "develop",
        input,
        effects: effects(),
      });
      assert.deepEqual(result.outcome, merged);
      const methods = effectRequests(result.requests).map(
        (request) => request.method,
      );
      assert.deepEqual(methods, [
        "prepare",
        "label",
        "run-turn",
        "open-pr",
        "wait-review",
        "merge",
        "close-issue",
      ]);
    },
  );
});

await test("CLV-315 an accepted review and a recorded demo upload the video to the description before the merge", async () => {
  const result = await demoRun({ turns: [recorded], uploads: [attached] });
  assert.deepEqual(result.outcome, merged);
  const requests = effectRequests(result.requests);
  assert.deepEqual(
    requests.map((request) => request.method),
    [
      "prepare",
      "label",
      "run-turn",
      "open-pr",
      "wait-review",
      "run-turn",
      "attach-asset",
      "merge",
      "close-issue",
    ],
  );
  const turn = requests[5];
  assert.ok(turn !== undefined);
  assert.deepEqual(turn.scope, {
    phase: "demo",
    operation: "claude-turn",
    round: 1,
    key: "attempt-1",
  });
  assert.equal(turn.target, input.cycleId);
  for (const rule of [
    "CLOVING_DEMO_TOOL",
    "$CLOVING_ATTACHMENTS_DIRECTORY/demo.mp4",
    "at most 60 seconds",
    "terminal scene",
    "contact sheet",
    "Do not change, commit or push tracked files",
    "do not publish",
    "Demo status: recorded",
    "Demo status: failed",
    commit,
    "#7",
    "# Fix the counter",
  ])
    assert.ok(turn.payload.includes(rule), rule);
  const upload = requests[6];
  assert.ok(upload !== undefined);
  assert.deepEqual(upload.scope, {
    phase: "demo",
    operation: "github-attach",
    round: 1,
    key: "attempt-1",
  });
  assert.equal(upload.target, input.cycleId);
  assert.deepEqual(JSON.parse(upload.payload), {
    number: 7,
    name: "demo.mp4",
    release: "pr-demos",
    comment: `Demo video of commit ${commit.slice(0, 7)}. A Cloving turn recorded it.`,
    place: "description",
  });
});

await test("CLV-315 a failed first demo gives a second turn with the failure text", async () => {
  const result = await demoRun({
    turns: [failedDemo, recorded],
    uploads: [attached],
  });
  assert.deepEqual(result.outcome, merged);
  const turns = effectRequests(result.requests).filter(
    (request) => request.scope.phase === "demo",
  );
  assert.deepEqual(
    turns.map((request) => [request.method, request.scope.key]),
    [
      ["run-turn", "attempt-1"],
      ["run-turn", "attempt-2"],
      ["attach-asset", "attempt-2"],
    ],
  );
  const second = turns[1];
  assert.ok(second !== undefined);
  assert.ok(
    second.payload.endsWith(
      "The earlier demo attempt failed:\nThe scene did not start.\nDemo status: failed",
    ),
  );
  assert.ok(!(turns[0]?.payload ?? "").includes("earlier demo attempt"));
});

await test("CLV-315 two failed demo attempts block the run with demo-failed and no merge", async () => {
  const stopped: ProtectedResult = {
    kind: "failed",
    operationId: "turn",
    reason: "claude-turn-failed",
  };
  const result = await demoRun({ turns: [stopped, failedDemo], uploads: [] });
  assert.deepEqual(result.outcome, blocked);
  const requests = effectRequests(result.requests);
  const methods = requests.map((request) => request.method);
  assert.ok(!methods.includes("merge") && !methods.includes("attach-asset"));
  assert.ok(
    (requests.at(-2)?.payload ?? "").endsWith(
      "The earlier demo attempt failed:\nThe demo turn ended claude-turn-failed.",
    ),
  );
  const label = requests.at(-1);
  assert.ok(label !== undefined && label.method === "label");
  assert.ok(label.payload.includes("cloving: blocked"));
});

await test("CLV-315 a failed upload gets one more upload of the same video", async () => {
  const again = await demoRun({
    turns: [recorded],
    uploads: [uploadFailed, attached],
  });
  assert.deepEqual(again.outcome, merged);
  assert.deepEqual(
    effectRequests(again.requests)
      .filter((request) => request.scope.phase === "demo")
      .map((request) => [request.method, request.scope.key]),
    [
      ["run-turn", "attempt-1"],
      ["attach-asset", "attempt-1"],
      ["attach-asset", "attempt-2"],
    ],
  );
  for (const turns of [[recorded], [failedDemo, recorded]]) {
    const result = await demoRun({
      turns,
      uploads: [uploadFailed, uploadFailed],
    });
    assert.deepEqual(result.outcome, blocked);
    assert.ok(
      !effectRequests(result.requests).some(
        (request) => request.method === "merge",
      ),
    );
  }
});

await test("CLV-315 the demo declaration covers the static effect count of 99", async () => {
  const files = await configuredDevelopFiles(template, demo);
  const path = "repo/.cloving/workflows/develop.declaration.json";
  const declared: unknown = JSON.parse(files[path] ?? "null");
  assert.ok(typeof declared === "object" && declared !== null);
  assert.ok(JSON.stringify(declared).includes('"attach-asset"'));
  const refusals = [];
  for (const limit of [99, 98]) {
    files[path] = (files[path] ?? "").replace(
      /"effectLimit":\d+/,
      `"effectLimit":${String(limit)}`,
    );
    refusals.push(
      await withFiles(files, async (directory) =>
        (await loadWorkflowFolders(folderInput(directory))).refusals.flatMap(
          (refusal) => refusal.codes,
        ),
      ),
    );
  }
  assert.deepEqual(refusals, [[], ["effect-limit"]]);
});
