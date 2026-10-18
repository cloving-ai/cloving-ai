import type { MessageRecord } from "../src/chats/normalize.ts";
import { redactRecord } from "../src/chats/redaction.ts";
import { structureImport } from "../src/chats/structure.ts";

const messages = [
  ["user", "limit", "At most three review and repair rounds."],
  ["assistant", "review-one", "Round one review found a defect."],
  ["assistant", "ask-one", "Approve routine repair for round one?"],
  ["assistant", "repair-one", "Round one repair completed."],
  ["assistant", "review-two", "Round two review found a defect."],
  ["assistant", "ask-two", "Approve routine repair for round two?"],
  ["assistant", "repair-two", "Round two repair completed."],
  ["user", "reject", "Do not take the shortcut of skipping tests."],
  ["user", "historical", "For that earlier event, post once."],
  [
    "user",
    "correction",
    "Continue routine repair without approval each round.",
  ],
  ["assistant", "review-one", "Round one review found a defect."],
  ["user", null, "A possible input remains uncertain."],
  ["user", null, "A possible input remains uncertain."],
  ["assistant", "review-one", "Conflicting review content remains unresolved."],
  ["user", "interruption", "An accidental interruption occurred."],
  ["assistant", "confirmation", "A tool imposed confirmation."],
] as const;

export const originalRecords: readonly MessageRecord[] = messages.map(
  ([role, uuid, text], index) => ({
    schemaVersion: 2,
    sourceId: `synthetic:${String(index === 12 ? 11 : index)}`,
    role,
    uuid,
    isSidechain: null,
    parentUuid: null,
    sessionId: index === 10 ? "second-session" : "first-session",
    timestamp: null,
    text,
    blocks: [{ position: 0, type: "text", text }],
  }),
);

export const structure = structureImport(originalRecords);
export const records = originalRecords.map(
  (record) => redactRecord(record, { home: null, privateTexts: [] }).record,
);

export function ref(recordIndex: number) {
  const record = records[recordIndex];
  if (!record) throw new Error("fixture-index");
  return { recordIndex, sourceId: record.sourceId };
}

export const expectedAnnotations = {
  kinds: [
    "observed-repetition",
    "explicit-human-instruction",
    "rejected-approach",
    "exception",
    "assistant-claim",
    "uncertain-inference",
    "assistant-claim",
    "assistant-claim",
  ],
  repair: { sourceRefs: [ref(9)], counterevidenceRefs: [ref(2), ref(5)] },
  obsolete: { sourceRefs: [ref(2), ref(5)], counterevidenceRefs: [ref(9)] },
  loop: {
    stageIds: ["review", "repair"],
    maxIterations: 3,
    sourceRefs: [ref(0)],
    counterevidenceRefs: [ref(2), ref(5)],
  },
  nonGates: [
    ["repair", "routine-repair"],
    ["interruption", "accidental-interruption"],
    ["confirmation", "tool-imposed-confirmation"],
  ],
};

const fixedCandidate = {
  schemaVersion: 1,
  process: {
    id: "bounded-review",
    name: "Bounded review and repair",
    scope: "Synthetic history; no current authority or inference guarantee.",
    inputs: [{ id: "candidate-input", description: "Candidate changes." }],
    stages: [
      {
        id: "review",
        description: "Review changes.",
        activity: "work",
        kind: "observed-repetition",
        sourceRefs: [ref(1), ref(4), ref(10)],
        counterevidenceRefs: [ref(13)],
      },
      {
        id: "repair",
        description: "Repair routinely with tests.",
        activity: "routine-repair",
        kind: "explicit-human-instruction",
        sourceRefs: [ref(9)],
        counterevidenceRefs: [ref(2), ref(5)],
      },
      {
        id: "obsolete-approval",
        description: "Obsolete approval approach; shortcut rejected.",
        activity: "work",
        kind: "rejected-approach",
        sourceRefs: [ref(2), ref(5)],
        counterevidenceRefs: [ref(9), ref(7)],
      },
      {
        id: "historical-post",
        description: "One historical post was permitted; grants nothing now.",
        activity: "work",
        kind: "exception",
        sourceRefs: [ref(8)],
        counterevidenceRefs: [],
      },
      {
        id: "report",
        description: "Assistant reported completion.",
        activity: "work",
        kind: "assistant-claim",
        sourceRefs: [ref(3), ref(6)],
        counterevidenceRefs: [],
      },
      {
        id: "uncertain",
        description: "Uncertain interpretation of input.",
        activity: "work",
        kind: "uncertain-inference",
        sourceRefs: [ref(11)],
        counterevidenceRefs: [],
      },
      {
        id: "interruption",
        description: "Accidental interruption.",
        activity: "accidental-interruption",
        kind: "assistant-claim",
        sourceRefs: [ref(14)],
        counterevidenceRefs: [],
      },
      {
        id: "confirmation",
        description: "Tool confirmation.",
        activity: "tool-imposed-confirmation",
        kind: "assistant-claim",
        sourceRefs: [ref(15)],
        counterevidenceRefs: [],
      },
    ],
    branches: [
      {
        id: "defect",
        description: "Repair if a defect is found.",
        sourceStageId: "review",
        condition: "Defect found.",
        targetStageId: "repair",
      },
    ],
    loops: [
      {
        id: "rounds",
        description: "Bounded review and repair.",
        kind: "explicit-human-instruction",
        sourceRefs: [ref(0)],
        counterevidenceRefs: [ref(2), ref(5)],
        stageIds: ["review", "repair"],
        maxIterations: 3,
        exitCondition: "Checks and review pass.",
        exhaustedStoppingConditionId: "exhausted",
      },
    ],
    artifacts: [
      { id: "verified-changes", description: "Changes and check results." },
    ],
    stoppingConditions: [
      { id: "complete", description: "Review and checks pass." },
      { id: "exhausted", description: "Three rounds exhausted." },
    ],
    gates: [
      {
        id: "design",
        description: "Resolve a consequential design choice.",
        stageId: "review",
        type: "design-decision",
        kind: "uncertain-inference",
        sourceRefs: [ref(11)],
        counterevidenceRefs: [],
      },
    ],
    nonGates: [
      {
        id: "repair-non-gate",
        description: "Routine repair proceeds.",
        stageId: "repair",
        reason: "routine-repair",
      },
      {
        id: "interrupt-non-gate",
        description: "Interruption grants no decision.",
        stageId: "interruption",
        reason: "accidental-interruption",
      },
      {
        id: "tool-non-gate",
        description: "Tool confirmation grants no decision.",
        stageId: "confirmation",
        reason: "tool-imposed-confirmation",
      },
    ],
  },
};

export function candidate() {
  return structuredClone(fixedCandidate);
}

export function questionCandidate() {
  return {
    ...candidate(),
    openQuestion: {
      claimId: "review",
      description: "Which review order applies?",
      sourceRefs: [ref(1), ref(13)],
      choices: [
        { id: "earlier", description: "Use the earlier review order." },
        { id: "later", description: "Use the later review order." },
      ],
    },
  };
}

export function itemAt<T>(items: readonly T[], index = 0): T {
  const item = items[index];
  if (item === undefined) throw new Error("fixture-index");
  return item;
}
