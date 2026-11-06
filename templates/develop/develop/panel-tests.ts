import assert from "node:assert/strict";
import type { ProtectedResult } from "cloving/workflows";
import {
  fakeStepBridge,
  type ScenarioRequest,
} from "cloving/workflows/testing";
import { reviewPanel, type PanelReviewer } from "./panel.ts";
import { reportOf, ticketInput, type DevelopFeedback } from "./report.ts";
import { commit, completed, input } from "./scenarios.ts";

type Result = ProtectedResult;

const failed: Result = {
  kind: "failed",
  operationId: "review",
  reason: "claude-turn-failed",
};

function verdict(reviewVerdict: "accept" | "change" | null, summary: string) {
  return completed({ summary, reviewVerdict });
}

function panelRequest(
  reviewers: readonly PanelReviewer[],
  feedback: DevelopFeedback | null,
) {
  return {
    state: {
      input: ticketInput(input),
      round: feedback === null ? 1 : 2,
      feedback,
    },
    report: reportOf(
      completed({ summary: "Fixed zero.\nTicket status: complete" }),
    ),
    pull: { number: 7, url: "pull/7", commit, target: input.cycleId },
    reviewers,
  };
}

function payloads(requests: readonly ScenarioRequest[]) {
  return requests.map((request) => [
    request[0] === "effect" ? request[1].method : request[0],
    request[0] === "effect" ? request[1].payload : "",
  ]);
}

async function panelOf(scenario: {
  readonly reviewers: readonly PanelReviewer[];
  readonly results: Readonly<Record<string, readonly Result[]>>;
  readonly feedback?: DevelopFeedback;
}) {
  using bridge = fakeStepBridge({ effects: scenario.results });
  const review = await reviewPanel(
    panelRequest(scenario.reviewers, scenario.feedback ?? null),
  );
  return { review, requests: payloads(bridge.requests) };
}

const two: readonly PanelReviewer[] = ["review-claude", "review-codex"];
const three: readonly PanelReviewer[] = two.concat("review-gemini");

export const panelTests = [
  {
    name: "CLV-299 two accepting reviewers and an accepting synthesizer accept the work",
    run: async () => {
      const { review, requests } = await panelOf({
        reviewers: two,
        results: {
          "claude run-turn:review-claude": [verdict("accept", "Good.")],
          "claude run-turn:review-codex": [verdict("accept", "Fine.")],
          "claude run-turn:review-synthesis": [verdict("accept", "Keep none.")],
        },
      });
      assert.deepEqual(review, {
        accepted: true,
        feedback: "Keep none.",
        findings: 0,
      });
      assert.deepEqual(
        requests.map(([method]) => method),
        [
          "run-turn:review-claude",
          "run-turn:review-codex",
          "run-turn:review-synthesis",
        ],
      );
      const [claude, codex, synthesis] = requests.map(
        ([, payload]) => payload ?? "",
      );
      assert.equal(claude, codex);
      for (const part of [
        input.input.ticket.text,
        `git diff origin/HEAD...${commit}`,
        "There are no earlier findings. This is the first round.",
        "Fix notes of round 1:\nFixed zero.",
        "Review verdict: accept\nReview verdict: change",
      ])
        assert.ok(
          claude?.includes(part) === true && synthesis?.includes(part) === true,
          part,
        );
      assert.ok(
        synthesis?.includes(
          "Report of review-claude (verdict: accept):\nGood.",
        ),
      );
      assert.ok(
        synthesis?.includes("Report of review-codex (verdict: accept):\nFine."),
      );
      assert.ok(
        synthesis?.includes(
          "Drop each finding that the current change already fixes.",
        ),
      );
    },
  },
  {
    name: "CLV-299 a reviewer change gives the synthesized findings and the earlier round",
    run: async () => {
      const { review, requests } = await panelOf({
        reviewers: three,
        feedback: {
          reason: "review-changes",
          output: "Keep: a.ts:1 Zero.",
          remaining: [],
        },
        results: {
          "claude run-turn:review-claude": [verdict("accept", "Good.")],
          "claude run-turn:review-codex": [
            verdict("change", "b.ts:2 Off by one."),
          ],
          "claude run-turn:review-gemini": [verdict("accept", "Fine.")],
          "claude run-turn:review-synthesis": [
            verdict("change", "Keep: b.ts:2 Off by one."),
          ],
        },
      });
      assert.deepEqual(review, {
        accepted: false,
        feedback: "Keep: b.ts:2 Off by one.",
        findings: 1,
      });
      const prompts = requests.map(([, payload]) => payload ?? "");
      assert.equal(new Set(prompts.slice(0, 3)).size, 1);
      for (const prompt of prompts)
        assert.ok(
          prompt.includes(
            "Findings of round 1 (review-changes):\nKeep: a.ts:1 Zero.",
          ),
        );
      assert.ok(prompts[0]?.includes("Fix notes of round 2:\nFixed zero."));
      assert.ok(
        prompts[3]?.includes(
          "Report of review-codex (verdict: change):\nb.ts:2 Off by one.",
        ),
      );
    },
  },
  {
    name: "CLV-299 the synthesizer drops a finding that is already fixed and accepts",
    run: async () => {
      const { review, requests } = await panelOf({
        reviewers: two,
        results: {
          "claude run-turn:review-claude": [
            verdict("change", "a.ts:1 Missing zero check."),
          ],
          "claude run-turn:review-codex": [verdict("accept", "Fine.")],
          "claude run-turn:review-synthesis": [
            verdict(
              "accept",
              "Drop: a.ts:1 Missing zero check. The current diff fixes it.",
            ),
          ],
        },
      });
      assert.deepEqual(review, {
        accepted: true,
        feedback: "Drop: a.ts:1 Missing zero check. The current diff fixes it.",
        findings: 0,
      });
      assert.equal(requests.length, 3);
    },
  },
  {
    name: "CLV-299 the synthesizer decides with the reports of the reviewers that did not fail",
    run: async () => {
      const { review, requests } = await panelOf({
        reviewers: three,
        results: {
          "claude run-turn:review-claude": [verdict("accept", "Good.")],
          "claude run-turn:review-codex": [failed],
          "claude run-turn:review-gemini": [
            { kind: "failed", operationId: "review", reason: null },
          ],
          "claude run-turn:review-synthesis": [verdict("accept", "Keep none.")],
        },
      });
      assert.deepEqual(review, {
        accepted: true,
        feedback: "Keep none.",
        findings: 0,
      });
      const synthesis = requests[3]?.[1] ?? "";
      assert.ok(
        synthesis.includes("Report of review-claude (verdict: accept):\nGood."),
      );
      assert.ok(
        synthesis.includes("review-codex gave no report (claude-turn-failed)."),
      );
      assert.ok(synthesis.includes("review-gemini gave no report (failed)."));
    },
  },
  {
    name: "CLV-299 a panel without any reviewer report blocks without a synthesizer",
    run: async () => {
      const { review, requests } = await panelOf({
        reviewers: three,
        results: {
          "claude run-turn:review-claude": [failed],
          "claude run-turn:review-codex": [
            { ...completed(null), result: null },
          ],
          "claude run-turn:review-gemini": [
            completed({ reviewVerdict: "accept" }),
          ],
        },
      });
      assert.deepEqual(review, {
        kind: "blocked",
        cycleId: input.cycleId,
        reason: "review-panel-unavailable",
        evidenceId: "review",
      });
      assert.equal(requests.length, 3);
    },
  },
  {
    name: "CLV-299 reports without a verdict line reach the synthesizer and a failed synthesizer blocks",
    run: async () => {
      const { review, requests } = await panelOf({
        reviewers: two,
        results: {
          "claude run-turn:review-claude": [
            completed({ summary: "No verdict." }),
          ],
          "claude run-turn:review-codex": [verdict(null, "Unsure.")],
          "claude run-turn:review-synthesis": [failed],
        },
      });
      assert.deepEqual(review, {
        kind: "blocked",
        cycleId: input.cycleId,
        reason: "review-panel-unavailable",
        evidenceId: "review",
      });
      assert.ok(
        requests[2]?.[1]?.includes(
          "Report of review-claude (verdict: none):\nNo verdict.",
        ),
      );
      assert.ok(
        requests[2]?.[1]?.includes(
          "Report of review-codex (verdict: none):\nUnsure.",
        ),
      );
    },
  },
  {
    name: "CLV-299 a synthesizer without a verdict or findings gives no findings",
    run: async () => {
      const reviews = [];
      for (const synthesis of [
        verdict(null, "Unsure."),
        verdict("change", " "),
      ])
        reviews.push(
          (
            await panelOf({
              reviewers: two,
              results: {
                "claude run-turn:review-claude": [
                  verdict("change", "a.ts:1 Zero."),
                ],
                "claude run-turn:review-codex": [
                  verdict("change", "a.ts:1 Zero."),
                ],
                "claude run-turn:review-synthesis": [synthesis],
              },
            })
          ).review,
        );
      assert.deepEqual(reviews, [
        {
          accepted: false,
          feedback: "The synthesizer turn has no verdict line.",
          findings: 0,
        },
        { accepted: false, feedback: " ", findings: 0 },
      ]);
    },
  },
  {
    name: "CLV-299 a panel needs two or three different reviewers",
    run: async () => {
      using bridge = fakeStepBridge({});
      for (const reviewers of [
        ["review-claude"],
        ["review-claude", "review-claude"],
      ] as const)
        await assert.rejects(reviewPanel(panelRequest(reviewers, null)), {
          message: "invalid-review-panel",
        });
      assert.deepEqual(bridge.requests, []);
    },
  },
];
