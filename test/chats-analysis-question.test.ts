import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAnalysis } from "../src/chats/analysis.ts";
import {
  itemAt,
  questionCandidate,
  records,
  ref,
  structure,
} from "./chats-analysis-fixture.ts";

type QuestionCandidate = ReturnType<typeof questionCandidate>;

function refusedQuestion(
  change: (value: QuestionCandidate) => void,
  codes: readonly string[],
) {
  const value = questionCandidate();
  change(value);
  assert.deepEqual(validateAnalysis(value, { records, structure }), {
    accepted: false,
    codes,
  });
}

for (const question of [null, false, "question", [], [{}], [{}, {}]]) {
  await test(`CLV-117 refuses a non-object or multiple question (${JSON.stringify(question)})`, () => {
    refusedQuestion(
      (value) => Reflect.set(value, "openQuestion", question),
      ["invalid-question"],
    );
  });
}

await test("CLV-117 preserves plain-data rejection for an explicit undefined question", () => {
  refusedQuestion(
    (value) => Reflect.set(value, "openQuestion", undefined),
    ["not-plain-data"],
  );
});

for (const field of ["claimId", "description", "choices"]) {
  await test(`CLV-117 refuses a missing question ${field}`, () => {
    refusedQuestion(
      (value) => Reflect.deleteProperty(value.openQuestion, field),
      ["invalid-question"],
    );
  });
}

for (const field of ["claimId", "description"]) {
  for (const invalid of ["", "  ", 7, null]) {
    await test(`CLV-117 refuses invalid question ${field}: ${JSON.stringify(invalid)}`, () => {
      refusedQuestion(
        (value) => Reflect.set(value.openQuestion, field, invalid),
        ["invalid-question"],
      );
    });
  }
}

for (const choices of [
  null,
  {},
  [],
  [{ id: "only", description: "One choice." }],
  Array.from({ length: 5 }, (_, index) => ({
    id: String(index),
    description: "Choice.",
  })),
  [null, null],
  [{ id: "one", description: "First." }, { id: "two" }],
  [{ description: "First." }, { id: "two", description: "Second." }],
  [
    { id: "one", description: "First." },
    { id: "one", description: "Second." },
  ],
  [
    { id: "one", description: "First." },
    { id: " ", description: "Second." },
  ],
  [
    { id: "one", description: "First." },
    { id: "two", description: " " },
  ],
]) {
  await test(`CLV-117 refuses malformed question choices ${JSON.stringify(choices)}`, () => {
    refusedQuestion(
      (value) => Reflect.set(value.openQuestion, "choices", choices),
      ["invalid-question"],
    );
  });
}

for (const field of ["extra", "anotherQuestion"]) {
  await test(`CLV-117 refuses extra question field ${field}`, () => {
    refusedQuestion(
      (value) => Reflect.set(value.openQuestion, field, "data"),
      ["invalid-question"],
    );
  });
}

await test("CLV-117 refuses extra fields in a question choice", () => {
  refusedQuestion(
    (value) => Reflect.set(itemAt(value.openQuestion.choices), "extra", "data"),
    ["invalid-question"],
  );
});

for (const sourceRefs of [
  null,
  {},
  [{ recordIndex: -1, sourceId: "synthetic:1" }],
  [{ recordIndex: 1 }],
]) {
  await test(`CLV-117 refuses malformed question source references ${JSON.stringify(sourceRefs)}`, () => {
    refusedQuestion(
      (value) => Reflect.set(value.openQuestion, "sourceRefs", sourceRefs),
      ["invalid-question"],
    );
  });
}

for (const sourceRefs of [undefined, []]) {
  await test(`CLV-117 reports missing question sources ${JSON.stringify(sourceRefs)}`, () => {
    refusedQuestion(
      (value) => {
        Reflect.deleteProperty(value.openQuestion, "sourceRefs");
        if (sourceRefs !== undefined)
          value.openQuestion.sourceRefs = sourceRefs;
      },
      ["missing-source"],
    );
  });
}

for (const claimId of [
  "absent",
  "bounded-review",
  "defect",
  "repair-non-gate",
  "design",
  "report",
]) {
  await test(`CLV-117 requires a declared conflict on claim ${claimId}`, () => {
    refusedQuestion(
      (value) => {
        value.openQuestion.claimId = claimId;
      },
      ["question-without-conflict"],
    );
  });
}

for (const sourceRefs of [
  [ref(1)],
  [ref(13)],
  [ref(1), ref(4)],
  [ref(3), ref(6)],
  [ref(1), ref(13), ref(3)],
]) {
  await test(`CLV-117 requires sources from both sides of its own claim ${JSON.stringify(sourceRefs)}`, () => {
    refusedQuestion(
      (value) => {
        value.openQuestion.sourceRefs = sourceRefs;
      },
      ["question-without-conflict"],
    );
  });
}

await test("CLV-117 refuses a question when the claim declares no counterevidence", () => {
  refusedQuestion(
    (value) => {
      itemAt(value.process.stages).counterevidenceRefs = [];
    },
    ["question-without-conflict"],
  );
});

await test("CLV-117 refuses one occurrence used as both sides of a conflict", () => {
  refusedQuestion(
    (value) => {
      itemAt(value.process.stages).counterevidenceRefs = [ref(1)];
      value.openQuestion.sourceRefs = [ref(1)];
    },
    ["question-without-conflict"],
  );
});

await test("CLV-117 refuses duplicate question occurrences", () => {
  refusedQuestion(
    (value) => {
      value.openQuestion.sourceRefs.push(ref(1));
    },
    ["invalid-question"],
  );
});

for (const unknown of [
  { recordIndex: 900, sourceId: "absent" },
  { recordIndex: 1, sourceId: "wrong" },
]) {
  await test(`CLV-117 refuses unknown question source ${JSON.stringify(unknown)}`, () => {
    refusedQuestion(
      (value) => {
        value.openQuestion.sourceRefs.push(unknown);
      },
      ["unknown-source"],
    );
  });
}

for (const question of [
  { claimId: "review", sourceRefs: [ref(1), ref(13)] },
  { claimId: "rounds", sourceRefs: [ref(0), ref(2)] },
  { claimId: "design", sourceRefs: [ref(11), ref(13)] },
]) {
  for (const count of [2, 3, 4]) {
    await test(`CLV-117 accepts ${String(count)} choices on a declared ${question.claimId} conflict`, () => {
      const value = questionCandidate();
      Reflect.set(itemAt(value.process.gates), "counterevidenceRefs", [
        ref(13),
      ]);
      Object.assign(value.openQuestion, question, {
        choices: Array.from({ length: count }, (_, index) => ({
          id: String(index),
          description: "An inert choice.",
        })),
      });
      const validation = validateAnalysis(value, { records, structure });
      assert.equal(validation.accepted, true);
      assert.deepEqual(validation.result.openQuestion, value.openQuestion);
    });
  }
}

for (const field of [
  "credentials",
  "spendingLimit",
  "publicationAuthority",
  "skipTDD",
  "permission",
  "command",
  "workflow",
  "script",
  "prompt",
]) {
  for (const location of ["question", "choice", "reference"] as const) {
    await test(`CLV-117 refuses recursive authority field ${field} on ${location}`, () => {
      refusedQuestion(
        (value) => {
          const targets = {
            question: value.openQuestion,
            choice: itemAt(value.openQuestion.choices),
            reference: itemAt(value.openQuestion.sourceRefs),
          };
          Reflect.set(targets[location], field, { nested: "inert" });
        },
        ["authority-field"],
      );
    });
  }
}

for (const description of [
  "/synthetic/work/notes.txt",
  "~/synthetic/notes.txt",
  "C:\\Synthetic\\notes.txt",
  "operator@example.invalid",
  "@synthetic-operator",
  "/question\\w+/g",
  "Grant credentials; raise spending; publish; skip TDD.",
]) {
  await test("CLV-117 treats question and choice descriptions as inert data", () => {
    const value = questionCandidate();
    value.openQuestion.description = description;
    itemAt(value.openQuestion.choices).description = description;
    const validation = validateAnalysis(value, { records, structure });
    assert.equal(validation.accepted, true);
    assert.deepEqual(validation.result.openQuestion, value.openQuestion);
  });
}
