import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { located } from "../src/daemon/operation-journal.ts";
import { transcriptFiles } from "../src/daemon/transcript-files.ts";
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
  options: { readonly port: boolean } = { port: true },
): Promise<Scene> {
  const scene = await workerScene(harness);
  await scene.service.close();
  const root = dirname(harness.runtimeDirectory);
  const service = await harness.start({
    ...scene.options,
    ...(options.port
      ? {
          turnTranscript: {
            read: transcriptFiles(root),
            privateTexts: ["Acme Secret"],
          },
        }
      : {}),
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
