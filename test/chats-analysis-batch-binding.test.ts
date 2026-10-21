import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { record } from "../src/protocol.ts";
import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import {
  withAnalysis,
  assertRefused,
  cycleId,
  importId,
} from "./chats-worker-fixture.ts";
import { batchCorpus } from "./analyze-chats-batches-fixture.ts";
import { batch } from "./chats-analysis-merge-fixture.ts";

await test(
  "CLV-159 unbound batch positions and changed evidence cannot advance checkpoint coverage",
  chatPlatformScenario(async () =>
    withAnalysis(async (fixture) => {
      await fixture.write("redacted.jsonl", batchCorpus());
      const read = await fixture.deliver("read-analysis");
      assert.ok("result" in read);
      const data = record(JSON.parse(read.result));
      assert.ok(data);
      const binding = record(data["batch"]);
      const snapshot = record(data["snapshot"]);
      assert.ok(binding);
      assert.ok(snapshot);
      const base = {
        importId,
        cycleId,
        batch: binding,
        reply: JSON.stringify(batch()),
      };
      const [folder] = (await fixture.files()).filter((name) =>
        name.startsWith("capture-"),
      );
      assert.ok(folder);
      const before = await readdir(join(fixture.directory, folder));
      for (const changed of [
        { batch: { ...binding, capturedDigest: "a".repeat(64) } },
        { batch: { ...binding, batchIndex: "0" } },
        { batch: { ...binding, batchIndex: 4 } },
        { batch: { ...binding, nextRecordIndex: 16 } },
        { batch: null },
        { snapshot: { ...snapshot, corpus: "changed" } },
      ]) {
        fixture.payloads.set(
          "save-analysis",
          JSON.stringify({ ...base, ...changed }),
        );
        assertRefused(
          await fixture.deliver("save-analysis"),
          "analysis-output-failed",
        );
        assert.deepEqual(
          await readdir(join(fixture.directory, folder)),
          before,
        );
      }
      const unbound = { importId, cycleId, reply: base.reply };
      fixture.payloads.set("save-analysis", JSON.stringify(unbound));
      assertRefused(
        await fixture.deliver("save-analysis"),
        "analysis-output-failed",
      );
      assert.deepEqual(await readdir(join(fixture.directory, folder)), before);
      fixture.payloads.set("save-analysis", JSON.stringify(base));
      const saved = await fixture.deliver("save-analysis");
      assert.equal(saved.kind, "completed");
      assert.deepEqual(await fixture.deliver("save-analysis"), saved);
      fixture.payloads.set(
        "save-analysis",
        JSON.stringify({ ...base, snapshot }),
      );
      assert.deepEqual(await fixture.deliver("save-analysis"), saved);
    }),
  ),
);
