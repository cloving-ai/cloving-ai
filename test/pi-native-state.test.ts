import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { piResumeSession, preparedPiSession } from "../src/daemon/pi-resume.ts";
import { createPiSession } from "../src/daemon/pi-session.ts";
import { writeRecord } from "../src/daemon/operation-journal.ts";
import { piMessage } from "./pi-fixture.ts";
import { withScene, type Scene } from "./claude-worker-fixture.ts";

async function checkpoint(scene: Scene) {
  const folder = join(scene.directory, "native-state");
  mkdirSync(folder);
  const session = await createPiSession({
    folder,
    directory: scene.repository,
  });
  assert.notEqual(typeof session, "string");
  if (typeof session === "string") throw new Error(session);
  const header = {
    type: "session",
    version: 3,
    id: session.id,
    cwd: session.cwd,
    timestamp: session.timestamp,
  };
  const message = { type: "message", message: piMessage() };
  appendFileSync(session.path, JSON.stringify(message) + "\n");
  const launch = {
    processId: 1_000_000_000,
    processStart: "unowned",
    marker: "unowned",
    output: join(folder, "output"),
    exit: join(folder, "exit"),
    configuration: join(folder, "config"),
    offset: 0,
  };
  writeFileSync(
    launch.exit,
    JSON.stringify({ exitCode: 0, endedAt: new Date().toISOString() }),
  );
  const entry = {
    harness: "pi",
    attempt: 1,
    operationId: "operation",
    worktree: scene.repository,
    piSession: session,
    launch,
    endedAt: new Date().toISOString(),
    turns: 1,
  };
  await writeRecord(folder, { name: "attempt-1.json", value: entry });
  return {
    folder,
    session,
    header,
    entry,
    request: { folder, started: entry, intent: { operationId: "operation" } },
  };
}

await test("CLV-365 native resume requires a confirmed ended invocation before using its checkpoint", async () => {
  for (const change of [
    undefined,
    { endedAt: undefined },
    { launch: undefined },
  ])
    await withScene(async (scene) => {
      const state = await checkpoint(scene);
      const path = join(state.folder, "attempt-1.json");
      rmSync(path);
      if (change !== undefined)
        writeFileSync(path, JSON.stringify({ ...state.entry, ...change }));
      assert.equal(
        await piResumeSession(state.request),
        "pi-prior-result-uncertain",
      );
    });
});

await test("CLV-365 native resume refuses an ended claim whose process has no exit evidence", () =>
  withScene(async (scene) => {
    const state = await checkpoint(scene);
    rmSync(state.entry.launch.exit);
    assert.equal(
      await piResumeSession(state.request),
      "pi-prior-result-uncertain",
    );
  }));

await test("CLV-365 a missing checkpoint after confirmed exit refuses native continuation", () =>
  withScene(async (scene) => {
    const state = await checkpoint(scene);
    rmSync(state.session.path);
    assert.equal(
      await piResumeSession(state.request),
      "pi-session-state-missing",
    );
  }));

await test("CLV-365 checkpoint changes after selection cannot be copied into a native invocation", async () => {
  for (const changed of [
    "null\n",
    "{broken}\n",
    JSON.stringify({ type: "session", version: 2 }) + "\n",
    JSON.stringify({ type: "session", version: 3, id: "foreign" }) + "\n",
  ])
    await withScene(async (scene) => {
      const state = await checkpoint(scene);
      writeFileSync(state.session.path, changed);
      const result = await preparedPiSession({
        folder: join(scene.directory, "next"),
        directory: scene.repository,
        previous: state.session,
      });
      assert.ok(typeof result === "string");
      assert.ok(
        ["pi-session-state-invalid", "pi-session-ownership-conflict"].includes(
          result,
        ),
      );
    });
});

await test("CLV-365 a directory cannot replace a selected native checkpoint", () =>
  withScene(async (scene) => {
    const state = await checkpoint(scene);
    rmSync(state.session.path);
    mkdirSync(state.session.path);
    assert.equal(
      await preparedPiSession({
        folder: join(scene.directory, "next"),
        directory: scene.repository,
        previous: state.session,
      }),
      "pi-session-state-invalid",
    );
  }));

await test("CLV-365 unavailable native resume storage returns an explicit refusal", () =>
  withScene(async (scene) => {
    const state = await checkpoint(scene);
    const blocked = join(scene.directory, "blocked");
    writeFileSync(blocked, "file");
    assert.equal(
      await preparedPiSession({
        folder: join(blocked, "next"),
        directory: scene.repository,
        previous: state.session,
      }),
      "pi-session-state-unavailable",
    );
  }));

await test("CLV-365 native resume refuses completed history without a stable response identity", () =>
  withScene(async (scene) => {
    const state = await checkpoint(scene);
    const message = piMessage({ responseId: undefined, timestamp: undefined });
    writeFileSync(
      state.session.path,
      JSON.stringify(state.header) +
        "\n" +
        JSON.stringify({ type: "message", message }) +
        "\n",
    );
    assert.equal(
      await piResumeSession(state.request),
      "pi-session-history-missing",
    );
  }));

await test("CLV-365 a later native checkpoint retains earlier invocation history", () =>
  withScene(async (scene) => {
    const state = await checkpoint(scene);
    appendFileSync(
      state.session.path,
      JSON.stringify({ type: "model_change" }) +
        "\n" +
        JSON.stringify({
          type: "message",
          message: piMessage({ responseId: "second", timestamp: 2 }),
        }) +
        "\n",
    );
    const piSession = {
      ...state.session,
      historicalResponses: ['["test-provider","test-model","response-1"]'],
    };
    const entry = { ...state.entry, piSession, turns: undefined };
    await writeRecord(state.folder, { name: "attempt-1.json", value: entry });
    assert.deepEqual(
      await piResumeSession({ ...state.request, started: entry }),
      piSession,
    );
  }));
