import assert from "node:assert/strict";
import { test } from "node:test";
import {
  call,
  field,
  startedRun,
  text,
  withHarness,
  type Harness,
} from "./service-fixture.ts";
import type { Service } from "../src/service/service.ts";
import { view } from "./service-views.ts";

const prompt = "Fix the flaky retention test in record-retention-loop";

function nameOf(shown: unknown): readonly unknown[] {
  return ["title", "titleSource", "label", "labelSource"].map((name) =>
    field(shown, name),
  );
}

function rename(
  harness: Harness,
  parameters: Readonly<Record<string, unknown>>,
) {
  return call(harness, { operation: "rename-run", parameters });
}

await test("CLV-334 a prompt run with no ticket is named by its prompt line and has no label", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const reply = await call(harness, {
      operation: "run",
      parameters: {
        workflowId: "develop",
        source: "prompt",
        submission: { prompt: `${prompt}\nMore detail` },
        commandId: "prompt-run",
      },
    });
    const shown = await view(harness, text(reply, "runId"));
    assert.deepEqual(nameOf(shown), [prompt, "prompt", null, null]);
    assert.doesNotMatch(JSON.stringify(shown), /Draft/);
    await service.close();
  }));

async function named(harness: Harness, service: Service): Promise<string> {
  const runId = await startedRun(harness, { service, commandId: "named" });
  const renamed = await rename(harness, {
    runId,
    commandId: "rename-1",
    title: "  Own name  ",
    label: "OWN-1",
  });
  assert.deepEqual(
    [renamed["kind"], renamed["runId"], renamed["replayed"]],
    ["run-renamed", runId, false],
  );
  assert.deepEqual(nameOf(renamed), ["Own name", "manual", "OWN-1", "manual"]);
  return runId;
}

await test("CLV-334 a rename sets the manual name, replays the same command, and refuses wrong values", () =>
  withHarness(async (harness) => {
    const service = await harness.start();
    const runId = await named(harness, service);
    assert.deepEqual(nameOf(await view(harness, runId)), [
      "Own name",
      "manual",
      "OWN-1",
      "manual",
    ]);
    const again = await rename(harness, {
      runId,
      commandId: "rename-1",
      title: "Own name",
      label: "OWN-1",
    });
    assert.equal(again["replayed"], true);
    const refusals = [
      [{ commandId: "rename-1", title: "Other name" }, "conflicting-command"],
      [{ commandId: "rename-2", title: "  " }, "invalid-title"],
      [{ commandId: "rename-2" }, "invalid-title"],
      [{ commandId: "rename-2", title: "x".repeat(201) }, "invalid-title"],
      [{ commandId: "rename-2", title: "Ok", label: "a b" }, "invalid-label"],
      [{ commandId: "rename-2", title: "Ok", runId: "run-x" }, "unknown-run"],
      [{ commandId: "rename-2", title: "Ok", clear: true }, "invalid-request"],
    ] as const;
    for (const [parameters, code] of refusals) {
      const refused = await rename(harness, { runId, ...parameters });
      assert.equal(refused["code"], code, JSON.stringify(parameters));
    }
    await service.close();
  }));

await test("CLV-334 a rename stays after a restart, the newest rename wins, a clear brings the automatic name back, and an ended run takes a rename", () =>
  withHarness(async (harness) => {
    let service = await harness.start();
    const runId = await named(harness, service);
    await service.close();
    service = await harness.start();
    assert.deepEqual(nameOf(await view(harness, runId)), [
      "Own name",
      "manual",
      "OWN-1",
      "manual",
    ]);
    const cleared = await rename(harness, {
      runId,
      commandId: "rename-3",
      clear: true,
    });
    assert.deepEqual(nameOf(cleared), ["task of named", "prompt", null, null]);
    assert.deepEqual(nameOf(await view(harness, runId)), nameOf(cleared));
    const later = await rename(harness, {
      runId,
      commandId: "rename-4",
      title: "AB-7 Newest name",
    });
    assert.deepEqual(nameOf(later), [
      "AB-7 Newest name",
      "manual",
      "AB-7",
      "title",
    ]);
    const failed = await service.worker.submit({
      kind: "fail-run",
      commandId: "named-failed",
      runId,
      expectedRevision: 2,
    });
    assert.equal(failed.kind, "accepted");
    const ended = await rename(harness, {
      runId,
      commandId: "rename-5",
      title: "After the end",
    });
    assert.equal(ended["title"], "After the end");
    await service.close();
  }));
