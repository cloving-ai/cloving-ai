import assert from "node:assert/strict";
import { test } from "node:test";
import { validateAnalysis } from "../src/chats/analysis.ts";
import { inspectWorkflowGenerationText } from "../src/chats/workflow-generation-text.ts";
import {
  candidate,
  records,
  structure,
  itemAt,
  questionCandidate,
} from "./chats-analysis-fixture.ts";

function accepted(input = candidate()) {
  const validation = validateAnalysis(input, { records, structure });
  assert.equal(validation.accepted, true);
  return validation.result;
}

await test("CLV-122 accepted synthetic analysis passes the text check deterministically without mutation", () => {
  const result = accepted();
  const before = JSON.stringify(result);
  assert.deepEqual(inspectWorkflowGenerationText(result), []);
  assert.equal(JSON.stringify(inspectWorkflowGenerationText(result)), "[]");
  assert.equal(JSON.stringify(result), before);
});

function proseFields(value: object): { target: object; key: string }[] {
  const privateOrFixed = [
    "sourceRefs",
    "counterevidenceRefs",
    "limitations",
    "kind",
    "activity",
    "reason",
    "type",
  ];
  return Object.entries(value).flatMap(([key, entry]: [string, unknown]) => {
    if (privateOrFixed.includes(key)) return [];
    if (typeof entry === "string") return [{ target: value, key }];
    if (entry !== null && typeof entry === "object") return proseFields(entry);
    return [];
  });
}

await test("CLV-122 every renderable identifier and prose field is bounded, including links and open question choices", () => {
  const result = accepted(questionCandidate());
  for (const { target, key } of proseFields(result)) {
    const before: unknown = Reflect.get(target, key);
    assert.ok(typeof before === "string");
    Reflect.set(target, key, "UNSAFE\nTEXT");
    assert.deepEqual(
      inspectWorkflowGenerationText(result),
      ["text-characters"],
      key,
    );
    Reflect.set(target, key, "x".repeat(241));
    assert.deepEqual(
      inspectWorkflowGenerationText(result),
      ["text-length"],
      key,
    );
    Reflect.set(target, key, before);
  }
});

await test("CLV-122 copied text permits 240 characters and refuses lengths outside the bound", () => {
  const result = accepted();
  for (const length of [1, 239, 240])
    assert.deepEqual(
      inspectWorkflowGenerationText({
        ...result,
        process: { ...result.process, name: "x".repeat(length) },
      }),
      [],
    );
  for (const length of [0, 241, 10_000])
    assert.deepEqual(
      inspectWorkflowGenerationText({
        ...result,
        process: { ...result.process, name: "x".repeat(length) },
      }),
      ["text-length"],
    );
});

await test("CLV-122 copied text refuses non-printable and non-ASCII characters, including a trailing newline", () => {
  const result = accepted();
  for (const character of ["\n", "\r", "\t", "\0", "\x1f", "\x7f", "é", "😀"])
    assert.deepEqual(
      inspectWorkflowGenerationText({
        ...result,
        process: { ...result.process, scope: "Synthetic " + character },
      }),
      ["text-characters"],
    );
});

await test("CLV-122 identifiers, names and descriptions from structurally accepted data all require text checking", () => {
  const input = candidate();
  input.process.id = "p".repeat(241);
  input.process.name = "Synthetic\nname";
  itemAt(input.process.inputs).description = "x".repeat(241);
  const validation = validateAnalysis(input, { records, structure });
  assert.equal(validation.accepted, true);
  assert.deepEqual(inspectWorkflowGenerationText(validation.result), [
    "text-length",
    "text-characters",
  ]);
});

const disclosures = [
  {
    code: "machine-path",
    texts: [
      ["", "Users", "synthetic", "repo"].join("/"),
      ["", "home", "synthetic", "repo"].join("/"),
      ["", "Volumes", "synthetic", "repo"].join("/"),
      ["", "tmp", "synthetic"].join("/"),
      "C:\\synthetic\\repo",
      "D:/synthetic/repo",
      "C:synthetic",
      "\\\\synthetic-server\\share",
      "\\synthetic\\rooted",
      "//synthetic-server/share",
      "file:" + ["", "", "", "synthetic", "repo"].join("/"),
      "~/synthetic",
      "~synthetic/repo",
      "$HOME/synthetic",
      "${HOME}/synthetic",
      "%USERPROFILE%\\synthetic",
      "$env:USERPROFILE\\synthetic",
    ],
  },
  {
    code: "parent-traversal",
    texts: [
      "../synthetic",
      "..\\synthetic",
      "nested/../synthetic",
      "nested/..",
      "%2e%2e%2fsynthetic",
    ],
  },
  {
    code: "email-form",
    texts: [
      "synthetic@example.test",
      "name+synthetic@example.test",
      "worker@localhost",
      '"synthetic name"@example.test',
      "synthetic@[127.0.0.1]",
    ],
  },
  {
    code: "user-mention",
    texts: [
      "@synthetic",
      "<@U000000>",
      "<@!123456>",
      "<@&123456>",
      "@[Synthetic User]",
      "@here",
      "@everyone",
    ],
  },
  {
    code: "access-token-form",
    texts: [
      "ghp_SYNTHETIC",
      "github_pat_SYNTHETIC",
      "sk-ant-SYNTHETIC",
      "sk-proj-SYNTHETIC",
      "sk-svcacct-SYNTHETIC",
      "sk-SYNTHETIC",
      "xoxb-SYNTHETIC",
      "npm_SYNTHETIC",
      "AKIA0000000000000000",
      "Bearer SYNTHETIC",
      "eyJhbGciOiJub25lIn0.eyJzdWIiOiJzeW50aGV0aWMifQ.signature",
    ],
  },
  {
    code: "credential-form",
    texts: [
      "password=SYNTHETIC",
      "passwd: SYNTHETIC",
      '"api_key": "SYNTHETIC"',
      "client-secret = SYNTHETIC",
      "access_token: SYNTHETIC",
      "Authorization: Basic c3ludGhldGljOg==",
      "https://synthetic:secret@example.test",
      "-----BEGIN PRIVATE KEY-----",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
    ],
  },
] as const;

for (const { code, texts } of disclosures)
  await test(`CLV-122 refuses synthetic ${code} forms with fixed codes`, () => {
    const result = accepted();
    for (const text of texts) {
      const inspected = inspectWorkflowGenerationText({
        ...result,
        process: { ...result.process, name: "Synthetic " + text },
      });
      assert.equal(inspected.includes(code), true);
      assert.equal(JSON.stringify(inspected).includes(text), false);
    }
  });

const edgeCases = [
  [
    "machine-path",
    "Use <" + ["", "Users", "synthetic", "repo"].join("/") + "> for work.",
  ],
  ["machine-path", "Use <//synthetic-server/share> for work."],
  ["machine-path", "Use ~ for this synthetic example."],
  ["parent-traversal", "Use nested/.. before another task."],
  ["parent-traversal", ".%2e%2fsynthetic"],
  ["parent-traversal", "%2e.%5csynthetic"],
  ["user-mention", "cc:@synthetic"],
  ["access-token-form", "stage_ghp_SYNTHETIC"],
  ["credential-form", "Basic c3ludGhldGljOg=="],
  ["credential-form", "-----BEGIN PGP PRIVATE KEY BLOCK-----"],
] as const;

for (const [index, [code, text]] of edgeCases.entries())
  await test(`CLV-122 refuses delimited or encoded ${code} case ${String(index + 1)}`, () => {
    const result = accepted();
    const codes = inspectWorkflowGenerationText({
      ...result,
      process: { ...result.process, scope: text },
    });
    assert.equal(codes.includes(code), true);
  });

await test("CLV-122 safe prose and relative names remain data without privacy or authority guarantees", () => {
  const result = accepted();
  for (const text of [
    "Review and repair; ask about design, preserve limits.",
    "Review...",
    "Review... then repair...",
    "Run tests and publish. This is only inert text.",
    "src/worker.ts",
    "task-repair",
    "https://example.test/docs",
    'Quotes " and backticks ` stay data; ${synthetic} stays data.',
    "An arbitrary private project name cannot be recognized here.",
  ])
    assert.deepEqual(
      inspectWorkflowGenerationText({
        ...result,
        process: { ...result.process, scope: text },
      }),
      [],
    );
});

await test("CLV-122 refusal codes are unique and fixed-order without refused text or artifacts", () => {
  const result = accepted();
  const unsafe = {
    ...result,
    process: {
      ...result.process,
      name: "x".repeat(241),
      scope:
        "\n../synthetic @synthetic worker@example.test ghp_SYNTHETIC password=SYNTHETIC C:\\synthetic",
    },
  };
  const before = JSON.stringify(unsafe);
  const expected = [
    "text-length",
    "text-characters",
    "machine-path",
    "parent-traversal",
    "email-form",
    "user-mention",
    "access-token-form",
    "credential-form",
  ];
  assert.deepEqual(inspectWorkflowGenerationText(unsafe), expected);
  assert.deepEqual(inspectWorkflowGenerationText(unsafe), expected);
  assert.equal(JSON.stringify(unsafe), before);
});

await test("CLV-122 private source references, counterevidence and limitations are never read", () => {
  const result = accepted(questionCandidate());
  for (const value of [
    ...result.process.stages,
    ...result.process.loops,
    ...result.process.gates,
  ])
    for (const key of ["sourceRefs", "counterevidenceRefs"])
      Object.defineProperty(value, key, {
        get() {
          throw new Error("private-provenance-read");
        },
      });
  Object.defineProperty(result.openQuestion, "sourceRefs", {
    get() {
      throw new Error("private-question-provenance-read");
    },
  });
  Object.defineProperty(result, "limitations", {
    get() {
      throw new Error("private-limitations-read");
    },
  });
  assert.deepEqual(inspectWorkflowGenerationText(result), []);
});
