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
