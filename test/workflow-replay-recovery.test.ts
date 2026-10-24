import assert from "node:assert/strict";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { pinnedWorkflowHandler } from "../src/daemon/workflow-replay.ts";
import type { HostPorts } from "../src/service/service.ts";
import {
  call,
  decide,
  digestOf,
  field,
  waitingGate,
  withHarness,
  type Harness,
} from "./service-fixture.ts";
import { bundled, reason } from "./service-bundle-fixture.ts";

function replaying(
  recovery: {
    readonly ports: HostPorts;
    readonly waiting: { readonly runId: string };
  },
  overrides: Partial<Parameters<typeof pinnedWorkflowHandler>[1]>,
) {
  const { ports, waiting } = recovery;
  const handler = pinnedWorkflowHandler(
    () => Promise.resolve(new Response("replayed")),
    {
      state: ports.state,
      run: () => Promise.resolve({ runId: waiting.runId }),
      available: ports.workflow.available,
      submit: ports.submit,
      ...overrides,
    },
  );
  return () =>
    handler(
      new Request("http://localhost/workflow", {
        method: "POST",
        body: JSON.stringify({ runId: "wrun-original" }),
      }),
    );
}

async function recovering(harness: Harness) {
  const settings = await bundled(harness);
  const given = Promise.withResolvers<HostPorts>();
  const service = await harness.start({
    ...settings,
    host: (ports) => {
      given.resolve(ports);
      return Promise.resolve({ close: () => Promise.resolve() });
    },
  });
  const waiting = await waitingGate(harness, {
    service,
    commandId: "original",
    kind: "question",
  });
  const ports = await given.promise;
  return {
    service,
    waiting,
    ports,
    bundle: join(settings.workflowBundles.directory, settings.bundleDigest),
    replay: replaying({ ports, waiting }, {}),
  };
}

async function nextGate(
  harness: Harness,
  recovery: Awaited<ReturnType<typeof recovering>> & {
    readonly kind: "question" | "approval";
  },
) {
  const { service, waiting, ports, kind } = recovery;
  assert.equal(
    (
      await decide(harness, {
        command: "answer",
        reference: waiting.decisionId,
        subjectDigest: digestOf("question of original?"),
        text: "Continue.",
      })
    )["kind"],
    "decision-recorded",
  );
  const revision = (await ports.state()).runs[waiting.runId]?.revision;
  assert.ok(revision !== undefined);
  assert.equal(
    (
      await service.worker.openGate({
        runId: waiting.runId,
        commandId: "next-gate",
        expectedRevision: revision,
        gateId: "next",
        kind,
        prompt: "Next?",
        subject: digestOf("Next?"),
      })
    ).kind,
    "accepted",
  );
  const shown = field(
    await call(harness, {
      operation: "status",
      parameters: { runId: waiting.runId },
    }),
    "run",
  );
  assert.equal(
    field(field(shown, "reason"), "code"),
    kind === "question" ? "design-question" : "policy-approval",
  );
  assert.equal(
    field(shown, "nextAction"),
    kind === "question" ? "answer" : "approve-or-deny",
  );
}

for (const kind of ["question", "approval"] as const) {
  await test(`CLV-161 restored replay exposes the next ${kind} instead of the missing bundle observation`, () =>
    withHarness(async (harness) => {
      const recovery = await recovering(harness);
      const { service, waiting, bundle, replay } = recovery;
      await rename(bundle, bundle + "-saved");
      assert.equal((await replay()).status, 503);
      assert.equal(
        await reason(harness, waiting.runId),
        "pinned-workflow-unavailable",
      );
      await rename(bundle + "-saved", bundle);
      assert.equal((await replay()).status, 200);
      assert.equal(await reason(harness, waiting.runId), "design-question");
      await nextGate(harness, { ...recovery, kind });
      await service.close();
    }));
}

await test("CLV-161 replay reports a second bundle loss after restoration without duplicating unchanged observations", () =>
  withHarness(async (harness) => {
    const { service, waiting, ports, bundle, replay } =
      await recovering(harness);
    for (let cycle = 0; cycle < 2; cycle += 1) {
      await rename(bundle, bundle + "-saved");
      assert.equal((await replay()).status, 503);
      assert.equal(
        await reason(harness, waiting.runId),
        "pinned-workflow-unavailable",
      );
      const failed = (await ports.state()).sequence;
      assert.equal((await replay()).status, 503);
      assert.equal((await ports.state()).sequence, failed);
      await rename(bundle + "-saved", bundle);
      assert.equal((await replay()).status, 200);
      assert.equal(await reason(harness, waiting.runId), "design-question");
      const restored = (await ports.state()).sequence;
      assert.equal((await replay()).status, 200);
      assert.equal((await ports.state()).sequence, restored);
    }
    await service.close();
  }));

for (const kind of ["failed", "rejected"] as const) {
  await test(`CLV-161 a ${kind} recovery observation defers workflow execution until persisted`, () =>
    withHarness(async (harness) => {
      const recovery = await recovering(harness);
      const { service, waiting, bundle, replay } = recovery;
      await rename(bundle, bundle + "-saved");
      assert.equal((await replay()).status, 503);
      await rename(bundle + "-saved", bundle);
      const failing = replaying(recovery, {
        submit: () => Promise.resolve({ kind }),
      });
      assert.equal((await failing()).status, 503);
      assert.equal(
        await reason(harness, waiting.runId),
        "pinned-workflow-unavailable",
      );
      assert.equal((await replay()).status, 200);
      assert.equal(await reason(harness, waiting.runId), "design-question");
      await service.close();
    }));
}

await test("CLV-161 restoration preserves an unrelated observation committed after its snapshot", () =>
  withHarness(async (harness) => {
    const recovery = await recovering(harness);
    const { service, waiting, ports, bundle, replay } = recovery;
    await rename(bundle, bundle + "-saved");
    assert.equal((await replay()).status, 503);
    await rename(bundle + "-saved", bundle);
    const racing = replaying(recovery, {
      state: async () => {
        const snapshot = await ports.state();
        assert.equal(
          (
            await service.worker.observe({
              runId: waiting.runId,
              commandId: "newer-quota",
              condition: "quota-wait",
              reason: "provider-quota",
            })
          ).kind,
          "accepted",
        );
        return snapshot;
      },
    });
    assert.equal((await racing()).status, 503);
    assert.equal(
      (await ports.state()).details[waiting.runId]?.observation?.reason,
      "provider-quota",
    );
    assert.equal((await replay()).status, 200);
    assert.equal(
      (await ports.state()).details[waiting.runId]?.observation?.reason,
      "provider-quota",
    );
    await service.close();
  }));
