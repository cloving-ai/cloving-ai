import assert from "node:assert/strict";
import { developFiles } from "./develop-template-flow-fixture.ts";

export interface DevelopSelection {
  readonly input: string;
  readonly select: string;
  readonly accept: string;
  readonly merge: string;
  readonly partial: string;
}

const prefix = "repo/.cloving/workflows/";

export const automatic = {
  input: "ticket",
  select: "queue",
  accept: "greptile",
  merge: "green",
  partial: "queue",
};
export const reviewed = {
  input: "ticket",
  select: "person",
  accept: "person",
  merge: "local",
  partial: "person",
};
export const completeConfigurations = [
  automatic,
  reviewed,
  { ...reviewed, input: "task-text" },
  { ...reviewed, accept: "turn" },
  { ...automatic, merge: "person" },
  { ...reviewed, merge: "green" },
  { ...reviewed, input: "task-text", accept: "turn", merge: "green" },
];

function edit(
  files: Record<string, string>,
  patch: { readonly file: string; readonly from: string; readonly to: string },
): void {
  const { file, from, to } = patch;
  const path = prefix + file;
  const source = files[path];
  assert.ok(
    source !== undefined && source.includes(from),
    `Missing template edit: ${file}: ${from}`,
  );
  files[path] = source.replaceAll(from, to);
}

export async function configuredDevelopFiles(
  directory: string,
  selected: DevelopSelection,
) {
  const files = await developFiles(directory);
  if (selected.input === "task-text")
    edit(files, { file: "develop.ts", from: "ticketInput", to: "promptInput" });
  acceptanceFiles(files, selected.accept);
  deliveryFiles(files, selected);
  files[prefix + "develop.declaration.json"] = declaration(selected);
  scenarioFiles(files, selected);
  return files;
}

function acceptanceFiles(files: Record<string, string>, accept: string): void {
  if (accept === "person") {
    edit(files, {
      file: "develop/accept.ts",
      from: "reviewByAgent",
      to: "reviewByPerson",
    });
    edit(files, {
      file: "develop/accept.ts",
      from: "review-by-agent",
      to: "review-by-person",
    });
    edit(files, {
      file: "develop/accept.ts",
      from: 'reviewer: { kind: "greptile" },',
      to: "",
    });
  }
  if (accept === "turn") {
    edit(files, {
      file: "develop/accept.ts",
      from: 'kind: "greptile"',
      to: 'kind: "turn", profile: "review"',
    });
    edit(files, {
      file: "develop/local.ts",
      from: "reviewByPerson",
      to: "reviewByAgent",
    });
    edit(files, {
      file: "develop/local.ts",
      from: "review-by-person",
      to: "review-by-agent",
    });
    edit(files, {
      file: "develop/local.ts",
      from: "subject: { target: input.cycleId, commit: report.commit },",
      to: 'subject: { target: input.cycleId, commit: report.commit },\n    reviewer: { kind: "turn", profile: "review" },',
    });
  }
}

function deliveryFiles(
  files: Record<string, string>,
  selected: DevelopSelection,
): void {
  if (selected.merge === "person") {
    edit(files, {
      file: "develop/round.ts",
      from: "mergeWhenGreen",
      to: "mergeByPerson",
    });
    edit(files, {
      file: "develop/round.ts",
      from: "merge-when-green",
      to: "merge-by-person",
    });
  }
  if (selected.merge === "local") localFiles(files);
  else if (selected.partial === "person") {
    edit(files, {
      file: "develop/round.ts",
      from: "import { developReport }",
      to: 'import { partialChoice } from "./partial-choice.ts";\nimport { developReport }',
    });
    edit(files, {
      file: "develop/round.ts",
      from: "const report = await developReport(state);",
      to: "const report = await developReport(state);\n    const partial = await partialChoice({ input, round, report });\n    if (partial !== null) return partial;",
    });
  }
}

function scenarioFiles(
  files: Record<string, string>,
  selected: DevelopSelection,
): void {
  edit(files, {
    file: "develop/scenarios.ts",
    from: "export const selection =",
    to: "export const defaultSelection =",
  });
  const source = files[prefix + "develop/scenarios.ts"];
  assert.ok(typeof source === "string");
  files[prefix + "develop/scenarios.ts"] =
    source + `\nexport const selection = ${JSON.stringify(selected)};\n`;
  edit(files, {
    file: "develop.test.ts",
    from: 'import { flowTests } from "./develop/flow-tests.ts";',
    to: 'import { optionTests as flowTests } from "./develop/option-tests.ts";',
  });
  edit(files, {
    file: "develop.test.ts",
    from: 'import { refusalTests } from "./develop/refusal-tests.ts";',
    to: "",
  });
  edit(files, {
    file: "develop.test.ts",
    from: "flowTests.concat(refusalTests)",
    to: "flowTests",
  });
}

function localFiles(files: Record<string, string>): void {
  edit(files, {
    file: "develop.ts",
    from: 'import { preparePull, labelTicket } from "./develop/pull.ts";',
    to: "",
  });
  edit(files, {
    file: "develop.ts",
    from: 'import { developRound } from "./develop/round.ts";',
    to: 'import { localRound as developRound } from "./develop/local.ts";',
  });
  for (const line of [
    "  await preparePull(input.cycleId);\n",
    '  await labelTicket(input, { key: "start", round: 1 });\n',
    "  let endingRound = 1;\n",
    "      endingRound = round;\n",
    '  if (outcome.kind === "blocked")\n    await labelTicket(input, { key: "blocked", round: endingRound });\n',
  ])
    edit(files, { file: "develop.ts", from: line, to: "" });
}

function declaration(selected: DevelopSelection): string {
  const local = selected.merge === "local";
  const claude =
    selected.accept === "turn" ? ["run-turn", "run-turn:review"] : ["run-turn"];
  const github = [
    "prepare",
    "label",
    "open-pr",
    "merge",
    "close-issue",
    "partial-issue",
  ];
  if (selected.accept === "greptile") github.push("wait-review");
  return JSON.stringify({
    workflow: {
      workflowId: "develop",
      effectLimit: 27,
      capabilities: local ? ["claude"] : ["claude", "github"],
      ...(selected.select === "queue" ? { queue: true } : {}),
      input: {
        maximumBytes: 65536,
        fields:
          selected.input === "ticket"
            ? { ticket: { type: "ticket" } }
            : { prompt: { type: "string" } },
      },
    },
    methods: local ? { claude } : { claude, github },
  });
}
