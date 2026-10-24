import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { retainWorkflowBundle } from "../tools/workflow-bundles.ts";
import {
  call,
  decide,
  digestOf,
  eventually,
  waitingGate,
  withHarness,
  text,
} from "./service-fixture.ts";
import { bundled, reason } from "./service-bundle-fixture.ts";

await test("CLV-161 a missing bundle blocks a waiting run's continuation even when the current workflow exists", () =>
  withHarness(async (harness) => {
    const settings = await bundled(harness);
    const service = await harness.start(settings);
    const waiting = await waitingGate(harness, {
      service,
      commandId: "original",
      kind: "question",
    });
    await rm(join(settings.workflowBundles.directory, settings.bundleDigest), {
      recursive: true,
    });
    const answer = await decide(harness, {
      command: "answer",
      reference: waiting.decisionId,
      subjectDigest: digestOf("question of original?"),
      text: "Continue.",
    });
    assert.equal(answer["kind"], "decision-recorded");
    await eventually(async () =>
      harness.sent.length > 1 ||
      (await reason(harness, waiting.runId)) === "pinned-workflow-unavailable"
        ? true
        : undefined,
    );
    assert.equal(harness.sent.length, 1, "no substitute continuation is sent");
    assert.equal(
      await reason(harness, waiting.runId),
      "pinned-workflow-unavailable",
    );
    await service.close();
  }));

await test("CLV-161 a damaged bundle blocks continuation after restart without substituting an available current bundle", () =>
  withHarness(async (harness) => {
    const original = await bundled(harness);
    const first = await harness.start(original);
    const waiting = await waitingGate(harness, {
      service: first,
      commandId: "original",
      kind: "question",
    });
    await first.close();
    await writeFile(
      join(
        original.workflowBundles.directory,
        original.bundleDigest,
        "artifacts/flow.mjs",
      ),
      "damaged",
    );
    await writeFile(
      join(harness.projectDirectory, "artifacts/flow.mjs"),
      "current flow",
    );
    const bundleDigest = await retainWorkflowBundle({
      ...original.workflowBundles,
      project: harness.projectDirectory,
    });
    const service = await harness.start({
      workflowBundles: original.workflowBundles,
      workflows: [
        {
          ...harness.registration,
          manifest: { ...harness.registration.manifest, bundleDigest },
        },
      ],
    });
    const answer = await decide(harness, {
      command: "answer",
      reference: waiting.decisionId,
      subjectDigest: digestOf("question of original?"),
      text: "Continue.",
    });
    assert.equal(answer["kind"], "decision-recorded");
    await eventually(async () =>
      harness.sent.length > 1 ||
      (await reason(harness, waiting.runId)) === "pinned-workflow-unavailable"
        ? true
        : undefined,
    );
    assert.equal(harness.sent.length, 1);
    assert.equal(
      await reason(harness, waiting.runId),
      "pinned-workflow-unavailable",
    );
    await service.close();
  }));

await test("CLV-161 a present current bundle continues its waiting run after restart", () =>
  withHarness(async (harness) => {
    const settings = await bundled(harness);
    const first = await harness.start(settings);
    const waiting = await waitingGate(harness, {
      service: first,
      commandId: "original",
      kind: "question",
    });
    await first.close();
    const service = await harness.start(settings);
    const answer = await decide(harness, {
      command: "answer",
      reference: waiting.decisionId,
      subjectDigest: digestOf("question of original?"),
      text: "Continue.",
    });
    assert.equal(answer["kind"], "decision-recorded");
    await eventually(() => (harness.sent.length === 2 ? true : undefined));
    assert.equal(harness.sent[1]?.kind, "continue-run");
    assert.equal(harness.sent[1].workflow, harness.sent[0]?.workflow);
    await service.close();
  }));

await test("CLV-161 a queued start with a missing bundle is blocked after restart", () =>
  withHarness(async (harness) => {
    const settings = await bundled(harness);
    const first = await harness.start({
      ...settings,
      delivery: {
        reconcile: () => Promise.resolve({ kind: "absent" }),
        deliver: () => Promise.reject(new Error("unreachable")),
      },
    });
    const result = await call(harness, {
      operation: "run",
      parameters: {
        workflowId: "develop",
        source: "prompt",
        submission: { prompt: "Task" },
        commandId: "queued",
      },
    });
    const runId = text(result, "runId");
    await eventually(async () =>
      (await reason(harness, runId)) === "delivery-outcome-unknown"
        ? true
        : undefined,
    );
    await first.close();
    await rm(join(settings.workflowBundles.directory, settings.bundleDigest), {
      recursive: true,
    });
    const service = await harness.start(settings);
    await eventually(async () =>
      (await reason(harness, runId)) === "pinned-workflow-unavailable"
        ? true
        : undefined,
    );
    assert.equal(harness.sent.length, 0);
    await service.close();
  }));

await test("CLV-161 a legacy run without a bundle digest retains its continuation behavior", () =>
  withHarness(async (harness) => {
    const first = await harness.start();
    const waiting = await waitingGate(harness, {
      service: first,
      commandId: "original",
      kind: "question",
    });
    await first.close();
    const settings = await bundled(harness);
    const service = await harness.start(settings);
    const answer = await decide(harness, {
      command: "answer",
      reference: waiting.decisionId,
      subjectDigest: digestOf("question of original?"),
      text: "Continue.",
    });
    assert.equal(answer["kind"], "decision-recorded");
    await eventually(async () =>
      harness.sent.length > 1 ||
      (await reason(harness, waiting.runId)) === "pinned-workflow-unavailable"
        ? true
        : undefined,
    );
    assert.equal(harness.sent.length, 2);
    await service.close();
  }));
