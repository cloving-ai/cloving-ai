import assert from "node:assert/strict";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { located } from "../src/daemon/operation-journal.ts";
import { transcriptFiles } from "../src/daemon/transcript-files.ts";
import { remembered } from "../src/service/transcript-handler.ts";
import { emptyTranscript } from "../src/turn-transcript.ts";
import { operationOf } from "./effect-fixture.ts";
import { untilStates } from "./service-effect-fixture.ts";
import { call, field, items, withHarness } from "./service-fixture.ts";
import { reportTurn, workerScene } from "./worker-report-fixture.ts";
import { requested } from "./service-effect-fixture.ts";

type Scene = Awaited<ReturnType<typeof workerScene>>;

const said = (words: string): string =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text: words }] },
  });

function texts(reply: Readonly<Record<string, unknown>>): unknown[] {
  return items(field(reply, "entries")).map((entry) => field(entry, "text"));
}

async function journal(scene: Scene, text: string | null): Promise<string> {
  const operationId = operationOf(scene.runId, { round: 1 });
  const root = dirname(scene.harness.runtimeDirectory);
  const { folder } = located(join(root, "journal"), operationId);
  if (text === null) return operationId;
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "turn.jsonl"), text);
  return operationId;
}

async function openTurn(
  harness: Parameters<Parameters<typeof withHarness>[0]>[0],
  offsets: number[] = [],
): Promise<Scene> {
  const scene = await workerScene(harness);
  await scene.service.close();
  const root = dirname(harness.runtimeDirectory);
  const read = transcriptFiles(root);
  const service = await harness.start({
    ...scene.options,
    turnTranscript: {
      read: (operationId, from) => {
        offsets.push(from);
        return read(operationId, from);
      },
      privateTexts: ["Acme Secret"],
      cache: new Map(),
    },
  });
  const reopened = { ...scene, service };
  await requested(reopened, {
    commandId: `request-${scene.runId}-1`,
    round: 1,
    capability: "claude",
  });
  await untilStates(reopened, ["running"]);
  return reopened;
}

function transcript(
  scene: Scene,
  parameters: Readonly<Record<string, unknown>>,
) {
  return call(scene.harness, {
    operation: "transcript",
    parameters: { runId: scene.runId, ...parameters },
  });
}

await test("CLV-329 the transcript operation gives the masked entries of an open agent turn after a position", () =>
  withHarness(async (harness) => {
    const scene = await openTurn(harness);
    const operationId = await journal(
      scene,
      `${said("One for Acme Secret.")}\n${said("Two.")}\n${said("Three.")}\n{"type":"assis`,
    );
    const first = await transcript(scene, { operationId });
    assert.equal(field(first, "kind"), "transcript");
    assert.equal(field(first, "runId"), scene.runId);
    assert.equal(field(first, "operationId"), operationId);
    assert.equal(field(first, "open"), true);
    assert.equal(field(first, "nextAfter"), 3);
    assert.deepEqual(
      items(field(first, "entries")).map((entry) => field(entry, "text")),
      ["One for [hidden].", "Two.", "Three."],
    );
    const later = await transcript(scene, { operationId, after: 2 });
    assert.deepEqual(
      items(field(later, "entries")).map((entry) => field(entry, "position")),
      [3],
    );
  }));

await test("CLV-329 the transcript of an ended turn is closed and has its last line", () =>
  withHarness(async (harness) => {
    const scene = await openTurn(harness);
    const operationId = await journal(scene, `${said("One.")}\nnot json`);
    await reportTurn(scene, { round: 1, result: "{}" });
    const ended = await transcript(scene, { operationId });
    assert.equal(field(ended, "open"), false);
    assert.deepEqual(
      items(field(ended, "entries")).map((entry) => field(entry, "kind")),
      ["assistant", "notice"],
    );
  }));

await test("CLV-329 a turn without a journal folder has an empty transcript while it works, and a transcript that is not kept after it ends", () =>
  withHarness(async (harness) => {
    const scene = await openTurn(harness);
    const operationId = await journal(scene, null);
    const working = await transcript(scene, { operationId, after: 4 });
    assert.deepEqual(field(working, "entries"), []);
    assert.equal(field(working, "nextAfter"), 4);
    assert.equal(field(working, "open"), true);
    await reportTurn(scene, { round: 1, result: "{}" });
    const ended = await transcript(scene, { operationId });
    assert.equal(field(ended, "code"), "transcript-not-kept");
  }));

await test("CLV-329 the transcript operation refuses an unknown turn, invalid parameters and a service without a journal read", () =>
  withHarness(async (harness) => {
    const scene = await openTurn(harness);
    const unknown = await transcript(scene, { operationId: "other" });
    assert.equal(field(unknown, "code"), "unknown-turn");
    for (const parameters of [
      { operationId: "" },
      { operationId: "other", after: -1 },
      { operationId: "other", after: 1.5 },
      { runId: "bad id", operationId: "other" },
    ]) {
      const refused = await transcript(scene, parameters);
      assert.equal(
        field(refused, "code"),
        "invalid-request",
        JSON.stringify(parameters),
      );
    }
    await scene.service.close();
    const plain = await harness.start(scene.options);
    const unavailable = await transcript(
      { ...scene, service: plain },
      { operationId: operationOf(scene.runId, { round: 1 }) },
    );
    assert.equal(field(unavailable, "code"), "transcript-unavailable");
  }));

await test("CLV-329 the transcript operation reads only the bytes after the complete lines of its last read, and reads again from the start when the stream is shorter", () =>
  withHarness(async (harness) => {
    const offsets: number[] = [];
    const scene = await openTurn(harness, offsets);
    const head = `${said("One.")}\n`;
    const operationId = await journal(scene, `${head}{"type":"assis`);
    assert.deepEqual(texts(await transcript(scene, { operationId })), ["One."]);
    const folder = located(
      join(dirname(harness.runtimeDirectory), "journal"),
      operationId,
    ).folder;
    await appendFile(
      join(folder, "turn.jsonl"),
      `${said("Two.").slice('{"type":"assis'.length)}\n${said("Three.")}\n`,
    );
    const later = await transcript(scene, { operationId, after: 1 });
    assert.deepEqual(texts(later), ["Two.", "Three."]);
    assert.deepEqual(offsets, [0, Buffer.byteLength(head)]);
    await writeFile(join(folder, "turn.jsonl"), `${said("New.")}\n`);
    assert.deepEqual(texts(await transcript(scene, { operationId })), ["New."]);
  }));

await test("CLV-329 the transcript of a refused agent turn is closed", () =>
  withHarness(async (harness) => {
    const scene = await openTurn(harness);
    const refused = await requested(scene, {
      commandId: `request-${scene.runId}-2`,
      round: 2,
      capability: "claude",
      units: 100_000,
    });
    assert.equal(refused.operation?.status, "refused");
    const reply = await transcript(scene, {
      operationId: operationOf(scene.runId, { round: 2 }),
    });
    assert.equal(field(reply, "code"), "transcript-not-kept");
  }));

await test("CLV-329 the transcript cache keeps the parsed entries of the last eight turns", () => {
  const cache = new Map([["old", emptyTranscript]]);
  for (const name of ["a", "b", "c", "d", "e", "f", "g", "old", "h"])
    remembered(cache, { operationId: name, parsed: emptyTranscript });
  assert.deepEqual(
    [...cache.keys()],
    ["b", "c", "d", "e", "f", "g", "old", "h"],
  );
});

await test("CLV-364 earlier transcript pages start just before the requested sparse position", () =>
  withHarness(async (harness) => {
    const scene = await openTurn(harness);
    const operationId = await journal(
      scene,
      Array.from({ length: 450 }, (_, index) =>
        JSON.stringify({
          type: "assistant",
          message: {
            content: [{ type: "text", text: `Entry ${String(index)}` }],
          },
          replaceId: `block-${String(Math.floor(index / 2))}`,
        }),
      ).join("\n") + "\n",
    );
    const first = await transcript(scene, { operationId, before: 451 });
    const entries = items(field(first, "entries"));
    assert.equal(entries.length, 200);
    assert.equal(field(entries[0], "position"), 52);
    assert.equal(field(entries.at(-1), "position"), 450);
    const earlier = await transcript(scene, { operationId, before: 52 });
    assert.equal(items(field(earlier, "entries")).length, 25);
    assert.equal(field(earlier, "hasEarlier"), false);
    for (const before of [-1, 0, 1.5, "bad"])
      assert.equal(
        field(await transcript(scene, { operationId, before }), "code"),
        "invalid-request",
      );
  }));
