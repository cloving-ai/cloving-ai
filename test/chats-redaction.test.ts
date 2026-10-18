import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeTranscript,
  type MessageRecord,
} from "../src/chats/normalize.ts";
import { redactRecord } from "../src/chats/redaction.ts";

const settings = {
  home: "/synthetic/home/operator",
  privateTexts: ["Private Phrase"],
};
const message = (
  text: string,
  blocks: readonly Record<string, unknown>[] = [],
): MessageRecord => ({
  schemaVersion: 1,
  sourceId: "sha256:synthetic:0",
  role: "assistant",
  timestamp: null,
  sessionId: "synthetic-session",
  text,
  blocks,
});

await test("CLV-103 redacts nested tool input and result strings and member names", () => {
  const record = message("", [
    {
      position: 2,
      type: "tool_use",
      id: "call",
      name: "tool",
      input: {
        "person@example.test": [
          "PRIVATE PHRASE",
          { inner: "person@example.test" },
        ],
        untouched: [null, true, 4],
      },
    },
    {
      position: 3,
      type: "tool_result",
      tool_use_id: "call",
      content: { value: "private phrase" },
      is_error: false,
    },
  ]);
  const before = JSON.stringify(record);
  const result = redactRecord(record, settings);
  assert.deepEqual(result.record.blocks, [
    {
      position: 2,
      type: "tool_use",
      id: "call",
      name: "tool",
      input: {
        "[EMAIL]": ["[PRIVATE_TEXT]", { inner: "[EMAIL]" }],
        untouched: [null, true, 4],
      },
    },
    {
      position: 3,
      type: "tool_result",
      tool_use_id: "call",
      content: { value: "[PRIVATE_TEXT]" },
      is_error: false,
    },
  ]);
  assert.equal(result.counts.email, 2);
  assert.equal(result.counts.privateText, 2);
  assert.equal(result.totalCount, 4);
  assert.equal(JSON.stringify(record), before);
});

const forms = [
  ["/synthetic/home/operator", "[HOME_PATH]", "homePath"],
  ["/synthetic/home/operator/project/file.txt", "[HOME_PATH]", "homePath"],
  [
    '"/synthetic/home/operator/project with spaces/file.txt"',
    '"[HOME_PATH]"',
    "homePath",
  ],
  ["'~/project with spaces/file.txt'", "'[HOME_PATH]'", "homePath"],
  ["~/project/file", "[HOME_PATH]", "homePath"],
  ["person+label@example.test", "[EMAIL]", "email"],
  ...[
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "ghr_",
    "github_pat_",
    "sk-ant-",
    "sk-",
    "sk-proj-",
    "sk-svcacct-",
  ].map(
    (prefix) =>
      [`${prefix}SyntheticKey123_abc-DEF`, "[TOKEN]", "token"] as const,
  ),
  [
    "-----BEGIN RSA PRIVATE KEY-----\nsynthetic\nkey material\n-----END RSA PRIVATE KEY-----",
    "[PRIVATE_KEY]",
    "privateKey",
  ],
  [
    "https://operator:password@example.test/a?q=1#part",
    "[CREDENTIAL_URL]",
    "credentialUrl",
  ],
  ["PRIVATE phrase", "[PRIVATE_TEXT]", "privateText"],
] as const;

for (const [text, expected, category] of forms) {
  await test(`CLV-103 replaces complete ${category} spans in each stored field`, () => {
    const record = message(`${text} ${text}`, [
      { position: 0, type: "text", text },
      {
        position: 1,
        type: "tool_use",
        id: "call",
        name: "tool",
        input: { [text]: text },
      },
      {
        position: 2,
        type: "tool_result",
        tool_use_id: "call",
        content: [text],
      },
    ]);
    const result = redactRecord(record, settings);
    assert.equal(result.record.text, `${expected} ${expected}`);
    assert.deepEqual(result.record.blocks, [
      { position: 0, type: "text", text: expected },
      {
        position: 1,
        type: "tool_use",
        id: "call",
        name: "tool",
        input: { [expected]: expected },
      },
      {
        position: 2,
        type: "tool_result",
        tool_use_id: "call",
        content: [expected],
      },
    ]);
    assert.equal(result.counts[category], 6);
    assert.equal(result.totalCount, 6);
    assert.equal(
      JSON.stringify(result),
      JSON.stringify(redactRecord(record, settings)),
    );
  });
}

await test("CLV-103 merges overlaps with category priority and does not scan replacements", () => {
  const cases = [
    [
      "-----BEGIN PRIVATE KEY-----\nhttps://u:p@example.test\n-----END PRIVATE KEY-----",
      "[PRIVATE_KEY]",
      "privateKey",
    ],
    [
      "https://ghp_synthetic@example.test/path",
      "[CREDENTIAL_URL]",
      "credentialUrl",
    ],
    [
      "/synthetic/home/operator/ghp_secret/person@example.test",
      "[HOME_PATH]",
      "homePath",
    ],
    ["ghp_secret@example.test", "[TOKEN]", "token"],
    ["person@example.test", "[EMAIL]", "email"],
    ["abcde", "[PRIVATE_TEXT]", "privateText"],
  ] as const;
  for (const [text, expected, category] of cases) {
    const result = redactRecord(message(text), {
      ...settings,
      privateTexts: [
        "secret",
        "example",
        "abc",
        "cde",
        "TOKEN",
        "PRIVATE_TEXT",
      ],
    });
    assert.equal(result.record.text, expected);
    assert.equal(result.counts[category], 1);
    assert.equal(result.totalCount, 1);
  }
});

await test("CLV-103 keeps benign text, public URLs, sibling paths and metadata unchanged", () => {
  const text =
    "/synthetic/home/operator-sibling/file https://example.test/path ~someone/file useful text";
  const record = {
    ...message(text, [
      {
        position: 3,
        type: "tool_use",
        id: "person@example.test",
        name: "Private Phrase",
        input: text,
      },
    ]),
    sourceId: "Private Phrase",
    timestamp: "person@example.test",
    sessionId: "~/metadata",
  };
  assert.deepEqual(redactRecord(record, settings).record, record);
});

await test("CLV-103 refuses member-name collisions without changing the input", () => {
  const record = message("", [
    {
      position: 0,
      type: "tool_use",
      id: "call",
      name: "tool",
      input: { "one@example.test": 1, "two@example.test": 2 },
    },
  ]);
  const before = JSON.stringify(record);
  assert.throws(() => redactRecord(record, settings), /member-name-collision/);
  assert.equal(JSON.stringify(record), before);
});

await test("CLV-103 preserves exact JSON number tokens while walking nested data", () => {
  for (const number of [
    "1e400",
    "-1e400",
    "1e-400",
    "9007199254740993",
    "0.1234567890123456789",
    "-0",
    "1.0",
    "1E+2",
  ]) {
    const source = `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"call","name":"tool","input":{"number":${number},"text":"person@example.test"}},{"type":"tool_result","tool_use_id":"call","content":[${number}]}]}}`;
    const normalized = normalizeTranscript(source, "sha256:synthetic");
    const record = normalized.records[0];
    assert.ok(record);
    const redacted = JSON.stringify(redactRecord(record, settings).record);
    assert.ok(redacted.includes(`"number":${number}`));
    assert.ok(redacted.includes(`"content":[${number}]`));
    assert.match(redacted, /\[EMAIL\]/);
  }
});

await test("CLV-103 merges overlapping occurrences of the same literal text", () => {
  assert.equal(
    redactRecord(message("ababa"), { home: null, privateTexts: ["aba"] }).record
      .text,
    "[PRIVATE_TEXT]",
  );
});

await test("CLV-103 redacts a large path listing without an argument limit", () => {
  const count = 200_000;
  const result = redactRecord(message("~/x ".repeat(count)), settings);
  assert.equal(result.record.text, "[HOME_PATH] ".repeat(count));
  assert.equal(result.counts.homePath, count);
  assert.equal(result.totalCount, count);
});

await test("CLV-103 redacts complete credential URLs with RFC user-information punctuation", () => {
  const text = "https://user;name:p%40ss@example.test/path?q=x#f";
  assert.equal(
    redactRecord(message(text), settings).record.text,
    "[CREDENTIAL_URL]",
  );
});

for (const [text, expected] of [
  ["/synthetic/home/operator/project[1]/file(name):part?value", "[HOME_PATH]"],
  [
    "https://user:password@example.test/project[1]/file(name)?value=x",
    "[CREDENTIAL_URL]",
  ],
]) {
  await test("CLV-103 replaces complete paths and credential URLs containing punctuation", () => {
    assert.ok(text);
    assert.equal(redactRecord(message(text), settings).record.text, expected);
  });
}

await test("CLV-103 treats private texts and home settings as literal strings", () => {
  const settings = {
    home: "/synthetic/home/operator[1]",
    privateTexts: ["a.b+[c](d)?", "[TOKEN]"],
  };
  const record = message(
    "a.b+[c](d)? A.B+[C](D)? /synthetic/home/operator[1]/file ghp_secret",
  );
  assert.equal(
    redactRecord(record, settings).record.text,
    "[PRIVATE_TEXT] [PRIVATE_TEXT] [HOME_PATH] [TOKEN]",
  );
});

await test("CLV-103 a root home folder never creates empty matches in benign text", () => {
  const result = redactRecord(message("  ordinary  words /synthetic/file"), {
    home: "/",
    privateTexts: [],
  });
  assert.equal(result.record.text, "  ordinary  words [HOME_PATH]");
  assert.equal(result.counts.homePath, 1);
});

await test("CLV-103 keeps ordinary identifiers and distinct tool member names", () => {
  const text = "task-123 disk-photo ask-proj-example xghp_example _sk-example";
  assert.equal(redactRecord(message(text), settings).record.text, text);
  const record = message(text, [
    { position: 0, type: "text", text },
    {
      position: 1,
      type: "tool_use",
      id: "call",
      name: "tool",
      input: { "task-1": text, "task-2": "disk-photo" },
    },
  ]);
  const result = redactRecord(record, settings);
  assert.equal(result.record.text, text);
  assert.deepEqual(result.record, record);
  assert.equal(result.counts.token, 0);
  assert.equal(result.totalCount, 0);
  assert.equal(
    redactRecord(
      message("(sk-Synthetic) 'ghp_Synthetic' =github_pat_Synthetic"),
      settings,
    ).record.text,
    "([TOKEN]) '[TOKEN]' =[TOKEN]",
  );
});

await test("CLV-110 preserves schema and private identity metadata through redaction", () => {
  for (const parent of [
    {},
    { parentUuid: null },
    { parentUuid: "person@example.test" },
  ]) {
    const record: MessageRecord = {
      ...message("person@example.test"),
      schemaVersion: 2,
      uuid: "ghp_SyntheticId",
      isSidechain: true,
      ...parent,
    };
    const result = redactRecord(record, settings).record;
    assert.deepEqual(result, { ...record, text: "[EMAIL]" });
    assert.equal(
      Object.hasOwn(result, "parentUuid"),
      Object.hasOwn(parent, "parentUuid"),
    );
    assert.equal(record.text, "person@example.test");
  }
});
