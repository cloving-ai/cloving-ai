import assert from "node:assert/strict";
import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { commandEffects } from "../src/daemon/command-journal.ts";
import { until } from "./claude-worker-fixture.ts";
import {
  commandIntent,
  signal,
  withCommandScene,
} from "./command-worker-fixture.ts";

await test("CLV-178 command status caches finished exit and duration metadata instead of reloading stdout", () =>
  withCommandScene(async (scene) => {
    const worker = scene.worker('process.stdout.write("x".repeat(1048576));');
    await worker.deliver(commandIntent(), signal);
    await until(() => scene.reports.length === 1);
    await worker.close();
    const result: unknown = JSON.parse(scene.recorded("result.json"));
    const duration: unknown = Reflect.get(
      Object(result),
      "durationMilliseconds",
    );
    const effects = commandEffects(scene.journal);
    const effect = {
      operationId: "operation-1",
      name: "scan",
      state: "completed",
      exitCode: null,
      durationMilliseconds: null,
    };
    const read = filesystem.readFile;
    const resultReads: string[] = [];
    Object.defineProperty(filesystem, "readFile", {
      value: (file: unknown, ...args: readonly unknown[]): unknown => {
        if (String(file).endsWith("/result.json"))
          resultReads.push(String(file));
        return Reflect.apply(read, filesystem, [file, ...args]);
      },
    });
    syncBuiltinESMExports();
    try {
      for (let count = 0; count < 3; count += 1) {
        assert.deepEqual(await effects([effect]), [
          {
            ...effect,
            exitCode: 0,
            durationMilliseconds: duration,
          },
        ]);
      }
      assert.equal(resultReads.length, 1);
    } finally {
      filesystem.readFile = read;
      syncBuiltinESMExports();
    }
  }));

await test("CLV-178 status refreshes unfinished command metadata and a fresh reader retains completed journal values", () =>
  withCommandScene(async (scene) => {
    const effects = commandEffects(scene.journal);
    const effect = {
      operationId: "operation-1",
      name: "scan",
      state: "running",
      exitCode: null,
      durationMilliseconds: null,
    };
    assert.deepEqual(await effects([effect]), [effect]);
    const worker = scene.worker("process.exitCode = 7;");
    await worker.deliver(commandIntent(), signal);
    await until(() => scene.reports.length === 1);
    const expected = { ...effect, state: "failed", exitCode: 7 };
    const completed = await effects([expected]);
    assert.equal(completed[0]?.state, "failed");
    assert.equal(completed[0].exitCode, 7);
    assert.equal(typeof completed[0].durationMilliseconds, "number");
    const fresh = commandEffects(scene.journal);
    assert.deepEqual(await fresh([expected]), completed);
    assert.deepEqual(await effects([{ ...effect, state: "stopped" }]), [
      { ...completed[0], state: "stopped" },
    ]);
  }));
