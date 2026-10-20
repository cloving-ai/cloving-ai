import { candidate, questionCandidate } from "./chats-analysis-fixture.ts";
import { corpus, importId, manifest, sidecar } from "./chats-worker-fixture.ts";

export const input = {
  cycleId: "analysis-cycle",
  repository: "unused",
  input: { importId },
};
export const snapshot = {
  importId,
  redaction: JSON.stringify(manifest),
  corpus,
  structure: JSON.stringify(sidecar),
};
export const reply = JSON.stringify(candidate());
export const completed = (value: unknown) => ({
  kind: "completed",
  operationId: "opaque",
  receipt: "opaque",
  result: JSON.stringify(value),
});

export function scenario() {
  return {
    workflow: "analyze-chats",
    input,
    effectLimit: 3,
    effects: {
      "chats read-analysis": [completed({ snapshot })],
      "claude run-turn:analyze-chats": [
        completed({ reply, usage: { input_tokens: 20 } }),
      ],
      "chats save-analysis": [
        completed({
          kind: "handoff_requested",
          cycleId: input.cycleId,
          promotionId: `analysis:${importId}:${input.cycleId}`,
        }),
      ],
    },
  };
}

export function draftScenario() {
  const given = scenario();
  return {
    ...given,
    gate: { kind: "opened", decisionId: "analysis-question" },
    effects: {
      ...given.effects,
      "claude run-turn:analyze-chats": [
        completed({ reply: JSON.stringify(questionCandidate()) }),
      ],
      "chats save-analysis": [
        completed({
          kind: "analysis_draft",
          cycleId: input.cycleId,
          candidateDigest: "a".repeat(64),
          expiresAt: "2026-10-21T10:00:00.000Z",
          question: questionCandidate().openQuestion,
        }),
      ],
    },
  };
}

export function answeredScenario() {
  const given = draftScenario();
  return {
    ...given,
    effectLimit: 5,
    decision: {
      gateId: "analysis-question",
      decision: "answered",
      answer: "earlier",
    },
    effects: {
      ...given.effects,
      "claude run-turn:analyze-chats": [
        ...given.effects["claude run-turn:analyze-chats"],
        completed({ reply, usage: { input_tokens: 30 } }),
      ],
      "chats save-analysis": [
        ...given.effects["chats save-analysis"],
        ...scenario().effects["chats save-analysis"],
      ],
    },
  };
}
