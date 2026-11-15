import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createPiSession, ownedPiSession } from "../src/daemon/pi-session.ts";
import { withScene, type Scene } from "./claude-worker-fixture.ts";
import { stopChild } from "./stop-child.ts";
import { testMilliseconds } from "./test-timing.ts";

async function sessionState(scene: Scene, attempt = 1) {
  const folder =
    attempt === 1
      ? scene.directory
      : join(scene.directory, `attempt-${String(attempt)}`);
  mkdirSync(folder, { recursive: true });
  const session = await createPiSession({
    folder,
    directory: scene.repository,
  });
  assert.ok(typeof session !== "string");
  const entry = { attempt, piSession: session };
  const started = {
    ...entry,
    operationId: "operation-1",
    worktree: scene.repository,
  };
  return {
    session,
    request: {
      folder: scene.directory,
      started,
      entry,
      operationId: "operation-1",
    },
  };
}

await test("CLV-365 a Pi session FIFO refuses without blocking recovery", () =>
  withScene(async (scene) => {
    const session = await createPiSession({
      folder: scene.directory,
      directory: scene.repository,
    });
    assert.ok(typeof session !== "string");
    const entry = { attempt: 1, piSession: session };
    const started = {
      ...entry,
      operationId: "operation-1",
      worktree: scene.repository,
    };
    rmSync(session.path);
    execFileSync("mkfifo", [session.path]);
    const request = {
      folder: scene.directory,
      started,
      entry,
      operationId: "operation-1",
    };
    const module = new URL("../src/daemon/pi-session.ts", import.meta.url).href;
    const source = `import { ownedPiSession } from ${JSON.stringify(module)}; console.log(await ownedPiSession(JSON.parse(process.argv[1])));`;
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", source, JSON.stringify(request)],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const ended = new Promise((resolve) => child.once("close", resolve));
    const timeout = new AbortController();
    try {
      const result = await Promise.race([
        ended,
        delay(testMilliseconds(3000), "recovery-blocked", {
          signal: timeout.signal,
        }),
      ]);
      assert.notEqual(result, "recovery-blocked");
      assert.equal(output.trim(), "pi-session-state-invalid");
    } finally {
      timeout.abort();
      await stopChild(child, { graceMilliseconds: 50 });
    }
  }));

await test("CLV-365 missing and conflicting Pi records cannot establish session ownership", () =>
  withScene(async (scene) => {
    const { request } = await sessionState(scene);
    for (const started of [
      undefined,
      {},
      { ...request.started, piSession: undefined },
    ])
      assert.equal(
        await ownedPiSession({ ...request, started }),
        "pi-session-state-missing",
      );
    for (const entry of [
      { attempt: 1 },
      {
        ...request.entry,
        piSession: { ...request.entry.piSession, id: "another-owner" },
      },
    ])
      assert.equal(
        await ownedPiSession({ ...request, entry }),
        "pi-session-ownership-conflict",
      );
  }));

await test("CLV-365 Pi refuses incomplete, foreign and unsupported session headers", () =>
  withScene(async (scene) => {
    const { session, request } = await sessionState(scene);
    const header = {
      type: "session",
      version: 3,
      id: session.id,
      cwd: session.cwd,
      timestamp: session.timestamp,
    };
    for (const text of ["", "null\n"]) {
      writeFileSync(session.path, text);
      assert.equal(await ownedPiSession(request), "pi-session-state-invalid");
    }
    for (const fields of [{ type: "foreign" }, { version: 2 }]) {
      writeFileSync(
        session.path,
        JSON.stringify({ ...header, ...fields }) + "\n",
      );
      assert.equal(
        await ownedPiSession(request),
        "pi-session-ownership-conflict",
      );
    }
    rmSync(dirname(session.path), { recursive: true });
    assert.equal(await ownedPiSession(request), "pi-session-state-missing");
  }));

await test("CLV-365 a recorded later Pi attempt selects only its own private state", () =>
  withScene(async (scene) => {
    const { session, request } = await sessionState(scene, 2);
    assert.deepEqual(await ownedPiSession(request), session);
  }));

await test("CLV-365 unavailable private storage returns a Pi refusal before launch", () =>
  withScene(async (scene) => {
    assert.equal(
      await createPiSession({
        folder: join(scene.directory, "absent"),
        directory: scene.repository,
      }),
      "pi-session-state-unavailable",
    );
  }));

await test("CLV-365 matching malformed Pi identities refuse before attachment", () =>
  withScene(async (scene) => {
    const session = await createPiSession({
      folder: scene.directory,
      directory: scene.repository,
    });
    assert.ok(typeof session !== "string");
    for (const fields of [
      { id: 17 },
      { id: "" },
      { cwd: "" },
      { timestamp: null },
      { timestamp: "invalid" },
    ]) {
      const changed = { ...session, ...fields };
      writeFileSync(
        session.path,
        JSON.stringify({ ...changed, type: "session", version: 3 }) + "\n",
      );
      const entry = { attempt: 1, piSession: changed };
      const started = {
        ...entry,
        operationId: "operation-1",
        worktree: changed.cwd,
      };
      const reply = await ownedPiSession({
        folder: scene.directory,
        started,
        entry,
        operationId: "operation-1",
      });
      assert.equal(reply, "pi-session-state-invalid");
    }
  }));
