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
import type { ScenarioRequest, WorkflowScenario } from "../src/testing.ts";
import type { DecisionResult, ProtectedResult } from "../src/step-bridge.ts";

const template = fileURLToPath(
  new URL("../templates/develop", import.meta.url),
);
const panel = { ...automatic, accept: "panel" };

function verdict(reviewVerdict: "accept" | "change", summary: string) {
  return completed({ summary, reviewVerdict });
}

function methods(requests: readonly ScenarioRequest[]): string[] {
  return requests.flatMap((request) =>
    request[0] === "effect" ? [request[1].method] : [],
  );
}

await test("CLV-299 two accepting reviewers and an accepting synthesizer go to the merge step", async () => {
  assert.deepEqual(configurationErrors(await developManifest(), panel), []);
  const files = await configuredDevelopFiles(template, panel);
  const round = "repo/.cloving/workflows/develop/round.ts";
  const source = files[round] ?? "";
  assert.ok(source.includes('"review-codex", "review-gemini"'));
  files[round] = source.replace(', "review-gemini"', "");
  await withFiles(files, async (directory) => {
    const result = await runScenario({
      workflow: join(directory, "repo/.cloving/workflows/develop.ts"),
      exportName: "develop",
      input,
      effects: {
        ...effects(),
        "claude run-turn:review-claude": [verdict("accept", "Good.")],
        "claude run-turn:review-codex": [verdict("accept", "Fine.")],
        "claude run-turn:review-synthesis": [verdict("accept", "Keep none.")],
      },
      effectLimit: 99,
    });
    assert.deepEqual(result.outcome, {
      kind: "handoff_requested",
      cycleId: input.cycleId,
      promotionId: "pull-request-7",
      ticketStatus: "complete",
    });
    assert.deepEqual(methods(result.requests), [
      "prepare",
      "label",
      "run-turn",
      "open-pr",
      "run-turn:review-claude",
      "run-turn:review-codex",
      "run-turn:review-synthesis",
      "merge",
      "close-issue",
    ]);
  });
});

const reviewers = ["review-claude", "review-codex", "review-gemini"];
const failed: ProtectedResult = {
  kind: "failed",
  operationId: "review",
  reason: "claude-turn-failed",
};

function rounds<T>(count: number, value: (round: number) => T): T[] {
  return Array.from({ length: count }, (_, index) => value(index + 1));
}

async function panelRun(scenario: {
  readonly effects: Readonly<Record<string, readonly ProtectedResult[]>>;
  readonly decisions?: readonly DecisionResult[];
}) {
  const files = await configuredDevelopFiles(template, panel);
  return await withFiles(files, async (directory) => {
    const run: WorkflowScenario = {
      workflow: join(directory, "repo/.cloving/workflows/develop.ts"),
      exportName: "develop",
      input,
      effects: { ...effects(), ...scenario.effects },
      decisions: scenario.decisions ?? [],
      effectLimit: 99,
    };
    return await runScenario(run);
  });
}

function payloads(requests: readonly ScenarioRequest[], method: string) {
  return requests.flatMap((request) =>
    request[0] === "effect" && request[1].method === method
      ? [request[1].payload]
      : [],
  );
}

await test("CLV-299 a change verdict gives the synthesized findings to the next fix turn", async () => {
  const findings = "Keep: src/counter.ts:3 The counter skips zero.";
  const result = await panelRun({
    effects: {
      "claude run-turn": [
        completed({ summary: "Implemented.\nTicket status: complete" }),
        completed({ summary: "Fixed zero.\nTicket status: complete" }),
      ],
      "github open-pr": rounds(2, () =>
        completed({ number: 7, url: "pull/7", commit }),
      ),
      "claude run-turn:review-claude": [
        verdict("change", "src/counter.ts:3 The counter skips zero."),
        verdict("accept", "Good."),
      ],
      "claude run-turn:review-codex": rounds(2, () =>
        verdict("accept", "Fine."),
      ),
      "claude run-turn:review-gemini": rounds(2, () =>
        verdict("accept", "Ok."),
      ),
      "claude run-turn:review-synthesis": [
        verdict("change", findings),
        verdict("accept", "Keep none."),
      ],
    },
  });
  assert.deepEqual(result.outcome, {
    kind: "handoff_requested",
    cycleId: input.cycleId,
    promotionId: "pull-request-7",
    ticketStatus: "complete",
  });
  const fixes = payloads(result.requests, "run-turn");
  assert.equal(fixes.length, 2);
  assert.ok(fixes[1]?.includes("Address review-changes"));
  assert.ok(
    fixes[1]?.endsWith(`Output from the previous result:\n${findings}`),
  );
  const second = payloads(result.requests, "run-turn:review-codex")[1] ?? "";
  assert.ok(
    second.includes(`Findings of round 1 (review-changes):\n${findings}`),
  );
  assert.ok(second.includes("Fix notes of round 2:\nFixed zero."));
  assert.ok(second.includes(input.input.ticket.text));
  assert.ok(second.includes(`git diff origin/HEAD...${commit}`));
  for (const reviewer of reviewers.slice(1))
    assert.deepEqual(payloads(result.requests, `run-turn:${reviewer}`), [
      payloads(result.requests, "run-turn:review-claude")[0],
      payloads(result.requests, "run-turn:review-claude")[1],
    ]);
});

await test("CLV-299 a panel without any reviewer report ends blocked", async () => {
  const result = await panelRun({
    effects: Object.fromEntries(
      reviewers.map((reviewer) => [`claude run-turn:${reviewer}`, [failed]]),
    ),
  });
  assert.deepEqual(result.outcome, {
    kind: "blocked",
    cycleId: input.cycleId,
    reason: "review-panel-unavailable",
    evidenceId: "review",
  });
  assert.deepEqual(methods(result.requests), [
    "prepare",
    "label",
    "run-turn",
    "open-pr",
    "run-turn:review-claude",
    "run-turn:review-codex",
    "run-turn:review-gemini",
    "label",
  ]);
});

await test("CLV-299 six rounds of a three-reviewer panel stay within the effect limit", async () => {
  const change = (round: number) =>
    verdict("change", `Finding ${String(round)}.`);
  const result = await panelRun({
    effects: {
      "claude run-turn": rounds(6, (round) =>
        completed({
          summary: `Round ${String(round)}.\nTicket status: complete`,
        }),
      ),
      "github open-pr": rounds(6, () =>
        completed({ number: 7, url: "pull/7", commit }),
      ),
      "claude run-turn:review-claude": rounds(6, change),
      "claude run-turn:review-codex": rounds(6, change),
      "claude run-turn:review-gemini": rounds(6, change),
      "claude run-turn:review-synthesis": rounds(6, change),
    },
    decisions: [
      { decision: "answered", answer: "1" },
      { decision: "answered", answer: "2" },
    ],
  });
  assert.deepEqual(result.outcome, {
    kind: "blocked",
    cycleId: input.cycleId,
    reason: "review-changes: pull/7",
    evidenceId: "review",
  });
  const names = methods(result.requests);
  for (const reviewer of reviewers.concat("review-synthesis"))
    assert.equal(
      names.filter((name) => name === `run-turn:${reviewer}`).length,
      6,
    );
  assert.equal(result.spent, names.length);
  assert.ok(names.length <= 99, `Spent ${String(names.length)} effects`);
});

await test("CLV-299 the panel declaration covers the static effect count of 99", async () => {
  const files = await configuredDevelopFiles(template, panel);
  const path = "repo/.cloving/workflows/develop.declaration.json";
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
