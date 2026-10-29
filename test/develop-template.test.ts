import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { join } from "node:path";
import ts from "typescript";
import { completeConfigurations } from "./develop-template-options-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import {
  automatic,
  configurationErrors,
  developManifest,
  manifest,
  reviewed,
} from "./develop-template-fixture.ts";

await test("CLV-221 completed fixtures accept JSON records or null and reject invalid result types", async () => {
  const source = await readFile(
    new URL("../templates/develop/develop/scenarios.ts", import.meta.url),
    "utf8",
  );
  const invalid = [
    "undefined",
    "1n",
    "Symbol()",
    "() => {}",
    "{ nested: undefined }",
    "{ items: [() => {}] }",
    "true",
    "42",
    '"text"',
    "[]",
  ];
  await withFiles(
    {
      "scenarios.ts": `${source}\ncompleted({ items: [null, true, 42, "text", {}] } as const);\ncompleted(null);\n${invalid.map((value) => `completed(${value});`).join("\n")}`,
    },
    (directory) => {
      const program = ts.createProgram([join(directory, "scenarios.ts")], {
        strict: true,
        noEmit: true,
        types: [],
        target: ts.ScriptTarget.ESNext,
      });
      const diagnostics = ts.getPreEmitDiagnostics(program);
      assert.deepEqual(
        diagnostics.map((diagnostic) => {
          assert.ok(diagnostic.code === 2345 || diagnostic.code === 2322);
          assert.ok(diagnostic.file && diagnostic.start !== undefined);
          const { line } = diagnostic.file.getLineAndCharacterOfPosition(
            diagnostic.start,
          );
          return diagnostic.file.text.split("\n")[line];
        }),
        invalid.map((value) => `completed(${value});`),
      );
    },
  );
});

await test("CLV-221 loads the develop template manifest", async () => {
  const document: unknown = JSON.parse(
    await readFile(
      new URL("../templates/develop/template.json", import.meta.url),
      "utf8",
    ),
  );
  assert.ok(document !== null && typeof document === "object");
  assert.equal(Reflect.get(document, "version"), 1);
  assert.equal(Reflect.get(document, "name"), "develop");
});

await test("CLV-221 rejects unknown option requirements and doctor codes", async () => {
  const document = await developManifest();
  const first = document.points[0];
  const choice = first?.options[0];
  assert.ok(first && choice);
  for (const mutation of [
    { requires: { select: ["missing"] } },
    { requires: { missing: ["person"] } },
    { requires: { select: [] } },
    { needs: ["missing-doctor-code"] },
  ]) {
    const invalid = {
      ...document,
      points: [
        { ...first, options: [{ ...choice, ...mutation }] },
        ...document.points.slice(1),
      ],
    };
    assert.throws(() => manifest(invalid), assert.AssertionError);
  }
});

await test("CLV-221 includes template assets in package files", async () => {
  const metadata: unknown = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.ok(metadata !== null && typeof metadata === "object");
  const files: unknown = Reflect.get(metadata, "files");
  assert.ok(Array.isArray(files) && files.includes("templates"));
});

await test("CLV-221 names the nested folder declaration fields in its edits", async () => {
  const document = await developManifest();
  const input = document.points.find((point) => point.id === "input");
  const select = document.points.find((point) => point.id === "select");
  assert.ok(input && select);
  for (const option of input.options)
    assert.match(option.change, /workflow\.input\.fields/);
  for (const option of select.options)
    assert.match(option.change, /workflow\.queue/);
});

await test("CLV-221 declares all five decision points and twelve options", async () => {
  const document = await developManifest();
  assert.deepEqual(
    document.points.map((point) => [
      point.id,
      point.options.map((option) => option.id),
    ]),
    [
      ["input", ["ticket", "task-text"]],
      ["select", ["queue", "person"]],
      ["accept", ["greptile", "person", "turn"]],
      ["merge", ["green", "person", "local"]],
      ["partial", ["queue", "person"]],
    ],
  );
});

await test("CLV-221 defaults to queue selection, Greptile and checked automatic merge", async () => {
  const document = await developManifest();
  const defaults = Object.fromEntries(
    document.points.map((point) => [point.id, point.options[0]?.id]),
  );
  assert.deepEqual(defaults, automatic);
  assert.deepEqual(configurationErrors(document, automatic), []);
  const needs = new Set(
    document.points.flatMap((point) => point.options[0]?.needs ?? []),
  );
  for (const code of [
    "gh-login",
    "greptile-review",
    "check-command",
    "ticket-command",
    "next-command",
    "queue-interval",
  ])
    assert.ok(needs.has(code), `Missing default prerequisite: ${code}`);
  const options = document.points.flatMap((point) => point.options);
  assert.ok(options.some((option) => option.change.includes('"queue": true')));
  assert.ok(
    options.some((option) =>
      option.change.includes(
        'reviewByAgent({ subject, reviewer: { kind: "greptile" } })',
      ),
    ),
  );
  assert.ok(
    options.some((option) =>
      option.change.includes('mergeWhenGreen({ pull, check: "beforeMerge" })'),
    ),
  );
});

await test("CLV-221 has a compatible complete selection for every option", async () => {
  const document = await developManifest();
  const covered = new Set<string>();
  for (const selected of completeConfigurations) {
    assert.deepEqual(configurationErrors(document, selected), []);
    for (const [point, option] of Object.entries(selected))
      covered.add(`${point}.${option}`);
  }
  assert.deepEqual(
    [...covered].sort(),
    document.points
      .flatMap((point) =>
        point.options.map((option) => `${point.id}.${option.id}`),
      )
      .sort(),
  );
});

await test("CLV-221 requires ticket input and a pull request for queued partial work", async () => {
  const document = await developManifest();
  const cases = [
    {
      selected: { ...reviewed, input: "task-text", select: "queue" },
      failure: "select.queue requires input",
    },
    {
      selected: { ...automatic, input: "task-text" },
      failure: "partial.queue requires input",
    },
    {
      selected: { ...reviewed, accept: "greptile" },
      failure: "accept.greptile requires merge",
    },
    {
      selected: { ...automatic, merge: "local" },
      failure: "partial.queue requires merge",
    },
    {
      selected: { ...automatic, select: "person" },
      failure: "partial.queue requires select",
    },
    {
      selected: { ...reviewed, input: "task-text", partial: "queue" },
      failure: "partial.queue requires input",
    },
  ];
  for (const { selected, failure } of cases)
    assert.ok(
      configurationErrors(document, selected).some((error) =>
        error.startsWith(failure),
      ),
      failure,
    );
});
