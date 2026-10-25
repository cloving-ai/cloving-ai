import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { importChats } from "../src/chats/import.ts";
import { redactImport } from "../src/chats/redact-import.ts";
import { withFiles } from "./quality/files-fixture.ts";

export function chatPlatformScenario(
  scenario: () => Promise<void> | void,
): () => Promise<void> {
  return async () => {
    if (process.platform === "darwin") {
      await scenario();
      return;
    }
    await assertChatPlatformRefusal();
  };
}

async function assertChatPlatformRefusal(): Promise<void> {
  const source = "private source bytes";
  await withFiles(
    { "source.jsonl": source, "runtime/sentinel": "unchanged" },
    async (directory) => {
      const before = await readdir(directory, { recursive: true });
      const imported = await importChats({
        paths: ["source.jsonl"],
        roots: ["runtime"],
        workingDirectory: directory,
        runtimeDirectory: "runtime",
      });
      const redacted = await redactImport({
        importId: "01234567-89ab-4cde-8fab-0123456789ab",
        workingDirectory: directory,
        runtimeDirectory: "runtime",
        settings: { home: null, privateTexts: [] },
      });
      assert.equal(imported.code, "platform-unsupported");
      assert.equal(imported.importId, null);
      assert.equal(redacted.code, "platform-unsupported");
      assert.equal(redacted.totalCount, 0);
      assert.deepEqual(await readdir(directory, { recursive: true }), before);
      assert.equal(
        await readFile(join(directory, "source.jsonl"), "utf8"),
        source,
      );
      assert.equal(
        await readFile(join(directory, "runtime/sentinel"), "utf8"),
        "unchanged",
      );
    },
  );
}
