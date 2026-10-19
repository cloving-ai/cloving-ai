import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import assert from "node:assert/strict";
import { readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { withFiles } from "./quality/files-fixture.ts";
import { importChats } from "../src/chats/import.ts";
import { redactImport } from "../src/chats/redact-import.ts";
import { readRootOutput, syntheticMessage } from "./chats-selection-fixture.ts";
await test(
  "CLV-111 redacts root coverage without reopening sources and leaves every original unchanged",
  chatPlatformScenario(async () => {
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
  }),
);

await test(
  "CLV-113 redacts size-bearing coverage and leaves revision files untouched without sources",
  chatPlatformScenario(async () => {
    await withFiles(
      { "root/source.jsonl": syntheticMessage("synthetic-redaction") },
      async (directory) => {
        for (const roots of [[], ["root"]]) {
          const request = {
            paths: roots.length === 0 ? ["root/source.jsonl"] : [],
            roots,
            workingDirectory: directory,
            runtimeDirectory: "runtime",
          };
          const first = await importChats(request);
          assert.ok(first.importId);
          const second = await importChats({
            ...request,
            previousImportId: first.importId,
          });
          assert.ok(second.importId);
          const output = join(directory, "runtime/chats", second.importId);
          const before = await readFile(join(output, "revision.json"));
          await rename(
            join(directory, "root/source.jsonl"),
            join(directory, "moved"),
          );
          const result = await redactImport({
            importId: second.importId,
            workingDirectory: directory,
            runtimeDirectory: "runtime",
            settings: { home: "/synthetic/home", privateTexts: [] },
          });
          assert.equal(result.code, "redaction-complete");
          assert.deepEqual(
            await readFile(join(output, "revision.json")),
            before,
          );
          await rename(
            join(directory, "moved"),
            join(directory, "root/source.jsonl"),
          );
        }
      },
    );
  }),
);
