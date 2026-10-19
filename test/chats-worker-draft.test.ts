import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import filesystem, { readFile, stat } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { record } from "../src/protocol.ts";
import { chatsWorker } from "../src/daemon/chats-worker.ts";
import { inspectAnalysisDraft } from "../src/daemon/chats-files.ts";
import { candidate, questionCandidate } from "./chats-analysis-fixture.ts";
import { chatPlatformScenario } from "./chats-platform-fixture.ts";
import {
  analysisIntent,
  assertRefused,
  cycleId,
  withAnalysis,
} from "./chats-worker-fixture.ts";

async function prepareDraft(
  fixture: Parameters<Parameters<typeof withAnalysis>[0]>[0],
) {
  const payload = {
    ...(await fixture.prepare()),
    reply: JSON.stringify(questionCandidate()),
  };
  fixture.payloads.set("save-analysis", JSON.stringify(payload));
  return payload;
}

for (const name of [
  `claim-${cycleId}.json`,
  `analysis-${cycleId}.json`,
  `draft-${cycleId}.json`,
]) {
  await test(
    `CLV-117 draft inspection propagates a non-Error ENOENT from ${name}`,
    chatPlatformScenario(async () => {
      await withAnalysis(async (fixture) => {
        const before = await fixture.files();
        const failure = Object.assign(new Error("missing"), { code: "ENOENT" });
        Object.setPrototypeOf(failure, null);
        assert.equal(failure instanceof Error, false);
        const original = filesystem.lstat;
        Object.defineProperty(filesystem, "lstat", {
          value: (...args: Parameters<typeof filesystem.lstat>) =>
            String(args[0]) === join(fixture.directory, name)
              ? Promise.reject(failure)
              : original(...args),
        });
        syncBuiltinESMExports();
        try {
          await assert.rejects(
            inspectAnalysisDraft(fixture.directory, {
              runId: cycleId,
              cycleId,
              operationId: "save-draft",
              inputDigest: "input",
              snapshotDigest: "snapshot",
              reply: JSON.stringify(questionCandidate()),
            }),
            (error) => error === failure,
          );
        } finally {
          filesystem.lstat = original;
          syncBuiltinESMExports();
        }
        assert.deepEqual(await fixture.files(), before);
      });
    }),
  );
}

await test(
  "CLV-117 a valid question saves only its exact private draft and fixed deadline",
  chatPlatformScenario(async () => {
    await withAnalysis(async (fixture) => {
      const payload = await fixture.prepare();
      const candidate = questionCandidate();
      candidate.openQuestion.description =
        "/synthetic/notes.txt C:\\synthetic\\notes.txt operator@example.invalid @synthetic /question\\w+/g";
      const reply = " \n" + JSON.stringify(candidate, null, 2) + "\n";
      fixture.payloads.set(
        "save-analysis",
        JSON.stringify({ ...payload, reply }),
      );
      const before = Date.now();
      const outcome = await fixture.deliver("save-analysis");
      const after = Date.now();
      assert.equal(outcome.kind, "completed", JSON.stringify(outcome));
      assert.ok("result" in outcome);
      const metadata = record(JSON.parse(outcome.result));
      assert.equal(metadata?.["kind"], "analysis_draft");
      assert.equal(metadata["cycleId"], cycleId);
      assert.equal(
        metadata["candidateDigest"],
        createHash("sha256").update(reply).digest("hex"),
      );
      assert.deepEqual(metadata["question"], candidate.openQuestion);
      const deadline = Date.parse(String(metadata["expiresAt"]));
      assert.ok(deadline >= before + 86_400_000);
      assert.ok(deadline <= after + 86_400_000);
      const path = join(fixture.directory, `draft-${cycleId}.json`);
      const draft = record(JSON.parse(await readFile(path, "utf8")));
      assert.equal(draft?.["reply"], reply);
      assert.equal(draft["runId"], cycleId);
      assert.equal(draft["cycleId"], cycleId);
      assert.equal(draft["candidateDigest"], metadata["candidateDigest"]);
      assert.equal(draft["expiresAt"], metadata["expiresAt"]);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      const claimPath = join(fixture.directory, `claim-${cycleId}.json`);
      assert.equal((await stat(claimPath)).mode & 0o777, 0o600);
      const claim = record(JSON.parse(await readFile(claimPath, "utf8")));
      assert.equal(claim?.["kind"], "draft");
      assert.deepEqual(Object.keys(claim).sort(), [
        "digest",
        "kind",
        "schemaVersion",
      ]);
      assert.match(String(claim["digest"]), /^[a-f0-9]{64}$/);
      assert.deepEqual((await fixture.files()).sort(), [
        `claim-${cycleId}.json`,
        `draft-${cycleId}.json`,
        "redacted.jsonl",
        "redaction.json",
        "structure.json",
      ]);
    });
  }),
);

for (const text of ["", "conflicting"]) {
  await test(
    `CLV-117 incomplete or conflicting cycle claim (${String(text.length)} bytes) prevents draft creation`,
    chatPlatformScenario(async () => {
      await withAnalysis(async (fixture) => {
        await prepareDraft(fixture);
        const name = `claim-${cycleId}.json`;
        await fixture.write(name, text);
        const before = await fixture.files();
        for (const mode of ["deliver", "reconcile", "stop"] as const) {
          assertRefused(
            await fixture.worker[mode](
              analysisIntent("save-analysis"),
              new AbortController().signal,
            ),
            "analysis-output-failed",
          );
          assert.deepEqual(await fixture.files(), before);
          assert.equal(
            await readFile(join(fixture.directory, name), "utf8"),
            text,
          );
        }
      });
    }),
  );
}

await test(
  "CLV-117 draft replay across restart preserves bytes, receipt and the first-save deadline",
  chatPlatformScenario(async () => {
    await withAnalysis(async (fixture) => {
      await prepareDraft(fixture);
      const firstWorker = chatsWorker({
        ...fixture.settings,
        now: () => "2026-10-19T10:00:00.000Z",
      });
      const intent = { ...analysisIntent("save-analysis"), runId: "run-1" };
      const signal = new AbortController().signal;
      const first = await firstWorker.deliver(intent, signal);
      assert.equal(first.kind, "completed", JSON.stringify(first));
      assert.ok("result" in first);
      assert.equal(
        record(JSON.parse(first.result))?.["expiresAt"],
        "2026-10-20T10:00:00.000Z",
      );
      const path = join(fixture.directory, `draft-${cycleId}.json`);
      const bytes = await readFile(path);
      const inode = (await stat(path)).ino;
      assert.equal(record(JSON.parse(bytes.toString()))?.["runId"], "run-1");
      await firstWorker.close();
      await fixture.write("redacted.jsonl", "changed after capture");
      const restarted = chatsWorker({
        ...fixture.settings,
        now: () => "2026-10-22T10:00:00.000Z",
      });
      for (const mode of ["deliver", "reconcile", "stop"] as const) {
        assert.deepEqual(
          await restarted[mode]({ ...intent, leaseGeneration: 2 }, signal),
          first,
        );
        assert.deepEqual(await readFile(path), bytes);
        assert.equal((await stat(path)).ino, inode);
      }
      await restarted.close();
    });
  }),
);

for (const changed of ["reply", "snapshot", "run", "operation", "input"]) {
  await test(
    `CLV-117 conflicting draft ${changed} fails without replacing its record`,
    chatPlatformScenario(async () => {
      await withAnalysis(async (fixture) => {
        const payload = await prepareDraft(fixture);
        assert.equal(
          (await fixture.deliver("save-analysis")).kind,
          "completed",
        );
        const path = join(fixture.directory, `draft-${cycleId}.json`);
        const before = await readFile(path);
        if (changed === "reply") payload.reply += "\n";
        if (changed === "snapshot")
          payload.snapshot = {
            ...payload.snapshot,
            redaction: payload.snapshot.redaction + "\n",
          };
        fixture.payloads.set("save-analysis", JSON.stringify(payload));
        const intent = {
          ...analysisIntent("save-analysis"),
          ...(changed === "run" ? { runId: "another-run" } : {}),
          ...(changed === "operation" ? { operationId: "another-op" } : {}),
          ...(changed === "input" ? { inputDigest: "another-input" } : {}),
        };
        for (const mode of ["deliver", "reconcile", "stop"] as const) {
          assertRefused(
            await fixture.worker[mode](intent, new AbortController().signal),
            "analysis-output-failed",
          );
          assert.deepEqual(await readFile(path), before);
        }
      });
    }),
  );
}

for (const mode of ["reconcile", "stop"] as const) {
  await test(
    `CLV-117 ${mode} of an absent draft creates no file or deadline`,
    chatPlatformScenario(async () => {
      await withAnalysis(async (fixture) => {
        await prepareDraft(fixture);
        const before = await fixture.files();
        assert.deepEqual(
          await fixture.worker[mode](
            analysisIntent("save-analysis"),
            new AbortController().signal,
          ),
          { kind: mode === "reconcile" ? "absent" : "stopped" },
        );
        assert.deepEqual(await fixture.files(), before);
      });
    }),
  );
}

for (const contents of [
  "",
  "{}",
  "conflicting",
  "expired-deadline",
  "changed-digest",
]) {
  await test(
    `CLV-117 incomplete or conflicting draft (${contents}) is retained and refused`,
    chatPlatformScenario(async () => {
      await withAnalysis(async (fixture) => {
        await prepareDraft(fixture);
        await fixture.deliver("save-analysis");
        const name = `draft-${cycleId}.json`;
        const path = join(fixture.directory, name);
        const stored = record(JSON.parse(await readFile(path, "utf8")));
        assert.ok(stored);
        const draft = {
          ...stored,
          ...(contents === "expired-deadline" ? { expiresAt: "invalid" } : {}),
          ...(contents === "changed-digest"
            ? { candidateDigest: "0".repeat(64) }
            : {}),
        };
        const text = contents.includes("-")
          ? JSON.stringify(draft) + "\n"
          : contents;
        await fixture.write(name, text);
        for (const mode of ["deliver", "reconcile", "stop"] as const) {
          assertRefused(
            await fixture.worker[mode](
              analysisIntent("save-analysis"),
              new AbortController().signal,
            ),
            "analysis-output-failed",
          );
          assert.equal(await readFile(path, "utf8"), text);
        }
      });
    }),
  );
}

await test(
  "CLV-117 a question cannot replace already finalized analysis",
  chatPlatformScenario(async () => {
    await withAnalysis(async (fixture) => {
      await fixture.prepare();
      assert.equal((await fixture.deliver("save-analysis")).kind, "completed");
      await prepareDraft(fixture);
      const before = await fixture.files();
      assertRefused(
        await fixture.deliver("save-analysis"),
        "analysis-output-failed",
      );
      assert.deepEqual(await fixture.files(), before);
    });
  }),
);

await test(
  "CLV-117 concurrent draft and final saves have one exclusive cycle owner",
  chatPlatformScenario(async () => {
    await withAnalysis(async (fixture) => {
      const payload = await prepareDraft(fixture);
      const workers = [payload.reply, JSON.stringify(candidate())].map(
        (reply) =>
          chatsWorker({
            ...fixture.settings,
            document: () =>
              Promise.resolve(JSON.stringify({ ...payload, reply })),
          }),
      );
      const outcomes = await Promise.all(
        workers.map((worker, index) =>
          worker.deliver(
            {
              ...analysisIntent("save-analysis"),
              runId: `run-${String(index)}`,
              operationId: `operation-${String(index)}`,
            },
            new AbortController().signal,
          ),
        ),
      );
      assert.equal(
        outcomes.filter((outcome) => outcome.kind === "completed").length,
        1,
      );
      const failures = outcomes.filter(
        (outcome) => outcome.kind !== "completed",
      );
      assert.equal(failures.length, 1);
      assertRefused(failures[0], "analysis-output-failed");
      const files = await fixture.files();
      assert.notEqual(
        files.includes(`draft-${cycleId}.json`),
        files.includes(`analysis-${cycleId}.json`),
      );
      assert.equal(
        files.includes(`analysis-${cycleId}.json`),
        files.includes(`proposal-${cycleId}.txt`),
      );
      await Promise.all(workers.map((worker) => worker.close()));
    });
  }),
);
