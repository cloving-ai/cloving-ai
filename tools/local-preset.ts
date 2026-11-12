import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { record, type Fields } from "../src/protocol.ts";

export async function applyLocalPreset(input: {
  readonly folder: string;
  readonly id: string;
}): Promise<void> {
  const root = join(input.folder, input.id);
  await writeChanged(root + ".ts", localWorkflow);
  await writeChanged(root + ".declaration.json", localDeclaration);
  await writeChanged(join(root, "accept.ts"), localAccept);
  await writeChanged(join(root, "recovery.ts"), localRecovery);
  await writeChanged(join(root, "lessons.ts"), localLessons);
  await writeChanged(join(root, "scenarios.ts"), localSelection);
}

async function writeChanged(
  path: string,
  change: (text: string) => string,
): Promise<void> {
  await writeFile(path, change(await readFile(path, "utf8")));
}

function swap(input: {
  readonly text: string;
  readonly from: string;
  readonly to: string;
}): string {
  if (!input.text.includes(input.from))
    throw new Error("local-preset-mismatch");
  return input.text.replace(input.from, input.to);
}

function localWorkflow(text: string): string {
  const next = workflowEdits.reduce(
    (current, [from, to]) => swap({ text: current, from, to }),
    text,
  );
  if (workflowMarkers.some((marker) => next.includes(marker)))
    throw new Error("local-preset-mismatch");
  return next;
}

const workflowEdits: readonly (readonly [string, string])[] = [
  [
    'import { preparePull, labelTicket, blockTicket } from "./develop/pull.ts";\nimport { developRound } from "./develop/round.ts";\n',
    'import { localRound as developRound } from "./develop/local.ts";\n',
  ],
  [
    "const input = await preparePull(ticketInput(request));",
    "const input = promptInput(request);",
  ],
  ["  ticketInput,\n", "  promptInput,\n"],
  [
    '  const started = await labelTicket(input, { key: "start", round: 1 });\n  if (started !== null) return started;\n  let endingRound = 1;\n',
    "",
  ],
  ["        endingRound = round;\n", ""],
  [
    '  if (failure !== null || outcome?.kind === "blocked")\n    failure = await blockTicket(input, { round: endingRound, failure });\n',
    "",
  ],
];

const workflowMarkers = [
  "preparePull",
  "ticketInput",
  "blockTicket",
  "labelTicket",
  "endingRound",
];

function localDeclaration(text: string): string {
  const parsed: unknown = JSON.parse(text);
  const workflow = record(parsed);
  const body = record(workflow?.["workflow"]);
  const input = record(body?.["input"]);
  if (workflow === undefined || body === undefined || input === undefined)
    throw new Error("local-preset-mismatch");
  return (
    JSON.stringify(
      {
        ...workflow,
        workflow: {
          ...withoutQueue(body),
          capabilities: ["claude"],
          input: { ...input, fields: { prompt: { type: "string" } } },
        },
        methods: { claude: ["run-turn"] },
      },
      null,
      2,
    ) + "\n"
  );
}

function withoutQueue(body: Fields): Fields {
  return Object.fromEntries(
    Object.entries(body).filter(([key]) => key !== "queue"),
  );
}

function localAccept(text: string): string {
  return swap({
    text: swap({
      text,
      from: 'import { reviewByAgent } from "cloving/workflows/steps/review-by-agent";',
      to: 'import { reviewByPerson } from "cloving/workflows/steps/review-by-person";',
    }),
    from: `  return await reviewByAgent({
    subject: subject,
    reviewer: { kind: "greptile" },
  });`,
    to: "  return await reviewByPerson({ subject });",
  });
}

function localRecovery(text: string): string {
  return swap({
    text,
    from: 'export const recovery = "person" as "person" | "stop";',
    to: 'export const recovery = "stop" as "person" | "stop";',
  });
}

function localLessons(text: string): string {
  return swap({
    text,
    from: 'export const lessons = "file" as LessonsMode;',
    to: 'export const lessons = "none" as LessonsMode;',
  });
}

function localSelection(text: string): string {
  return swap({
    text,
    from: `export const selection = {
  input: "ticket",
  select: "queue",
  verify: "none",
  accept: "greptile",
  merge: "green",
  partial: "queue",
  recovery: "person",
  lessons: "file",
  demo: "none",
};`,
    to: `export const selection = {
  input: "task-text",
  select: "person",
  verify: "none",
  accept: "person",
  merge: "local",
  partial: "person",
  recovery: "stop",
  lessons: "none",
  demo: "none",
};`,
  });
}
