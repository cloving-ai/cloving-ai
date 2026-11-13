import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { SubmissionContract } from "../src/submission.ts";
import { candidatePackageRoot } from "./candidate-package-fixture.ts";
import { scene } from "./self-host-fixture.ts";
import { record } from "../src/protocol.ts";
import { writeDeclaredWorkflow } from "./workflow-folder-fixture.ts";
import { setTimeout as delay } from "node:timers/promises";
import { testMilliseconds } from "./test-timing.ts";
import {
  cli,
  privateSettings,
  queueScene,
  registered,
  startOutput,
  statusOf,
  workflowFile,
} from "./cli-start-declared-queue-fixture.ts";
import { mkdir } from "node:fs/promises";

const packagedEntry = join(candidatePackageRoot, "src/cli.ts");

await test("CLV-262 start with no project or user workflow registers nothing and guides initialization", async () => {
  const fixture = await scene();
  const output = await startOutput(fixture, {
    inspect: () => {
      assert.deepEqual(registered(fixture), []);
    },
  });
  assert.match(output, /Cloving runs/);
  assert.match(output, /No workflow\. Run: cloving init/);
  assert.doesNotMatch(output, /run develop-(ticket|issue|prompt|prd)/);
});

await test("CLV-262 start registers a template under a formerly bundled ID and guides its ticket command", async () => {
  const fixture = await scene();
  const declaration = await writeDeclaredWorkflow(fixture.repository);
  await writeFile(
    join(fixture.repository, ".cloving/workflows/develop.declaration.json"),
    JSON.stringify({
      ...declaration,
      workflow: { ...declaration.workflow, workflowId: "develop-issue" },
    }),
  );
  const output = await startOutput(fixture, {
    entry: packagedEntry,
    inspect: () => {
      assert.deepEqual(registered(fixture), ["develop-issue"]);
    },
  });
  assert.match(output, /Cloving runs/);
  assert.doesNotMatch(output, /Refused workflow|bundled-name-reserved/);
  assert.match(output, /run develop-issue --ticket <ticket-id>/);
  assert.doesNotMatch(output, /run develop-(ticket|prompt|prd)/);
});

await test("CLV-262 start guides project and user workflows with their declared inputs", async () => {
  const fixture = await scene();
  await workflowFile(join(fixture.repository, ".cloving/workflows"), {
    name: "report",
    fields: { rounds: { type: "integer" } },
    queue: false,
  });
  await workflowFile(join(fixture.root, "config/cloving/workflows"), {
    name: "notes",
    fields: { prompt: { type: "string" } },
    queue: false,
  });
  const output = await startOutput(fixture, {
    entry: packagedEntry,
    inspect: () => {
      assert.deepEqual(registered(fixture), ["report", "notes"]);
    },
  });
  assert.match(output, /run report --input <json-file>/);
  assert.match(output, /run notes --prompt "<text>"/);
  assert.doesNotMatch(
    output,
    /No workflow|run develop-(ticket|issue|prompt|prd)/,
  );
});

await test("CLV-228 start needs no ticket commands when a queue interval has no declared target", async () => {
  const fixture = await scene();
  for (const command of [undefined, "[]"]) {
    const output = await startOutput(fixture, {
      environment: {
        CLOVING_QUEUE_SECONDS: "10",
        CLOVING_TICKET_COMMAND: command,
        CLOVING_NEXT_COMMAND: command,
      },
    });
    assert.match(output, /Cloving runs/);
    assert.doesNotMatch(output, /The daemon did not start/);
  }
});

await test("CLV-218 start prints the specific queue input refusal codes", async () => {
  const fixture = await scene();
  const folder = join(fixture.repository, ".cloving/workflows");
  await workflowFile(folder, { name: "missing", fields: {} });
  await workflowFile(folder, {
    name: "incomplete",
    fields: {
      ticket: { type: "ticket" },
      note: { type: "string" },
    },
  });
  const output = await startOutput(fixture);
  assert.match(output, /missing.ts: queue-needs-ticket-field/);
  assert.match(output, /incomplete.ts: queue-input-incomplete/);
});

await test("CLV-360 start admits project and user queue workflows", async () => {
  const fixture = await scene();
  const fields: SubmissionContract["fields"] = { ticket: { type: "ticket" } };
  await workflowFile(join(fixture.repository, ".cloving/workflows"), {
    name: "projectqueue",
    fields,
  });
  await workflowFile(join(fixture.root, "config/cloving/workflows"), {
    name: "userqueue",
    fields,
  });
  const output = await startOutput(fixture);
  assert.match(output, /Cloving runs/);
  assert.doesNotMatch(output, /The daemon did not start/);
});

await test("CLV-359 start starts a declared queue with no interval setting and admits the first ticket after the declared interval", async () => {
  const { fixture, environment } = await queueScene({
    queue: { everySeconds: 10 },
  });
  const output = await startOutput(fixture, {
    environment,
    inspect: async () => {
      const started = performance.now();
      const queue = record(statusOf(fixture)["queue"]);
      assert.equal(queue?.["workflowId"], "develop");
      assert.deepEqual(queue["settings"], {
        everySeconds: { value: 10, source: "declaration" },
        lanes: { value: 1, source: "default" },
        workingLanes: { value: 1, source: "default" },
      });
      const deadline = started + testMilliseconds(40_000);
      let runs: unknown = [];
      while (performance.now() < deadline) {
        runs = statusOf(fixture)["runs"];
        if (Array.isArray(runs) && runs.length > 0) break;
        await delay(200);
      }
      assert.equal(Array.isArray(runs) ? runs.length : 0, 1);
      assert.ok(performance.now() - started >= 5000);
    },
  });
  assert.match(output, /Cloving runs/);
});

await test("CLV-359 the start environment, the queue setting and the private queues setting come before the declaration", async () => {
  const { fixture, environment } = await queueScene({
    queue: {
      everySeconds: 300,
      lanes: 2,
    },
  });
  await mkdir(join(fixture.repository, ".cloving"), { recursive: true });
  await writeFile(
    join(fixture.repository, ".cloving/config.json"),
    JSON.stringify({ version: 1, queue: { everySeconds: 60 } }),
  );
  const shown = () => record(statusOf(fixture)["queue"])?.["settings"];
  await startOutput(fixture, {
    environment: { ...environment, CLOVING_QUEUE_LANES: "3" },
    inspect: () => {
      assert.deepEqual(shown(), {
        everySeconds: { value: 60, source: "queue setting" },
        lanes: { value: 3, source: "environment" },
        workingLanes: { value: 3, source: "default" },
      });
      const queue = cli(fixture, ["queue"]);
      assert.match(
        queue.stdout,
        /Queue settings: every 60 s \(queue setting\), 3 lanes \(environment\), 3 working lanes \(default\)/,
      );
    },
  });
  await privateSettings(fixture, {
    queues: { develop: { lanes: 4, everySeconds: 600, workingLanes: 2 } },
  });
  await startOutput(fixture, {
    environment: { ...environment, CLOVING_QUEUE_LANES: "3" },
    inspect: () => {
      assert.deepEqual(shown(), {
        everySeconds: { value: 600, source: "queues setting (private file)" },
        lanes: { value: 4, source: "queues setting (private file)" },
        workingLanes: { value: 2, source: "queues setting (private file)" },
      });
    },
  });
});

await test("CLV-359 the queues state off starts no declared queue and the status names the setting", async () => {
  const { fixture, environment } = await queueScene({ queue: true });
  await privateSettings(fixture, { queues: { develop: { state: "off" } } });
  const output = await startOutput(fixture, {
    environment,
    inspect: () => {
      const status = statusOf(fixture);
      assert.equal(record(status["queue"])?.["state"], "off");
      assert.deepEqual(status["queues"], [status["queue"]]);
      assert.deepEqual(status["queueOff"], {
        workflowId: "develop",
        source: "queues setting",
      });
      assert.match(
        cli(fixture, ["status"]).stdout,
        /Queue: off for develop \(queues setting\)/,
      );
      const queue = cli(fixture, ["queue"]);
      assert.match(queue.stdout + queue.stderr, /queues setting/);
    },
  });
  assert.match(output, /Cloving runs/);
});

await test("CLV-359 a declared queue without ticket commands or an interval setting starts no queue", async () => {
  const { fixture } = await queueScene({ queue: true });
  const output = await startOutput(fixture, {
    environment: {
      CLOVING_TICKET_COMMAND: undefined,
      CLOVING_NEXT_COMMAND: undefined,
    },
    inspect: () => {
      const queue = record(statusOf(fixture)["queue"]);
      assert.equal(queue?.["state"], "off");
      assert.equal(record(queue["off"])?.["reason"], "no ticket command");
    },
  });
  assert.match(output, /Cloving runs/);
});

await test("CLV-359 a reload applies the queues lanes with no restart and names a state change as a restart field", async () => {
  const { fixture, environment } = await queueScene({
    queue: { everySeconds: 300 },
  });
  await startOutput(fixture, {
    environment,
    inspect: () => {
      const status = cli(fixture, ["status"]);
      assert.match(status.stdout, /Queue: running, 0 of 1 lanes busy/);
      assert.match(
        status.stdout,
        /Queue settings: every 300 s \(declaration\), 1 lanes \(default\), 1 working lanes \(default\)/,
      );
      const set = cli(fixture, [
        "config",
        "set",
        "queues",
        '{"develop":{"lanes":3}}',
        "--private",
      ]);
      assert.equal(set.status, 0, set.stdout + set.stderr);
      const reload = cli(fixture, ["reload", "--json"]);
      assert.equal(reload.status, 0, reload.stdout + reload.stderr);
      const applied = record(JSON.parse(reload.stdout));
      assert.deepEqual(
        [applied?.["reloadedFields"], applied?.["restartFields"]],
        [["queues"], []],
      );
      const queue = record(statusOf(fixture)["queue"]);
      assert.equal(queue?.["lanes"], 3);
      assert.deepEqual(record(queue["settings"])?.["lanes"], {
        value: 3,
        source: "queues setting (private file)",
      });
      cli(fixture, [
        "config",
        "set",
        "queues",
        '{"develop":{"lanes":3,"state":"off"}}',
        "--private",
      ]);
      const stopped = record(
        JSON.parse(cli(fixture, ["reload", "--json"]).stdout),
      );
      assert.deepEqual(
        [stopped?.["reloadedFields"], stopped?.["restartFields"]],
        [[], ["queues"]],
      );
      assert.deepEqual(record(statusOf(fixture)["queue"])?.["settings"], {
        everySeconds: { value: 300, source: "declaration" },
        lanes: { value: 3, source: "queues setting (private file)" },
        workingLanes: { value: 3, source: "default" },
      });
    },
  });
});

await test("CLV-359 a restart-only ticket command change keeps the running queue limits", async () => {
  const { fixture, environment } = await queueScene({ queue: { lanes: 4 } });
  const command: unknown = JSON.parse(environment.CLOVING_TICKET_COMMAND);
  const nextCommand: unknown = JSON.parse(environment.CLOVING_NEXT_COMMAND);
  await privateSettings(fixture, {
    tickets: { command, nextCommand },
    queues: { develop: { workingLanes: 2 } },
  });
  await startOutput(fixture, {
    environment: {
      ...environment,
      CLOVING_TICKET_COMMAND: undefined,
      CLOVING_NEXT_COMMAND: undefined,
    },
    inspect: () => {
      const before = record(statusOf(fixture)["queue"])?.["settings"];
      const set = cli(fixture, [
        "config",
        "set",
        "tickets.nextCommand",
        "[]",
        "--private",
      ]);
      assert.equal(set.status, 0, set.stdout + set.stderr);
      const reload = cli(fixture, ["reload", "--json"]);
      assert.equal(reload.status, 0, reload.stdout + reload.stderr);
      const reply = record(JSON.parse(reload.stdout));
      assert.deepEqual(reply?.["restartFields"], ["tickets.nextCommand"]);
      assert.deepEqual(
        record(statusOf(fixture)["queue"])?.["settings"],
        before,
      );
    },
  });
});

await test("CLV-359 queue file lanes and the start environment interval override the declaration", async () => {
  const { fixture, environment } = await queueScene({
    queue: { lanes: 2, everySeconds: 300 },
  });
  await writeFile(
    join(fixture.repository, ".cloving/config.json"),
    JSON.stringify({ version: 1, queue: { lanes: 5, everySeconds: 60 } }),
  );
  await startOutput(fixture, {
    environment: { ...environment, CLOVING_QUEUE_SECONDS: "30" },
    inspect: () => {
      assert.deepEqual(record(statusOf(fixture)["queue"])?.["settings"], {
        everySeconds: { value: 30, source: "environment" },
        lanes: { value: 5, source: "queue setting" },
        workingLanes: { value: 5, source: "default" },
      });
    },
  });
});
