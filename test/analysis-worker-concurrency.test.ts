import assert from "node:assert/strict";
import { test } from "node:test";
import { corpus, importId, manifest, sidecar } from "./chats-worker-fixture.ts";
import {
  installAnalysisCli,
  intent,
  until,
  withScene,
} from "./claude-worker-fixture.ts";

const signal = new AbortController().signal;
const analysis = intent({ method: "run-turn:analyze-chats", target: importId });
const snapshot = {
  importId,
  corpus,
  redaction: JSON.stringify(manifest),
  structure: JSON.stringify(sidecar),
};
const workflowId = () => Promise.resolve("analyze-chats");

await test("CLV-116 concurrent deliveries cannot launch a delayed replacement after durable completion", () =>
  withScene(async (scene) => {
    const restore = installAnalysisCli(scene, { reply: "{}" });
    const delayed = Promise.withResolvers<undefined>();
    let reads = 0;
    try {
      const worker = scene.worker("bare", {
        workflowId,
        document: async () => {
          reads += 1;
          if (reads === 2) await delayed.promise;
          return JSON.stringify({ snapshot });
        },
      });
      const first = worker.deliver(analysis, signal);
      await until(() => reads === 1);
      const second = worker.deliver(analysis, signal);
      await first;
      await until(() => scene.reports.length === 1);
      delayed.resolve(undefined);
      await second;
      await worker.close();
      assert.equal(reads, 1);
      assert.equal(scene.turns().length, 1);
    } finally {
      delayed.resolve(undefined);
      restore();
    }
  }));

await test("CLV-116 close during preparation prevents a later launch", () =>
  withScene(async (scene) => {
    const delayed = Promise.withResolvers<undefined>();
    const restore = installAnalysisCli(scene, { reply: "{}" });
    let read = false;
    try {
      const worker = scene.worker("bare", {
        workflowId,
        document: async () => {
          read = true;
          await delayed.promise;
          return JSON.stringify({ snapshot });
        },
      });
      const delivery = worker.deliver(analysis, signal);
      await until(() => read);
      const closing = worker.close();
      delayed.resolve(undefined);
      assert.deepEqual(await delivery, {
        kind: "failed",
        reason: "analysis-turn-failed",
      });
      await closing;
      assert.equal(scene.turns().length, 0);
    } finally {
      delayed.resolve(undefined);
      restore();
    }
  }));
