import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  alive,
  field,
  intent,
  record,
  resultOf,
  until,
  withScene,
  type Scene,
} from "./claude-worker-fixture.ts";
import { consumePiShutdown, piResumeSession } from "../src/daemon/pi-resume.ts";
import { dirname } from "node:path";
import { operationFile } from "./harness-detached-fixture.ts";
import { fakePi, piEvents, piMessage } from "./pi-fixture.ts";

const nextMessage = piMessage({ responseId: "new-response", timestamp: 2 });

async function stoppedPi(
  scene: Scene,
  options: {
    readonly events?: readonly unknown[];
    readonly resumeEvents?: readonly unknown[];
    readonly resumeGate?: string;
    readonly model?: string;
  } = {},
) {
  const gate = join(scene.directory, "release");
  const settings = {
    profiles: {
      native: { harness: "pi", model: options.model ?? "operator/alias" },
    },
    tokenPrices: {
      "test-provider/test-model": { input: 2, cachedInput: 0.5, output: 8 },
    },
    harness: {
      name: "pi",
      path: fakePi(scene, {
        gate,
        resumeEvents: piEvents(nextMessage),
        ...options,
      }),
    },
  };
  const signal = new AbortController().signal;
  const first = scene.worker("unused", settings);
  const call =
    options.model === undefined
      ? intent()
      : intent({ method: "run-turn:native" });
  await first.deliver(call, signal);
  await until(() => existsSync(join(scene.directory, "observed.json")));
  const started = record(scene, "operation-1/started.json");
  const session = field(started, "piSession");
  const processId = Number(field(field(started, "launch"), "processId"));
  const output = String(field(field(started, "launch"), "output"));
  await until(() => readFileSync(output, "utf8").includes('"message_end"'));
  await first.close();
  assert.equal(alive(processId), false);
  assert.equal(scene.reports.length, 0);
  return {
    signal,
    session,
    settings,
    call,
    next: scene.worker("unused", settings),
  };
}

function prompts(scene: Scene) {
  return readFileSync(join(scene.directory, "pi-prompts.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => resultOf(line));
}

await test("CLV-365 a confirmed Pi shutdown resumes the owned session once with invocation accounting", () =>
  withScene(async (scene) => {
    const { signal, session, next } = await stoppedPi(scene);
    const replies = await Promise.all([
      next.reconcile(intent(), signal),
      next.reconcile(intent(), signal),
    ]);
    assert.deepEqual(
      replies.map((reply) => reply.kind),
      ["accepted", "accepted"],
    );
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    const resumed = record(scene, "operation-1/attempt-2.json");
    assert.equal(
      field(field(resumed, "piSession"), "id"),
      field(session, "id"),
    );
    assert.equal(field(resumed, "resumedAfter"), "daemon-restart");
    assert.equal(prompts(scene).length, 2);
    assert.match(
      String(prompts(scene)[1]?.["prompt"]),
      /^This turn stopped because/,
    );
    assert.equal(
      field(prompts(scene)[1]?.["session"], "id"),
      field(session, "id"),
    );
    const result = resultOf(scene.reports[0].result);
    assert.equal(result["turns"], 2);
    assert.equal(field(result["piAccounting"], "responseCount"), 2);
    assert.equal(field(result["usage"], "input_tokens"), 200);
    assert.equal((await next.reconcile(intent(), signal)).kind, "completed");
  }));

await test("CLV-365 native Pi resume excludes old assistant replay after the new invocation starts", () =>
  withScene(async (scene) => {
    const replay = [
      ...piEvents(nextMessage).slice(0, 2),
      ...piEvents().slice(2, 4),
      ...piEvents(nextMessage).slice(2),
    ];
    const { signal, next } = await stoppedPi(scene, { resumeEvents: replay });
    assert.equal((await next.reconcile(intent(), signal)).kind, "accepted");
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    const result = resultOf(scene.reports[0].result);
    assert.equal(result["turns"], 2);
    assert.equal(field(result["piAccounting"], "responseCount"), 2);
    assert.equal(field(result["usage"], "input_tokens"), 200);
    const attempts = result["attempts"];
    assert.ok(Array.isArray(attempts));
    assert.equal(field(field(attempts[1], "usage"), "input_tokens"), 100);
    assert.equal(prompts(scene).length, 2);
  }));

await test("CLV-365 Pi refuses a truncated native resume checkpoint before another prompt", () =>
  withScene(async (scene) => {
    const { signal, session, next } = await stoppedPi(scene);
    const path = String(field(session, "path"));
    writeFileSync(path, readFileSync(path, "utf8") + '{"type":"message"');
    const reply = await next.reconcile(intent(), signal);
    assert.equal(reply.kind, "failed");
    assert.equal(field(reply, "reason"), "pi-session-state-invalid");
    assert.equal(prompts(scene).length, 1);
  }));

await test("CLV-365 native Pi resume keeps an interrupted invocation's incomplete accounting unknown", () =>
  withScene(async (scene) => {
    const { signal, next } = await stoppedPi(scene, {
      events: piEvents().slice(0, 4),
    });
    assert.equal((await next.reconcile(intent(), signal)).kind, "accepted");
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    const result = resultOf(scene.reports[0].result);
    assert.equal(field(result["usage"], "input_tokens"), null);
    assert.equal(result["costUsd"], null);
    assert.equal(result["estimatedCostUsd"], null);
    const attempts = result["attempts"];
    assert.ok(Array.isArray(attempts));
    assert.equal(field(field(attempts[0], "usage"), "input_tokens"), null);
    assert.equal(field(field(attempts[1], "usage"), "input_tokens"), 100);
  }));

await test("CLV-365 a resumed Pi process reconnects after a second daemon restart without a third prompt", () =>
  withScene(async (scene) => {
    const gate = join(scene.directory, "resumed-release");
    const { signal, settings, next } = await stoppedPi(scene, {
      resumeGate: gate,
    });
    try {
      assert.equal((await next.reconcile(intent(), signal)).kind, "accepted");
      await until(() => prompts(scene).length === 2);
      const launch = field(record(scene, "operation-1/started.json"), "launch");
      await next.close({ turns: "keep" });
      const last = scene.worker("unused", settings);
      assert.equal((await last.reconcile(intent(), signal)).kind, "accepted");
      assert.deepEqual(
        field(record(scene, "operation-1/started.json"), "launch"),
        launch,
      );
      writeFileSync(gate, "release");
      await until(() => scene.reports.length === 1);
      assert.equal(scene.reports[0]?.outcome, "completed");
      assert.equal(resultOf(scene.reports[0].result)["turns"], 2);
      assert.equal(
        field(
          resultOf(scene.reports[0].result)["piAccounting"],
          "responseCount",
        ),
        2,
      );
      assert.equal(prompts(scene).length, 2);
    } finally {
      writeFileSync(gate, "release");
    }
  }));

await test("CLV-365 native Pi resume preserves unknown pricing from an invocation with auxiliary work", () =>
  withScene(async (scene) => {
    const events = [
      ...piEvents().slice(0, -1),
      { type: "compaction_end" },
      {
        type: "message_end",
        message: {
          role: "toolResult",
          toolName: "bash",
          toolCallId: "nested",
          usage: piMessage().usage,
          content: [],
          isError: false,
        },
      },
      ...piEvents().slice(-1),
    ];
    const { signal, next } = await stoppedPi(scene, { events });
    assert.equal((await next.reconcile(intent(), signal)).kind, "accepted");
    await until(() => scene.reports.length === 1);
    const result = resultOf(scene.reports[0]?.result);
    assert.equal(result["estimatedCostUsd"], null);
    assert.equal(field(result["piAccounting"], "auxiliaryWork"), true);
    assert.equal(field(result["piAccounting"], "responseCount"), 2);
    assert.equal(
      field(field(result["piAccounting"], "nestedUsage"), "input_tokens"),
      100,
    );
    const attempts = result["attempts"];
    assert.ok(Array.isArray(attempts));
    assert.equal(field(attempts[0], "estimatedCostUsd"), null);
    assert.equal(field(attempts[1], "estimatedCostUsd"), 0.00038);
  }));

await test("CLV-365 native Pi resume refuses a matching header whose completed history is missing", () =>
  withScene(async (scene) => {
    const { signal, session, next } = await stoppedPi(scene);
    const path = String(field(session, "path"));
    writeFileSync(
      path,
      (readFileSync(path, "utf8").split("\n")[0] ?? "") + "\n",
    );
    const reply = await next.reconcile(intent(), signal);
    assert.equal(reply.kind, "failed");
    assert.equal(field(reply, "reason"), "pi-session-history-missing");
    assert.equal(prompts(scene).length, 1);
  }));

await test("CLV-365 a drop recorded during native Pi recovery prevents a replacement prompt", () =>
  withScene(async (scene) => {
    const { signal, settings } = await stoppedPi(scene);
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const next = scene.worker("unused", {
      ...settings,
      document: async () => {
        entered.resolve(undefined);
        await release.promise;
        return "original task";
      },
    });
    const recovery = next.reconcile(intent(), signal);
    await entered.promise;
    const dropping = next.stop(intent(), signal);
    try {
      await until(() =>
        existsSync(
          operationFile(scene, {
            operationId: "operation-1",
            name: "stop-request.json",
          }),
        ),
      );
      release.resolve(undefined);
      await recovery;
      assert.equal((await dropping).kind, "stopped");
      assert.equal(prompts(scene).length, 1);
      assert.equal(
        field(record(scene, "operation-1/started.json"), "attempt"),
        1,
      );
    } finally {
      release.resolve(undefined);
      await recovery;
      await dropping;
    }
  }));

await test("CLV-365 native Pi resume retains the operator model selector", () =>
  withScene(async (scene) => {
    const { signal, next, call } = await stoppedPi(scene, {
      model: "operator/alias",
    });
    assert.equal((await next.reconcile(call, signal)).kind, "accepted");
    await until(() => scene.reports.length === 1);
    assert.deepEqual(
      scene
        .turns()
        .map((turn) => turn.arguments[turn.arguments.indexOf("--model") + 1]),
      ["operator/alias", "operator/alias"],
    );
  }));

await test("CLV-365 an orphan Pi resume checkpoint refuses visibly without another prompt", () =>
  withScene(async (scene) => {
    const { signal, next } = await stoppedPi(scene);
    mkdirSync(
      operationFile(scene, {
        operationId: "operation-1",
        name: "attempt-2/pi-session",
      }),
      { recursive: true },
    );
    await assert.doesNotReject(() => next.reconcile(intent(), signal));
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.reason, "pi-session-state-unowned");
    assert.equal(prompts(scene).length, 1);
  }));

await test("CLV-365 a header-only Pi checkpoint cannot resume an invocation without a completed assistant", () =>
  withScene(async (scene) => {
    const events = [
      ...piEvents().slice(0, 2),
      {
        type: "message_end",
        message: { role: "user", content: "Original task", timestamp: 1 },
      },
    ];
    const { signal, next, session } = await stoppedPi(scene, { events });
    const path = String(field(session, "path"));
    writeFileSync(
      path,
      (readFileSync(path, "utf8").split("\n")[0] ?? "") + "\n",
    );
    assert.equal(
      field(record(scene, "operation-1/attempt-1.json"), "turns"),
      0,
    );
    const reply = await next.reconcile(intent(), signal);
    assert.equal(reply.kind, "failed");
    assert.equal(field(reply, "reason"), "pi-session-history-missing");
    assert.equal(prompts(scene).length, 1);
  }));

await test("CLV-365 native Pi refuses system setup without an original conversation", () =>
  withScene(async (scene) => {
    const events = [
      ...piEvents().slice(0, 2),
      {
        type: "message_end",
        message: { role: "system", content: "Setup", timestamp: 1 },
      },
    ];
    const { signal, next } = await stoppedPi(scene, { events });
    const reply = await next.reconcile(intent(), signal);
    assert.equal(reply.kind, "failed");
    assert.equal(field(reply, "reason"), "pi-session-history-missing");
    assert.equal(prompts(scene).length, 1);
  }));

await test("CLV-365 a native Pi resume decision survives a crash before the replacement attempt record", () =>
  withScene(async (scene) => {
    const { signal, next } = await stoppedPi(scene);
    const folder = dirname(
      operationFile(scene, {
        operationId: "operation-1",
        name: "started.json",
      }),
    );
    const session = await piResumeSession({
      folder,
      started: record(scene, "operation-1/started.json"),
      intent: intent(),
    });
    assert.equal(typeof session, "object");
    if (typeof session !== "object")
      throw new Error("Owned Pi session missing");
    await consumePiShutdown(folder, { resume: { piSession: session } });
    assert.equal((await next.reconcile(intent(), signal)).kind, "accepted");
    await until(() => scene.reports.length === 1);
    assert.equal(scene.reports[0]?.outcome, "completed");
    assert.equal(prompts(scene).length, 2);
  }));
