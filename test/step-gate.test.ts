import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { decisionGate } from "../src/steps/decision-gate.ts";
import { protectedEffect } from "../src/steps/protected-effect.ts";
import {
  registerStepBridge,
  stepBridge,
  type BridgePorts,
} from "../src/host/step-bridge-host.ts";

const request = {
  gateId: "review-1",
  kind: "approval",
  prompt: "Approve the change of cycle-1?",
} as const;
const subject = `sha256:${createHash("sha256").update(request.prompt).digest("hex")}`;
const timing = { lookupTries: 3, pollMilliseconds: 1, retryMilliseconds: 2 };
const opened = { kind: "opened", decisionId: "review-1" };

type Receipt = Awaited<ReturnType<BridgePorts["openGate"]>>;
type Fault = "fault";

interface Shown {
  readonly status: string;
  readonly revision: number;
  readonly gates?: readonly string[];
}

const running: Shown = { status: "running", revision: 2 };
const atGate: Shown = {
  status: "waiting_gate",
  revision: 3,
  gates: ["run-1 review-1"],
};
const accepted: Receipt = { kind: "accepted" };
const lost: Receipt = { kind: "failed", reason: "storage-failure" };
const busy: Receipt = { kind: "rejected", reason: "service-busy" };
const stale: Receipt = { kind: "rejected", reason: "stale-revision" };

await test("CLV-117 the gate step forwards the stored deadline unchanged on opening retries", async () => {
  const expiresAt = "2026-10-20T10:00:00.000Z";
  const ports = scene({ opens: [lost, accepted] });
  const remove = registerStepBridge(stepBridge(ports));
  try {
    assert.deepEqual(await decisionGate({ ...request, expiresAt }), opened);
    assert.deepEqual(ports.sent, [
      {
        runId: "run-1",
        commandId: "sdk:step_01ABC:open:review-1",
        expectedRevision: 2,
        ...request,
        subject,
        expiresAt,
      },
      {
        runId: "run-1",
        commandId: "sdk:step_01ABC:open:review-1",
        expectedRevision: 2,
        ...request,
        subject,
        expiresAt,
      },
      {
        runId: "run-1",
        commandId: "sdk:step_01ABC:wait:review-1",
        gateId: "review-1",
      },
    ]);
  } finally {
    remove();
  }
});

function taken<Value>(entries: (Value | Fault)[]): Promise<Value> {
  const entry = entries.length > 1 ? entries.shift() : entries[0];
  return entry === "fault" || entry === undefined
    ? Promise.reject(new Error("the authority is closed"))
    : Promise.resolve(entry);
}

function scene(script: {
  readonly worldRunId?: string;
  readonly states?: readonly (Shown | Fault)[];
  readonly opens?: readonly (Receipt | Fault)[];
  readonly waits?: readonly (Receipt | Fault)[];
  readonly stopped?: AbortSignal;
}): BridgePorts & { readonly log: string[]; readonly sent: unknown[] } {
  const log: string[] = [];
  const sent: unknown[] = [];
  const states = [...(script.states ?? [running])];
  const opens = [...(script.opens ?? [accepted])];
  const waits = [...(script.waits ?? [accepted])];
  return {
    log,
    sent,
    call: () => ({
      worldRunId: script.worldRunId ?? "wrun_1",
      stepId: "step_01ABC",
      attempt: 1,
    }),
    timing,
    stopped: script.stopped ?? new AbortController().signal,
    run: (worldRunId) =>
      Promise.resolve(worldRunId === "wrun_1" ? { runId: "run-1" } : undefined),
    state: async () => {
      const { status, revision, gates } = await taken(states);
      log.push(`state ${status} ${String(revision)}`);
      return {
        runs: { "run-1": { status, revision } },
        gates: Object.fromEntries((gates ?? []).map((key) => [key, {}])),
      };
    },
    openGate: (opening) => {
      log.push(`open ${String(opening.expectedRevision)}`);
      sent.push(opening);
      return taken(opens);
    },
    registerWait: (wait) => {
      log.push("wait");
      sent.push(wait);
      return taken(waits);
    },
    requestEffect: () => Promise.reject(new Error("no effect in this scene")),
    operation: () => Promise.resolve(undefined),
    document: () => Promise.resolve(undefined),
  };
}

await test("CLV-010 the bridge opens a gate only when the authority shows the run in work, with the run revision, the SDK step as the command ID and the digest of the prompt as the subject, then it registers the wait and gives the gate ID as the decision ID", async () => {
  const ports = scene({
    states: [{ status: "queued", revision: 1 }, running, running],
  });
  assert.deepEqual(await stepBridge(ports).gate(request), opened);
  assert.deepEqual(ports.log, [
    "state queued 1",
    "state running 2",
    "state running 2",
    "open 2",
    "wait",
  ]);
  assert.deepEqual(ports.sent, [
    {
      runId: "run-1",
      commandId: "sdk:step_01ABC:open:review-1",
      expectedRevision: 2,
      gateId: "review-1",
      kind: "approval",
      prompt: request.prompt,
      subject,
    },
    {
      runId: "run-1",
      commandId: "sdk:step_01ABC:wait:review-1",
      gateId: "review-1",
    },
  ]);
});

await test("CLV-010 a second try of a step does not open a gate that the authority state has, and it registers the wait again", async () => {
  const again = scene({ states: [atGate], waits: [{ kind: "duplicate" }] });
  assert.deepEqual(await stepBridge(again).gate(request), opened);
  assert.deepEqual(again.log, [
    "state waiting_gate 3",
    "state waiting_gate 3",
    "wait",
  ]);
  const decided = scene({ states: [{ ...atGate, status: "running" }] });
  assert.deepEqual(await stepBridge(decided).gate(request), opened);
  assert.deepEqual(decided.sent, [
    {
      runId: "run-1",
      commandId: "sdk:step_01ABC:wait:review-1",
      gateId: "review-1",
    },
  ]);
});

await test("CLV-010 the bridge keeps a gate request whose outcome it does not know, and it tries again from the state read after a failed receipt, a failed call, a busy service and a stale revision", async () => {
  const held = scene({
    states: [
      running,
      "fault",
      running,
      running,
      running,
      running,
      { status: "running", revision: 5 },
      atGate,
    ],
    opens: [lost, "fault", busy, stale, { kind: "duplicate" }],
    waits: [lost, "fault", busy, accepted],
  });
  assert.deepEqual(await stepBridge(held).gate(request), opened);
  assert.deepEqual(held.log, [
    "state running 2",
    "state running 2",
    "open 2",
    "state running 2",
    "open 2",
    "state running 2",
    "open 2",
    "state running 2",
    "open 2",
    "state running 5",
    "open 5",
    "wait",
    "wait",
    "wait",
    "wait",
  ]);
});

await test("CLV-010 a rejected receipt of the gate opening or of the wait registration gives a refused result with its reason, and a run that the state does not have gets no command", async () => {
  const result = (script: Parameters<typeof scene>[0]): Promise<unknown> =>
    stepBridge(scene(script)).gate(request);
  assert.deepEqual(
    await result({
      opens: [{ kind: "rejected", reason: "invalid-transition" }],
    }),
    { kind: "refused", reason: "invalid-transition" },
  );
  assert.deepEqual(await result({ opens: [{ kind: "rejected" }] }), {
    kind: "refused",
    reason: "rejected",
  });
  assert.deepEqual(
    await result({ waits: [{ kind: "rejected", reason: "unknown-gate" }] }),
    { kind: "refused", reason: "unknown-gate" },
  );
  const foreign = scene({ worldRunId: "wrun_9" });
  assert.deepEqual(await stepBridge(foreign).gate(request), {
    kind: "unavailable",
    reason: "unknown-world-run",
  });
  const absent = {
    ...scene({}),
    state: () => Promise.resolve({ runs: {}, gates: {} }),
  };
  assert.deepEqual(await stepBridge(absent).gate(request), {
    kind: "refused",
    reason: "unknown-run",
  });
  assert.deepEqual([foreign.sent, absent.sent], [[], []]);
});

await test("CLV-010 after the host stops the bridge, a gate request in work gets no result and the bridge sends no more command", async () => {
  const stopping = new AbortController();
  const held = scene({ opens: [lost], stopped: stopping.signal });
  const outcome = { settled: "no" };
  const settle = (): void => {
    outcome.settled = "yes";
  };
  void stepBridge(held).gate(request).then(settle, settle);
  while (held.sent.length < 3) await delay(1);
  stopping.abort();
  await delay(10);
  const sent = held.sent.length;
  await delay(30);
  assert.deepEqual([outcome.settled, held.sent.length], ["no", sent]);
  const late = scene({ stopped: stopping.signal });
  void stepBridge(late).gate(request).then(settle, settle);
  await delay(20);
  assert.deepEqual([outcome.settled, late.sent], ["no", []]);
});

await test("CLV-010 the gate step helper gives its request to the bridge of its process, and each helper reports the absent host for a registry value that is not a complete bridge", async () => {
  const ports = scene({});
  const remove = registerStepBridge(stepBridge(ports));
  assert.deepEqual(await decisionGate(request), opened);
  assert.equal(ports.sent.length, 2);
  remove();
  const unavailable = {
    kind: "unavailable",
    reason: "cloving-host-unavailable",
  };
  assert.deepEqual(await decisionGate(request), unavailable);
  const partial = { effect: () => Promise.resolve(opened) };
  const key = Symbol.for("cloving.step-bridge/v1");
  Reflect.set(globalThis, key, partial);
  const effect = {
    scope: { phase: "work", operation: "effect", round: 1 },
    capability: "fake-harness",
    method: "run-turn",
    target: "workspace/main",
    payload: "build the package",
    units: 1,
  };
  const answers = [await decisionGate(request), await protectedEffect(effect)];
  Reflect.deleteProperty(globalThis, key);
  assert.deepEqual(answers, [unavailable, unavailable]);
  assert.equal(ports.sent.length, 2);
});
