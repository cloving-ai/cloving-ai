import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  candidate,
  itemAt,
  questionCandidate,
} from "./chats-analysis-fixture.ts";
import { analysisCodes } from "../src/chats/analysis-contract.ts";
import {
  withAnalysis,
  assertRefused,
  cycleId,
  analysisIntent,
} from "./chats-worker-fixture.ts";

for (const mode of ["deliver", "reconcile", "stop"] as const) {
  await test(`CLV-117 ${mode} cannot finalize an unresolved analysis question`, async () => {
    await withAnalysis(async (fixture) => {
      const payload = await fixture.prepare();
      const value = questionCandidate();
      value.openQuestion.description =
        "/synthetic/notes.txt operator@example.invalid @synthetic /question\\w+/g";
      fixture.payloads.set(
        "save-analysis",
        JSON.stringify({ ...payload, reply: JSON.stringify(value) }),
      );
      const before = await fixture.files();
      const result = await fixture.worker[mode](
        analysisIntent("save-analysis"),
        new AbortController().signal,
      );
      assertRefused(result, "analysis-input-refused");
      assert.deepEqual(result, {
        kind: "failed",
        reason: "analysis-input-refused",
        result: JSON.stringify({
          kind: "blocked",
          codes: ["analysis-input-refused"],
        }),
      });
      assert.deepEqual(await fixture.files(), before);
    });
  });
}

await test("CLV-115 save validation uses captured evidence after files mutate", async () => {
  await withAnalysis(async (f) => {
    await f.prepare();
    await f.write("structure.json", {});
    await f.write("redacted.jsonl", "changed");
    assert.equal((await f.deliver("save-analysis")).kind, "completed");
  });
});

for (const reply of [
  "{",
  JSON.stringify({ schemaVersion: 8 }),
  JSON.stringify({ ...candidate(), authority: true }),
]) {
  await test(`CLV-115 refuses invalid reply ${reply.slice(0, 40)} without outputs`, async () => {
    await withAnalysis(async (f) => {
      const payload = await f.prepare();
      f.payloads.set("save-analysis", JSON.stringify({ ...payload, reply }));
      const result = await f.deliver("save-analysis");
      const codes = [
        "analysis-invalid-json",
        "unknown-version",
        "authority-field",
      ];
      const code =
        codes[reply === "{" ? 0 : Number(reply.includes('"authority"')) + 1];
      assert.ok(code);
      assertRefused(result, code);
      assert.ok(
        (await f.files()).every((name) => !/^(proposal|analysis)-/.test(name)),
      );
    });
  });
}

await test("CLV-115 refusal retains unique codes in validator declaration order", async () => {
  await withAnalysis(async (f) => {
    const payload = await f.prepare();
    const bad = candidate();
    itemAt(bad.process.stages).sourceRefs = [];
    itemAt(bad.process.loops).maxIterations = 0;
    itemAt(bad.process.stages, 1).sourceRefs = [];
    f.payloads.set(
      "save-analysis",
      JSON.stringify({ ...payload, reply: JSON.stringify(bad) }),
    );
    const result = await f.deliver("save-analysis");
    assertRefused(result, "missing-source");
    assert.ok("result" in result && typeof result.result === "string");
    const codes = analysisCodes.filter((code) =>
      ["missing-source", "invalid-loop-limit"].includes(code),
    );
    assert.deepEqual(JSON.parse(result.result), { kind: "blocked", codes });
  });
});

await test("CLV-115 rejects serialized save payload overflow", async () => {
  await withAnalysis(async (f) => {
    const payload = await f.prepare();
    f.payloads.set(
      "save-analysis",
      JSON.stringify({ ...payload, reply: " ".repeat(65_536) + payload.reply }),
    );
    assertRefused(await f.deliver("save-analysis"), "analysis-too-large");
  });
});

await test("CLV-115 duplicate save and restart retain bytes, inode and receipt", async () => {
  await withAnalysis(async (f) => {
    await f.prepare();
    const first = await f.deliver("save-analysis");
    const path = join(f.directory, `analysis-${cycleId}.json`);
    const before = await stat(path);
    assert.deepEqual(await f.deliver("save-analysis"), first);
    assert.equal((await stat(path)).ino, before.ino);
    assert.deepEqual(
      await f.worker.reconcile(
        analysisIntent("save-analysis"),
        new AbortController().signal,
      ),
      first,
    );
  });
});

await test("CLV-115 matching proposal without marker finishes exactly once", async () => {
  await withAnalysis(async (f) => {
    await f.prepare();
    const first = await f.deliver("save-analysis");
    const path = join(f.directory, `analysis-${cycleId}.json`);
    await rm(path);
    const proposal = join(f.directory, `proposal-${cycleId}.txt`);
    const before = await stat(proposal);
    assert.deepEqual(await f.deliver("save-analysis"), first);
    assert.equal((await stat(proposal)).ino, before.ino);
  });
});

for (const name of [`proposal-${cycleId}.txt`, `analysis-${cycleId}.json`]) {
  for (const text of ["", "conflicting"]) {
    await test(`CLV-115 leaves incomplete or conflicting ${name} unchanged`, async () => {
      await withAnalysis(async (f) => {
        await f.prepare();
        assert.equal((await f.deliver("save-analysis")).kind, "completed");
        await f.write(name, text);
        assertRefused(
          await f.deliver("save-analysis"),
          "analysis-output-failed",
        );
        assert.equal(await readFile(join(f.directory, name), "utf8"), text);
      });
    });
  }
}

for (const text of ["", "conflicting"]) {
  await test(`CLV-115 refuses a private incomplete proposal without marker (${String(text.length)} bytes)`, async () => {
    await withAnalysis(async (f) => {
      await f.prepare();
      const name = `proposal-${cycleId}.txt`;
      await f.write(name, text);
      assertRefused(await f.deliver("save-analysis"), "analysis-output-failed");
      assert.equal(await readFile(join(f.directory, name), "utf8"), text);
      await assert.rejects(
        readFile(join(f.directory, `analysis-${cycleId}.json`)),
        { code: "ENOENT" },
      );
    });
  });
}

for (const workflow of ["develop-ticket", "", "analyze-chats-other"]) {
  await test(`CLV-115 refuses protected calls from ${workflow}`, async () => {
    await withAnalysis(async (f) => {
      f.context.workflow = workflow;
      assertRefused(await f.deliver("read-analysis"), "workflow-not-allowed");
    });
  });
}

await test("CLV-115 reconciliation observes absent saves without creating output", async () => {
  await withAnalysis(async (f) => {
    await f.prepare();
    const before = await f.files();
    assert.deepEqual(
      await f.worker.reconcile(
        analysisIntent("save-analysis"),
        new AbortController().signal,
      ),
      { kind: "absent" },
    );
    assert.deepEqual(await f.files(), before);
    assert.deepEqual(
      await f.worker.reconcile(
        analysisIntent("read-analysis"),
        new AbortController().signal,
      ),
      { kind: "absent" },
    );
  });
});

await test("CLV-115 an aborted delivery cannot access evidence or create outputs", async () => {
  await withAnalysis(async (f) => {
    await f.prepare();
    const signal = AbortSignal.abort();
    assert.deepEqual(
      await f.worker.deliver(analysisIntent("save-analysis"), signal),
      { kind: "stopped" },
    );
    assert.ok(
      (await f.files()).every((name) => !/^(proposal|analysis)-/.test(name)),
    );
  });
});

await test("CLV-115 serialized save payload passes at 65536 bytes and rejects one extra byte", async () => {
  await withAnalysis(async (f) => {
    const payload = await f.prepare();
    const size = Buffer.byteLength(JSON.stringify(payload));
    const atLimit = JSON.stringify({
      ...payload,
      reply: " ".repeat(65_536 - size) + payload.reply,
    });
    assert.equal(Buffer.byteLength(atLimit), 65_536);
    f.payloads.set("save-analysis", atLimit);
    assert.equal((await f.deliver("save-analysis")).kind, "completed");
    f.payloads.set("save-analysis", atLimit + " ");
    assertRefused(await f.deliver("save-analysis"), "analysis-too-large");
  });
});

await test("CLV-115 adapter closes and observes stopped idle operations without outputs", async () => {
  await withAnalysis(async (f) => {
    await f.prepare();
    assert.deepEqual(
      await f.worker.stop(
        analysisIntent("save-analysis"),
        new AbortController().signal,
      ),
      { kind: "stopped" },
    );
    const before = await f.files();
    await f.worker.close();
    assert.deepEqual(await f.deliver("save-analysis"), { kind: "stopped" });
    assert.deepEqual(await f.files(), before);
  });
});

await test("CLV-115 completed outputs remain completed when stop arrives later", async () => {
  await withAnalysis(async (f) => {
    await f.prepare();
    const saved = await f.deliver("save-analysis");
    assert.deepEqual(
      await f.worker.stop(
        analysisIntent("save-analysis"),
        new AbortController().signal,
      ),
      saved,
    );
  });
});

for (const name of ["😀".repeat(300), "\ud800", "\udc00"]) {
  await test(`CLV-115 multibyte proposal text replays exactly (${String(name.length)} code units)`, async () => {
    await withAnalysis(async (f) => {
      const payload = await f.prepare();
      const value = candidate();
      value.process.name = name;
      f.payloads.set(
        "save-analysis",
        JSON.stringify({ ...payload, reply: JSON.stringify(value) }),
      );
      const first = await f.deliver("save-analysis");
      assert.equal(first.kind, "completed");
      assert.deepEqual(await f.deliver("save-analysis"), first);
      const proposal = await readFile(
        join(f.directory, `proposal-${cycleId}.txt`),
        "utf8",
      );
      assert.ok(proposal.length <= 4_000);
      assert.equal(Buffer.from(proposal).toString("utf8"), proposal);
      const saved = await readFile(
        join(f.directory, `analysis-${cycleId}.json`),
        "utf8",
      );
      assert.ok(saved.includes(JSON.stringify(name)));
    });
  });
}
