import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { pinnedWorkflowHandler } from "../src/daemon/workflow-replay.ts";
import type { HostPorts } from "../src/service/service.ts";
import {
  admitted,
  startedRun,
  waitingGate,
  withHarness,
  call,
  field,
  type Harness,
} from "./service-fixture.ts";
import { bundled, reason } from "./service-bundle-fixture.ts";

await test("CLV-161 SDK replay checks the stored bundle before invoking any current handler", () =>
  withHarness(async (harness) => {
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
    let invoked = 0;
    let lookups = 0;
    const replay = pinnedWorkflowHandler(
      async (request) => {
        invoked += 1;
        return new Response(await request.text());
      },
      {
        state: ports.state,
        run: () =>
          Promise.resolve(
            ++lookups === 1 ? undefined : { runId: waiting.runId },
          ),
        available: ports.workflow.available,
        submit: ports.submit,
      },
    );
    const body = JSON.stringify({ runId: "wrun-original" });
    const current = await replay(
      new Request("http://localhost/workflow", { method: "POST", body }),
    );
    assert.equal(current.status, 200);
    assert.equal(await current.text(), body);
    assert.equal(invoked, 1);
    await rm(join(settings.workflowBundles.directory, settings.bundleDigest), {
      recursive: true,
    });
    const response = await replay(
      new Request("http://localhost/workflow", {
        method: "POST",
        body: JSON.stringify({ runId: "wrun-original" }),
      }),
    );
    assert.equal(invoked, 1);
    assert.equal(response.status, 503);
    assert.equal(
      await reason(harness, waiting.runId),
      "pinned-workflow-unavailable",
    );
    await service.close();
  }));

await test("CLV-161 a resilient SDK start checks the recorded pin before the World run is persisted", () =>
  withHarness(async (harness) => {
    const settings = await bundled(harness);
    const given = Promise.withResolvers<HostPorts>();
    const service = await harness.start({
      ...settings,
      host: (ports) => {
        given.resolve(ports);
        return Promise.resolve({ close: () => Promise.resolve() });
      },
    });
    const runId = await startedRun(harness, {
      service,
      commandId: "resilient",
    });
    const ports = await given.promise;
    let invoked = 0;
    const replay = pinnedWorkflowHandler(
      () => {
        invoked += 1;
        return Promise.resolve(new Response("started"));
      },
      {
        state: ports.state,
        run: () => Promise.resolve(undefined),
        available: ports.workflow.available,
        submit: ports.submit,
      },
    );
    const message = (workflowName: string) =>
      new Request("http://localhost/workflow", {
        method: "POST",
        body: JSON.stringify({
          runId: "wrun-not-yet-stored",
          runInput: { workflowName, attributes: { "cloving.run": runId } },
        }),
      });
    const current = await replay(
      message(harness.registration.manifest.workflowId),
    );
    assert.equal(current.status, 200);
    assert.equal(invoked, 1);
    const substitute = await replay(message("workflow//substitute//develop"));
    assert.equal(substitute.status, 503);
    assert.equal(invoked, 1);
    await service.close();
  }));

for (const state of ["queued", "running"]) {
  await test(`CLV-161 unavailable replay reports the restore action while ${state}`, () =>
    withHarness(async (harness) => {
      const settings = await bundled(harness);
      const given = Promise.withResolvers<HostPorts>();
      const service = await harness.start({
        ...settings,
        host: (ports) => {
          given.resolve(ports);
          return Promise.resolve({ close: () => Promise.resolve() });
        },
      });
      const runId =
        state === "queued"
          ? await admitted(harness, "original")
          : await startedRun(harness, { service, commandId: "original" });
      const ports = await given.promise;
      const replay = pinnedWorkflowHandler(
        () => Promise.reject(new Error("must not execute")),
        {
          state: ports.state,
          run: () => Promise.resolve({ runId }),
          available: ports.workflow.available,
          submit: ports.submit,
        },
      );
      await rm(
        join(settings.workflowBundles.directory, settings.bundleDigest),
        { recursive: true },
      );
      const response = await replay(
        new Request("http://localhost/workflow", {
          method: "POST",
          body: JSON.stringify({ runId: "wrun-original" }),
        }),
      );
      assert.equal(response.status, 503);
      const result = await call(harness, {
        operation: "status",
        parameters: { runId },
      });
      const shown = field(result, "run");
      assert.equal(
        field(field(shown, "reason"), "code"),
        "pinned-workflow-unavailable",
      );
      assert.equal(field(shown, "nextAction"), "restore-pinned-workflow");
      assert.equal(field(shown, "humanInputCanHelp"), true);
      await service.close();
    }));
}

async function hosted(harness: Harness) {
  const settings = await bundled(harness);
  const given = Promise.withResolvers<HostPorts>();
  const service = await harness.start({
    ...settings,
    host: (ports) => {
      given.resolve(ports);
      return Promise.resolve({ close: () => Promise.resolve() });
    },
  });
  return { settings, service, ports: given.promise };
}

async function dropped(
  harness: Harness,
  target: { readonly ports: HostPorts; readonly runId: string },
) {
  const { ports, runId } = target;
  const result = await call(harness, {
    operation: "run-command",
    parameters: {
      command: "drop",
      runId,
      expectedRevision: (await ports.state()).runs[runId]?.revision,
      commandId: "drop",
    },
  });
  assert.equal(field(field(result, "committed"), "state"), "cancelled");
}

async function droppedRun(harness: Harness, pin: string) {
  const { settings, service, ports: given } = await hosted(harness);
  const { runId } = await waitingGate(harness, {
    service,
    commandId: "dropped",
    kind: "question",
  });
  const ports = await given;
  await dropped(harness, { ports, runId });
  if (pin === "missing")
    await rm(join(settings.workflowBundles.directory, settings.bundleDigest), {
      recursive: true,
    });
  assert.equal(await ports.workflow.available(runId), pin === "present");
  return { service, ports, runId };
}

for (const pin of ["missing", "present"]) {
  await test(`CLV-278 a message of a dropped run with a ${pin} pin is done without workflow code or a new observation`, () =>
    withHarness(async (harness) => {
      const { service, ports, runId } = await droppedRun(harness, pin);
      let invoked = 0;
      const replay = pinnedWorkflowHandler(
        () => {
          invoked += 1;
          return Promise.resolve(new Response("ran"));
        },
        {
          state: ports.state,
          run: () => Promise.resolve({ runId }),
          available: ports.workflow.available,
          submit: ports.submit,
        },
      );
      const sequence = (await ports.state()).sequence;
      const response = await replay(
        new Request("http://localhost/workflow", {
          method: "POST",
          body: JSON.stringify({ runId: "wrun-dropped" }),
        }),
      );
      assert.equal(invoked, 0);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true });
      assert.equal((await ports.state()).sequence, sequence);
      assert.notEqual(
        await reason(harness, runId),
        "pinned-workflow-unavailable",
      );
      await service.close();
    }));
}

await test("CLV-278 a run dropped during the bundle check gets a done answer", () =>
  withHarness(async (harness) => {
    const { service, ports: given } = await hosted(harness);
    const { runId } = await waitingGate(harness, {
      service,
      commandId: "dropped-during-check",
      kind: "question",
    });
    const ports = await given;
    let invoked = 0;
    const replay = pinnedWorkflowHandler(
      () => {
        invoked += 1;
        return Promise.resolve(new Response("ran"));
      },
      {
        state: ports.state,
        run: () => Promise.resolve({ runId }),
        available: async () => {
          await dropped(harness, { ports, runId });
          return false;
        },
        submit: ports.submit,
      },
    );
    const response = await replay(
      new Request("http://localhost/workflow", {
        method: "POST",
        body: JSON.stringify({ runId: "wrun-dropped-during-check" }),
      }),
    );
    assert.equal(invoked, 0);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.notEqual(
      await reason(harness, runId),
      "pinned-workflow-unavailable",
    );
    await service.close();
  }));

await test("CLV-278 a replay reads the observation after the bundle check", () =>
  withHarness(async (harness) => {
    const { service, ports: given } = await hosted(harness);
    const runId = await startedRun(harness, { service, commandId: "raced" });
    const ports = await given;
    const restoredElsewhere = async () => {
      const sequence =
        (await ports.state()).details[runId]?.observation?.sequence ?? 0;
      const outcome = await ports.submit({
        kind: "report-observation",
        runId,
        commandId: "restored-by-another-message",
        condition: "working",
        reason: "in-progress",
        expectedObservation: sequence,
      });
      assert.equal(outcome.kind, "accepted");
      return true;
    };
    const checks = [() => Promise.resolve(false), restoredElsewhere];
    let invoked = 0;
    const replay = pinnedWorkflowHandler(
      () => {
        invoked += 1;
        return Promise.resolve(new Response("ran"));
      },
      {
        state: ports.state,
        run: () => Promise.resolve({ runId }),
        available: () => checks.shift()?.() ?? Promise.resolve(true),
        submit: ports.submit,
      },
    );
    const message = () =>
      new Request("http://localhost/workflow", {
        method: "POST",
        body: JSON.stringify({ runId: "wrun-raced" }),
      });
    const unavailable = await replay(message());
    assert.equal(await unavailable.text(), "pinned-workflow-unavailable");
    assert.equal(await reason(harness, runId), "pinned-workflow-unavailable");
    const restored = await replay(message());
    assert.equal(await restored.text(), "ran");
    assert.equal(invoked, 1);
    await service.close();
  }));

await test("CLV-161 malformed and uncorrelated SDK messages cannot invoke workflow code", async () => {
  const unreachable = () => Promise.reject(new Error("uncorrelated message"));
  const replay = pinnedWorkflowHandler(unreachable, {
    state: unreachable,
    run: () => Promise.resolve(undefined),
    available: unreachable,
    submit: unreachable,
  });
  const messages = [
    { body: "{", status: 400 },
    { body: "{}", status: 400 },
    { body: JSON.stringify({ runId: "unknown" }), status: 503 },
    {
      body: JSON.stringify({
        runId: "unknown",
        runInput: {
          workflowName: "workflow",
          attributes: { "cloving.run": 42 },
        },
      }),
      status: 503,
    },
  ];
  for (const message of messages) {
    const response = await replay(
      new Request("http://localhost/workflow", {
        method: "POST",
        body: message.body,
      }),
    );
    assert.equal(response.status, message.status);
  }
});
