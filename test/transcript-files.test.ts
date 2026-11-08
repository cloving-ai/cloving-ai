import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { located } from "../src/daemon/operation-journal.ts";
import { transcriptFiles } from "../src/daemon/transcript-files.ts";

const operationId = JSON.stringify([
  "cloving-operation",
  1,
  "run-1",
  "implement",
  "claude-turn",
  null,
  null,
]);

async function withJournal(
  body: (directory: string, folder: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "clv-transcript-"));
  try {
    await body(
      directory,
      located(join(directory, "journal"), operationId).folder,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await test("CLV-329 the transcript read gives the stream of the turn and the attempts that resumed after a restart", () =>
  withJournal(async (directory, folder) => {
    await mkdir(join(folder, "attempt-2"), { recursive: true });
    await writeFile(
      join(folder, "turn.jsonl"),
      '{"type":"x"}\n\n{"type":"y"}\n',
    );
    await writeFile(
      join(folder, "attempt-1.json"),
      JSON.stringify({ attempt: 1 }),
    );
    await writeFile(
      join(folder, "attempt-2.json"),
      JSON.stringify({ attempt: 2, resumedAfter: "daemon-restart" }),
    );
    await writeFile(
      join(folder, "started.json"),
      JSON.stringify({ attempt: 3, resumedAfter: "daemon-restart" }),
    );
    await writeFile(join(folder, "attempt-4.json"), "{");
    assert.deepEqual(await transcriptFiles(directory)(operationId), {
      text: '{"type":"x"}\n\n{"type":"y"}\n',
      attempts: [
        { attempt: 1, resumed: false },
        { attempt: 2, resumed: true },
        { attempt: 3, resumed: true },
      ],
    });
  }));

await test("CLV-329 the transcript read gives an empty stream before the turn writes its first line", () =>
  withJournal(async (directory, folder) => {
    await mkdir(folder, { recursive: true });
    assert.deepEqual(await transcriptFiles(directory)(operationId), {
      text: "",
      attempts: [],
    });
  }));

await test("CLV-329 the transcript read gives nothing when the journal folder of the turn is not kept", () =>
  withJournal(async (directory) => {
    assert.equal(await transcriptFiles(directory)(operationId), undefined);
  }));
