import assert from "node:assert/strict";
import {
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  base,
  cli,
  configuredCli,
  corpus,
  expectedRedacted,
  coverage,
  files,
  importId,
  record,
} from "./chats-redact-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { importChats } from "../src/chats/import.ts";
import { redactImport } from "../src/chats/redact-import.ts";
import { readRootOutput, syntheticMessage } from "./chats-selection-fixture.ts";

const variants: readonly Readonly<Record<string, string>>[] = [
  {
    [`${base}/corpus.jsonl`]:
      JSON.stringify({
        ...record,
        blocks: [
          {
            position: 0,
            type: "tool_use",
            id: "call",
            name: "tool",
            input: { "one@example.test": 1, "two@example.test": 2 },
          },
        ],
      }) + "\n",
  },
  { [`${base}/coverage.json`]: "{" },
  {
    [`${base}/coverage.json`]: JSON.stringify({
      schemaVersion: 2,
      importId,
      roots: ["/synthetic/root"],
      exclusions: [],
      limits: {},
      entries: [],
    }),
  },
  {
    [`${base}/coverage.json`]: JSON.stringify({
      schemaVersion: 3,
      importId,
      files: [],
    }),
  },
  {
    [`${base}/coverage.json`]: JSON.stringify({
      schemaVersion: 1,
      importId: "other",
      files: [],
    }),
  },
  { [`${base}/coverage.json`]: JSON.stringify({ schemaVersion: 1, importId }) },
  {
    [`${base}/coverage.json`]: JSON.stringify({
      schemaVersion: 1,
      importId,
      files: [null],
    }),
  },
  ...[
    {},
    null,
    { ...record, schemaVersion: 2 },
    { ...record, role: "system" },
    { ...record, sourceId: 1 },
    { ...record, sessionId: 1 },
    { ...record, timestamp: false },
    { ...record, text: null },
    { ...record, blocks: [{}] },
    { ...record, unexpected: "private" },
    { ...record, blocks: [{ position: 0, type: "image" }] },
    { ...record, blocks: [{ position: -1, type: "text", text: "a" }] },
    {
      ...record,
      blocks: [{ position: 1, type: "tool_use", id: "call", name: "tool" }],
    },
    {
      ...record,
      blocks: [
        {
          position: 1,
          type: "tool_result",
          tool_use_id: "call",
          content: null,
          is_error: 1,
        },
      ],
    },
  ].map((value) => ({
    [`${base}/corpus.jsonl`]: JSON.stringify(value) + "\n",
  })),
];

for (const [index, variant] of variants.entries()) {
  await test(`CLV-103 refuses malformed import variant ${String(index)}`, async () => {
    await withFiles({ ...files, ...variant }, async (directory) => {
      const result = cli(directory, ["chats", "redact", importId]);
      assert.equal(result.status, 1);
      assert.match(result.stdout, /redaction-failed/);
      assert.equal(
        await readFile(join(directory, base, "corpus.jsonl"), "utf8"),
        variant[`${base}/corpus.jsonl`] ?? corpus,
      );
      assert.deepEqual((await readdir(join(directory, base))).sort(), [
        "corpus.jsonl",
        "coverage.json",
      ]);
    });
  });
}

for (const name of [
  "corpus.jsonl",
  "coverage.json",
  "import",
  "runtime",
] as const) {
  await test(`CLV-103 refuses missing or linked ${name} inputs`, async () => {
    for (const kind of [
      "missing",
      "symlink",
      "nonregular",
      "hardlink",
    ] as const) {
      if (kind === "hardlink" && ["import", "runtime"].includes(name)) continue;
      await withFiles(files, async (directory) => {
        let target = join(directory, base, name);
        if (name === "runtime") target = join(directory, "runtime");
        if (name === "import") target = join(directory, base);
        const backup = join(directory, "saved");
        if (kind === "hardlink") await link(target, backup);
        else {
          await rename(target, backup);
          if (kind === "symlink") await symlink(backup, target);
          if (kind === "nonregular") await mkdir(target);
        }
        const result = cli(directory, ["chats", "redact", importId]);
        assert.equal(result.status, 1);
        assert.equal(result.stderr, "");
        assert.doesNotMatch(result.stdout, /saved|synthetic|Error/);
      });
    }
  });
}

for (const name of ["redacted.jsonl", "redaction.json"]) {
  await test(`CLV-103 preserves existing ${name} and creates no other outputs`, async () => {
    await withFiles(
      { ...files, [`${base}/${name}`]: "existing-sentinel" },
      async (directory) => {
        assert.equal(cli(directory, ["chats", "redact", importId]).status, 1);
        assert.equal(
          await readFile(join(directory, base, name), "utf8"),
          "existing-sentinel",
        );
        assert.equal((await readdir(join(directory, base))).length, 3);
      },
    );
  });
}

await test("CLV-103 refuses repository destinations", async () => {
  await withFiles(
    { ...files, ".git/config": "synthetic" },
    async (directory) => {
      assert.equal(cli(directory, ["chats", "redact", importId]).status, 1);
      assert.deepEqual((await readdir(join(directory, base))).sort(), [
        "corpus.jsonl",
        "coverage.json",
      ]);
    },
  );
});

await test("CLV-103 permits absent and empty private-text lists and preserves corpus numeric tokens", async () => {
  for (const setting of [undefined, "[]"]) {
    const numeric = JSON.stringify({
      ...record,
      blocks: [
        {
          position: 0,
          type: "tool_use",
          id: "call",
          name: "tool",
          input: "NUMBER",
        },
      ],
    }).replace(
      '"NUMBER"',
      '{"numbers":[-0,1e400,1e-400,9007199254740993,1.0],"Private Phrase":"person@example.test"}',
    );
    await withFiles(
      { ...files, [`${base}/corpus.jsonl`]: numeric + "\n" },
      async (directory) => {
        const result = configuredCli(directory, {
          argumentsList: ["chats", "redact", importId],
          environment: { CLOVING_PRIVATE_TEXTS: setting },
        });
        assert.equal(result.status, 0);
        const output = await readFile(
          join(directory, base, "redacted.jsonl"),
          "utf8",
        );
        assert.ok(
          output.includes('"numbers":[-0,1e400,1e-400,9007199254740993,1.0]'),
        );
        assert.match(output, /Private Phrase/);
      },
    );
  }
});

await test("CLV-103 missing corpus and empty completed imports are distinguished", async () => {
  await withFiles(
    { ...files, [`${base}/corpus.jsonl`]: "" },
    async (directory) => {
      assert.equal(cli(directory, ["chats", "redact", importId]).status, 0);
      assert.equal(
        await readFile(join(directory, base, "redacted.jsonl"), "utf8"),
        "",
      );
      await rm(join(directory, base, "corpus.jsonl"));
      assert.equal(
        await readFile(join(directory, base, "coverage.json"), "utf8"),
        coverage,
      );
    },
  );
});

const firstRedacted: unknown = JSON.parse(
  expectedRedacted.split("\n")[0] ?? "",
);
assert.ok(
  firstRedacted &&
    typeof firstRedacted === "object" &&
    "text" in firstRedacted &&
    "blocks" in firstRedacted,
);
const redactedContent = {
  text: firstRedacted.text,
  blocks: firstRedacted.blocks,
};

await test("CLV-110 redacts mixed versions in order while leaving structure and identity private", async () => {
  const identities = [
    { uuid: "ghp_SyntheticId", isSidechain: true, parentUuid: null },
    { uuid: null, isSidechain: null },
    { uuid: "child", isSidechain: false, parentUuid: "person@example.test" },
  ];
  const records = [
    record,
    ...identities.map((identity) => ({
      ...record,
      schemaVersion: 2,
      ...identity,
    })),
  ];
  const input = records.map((value) => JSON.stringify(value)).join("\n") + "\n";
  const sidecar = '{"private":"ghp_SyntheticId"}\n';
  await withFiles(
    {
      ...files,
      [`${base}/corpus.jsonl`]: input,
      [`${base}/structure.json`]: sidecar,
    },
    async (directory) => {
      const result = cli(directory, ["chats", "redact", importId]);
      assert.equal(result.status, 0);
      const output = (
        await readFile(join(directory, base, "redacted.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map((line): unknown => JSON.parse(line));
      assert.deepEqual(
        output,
        records.map((value) => ({ ...value, ...redactedContent })),
      );
      assert.equal(
        await readFile(join(directory, base, "corpus.jsonl"), "utf8"),
        input,
      );
      assert.equal(
        await readFile(join(directory, base, "structure.json"), "utf8"),
        sidecar,
      );
      assert.equal(
        await readFile(join(directory, base, "coverage.json"), "utf8"),
        coverage,
      );
    },
  );
});

await test("CLV-111 redacts root coverage without reopening sources and leaves every original unchanged", async () => {
  await withFiles(
    {
      "root/project/session.jsonl": syntheticMessage("person@example.test"),
      "root/skip/sentinel.jsonl": "sentinel",
    },
    async (directory) => {
      const request = {
        paths: [],
        roots: ["root"],
        excludeProjects: ["skip"],
        workingDirectory: directory,
        runtimeDirectory: "runtime",
      };
      const imported = await importChats(request);
      assert.ok(imported.importId);
      const output = await readRootOutput(directory, imported.importId);
      const structure = await readFile(
        join(output.output, "structure.json"),
        "utf8",
      );
      await rm(join(directory, "root"), { recursive: true });
      const result = await redactImport({
        importId: imported.importId,
        workingDirectory: directory,
        runtimeDirectory: "runtime",
        settings: { home: null, privateTexts: [] },
      });
      assert.equal(result.code, "redaction-complete");
      for (const [name, expected] of [
        ["corpus.jsonl", output.corpus],
        ["coverage.json", output.coverage],
        ["structure.json", structure],
      ])
        assert.equal(
          await readFile(join(output.output, String(name)), "utf8"),
          expected,
        );
      const redacted = await readFile(
        join(output.output, "redacted.jsonl"),
        "utf8",
      );
      assert.doesNotMatch(redacted, /person@example.test/);
      assert.match(structure, /"historyCompleteness": "unknown"/);
    },
  );
});
