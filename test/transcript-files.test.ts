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
    assert.deepEqual(await transcriptFiles(directory)(operationId, 0), {
      text: '{"type":"x"}\n\n{"type":"y"}\n',
      size: 27,
      attempts: [
        { attempt: 1, resumed: false },
        { attempt: 2, resumed: true },
        { attempt: 3, resumed: true },
      ],
      prompts: [],
    });
  }));

await test("CLV-329 the transcript read gives an empty stream before the turn writes its first line", () =>
  withJournal(async (directory, folder) => {
    await mkdir(folder, { recursive: true });
    assert.deepEqual(await transcriptFiles(directory)(operationId, 0), {
      text: "",
      size: 0,
      attempts: [],
      prompts: [],
    });
  }));

await test("CLV-329 the transcript read gives nothing when the journal folder of the turn is not kept", () =>
  withJournal(async (directory) => {
    assert.equal(await transcriptFiles(directory)(operationId, 0), undefined);
  }));

await test("CLV-329 the transcript read ignores an attempt record without an attempt number and fails when the journal folder is a file", () =>
  withJournal(async (directory, folder) => {
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "attempt-1.json"),
      JSON.stringify({ phase: "running" }),
    );
    assert.deepEqual(
      (await transcriptFiles(directory)(operationId, 0))?.attempts,
      [],
    );
    await rm(folder, { recursive: true });
    await writeFile(folder, "not a folder");
    await assert.rejects(transcriptFiles(directory)(operationId, 0), {
      code: "ENOTDIR",
    });
  }));

await test("CLV-329 the transcript read gives the stream after a byte offset and the size of the whole stream", () =>
  withJournal(async (directory, folder) => {
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "turn.jsonl"), "één\ntwee\n");
    const read = transcriptFiles(directory);
    assert.deepEqual(await read(operationId, 6), {
      text: "twee\n",
      size: 11,
      attempts: [],
      prompts: [],
    });
    assert.deepEqual(await read(operationId, 11), {
      text: "",
      size: 11,
      attempts: [],
      prompts: [],
    });
  }));

await test("CLV-333 the transcript read gives the complete prompt lines of the attempts, and a turn without a prompt file gives no prompts", () =>
  withJournal(async (directory, folder) => {
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "turn.jsonl"), "");
    const read = transcriptFiles(directory);
    assert.deepEqual((await read(operationId, 0))?.prompts, []);
    await writeFile(
      join(folder, "turn-prompts.jsonl"),
      `${JSON.stringify({ prompt: "Fix it." })}\n${JSON.stringify({ prompt: 3 })}\nnot json\nnull\n7\n${JSON.stringify({ prompt: "Go on." })}\n{"prompt":"cut`,
    );
    assert.deepEqual((await read(operationId, 0))?.prompts, [
      "Fix it.",
      "",
      "",
      "",
      "",
      "Go on.",
    ]);
    await rm(join(folder, "turn-prompts.jsonl"));
    await mkdir(join(folder, "turn-prompts.jsonl"));
    await assert.rejects(read(operationId, 0), { code: "EISDIR" });
  }));
