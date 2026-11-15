import assert from "node:assert/strict";
import { test } from "node:test";
import { queueObservation } from "../src/cli/doctor-local.ts";
import { settingChanges } from "../src/daemon/settings-reload.ts";
import { queuesDigest } from "../src/queue-settings.ts";
import { queueConfigurations, queuePlan } from "../tools/self-host-queue.ts";
import { queueStartup } from "../tools/self-host-queue-startup.ts";
import { commandUsage } from "../src/cli/usage.ts";

const legacyDeclaration = { workflowId: "develop", queue: true };
const ticketCommands = {
  CLOVING_TICKET_COMMAND: '["ticket"]',
  CLOVING_NEXT_COMMAND: '["next"]',
};

await test("CLV-373 start help distinguishes legacy activation from explicit polling defaults", () => {
  const help = commandUsage["start"] ?? "";
  assert.match(help, /A boolean queue stays inactive without an interval/);
  assert.match(
    help,
    /A queue object or a per-workflow queues entry selects the new defaults/,
  );
});
const legacyConfiguration = {
  declarations: [legacyDeclaration],
  sources: {},
};

await test("CLV-373 a dormant legacy queue does not reject shared settings of an active queue in either declaration order", () => {
  const modernDeclaration = { workflowId: "modern", queue: {} };
  for (const declarations of [
    [legacyDeclaration, modernDeclaration],
    [modernDeclaration, legacyDeclaration],
  ]) {
    const startup = queueStartup(
      {
        ...ticketCommands,
        CLOVING_READY_COMMAND: '["ready"]',
        CLOVING_QUEUE_LANES: "2",
      },
      { ...legacyConfiguration, declarations },
    );
    assert.equal(startup.queueMilliseconds, 120_000);
    assert.equal(
      startup.queueConfigurations["develop"]?.intervalMilliseconds,
      undefined,
    );
    assert.equal(
      startup.queueConfigurations["modern"]?.intervalMilliseconds,
      120_000,
    );
    assert.equal(startup.queueLanes, 2);
    assert.deepEqual(startup.readyCommand, ["ready"]);
  }
});

await test("CLV-373 the v1.9 boolean queue stays inactive without an interval even with ticket commands", () => {
  for (const queues of [undefined, "{}", '{"other":{}}']) {
    const environment = { ...ticketCommands, CLOVING_QUEUES: queues };
    assert.deepEqual(queuePlan(environment, legacyConfiguration), {
      kind: "none",
    });
    assert.equal(
      queueConfigurations(environment, legacyConfiguration)["develop"]
        ?.intervalMilliseconds,
      undefined,
    );
  }
});

await test("CLV-373 adding or removing a per-workflow queue entry reports a restart for activation", () => {
  const digest = (text: string) => text;
  const absent = { queues: queuesDigest("{}", digest) };
  for (const value of ['{"develop":{}}', '{"develop":{"lanes":2}}']) {
    const present = { queues: queuesDigest(value, digest) };
    assert.deepEqual(settingChanges(absent, present).restartFields, ["queues"]);
    assert.deepEqual(settingChanges(present, absent).restartFields, ["queues"]);
  }
  assert.deepEqual(
    settingChanges(
      { queues: queuesDigest('{"develop":{"lanes":2}}', digest) },
      { queues: queuesDigest('{"develop":{"lanes":3}}', digest) },
    ),
    { reloadedFields: ["queues"], restartFields: [] },
  );
});

await test("CLV-373 an explicit legacy interval still activates the boolean queue", () => {
  for (const seconds of ["10", "30", "3600"]) {
    const plan = queuePlan(
      { ...ticketCommands, CLOVING_QUEUE_SECONDS: seconds },
      legacyConfiguration,
    );
    assert.equal(plan.kind, "on");
    assert.deepEqual(plan.values.everySeconds, {
      value: Number(seconds),
      source: "environment",
    });
  }
});

await test("CLV-373 the doctor retains the v1.9 missing interval refusal for a legacy queue", () => {
  assert.deepEqual(
    queueObservation({
      environment: {},
      sources: {},
      workflows: [{ ...legacyDeclaration, scope: "project", capabilities: [] }],
    }),
    {
      result: "fail",
      detail: "queue.everySeconds must be a whole number from 10 to 3600",
    },
  );
});
