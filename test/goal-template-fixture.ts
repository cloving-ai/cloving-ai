import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { record } from "../src/protocol.ts";
import { runScenario, type StepScenario } from "../src/testing.ts";
import { developFiles } from "./develop-template-flow-fixture.ts";
import { replaced, selected } from "./rescue-template-options-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { input } from "../templates/goal-to-tickets/goal-to-tickets/scenarios.ts";

export interface GoalSelection {
  readonly review: string;
  readonly next: string;
}

export const goalTemplate = fileURLToPath(
  new URL("../templates/goal-to-tickets", import.meta.url),
);
const prefix = "repo/.cloving/workflows/";
export const packedGoalSources = [
  "templates/goal-to-tickets/goal-to-tickets.test.ts",
  "templates/goal-to-tickets/goal-to-tickets.ts",
  "templates/goal-to-tickets/goal-to-tickets/develop.ts",
  "templates/goal-to-tickets/goal-to-tickets/effects.ts",
  "templates/goal-to-tickets/goal-to-tickets/leave.ts",
  "templates/goal-to-tickets/goal-to-tickets/person.ts",
  "templates/goal-to-tickets/goal-to-tickets/plan.ts",
  "templates/goal-to-tickets/goal-to-tickets/post.ts",
  "templates/goal-to-tickets/goal-to-tickets/queue.ts",
  "templates/goal-to-tickets/goal-to-tickets/review.ts",
  "templates/goal-to-tickets/goal-to-tickets/scenarios.ts",
  "templates/goal-to-tickets/goal-to-tickets/tree.ts",
  "templates/goal-to-tickets/goal-to-tickets/turn.ts",
];
export const goalSelections: readonly GoalSelection[] = [
  { review: "turn", next: "queue" },
  { review: "person", next: "develop" },
  { review: "turn", next: "nothing" },
];

const reviewImports: Readonly<Record<string, string>> = {
  turn: 'reviewByTurn as checkPlan } from "./goal-to-tickets/review.ts"',
  person: 'reviewByPerson as checkPlan } from "./goal-to-tickets/person.ts"',
};
const nextImports: Readonly<Record<string, string>> = {
  queue: 'queueReady as nextTickets } from "./goal-to-tickets/queue.ts"',
  develop: 'handoffFirst as nextTickets } from "./goal-to-tickets/develop.ts"',
  nothing: 'leaveTickets as nextTickets } from "./goal-to-tickets/leave.ts"',
};

function declaration(text: string, selection: GoalSelection): string {
  const document = record(JSON.parse(text));
  const workflow = record(document?.["workflow"]);
  const methods = record(document?.["methods"]);
  const github: unknown = methods?.["github"];
  assert.ok(workflow && methods && Array.isArray(github));
  return JSON.stringify({
    workflow:
      selection.next === "develop"
        ? { ...workflow, handoffs: ["develop"] }
        : workflow,
    methods: {
      ...methods,
      github:
        selection.next === "nothing"
          ? github.filter((method: unknown) => method !== "label")
          : github,
    },
  });
}

export async function configuredGoalFiles(
  selection: GoalSelection,
): Promise<Record<string, string>> {
  const files = await developFiles(goalTemplate);
  replaced(files, {
    path: "goal-to-tickets.ts",
    from: String(reviewImports["turn"]),
    to: String(reviewImports[selection.review]),
  });
  replaced(files, {
    path: "goal-to-tickets.ts",
    from: String(nextImports["queue"]),
    to: String(nextImports[selection.next]),
  });
  selected(files, { path: "goal-to-tickets/scenarios.ts", selection });
  const key = prefix + "goal-to-tickets.declaration.json";
  files[key] = declaration(files[key] ?? "{}", selection);
  return files;
}

export async function goalScenario(request: {
  readonly selection: GoalSelection;
  readonly scenario: StepScenario;
}) {
  return withFiles(
    await configuredGoalFiles(request.selection),
    async (directory) =>
      await runScenario({
        workflow: join(directory, prefix, "goal-to-tickets.ts"),
        exportName: "goalToTickets",
        input: input,
        ...request.scenario,
      }),
  );
}
