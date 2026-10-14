import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInvocation } from "../src/cli/arguments.ts";

type Line = string | readonly string[];
type Fields = Readonly<Record<string, unknown>>;
type Success = readonly [line: Line, invocation: Fields];
type Failure = readonly [code: string, line: Line];

interface Shape {
  readonly subject: string;
  readonly needed: readonly string[];
  readonly taken: readonly string[];
  readonly absent: string;
}

interface Change {
  readonly subject?: string;
  readonly without?: string;
  readonly added?: string;
}

const largest = String(Number.MAX_SAFE_INTEGER);
const digest = `sha256:${"a1".repeat(32)}`;
const bindings = [
  "--expected-revision 3",
  "--generation 2",
  `--subject-digest ${digest}`,
];
const bound = bindings.join(" ");
const mutation = ["command-id", "json"];
const query = { subject: "", needed: [], absent: "missing-option" };
const decision = {
  subject: "run-1/gate-1",
  needed: bindings,
  taken: ["expected-revision", "generation", "subject-digest", ...mutation],
  absent: "missing-option",
};
const control = {
  subject: "run-1",
  needed: ["--expected-revision 4"],
  taken: ["expected-revision", ...mutation],
  absent: "missing-option",
};
const run = {
  subject: "develop",
  needed: ["--prompt x"],
  taken: ["prompt", "input", "ticket", ...mutation],
  absent: "missing-input-source",
};
const answer = {
  ...decision,
  needed: ["--text yes", ...bindings],
  taken: ["text", ...decision.taken],
};
const shapes: readonly (readonly [string, Shape])[] = [
  ["run", run],
  ["status", { ...query, taken: ["limit", "after", "json"] }],
  ["questions", { ...query, taken: ["json"] }],
  ["answer", answer],
  ["approve", decision],
  ["deny", { ...decision, taken: ["text", ...decision.taken] }],
  ["pause", control],
  ["resume", control],
  ["drop", control],
  ["events", { ...query, taken: ["after", "limit", "follow", "json"] }],
];
const samples: Readonly<Record<string, string>> = {
  prompt: "x",
  input: "f.json",
  ticket: "CLV-016",
  text: "t",
  "command-id": "c-1",
  "expected-revision": "1",
  generation: "1",
  "subject-digest": digest,
  limit: "5",
  after: "1",
};
const flags = ["version", "json", "follow", ...Object.keys(samples)];
const notWhole = ["1e3", "1.0", "+1", "01", "00", "0x1", "x", "１", "1,0"];
const notPositive = [...notWhole, "0", "9007199254740992"];
const notIdentifier = ["bad!id", "run+1", "a,b", "ü"];
const wrong: Readonly<Record<string, readonly string[]>> = {
  "expected-revision": notPositive,
  generation: notPositive,
  "command-id": [...notIdentifier, "c".repeat(129)],
  "subject-digest": [
    "a1".repeat(32),
    `sha256:${"A1".repeat(32)}`,
    `sha256:${"a".repeat(63)}`,
    `sha256:${"a".repeat(65)}`,
    `sha512:${"a1".repeat(32)}`,
  ],
};

function words(line: Line): readonly string[] {
  if (typeof line !== "string") return line;
  return line.split(" ").filter((word) => word !== "");
}

function sample(flag: string): string {
  const value = samples[flag];
  return value === undefined ? `--${flag}` : `--${flag} ${value}`;
}

function command(row: readonly [string, Shape], change: Change = {}): string {
  const [name, shape] = row;
  const removed = `${change.without ?? "--none"} `;
  const kept = shape.needed.filter((flag) => !flag.startsWith(removed));
  const subject = change.subject ?? shape.subject;
  return [name, subject, ...kept, change.added ?? ""].join(" ");
}

function forms(flag: string, text: string): readonly (readonly string[])[] {
  const separate = text.startsWith("-") ? [] : [[flag, text]];
  return [[`${flag}=${text}`], ...separate];
}

function ran(source: Fields, changes: Fields = {}): Fields {
  const submission = { kind: "run", workflowId: "develop", source };
  return { ...submission, commandId: null, json: false, ...changes };
}

function status(changes: Fields = {}): Fields {
  const list = { kind: "status", runId: null, limit: null, after: null };
  return { ...list, json: false, ...changes };
}

function decided(name: string, changes: Fields = {}): Fields {
  const subject = { reference: "run-1/gate-1", text: null };
  const binding = { expectedRevision: 3, generation: 2, subjectDigest: digest };
  const record = { kind: "decision", command: name, ...subject, ...binding };
  return { ...record, commandId: null, json: false, ...changes };
}

function controlled(name: string, changes: Fields = {}): Fields {
  const record = { kind: "run-command", command: name, runId: "run-1" };
  return {
    ...record,
    expectedRevision: 4,
    commandId: null,
    json: false,
    ...changes,
  };
}

function events(changes: Fields = {}): Fields {
  const page = { kind: "events", runId: null, after: 0, limit: null };
  return { ...page, follow: false, json: false, ...changes };
}

const promptX = { kind: "prompt", text: "x" };
const identified = { commandId: "c-2", json: true };
const edge = { expectedRevision: 1, generation: Number.MAX_SAFE_INTEGER };
const accepted: readonly Success[] = [
  ["run develop --prompt x", ran(promptX)],
  ["--json run --prompt x develop --command-id c-2", ran(promptX, identified)],
  [
    `run ${"w".repeat(128)} --prompt x --command-id ${"c".repeat(128)}`,
    ran(promptX, { workflowId: "w".repeat(128), commandId: "c".repeat(128) }),
  ],
  ["run develop --input in.json", ran({ kind: "input", file: "in.json" })],
  [
    ["run", "a/b", "--input=./my dir/../in put.json", "--json"],
    ran(
      { kind: "input", file: "./my dir/../in put.json" },
      { workflowId: "a/b", json: true },
    ),
  ],
  ["status", status()],
  ["status --json", status({ json: true })],
  ["status --limit 1", status({ limit: 1 })],
  [
    "status --limit 500 --after cursor_0:1/a.b-Z --json",
    status({ limit: 500, after: "cursor_0:1/a.b-Z", json: true }),
  ],
  ["status run-1", status({ runId: "run-1" })],
  [
    `status ${"r".repeat(128)} --json`,
    status({ runId: "r".repeat(128), json: true }),
  ],
  ["questions", { kind: "questions", runId: null, json: false }],
  ["questions run-1 --json", { kind: "questions", runId: "run-1", json: true }],
  [
    `answer run-1/gate-1 --text yes ${bound}`,
    decided("answer", { text: "yes" }),
  ],
  [
    `answer Q3 --json --text=yes --subject-digest ${digest} --generation ${largest} --command-id c-2 --expected-revision 1`,
    decided("answer", { reference: "Q3", text: "yes", ...edge, ...identified }),
  ],
  ...["approve", "deny"].flatMap((name): Success[] => [
    [`${name} run-1/gate-1 ${bound}`, decided(name)],
    [
      `${name} ${"d".repeat(256)} ${bound} --command-id c-2 --json`,
      decided(name, { reference: "d".repeat(256), ...identified }),
    ],
  ]),
  [`deny run-1/gate-1 --text=t ${bound}`, decided("deny", { text: "t" })],
  ...["pause", "resume", "drop"].flatMap((name): Success[] => [
    [`${name} run-1 --expected-revision 4`, controlled(name)],
    [
      `${name} run-1 --expected-revision=${largest} --command-id c-2 --json`,
      controlled(name, {
        expectedRevision: Number.MAX_SAFE_INTEGER,
        ...identified,
      }),
    ],
  ]),
  ["events", events()],
  ["events --after 0 --limit 1", events({ limit: 1 })],
  [
    "events run-1 --after 12 --limit 1000 --json",
    events({ runId: "run-1", after: 12, limit: 1000, json: true }),
  ],
  [
    `events --follow --after ${largest}`,
    events({ after: Number.MAX_SAFE_INTEGER, follow: true }),
  ],
  [["events", "--", "run-1"], events({ runId: "run-1" })],
  ["status --help --version", { kind: "command-help", command: "status" }],
  ["--help --version", { kind: "version" }],
  ["workflows validate --help", { kind: "validate-help" }],
  [
    "workflows validate m.json --input a.json --input b.json",
    { kind: "validate", manifest: "m.json", input: "b.json", json: false },
  ],
];

for (const [line, invocation] of accepted)
  await test(`CLV-008 the parser accepts ${JSON.stringify(line)}`, () => {
    assert.deepEqual(parseInvocation(words(line)), invocation);
  });

for (const [name] of shapes)
  await test(`CLV-008 the parser gives the help of ${name} when --help is present`, () => {
    for (const line of [
      `${name} --help`,
      `${name} -h`,
      `--help ${name} --json`,
      `${name} a b --help --follow --prompt= --limit x`,
    ])
      assert.deepEqual(parseInvocation(words(line)), {
        kind: "command-help",
        command: name,
      });
  });

for (const text of [
  "  work on CLV-037  ",
  "say \"hi\" and 'bye'",
  "línea uno\nlínea dos\r\n\tfin",
  "日本語 🚀 e\u0301",
  "$(echo no) `no` ${HOME} ; exit 1",
  "-starts with a dash",
  "--json",
])
  await test(`CLV-008 the parser keeps the exact text ${JSON.stringify(text)}`, () => {
    for (const prompt of forms("--prompt", text))
      assert.deepEqual(
        parseInvocation(["run", "develop", ...prompt]),
        ran({ kind: "prompt", text }),
      );
    for (const given of forms("--text", text))
      assert.deepEqual(
        parseInvocation(["answer", "Q1", ...given, ...words(bound)]),
        decided("answer", { reference: "Q1", text }),
      );
  });

const ordered: readonly Failure[] = [
  ["unknown-command", "frobnicate"],
  ["unknown-command", "runs develop --prompt x"],
  ["unknown-command", "frobnicate --nope"],
  ["unknown-command", "--nope frobnicate"],
  ["unknown-command", "frobnicate --prompt"],
  ["unknown-command", "workflows --nope"],
  ["unknown-option", "--nope"],
  ["unknown-option", "run develop --json --json --nope"],
  ["unknown-option", "run --help --nope"],
  ["missing-value", "status --json --json --limit"],
  ["missing-value", "run develop --json=true"],
  ["missing-value", ["run", "develop", "--prompt", "-h"]],
  ["repeated-option", "run -h --help"],
  ["repeated-option", "run develop --prompt=a --prompt b"],
  ["repeated-option", "status --prompt x --prompt y"],
  ["unexpected-option", "--prompt x"],
  ["unexpected-option", "--follow"],
  ["unexpected-option", "workflows validate m.json --prompt x"],
  ["unexpected-option", "workflows validate m.json --help --version"],
  ["unexpected-option", "pause --prompt x"],
  ["unexpected-option", "status run-1 --limit 5"],
  ["unexpected-option", "status run-1 --after c"],
  ["unexpected-option", "status run-1 run-2 --limit 5"],
  ["unexpected-option", "events --follow --limit 5"],
  ["unexpected-option", "events run-1 --limit 5 --follow"],
  ["unexpected-option", "status -v"],
  ["missing-argument", "run"],
  ["missing-argument", "pause"],
  ["unexpected-argument", "run develop extra"],
  ["unexpected-argument", "drop run-1 run-2"],
  ["conflicting-input-sources", "run develop --prompt x --input f.json"],
  ["conflicting-input-sources", "run bad!id --prompt= --input f.json"],
  ["missing-input-source", "run bad!id --command-id bad!id"],
  ["missing-option", "answer Q1 --text= --generation 2 --subject-digest x"],
  ["missing-option", "pause bad!id --command-id bad!id"],
  ["empty-prompt", "run develop --prompt="],
  ["empty-prompt", ["run", "develop", "--prompt", ""]],
  ["empty-prompt", ["run", "develop", "--prompt", " \n\t\u00a0 "]],
  ["empty-prompt", "run bad!id --prompt= --command-id bad!id"],
  ["empty-prompt", `answer Q1 --text= ${bound}`],
  ["empty-prompt", ["answer", "bad!ref", ...words(bound), "--text", " \n "]],
  ["empty-prompt", `answer bad!ref --text= ${bound.replace("3", "x")}`],
  ["invalid-option-value", "status --limit 0"],
  ["invalid-option-value", "status --limit 501"],
  ["invalid-option-value", "events --limit 0"],
  ["invalid-option-value", "events --limit 1001"],
  ["invalid-option-value", "events --after=-1"],
  ["invalid-option-value", "events --after 9007199254740992"],
  ["invalid-option-value", "resume run-1 --expected-revision=-1"],
  ["invalid-option-value", "drop run-1 --expected-revision="],
  ["invalid-option-value", ["pause", "run-1", "--expected-revision", " 1"]],
  ["invalid-option-value", ["status", ""]],
  ["invalid-option-value", ["questions", "run 1"]],
  ["invalid-option-value", ["events", "run-1\n"]],
  ["invalid-option-value", ["pause", "run-1", "--expected-revision", "1\n"]],
  ["invalid-option-value", "status --after="],
  ["invalid-option-value", `status --after ${"c".repeat(129)}`],
  ["invalid-option-value", `events ${"r".repeat(129)}`],
  ["invalid-option-value", `run ${"w".repeat(129)} --prompt x`],
  ["invalid-option-value", `drop ${"r".repeat(129)} --expected-revision 4`],
  ["invalid-option-value", `approve ${"d".repeat(257)} ${bound}`],
];

const generated = shapes.flatMap((row): Failure[] => {
  const [name, shape] = row;
  const foreign = flags.filter((flag) => !shape.taken.includes(flag));
  const valued = shape.taken.filter((flag) => samples[flag] !== undefined);
  const required = shape.subject === "" ? [] : [""];
  return [
    ["unknown-option", `${name} --nope`],
    ["unknown-option", `${command(row)} -x`],
    ...valued.map((flag): Failure => ["missing-value", `${name} --${flag}`]),
    ...["help", ...shape.taken].map((flag): Failure => [
      "repeated-option",
      `${name} ${sample(flag)} ${sample(flag)}`,
    ]),
    ...foreign.map((flag): Failure => [
      "unexpected-option",
      command(row, { added: sample(flag) }),
    ]),
    ...required.map((subject): Failure => [
      "missing-argument",
      command(row, { subject }),
    ]),
    ["unexpected-argument", `${command(row, { subject: "run-1" })} extra`],
    ...shape.needed.map((flag): Failure => [
      shape.absent,
      command(row, { without: flag.split(" ")[0] ?? "" }),
    ]),
    ...shape.taken.flatMap((flag) =>
      (wrong[flag] ?? []).map((value): Failure => [
        "invalid-option-value",
        command(row, { without: `--${flag}`, added: `--${flag} ${value}` }),
      ]),
    ),
    ...notIdentifier.map((subject): Failure => [
      "invalid-option-value",
      command(row, { subject }),
    ]),
  ];
});

const limited = [
  ...notWhole.map((value) => `status --limit ${value}`),
  ...notWhole.map((value) => `events --limit ${value}`),
  ...notWhole.map((value) => `events --after ${value}`),
  ...notIdentifier.map((value) => `status --after ${value}`),
].map((line): Failure => ["invalid-option-value", line]);

const failures = [...ordered, ...generated, ...limited].flatMap(
  ([code, line]): (readonly [string, readonly string[]])[] => {
    const argumentsList = words(line);
    if (argumentsList.includes("--json")) return [[code, argumentsList]];
    return [
      [code, argumentsList],
      [code, ["--json", ...argumentsList]],
    ];
  },
);

for (const [code, argumentsList] of failures)
  await test(`CLV-008 the parser gives ${code} for ${JSON.stringify(argumentsList)}`, () => {
    assert.deepEqual(parseInvocation(argumentsList), {
      kind: "usage-error",
      code,
      json: argumentsList.includes("--json"),
    });
  });
