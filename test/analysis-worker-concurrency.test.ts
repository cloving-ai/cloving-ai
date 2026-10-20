import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { corpus, importId, manifest, sidecar } from "./chats-worker-fixture.ts";
import {
  alive,
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
      const fetched = join(scene.directory, "token-fetched");
      process.env["CLOVING_ANALYSIS_TOKEN_COMMAND"] = JSON.stringify([
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(fetched)}, "fetched"); process.stdout.write("synthetic-token")`,
      ]);
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
      assert.equal(existsSync(fetched), false);
    } finally {
      delayed.resolve(undefined);
      restore();
    }
  }));

for (const cancellation of ["delivery abort", "worker close"]) {
  await test(
    "CLV-118 stops an in-flight token command on " + cancellation,
    () =>
      withScene(async (scene) => {
        const restore = installAnalysisCli(scene, { reply: "{}" });
        const processFile = join(scene.directory, "token-process");
        writeFileSync(processFile, "");
        process.env["CLOVING_ANALYSIS_TOKEN_COMMAND"] = JSON.stringify([
          "env",
          "-u",
          "NODE_V8_COVERAGE",
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(processFile)}, String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)`,
        ]);
        const worker = scene.worker("bare", {
          workflowId,
          document: () => Promise.resolve(JSON.stringify({ snapshot })),
        });
        const controller = new AbortController();
        const delivery = worker.deliver(analysis, controller.signal);
        let processId = 0;
        try {
          await until(() => {
            processId = Number(readFileSync(processFile, "utf8"));
            return Number.isSafeInteger(processId) && processId > 0;
          });
          assert.ok(alive(processId));
          const closing =
            cancellation === "worker close" ? worker.close() : undefined;
          if (cancellation === "delivery abort") controller.abort();
          const settled = Promise.all([
            delivery,
            closing,
            until(() => !alive(processId)),
          ]);
          assert.equal(
            await Promise.race([
              settled.then(() => "settled"),
              delay(2000, "pending"),
            ]),
            "settled",
          );
          assert.deepEqual(await delivery, {
            kind: "failed",
            reason: "analysis-turn-failed",
          });
          assert.equal(scene.turns().length, 0);
          assert.deepEqual(scene.reports, []);
          await worker.close();
          assert.deepEqual(await worker.deliver(analysis, signal), {
            kind: "failed",
            reason: "analysis-turn-failed",
          });
        } finally {
          if (processId > 0 && alive(processId))
            process.kill(processId, "SIGKILL");
          await worker.close();
          restore();
        }
      }),
  );
}
