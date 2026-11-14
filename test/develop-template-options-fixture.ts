import assert from "node:assert/strict";
import { developFiles } from "./develop-template-flow-fixture.ts";
export interface DevelopSelection {
  readonly input: string;
  readonly select: string;
  readonly verify: string;
  readonly accept: string;
  readonly merge: string;
  readonly partial: string;
  readonly recovery: string;
  readonly lessons: string;
  readonly demo: string;
}

const prefix = "repo/.cloving/workflows/";
export const automatic = {
  input: "ticket",
  select: "queue",
  verify: "none",
  accept: "greptile",
  merge: "green",
  partial: "queue",
  recovery: "person",
  lessons: "file",
  demo: "none",
};
export const reviewed = {
  input: "ticket",
  select: "person",
  verify: "none",
  accept: "person",
  merge: "local",
  partial: "person",
  recovery: "stop",
  lessons: "none",
  demo: "none",
};
export const completeConfigurations = [
  automatic,
  reviewed,
  { ...reviewed, input: "task-text" },
  { ...reviewed, accept: "turn" },
  { ...automatic, merge: "person" },
  { ...reviewed, merge: "green" },
  { ...reviewed, input: "task-text", accept: "turn", merge: "green" },
  { ...automatic, accept: "panel" },
  { ...automatic, verify: "red-green" },
  { ...automatic, verify: "red-green", merge: "person" },
  { ...automatic, demo: "record" },
  { ...automatic, accept: "turn", merge: "person", demo: "record" },
  {
    ...reviewed,
    input: "task-text",
    verify: "red-green",
    accept: "turn",
    merge: "green",
  },
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
  acceptanceFiles(files, selected.accept);
  deliveryFiles(files, selected);
  if (selected.input === "task-text")
    edit(files, { file: "develop.ts", from: "ticketInput", to: "promptInput" });
  if (selected.verify === "red-green") verificationFiles(files);
  if (selected.recovery === "stop")
    edit(files, {
      file: "develop/recovery.ts",
      from: 'export const recovery = "person" as',
      to: 'export const recovery = "stop" as',
    });
  if (selected.lessons === "none")
    edit(files, {
      file: "develop/lessons.ts",
      from: 'export const lessons = "file" as',
      to: 'export const lessons = "none" as',
    });
  files[prefix + "develop.declaration.json"] = declaration(selected);
  if (selected.demo === "record")
    for (const change of demoEdits) edit(files, change);
  if (selected.select !== "queue") {
    const source = files[prefix + "develop.ts"];
    if (source === undefined) throw new Error("Missing develop source");
    files[prefix + "develop.ts"] = source
      .slice(0, source.indexOf("export async function developFeed"))
      .replace(
        /import \{[^}]+\} from "(?:cloving\/workflows\/steps\/protected-effect|\.\/develop\/feed-(?:selection|results)\.ts)";\n/g,
        "",
      );
    for (const from of [
      'import { feedTests } from "./develop/feed-tests.ts";\n',
      "for (const scenario of feedTests) await test(scenario.name, scenario.run);\n",
    ])
      edit(files, { file: "develop.test.ts", from, to: "" });
  }
  scenarioFiles(files, selected);
  return files;
}

function verificationFiles(files: Record<string, string>): void {
  edit(files, {
    file: "develop/round.ts",
    from: "import { acceptWork }",
    to: 'import { verifyRedGreen } from "./red-green.ts";\nimport { acceptWork }',
  });
  edit(files, {
    file: "develop/round.ts",
    from: "  const { round, pull } = request;",
    to: `  const { round, pull } = request;
  const verification = await verifyRedGreen({ cycleId: pull.target, head: pull.commit, round });
  if (verification !== null && "kind" in verification) return verification;
  if (verification !== null)
    return { merged: false, reason: verification.reason, output: verification.output };`,
  });
}

const demoEdits = [
  {
    file: "develop/round.ts",
    from: 'import { openPull, finishPull } from "./pull.ts";',
    to: 'import { recordDemo } from "./demo.ts";\nimport { openPull, finishPull } from "./pull.ts";',
  },
  {
    file: "develop/round.ts",
    from: "  type RoundResult,",
    to: "  type RoundResult,\n  type DevelopTask,",
  },
  {
    file: "develop/round.ts",
    from: "await deliverPull({ round, pull",
    to: "await deliverPull({ input, round, pull",
  },
  {
    file: "develop/round.ts",
    from: "  readonly pull: PullRequest;\n",
    to: "  readonly pull: PullRequest;\n  readonly input: DevelopTask;\n",
  },
  {
    file: "develop/round.ts",
    from: "  try {\n    return await ",
    to: "  const demo = await recordDemo({ input: request.input, round: round, pull: pull });\n  if (demo !== null) return demo;\n  try {\n    return await ",
  },
  {
    file: "develop.declaration.json",
    from: '"close-pr"',
    to: '"close-pr","attach-asset"',
  },
  {
    file: "develop.declaration.json",
    from: '"effectLimit":87',
    to: '"effectLimit":99',
  },
];

const panelEdits = [
  {
    from: 'import { acceptWork } from "./accept.ts";',
    to: 'import { reviewPanel } from "./panel.ts";',
  },
  {
    from: "  type DevelopState,",
    to: "  type DevelopState,\n  type DevelopReport,",
  },
  {
    from: "await deliverPull({ round, pull });",
    to: "await deliverPull({ round, pull, state, report });",
  },
  {
    from: "  readonly pull: PullRequest;\n}): Promise<RoundResult | CycleOutcome> {",
    to: "  readonly pull: PullRequest;\n  readonly state: DevelopState;\n  readonly report: DevelopReport;\n}): Promise<RoundResult | CycleOutcome> {",
  },
  {
    from: "  const review = await acceptWork({\n    target: pull.target,\n    number: pull.number,\n    commit: pull.commit,\n  });",
    to: '  const review = await reviewPanel({\n    state: request.state,\n    report: request.report,\n    pull: pull,\n    reviewers: ["review-claude", "review-codex", "review-gemini"],\n  });\n  if ("kind" in review) return review;',
  },
];

export const panelMethods = [
  "run-turn:review-claude",
  "run-turn:review-codex",
  "run-turn:review-gemini",
  "run-turn:review-synthesis",
];

function acceptanceFiles(files: Record<string, string>, accept: string): void {
  if (accept === "panel")
    for (const { from, to } of panelEdits)
      edit(files, { file: "develop/round.ts", from, to });
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
      from: 'if ("kind" in report) return report;',
      to: 'if ("kind" in report) return report;\n    const partial = await partialChoice({ input, round, report });\n    if (partial !== null) return partial;',
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
    from: 'import { recoveryTests } from "./develop/recovery-tests.ts";',
    to: "",
  });
  edit(files, {
    file: "develop.test.ts",
    from: "flowTests.concat(refusalTests, recoveryTests)",
    to: "flowTests",
  });
}

function localFiles(files: Record<string, string>): void {
  edit(files, {
    file: "develop.ts",
    from: 'import { preparePull, labelTicket, blockTicket } from "./develop/pull.ts";',
    to: "",
  });
  edit(files, {
    file: "develop.ts",
    from: 'import { developRound } from "./develop/round.ts";',
    to: 'import { localRound as developRound } from "./develop/local.ts";',
  });
  edit(files, {
    file: "develop.ts",
    from: "await preparePull(ticketInput(request))",
    to: "ticketInput(request)",
  });
  for (const line of [
    '  const started = await labelTicket(input, { key: "start", round: 1 });\n',
    "  if (started !== null) return started;\n",
    "  let endingRound = 1;\n",
    "        endingRound = round;\n",
    '  if (failure !== null || outcome?.kind === "blocked")\n    failure = await blockTicket(input, { round: endingRound, failure });\n',
  ])
    edit(files, { file: "develop.ts", from: line, to: "" });
}

function declaration(selected: DevelopSelection): string {
  const local = selected.merge === "local";
  const verification =
    selected.verify === "red-green"
      ? {
          effectLimit: 93,
          capabilities: ["command"],
          workflow: { commands: ["red-green"] },
          methods: { command: ["run:red-green"] },
        }
      : {
          effectLimit: selected.accept === "panel" ? 99 : 87,
          capabilities: [],
          workflow: {},
          methods: {},
        };
  const claude = ["run-turn"].concat(
    selected.accept === "turn" ? ["run-turn:review"] : [],
    selected.accept === "panel" ? panelMethods : [],
  );
  const github = [
    "prepare",
    "label",
    "open-pr",
    "merge",
    "close-issue",
    "partial-issue",
    "close-pr",
  ];
  if (selected.accept === "greptile") github.push("wait-review");
  github.push(...queueMethods(selected));
  return JSON.stringify({
    workflow: {
      workflowId: "develop",
      effectLimit: verification.effectLimit,
      capabilities: (local ? ["claude"] : ["claude", "github"]).concat(
        verification.capabilities,
      ),
      ...verification.workflow,
      ...(selected.select === "queue"
        ? { queue: { everySeconds: 120, lanes: 1, feed: "developFeed" } }
        : {}),
      input: {
        maximumBytes: 65536,
        fields:
          selected.input === "ticket"
            ? { ticket: { type: "ticket" } }
            : { prompt: { type: "string" } },
      },
    },
    methods: {
      ...(local ? { claude } : { claude, github }),
      ...verification.methods,
    },
  });
}

function queueMethods(selected: DevelopSelection): string[] {
  return selected.select === "queue" ? ["issues", "issue-states"] : [];
}
