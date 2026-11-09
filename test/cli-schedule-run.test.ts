import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parseInvocation } from "../src/cli/arguments.ts";
import { send } from "../src/cli/client.ts";
import { commandUsage } from "../src/cli/usage.ts";
import type { Reply } from "../src/protocol.ts";
import type { WorkflowRegistration } from "../src/service/service.ts";
import { failed, result } from "../src/service/replies.ts";
import { runIdentity } from "../src/service/submission-handler.ts";
import { scheduledWorkflow } from "./workflow-scheduler-fixture.ts";
import {
  call,
  fields,
  items,
  parsed,
  withHarness,
  type Harness,
} from "./service-fixture.ts";
import { withSchedule } from "./cli-schedule-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

const developLoop = {
  declarations: [{ ...scheduledWorkflow, workflowId: "develop" }],
  clock: 0,
};

async function listedSchedule(
  harness: Harness,
): Promise<Readonly<Record<string, unknown>>> {
  const listed = await harness.cli(["schedule", "--json"]);
  assert.equal(listed.status, 0, listed.stderr);
  return fields(items(parsed(listed)["schedules"])[0]);
}

await test("CLV-328 schedule run admits one manual run with the schedule input and the mark, and keeps the next slot", () =>
  withSchedule(async (harness) => {
    const before = await listedSchedule(harness);
    const admitted = await harness.cli([
      "schedule",
      "run",
      "develop",
      "--command-id",
      "first",
      "--json",
    ]);
    assert.equal(admitted.status, 0, admitted.stdout + admitted.stderr);
    const result = parsed(admitted);
    const runId = runIdentity("loop:develop:first");
    assert.equal(result["kind"], "run-admitted");
    assert.equal(result["runId"], runId);
    assert.deepEqual(harness.resolved, [
      {
        workflowId: "develop",
        submission: { prompt: "current" },
        commandId: "loop:develop:first",
      },
    ]);
    const after = await listedSchedule(harness);
    assert.equal(after["nextAt"], before["nextAt"]);
    assert.equal(after["lastSlot"], before["lastSlot"]);
    assert.equal(after["activeRunId"], null);
    const status = await harness.cli(["status", runId, "--json"]);
    assert.equal(fields(parsed(status)["run"])["manualFromLoop"], true);
    const plain = await harness.cli(["status", runId]);
    assert.match(plain.stdout, /^manual from loop$/m);
    const listed = await harness.cli(["status"]);
    assert.match(listed.stdout, new RegExp(`${runId}.*manual from loop`));
  }, developLoop));

await test("CLV-328 schedule run refuses a second run while a run of the workflow is active and replays its own command", () =>
  withSchedule(async (harness) => {
    const first = await harness.cli(["schedule", "run", "develop"]);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /^Run run-[0-9a-f]{32} is admitted\.$/m);
    const refused = await harness.cli([
      "schedule",
      "run",
      "develop",
      "--command-id",
      "second",
      "--json",
    ]);
    assert.equal(refused.status, 1);
    assert.equal(parsed(refused)["code"], "run-active");
    const plain = await harness.cli(["schedule", "run", "develop"]);
    assert.equal(plain.status, 1);
    assert.match(plain.stderr, /run-active/);
    assert.equal(harness.resolved.length, 1);
  }, developLoop));

await test("CLV-328 schedule run replays the same command ID with the same run", () =>
  withSchedule(async (harness) => {
    const command = ["schedule", "run", "develop", "--command-id", "again"];
    const first = await harness.cli([...command, "--json"]);
    const second = await harness.cli([...command, "--json"]);
    assert.equal(second.status, 0, second.stdout);
    assert.equal(parsed(second)["runId"], parsed(first)["runId"]);
    assert.equal(parsed(second)["replayed"], true);
    assert.equal(harness.resolved.length, 1);
  }, developLoop));

await test("CLV-328 schedule run refuses an unknown schedule", () =>
  withSchedule(async (harness) => {
    const refused = await harness.cli(["schedule", "run", "missing", "--json"]);
    assert.equal(refused.status, 1);
    assert.equal(parsed(refused)["code"], "unknown-schedule");
    assert.equal(harness.resolved.length, 0);
  }, developLoop));

await test("CLV-328 schedule help shows the run action and its command ID option", () => {
  const usage = commandUsage["schedule"] ?? "";
  assert.match(
    usage,
    /^ +cloving schedule run <workflowId> \[--command-id <id>\] \[--json\]$/m,
  );
  assert.match(usage, /manual from loop/);
  assert.match(usage, /run-active/);
});

await test("CLV-328 schedule run arguments refuse a missing workflow, a bad command ID and an option of another action", () => {
  for (const args of [
    ["run"],
    ["run", "develop", "--command-id", "bad id"],
    ["run", "develop", "extra"],
    ["pause", "develop", "--command-id", "one"],
  ])
    assert.equal(
      parseInvocation(["schedule", ...args]).kind,
      "usage-error",
      JSON.stringify(args),
    );
});

await test("CLV-328 the README describes the Loops panel, its controls, cloving schedule run, the MCP tools and the schedules route", async () => {
  const readme = await readFile(
    new URL("../README.md", import.meta.url),
    "utf8",
  );
  assert.match(readme, /The \*\*Loops\*\* panel at the side of the floor/);
  assert.match(readme, /\*\*Run now\*\*.*`cloving schedule run <workflowId>`/);
  assert.match(readme, /`cloving schedule pause <workflowId>`.*switch/s);
  assert.match(
    readme,
    /`cloving schedule run <workflowId> \[--command-id <id>\] \[--json\]`/,
  );
  assert.match(
    readme,
    /`cloving_schedules`, `cloving_schedule_pause`, `cloving_schedule_resume` and `cloving_schedule_run`/,
  );
  assert.match(readme, /^- `GET \/api\/v1\/schedules` gives the loops/m);
  assert.match(
    readme,
    /the queue control, the loop controls and their endpoints/,
  );
  assert.match(readme, /`manual from loop`/);
  assert.match(
    readme,
    /The service admits the run requests of one workflow one at a time\. So a run now that comes during another admission of the workflow waits for it and then refuses with `run-active`\./,
  );
});

await test("CLV-328 the service refuses a run of a loop with no command ID or with a command ID that is too long", () =>
  withSchedule(async (harness) => {
    for (const parameters of [
      { action: "run", workflowId: "develop" },
      { action: "run", workflowId: 7, commandId: "one" },
      { action: "run", workflowId: "develop", commandId: "x".repeat(128) },
    ]) {
      const reply = await send(harness.runtimeDirectory, {
        operation: "schedule",
        parameters,
      });
      assert.equal(reply.kind, "error");
      assert.equal(reply.error.code, "invalid-request");
    }
    assert.equal(harness.resolved.length, 0);
  }, developLoop));

function loopCommand(commandId: string): {
  readonly operation: string;
  readonly parameters: Readonly<Record<string, unknown>>;
} {
  return {
    operation: "schedule",
    parameters: { action: "run", workflowId: "develop", commandId },
  };
}

function inputReply(input: unknown): Reply {
  return result("schedule-input", { workflowId: "develop", input });
}

await test("CLV-328 a loop run reads the schedule input before it holds the workflow lock, so a scheduled run that the input read waits for is not blocked", () =>
  withHarness(async (harness) => {
    const ticks: unknown[] = [];
    await harness.start({
      workflows: [{ ...harness.registration, admission: "when-idle" }],
      schedule: async () => {
        ticks.push(
          await call(harness, {
            operation: "run",
            parameters: {
              workflowId: "develop",
              source: "declared",
              submission: { prompt: "tick" },
              commandId: "tick",
            },
          }),
        );
        return inputReply({ prompt: "current" });
      },
    });
    const refused = await call(harness, loopCommand("now"));
    assert.equal(fields(ticks[0])["kind"], "run-admitted");
    assert.equal(refused["code"], "run-active");
  }));

await test("CLV-328 a repeated loop run command gives its stored run after the schedule input changes or the schedule is removed", () =>
  withHarness(async (harness) => {
    const inputs = [
      inputReply({ prompt: "first" }),
      inputReply({ prompt: "changed" }),
    ];
    let reads = 0;
    await harness.start({
      schedule: () => {
        reads += 1;
        return Promise.resolve(
          inputs.shift() ??
            failed("unknown-schedule", { workflowId: "develop" }),
        );
      },
    });
    const first = await call(harness, loopCommand("again"));
    assert.equal(first["kind"], "run-admitted");
    for (const repeated of [
      await call(harness, loopCommand("again")),
      await call(harness, loopCommand("again")),
    ]) {
      assert.equal(repeated["kind"], "run-admitted", JSON.stringify(repeated));
      assert.equal(repeated["runId"], first["runId"]);
      assert.equal(repeated["replayed"], true);
    }
    assert.equal(reads, 1);
    assert.equal(harness.resolved.length, 1);
  }));

await test("CLV-328 two loop run commands with the same command ID that both read the schedule input give one run", () =>
  withHarness(async (harness) => {
    const held: (() => void)[] = [];
    await harness.start({
      schedule: () =>
        new Promise((settle) => {
          held.push(() => {
            settle(inputReply({ prompt: "current" }));
          });
          if (held.length === 2) for (const release of held) release();
        }),
    });
    const replies = await Promise.all([
      call(harness, loopCommand("twice")),
      call(harness, loopCommand("twice")),
    ]);
    assert.deepEqual(
      replies.map((reply) => [reply["kind"], reply["runId"]]),
      Array.from({ length: 2 }, () => [
        "run-admitted",
        runIdentity("loop:develop:twice"),
      ]),
    );
    assert.equal(harness.resolved.length, 1);
  }));

await test("CLV-328 a loop run command refuses a command ID that a run of another workflow or another command already has", () =>
  withHarness(async (harness) => {
    await harness.start({
      workflows: [
        harness.registration,
        { ...harness.registration, workflowId: "other" },
      ],
      schedule: () => Promise.resolve(inputReply({ prompt: "current" })),
    });
    const admit = async (workflowId: string, commandId: string) => {
      const admitted = await call(harness, {
        operation: "run",
        parameters: {
          workflowId,
          source: "declared",
          submission: { prompt: "current" },
          commandId,
        },
      });
      assert.equal(admitted["kind"], "run-admitted");
      return admitted["runId"];
    };
    await admit("other", "loop:develop:taken");
    const runId = await admit("develop", "base");
    const status = await call(harness, {
      operation: "status",
      parameters: { runId },
    });
    const paused = await call(harness, {
      operation: "run-command",
      parameters: {
        command: "pause",
        runId,
        expectedRevision: fields(status["run"])["revision"],
        commandId: "loop:develop:paused",
      },
    });
    assert.equal(paused["kind"], "run-command", JSON.stringify(paused));
    for (const commandId of ["taken", "paused"])
      assert.equal(
        (await call(harness, loopCommand(commandId)))["code"],
        "conflicting-command",
        commandId,
      );
    assert.equal(harness.resolved.length, 2);
  }));

interface HeldCard {
  readonly registration: WorkflowRegistration;
  readonly cardEntered: Promise<undefined>;
  readonly loopEntered: Promise<undefined>;
  readonly release: () => void;
}

function heldCard(registration: WorkflowRegistration): HeldCard {
  const { resolver } = registration;
  const cardEntered = Promise.withResolvers<undefined>();
  const loopEntered = Promise.withResolvers<undefined>();
  const cardHeld = Promise.withResolvers<undefined>();
  const resolve: typeof resolver.resolve = async (request) => {
    if (request.commandId !== "card") {
      loopEntered.resolve(undefined);
      return resolver.resolve(request);
    }
    cardEntered.resolve(undefined);
    await cardHeld.promise;
    return resolver.resolve(request);
  };
  return {
    registration: { ...registration, resolver: { ...resolver, resolve } },
    cardEntered: cardEntered.promise,
    loopEntered: loopEntered.promise,
    release: () => {
      cardHeld.resolve(undefined);
    },
  };
}

await test("CLV-328 a loop run waits for an ordinary run of a workflow with no admission limit and then refuses with run-active", () =>
  withHarness(async (harness) => {
    const held = heldCard(harness.registration);
    await harness.start({
      workflows: [held.registration],
      schedule: () => Promise.resolve(inputReply({ prompt: "current" })),
    });
    const card = call(harness, {
      operation: "run",
      parameters: {
        workflowId: "develop",
        source: "declared",
        submission: { prompt: "card" },
        commandId: "card",
      },
    });
    await held.cardEntered;
    const loop = call(harness, loopCommand("now"));
    await Promise.race([held.loopEntered, delay(testMilliseconds(500))]);
    held.release();
    assert.equal((await card)["kind"], "run-admitted");
    assert.equal((await loop)["code"], "run-active");
    assert.equal(harness.resolved.length, 1);
  }));
