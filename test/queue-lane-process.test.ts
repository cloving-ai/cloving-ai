import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { privateSettingsPath } from "../src/cli/project-settings.ts";
import { changeConfigFile } from "../src/cli/config-file.ts";
import { record } from "../src/protocol.ts";
import {
  field,
  reached,
  scene,
  withoutChildren,
  type Scene,
} from "./self-host-fixture.ts";
import { call, runCli } from "./service-fixture.ts";
import { candidateDeclaration } from "./workflow-candidate-fixtures.ts";
import { candidatePackageRoot } from "./candidate-package-fixture.ts";
import { checkedLiveBrowser } from "./queue-lane-browser-fixture.ts";
import {
  withLaneReloadProbe,
  laneReloadDiagnostics,
} from "./queue-lane-reload-fixture.ts";

await rm(join(candidatePackageRoot, "dist/package.json"), { force: true });

const harness = `
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
appendFileSync(join(import.meta.dirname, "prompts.jsonl"), JSON.stringify({ pid: process.pid, prompt }) + "\\n");
const line = value => process.stdout.write(JSON.stringify(value) + "\\n");
line({ type: "system", subtype: "init", session_id: "session-" + process.pid });
while (!existsSync(join(import.meta.dirname, "release-turn"))) await delay(25);
line({ type: "result", subtype: "success", is_error: false, result: "Done.", total_cost_usd: 0.01, session_id: "session-" + process.pid, num_turns: 1 });
`;

function laneScene() {
  return scene(harness, join(candidatePackageRoot, "dist/src/cli.js"));
}

async function workflow(fixture: Scene) {
  await queueWorkflow(fixture, { id: "lane-turn", lanes: 2 });
  await queueWorkflow(fixture, { id: "lane-peer", lanes: 5 });
}

async function queueWorkflow(
  fixture: Scene,
  target: { readonly id: string; readonly lanes: number },
) {
  const folder = join(fixture.repository, ".cloving/workflows");
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, `${target.id}.ts`),
    `
import { protectedEffect } from "cloving/workflows/steps/protected-effect";
export async function ${target.id === "lane-turn" ? "laneTurn" : "lanePeer"}(input: { cycleId: string }) {
  "use workflow";
  const turn = await protectedEffect({ scope: { phase: "review", operation: "turn", round: 1 }, capability: "claude", method: "run-turn", target: input.cycleId, payload: "Review the lane fixture.", units: 1 });
  return { kind: turn.kind === "completed" ? "handoff_requested" : "blocked", reason: "lane fixture" };
}`,
  );
  await writeFile(
    join(folder, `${target.id}.declaration.json`),
    JSON.stringify({
      ...candidateDeclaration,
      workflow: {
        ...candidateDeclaration.workflow,
        workflowId: target.id,
        queue: { everySeconds: 3600, lanes: target.lanes },
        input: { maximumBytes: 1024, fields: { ticket: { type: "ticket" } } },
      },
      methods: { claude: ["run-turn"] },
    }),
  );
}

async function identities(fixture: Scene) {
  const journal = join(fixture.directory, "journal");
  const names = (await readdir(journal)).filter((name) =>
    existsSync(join(journal, name, "started.json")),
  );
  const started = await Promise.all(
    names.map((name) => readFile(join(journal, name, "started.json"), "utf8")),
  );
  return started.sort();
}

async function prompts(fixture: Scene) {
  const file = join(fixture.root, "prompts.jsonl");
  if (!existsSync(file)) return [];
  return (await readFile(file, "utf8"))
    .split("\n")
    .slice(0, -1)
    .map((line) => record(JSON.parse(line)) ?? {});
}

await test("CLV-377 prompt observations wait for complete records", () =>
  withoutChildren(async () => {
    const fixture = await laneScene();
    const file = join(fixture.root, "prompts.jsonl");
    await writeFile(file, '{"pid":1}\n{"pid":');
    assert.deepEqual(await prompts(fixture), [{ pid: 1 }]);
    await writeFile(file, "2}\n", { flag: "a" });
    assert.deepEqual(await prompts(fixture), [{ pid: 1 }, { pid: 2 }]);
    await writeFile(file, '{"pid":');
    assert.deepEqual(await prompts(fixture), []);
    await writeFile(file, "invalid\n");
    await assert.rejects(prompts(fixture), SyntaxError);
  }));

function workflowQueue(
  reply: Readonly<Record<string, unknown>>,
  workflowId = "lane-turn",
) {
  const queues = reply["queues"];
  return Array.isArray(queues)
    ? queues.map(record).find((queue) => queue?.["workflowId"] === workflowId)
    : undefined;
}

function lanes(
  fixture: Scene,
  parameters: {
    readonly lanes: number;
    readonly expectedLanes: number;
    readonly commandId: string;
  },
) {
  return call(fixture, {
    operation: "queue-setting",
    parameters: {
      scope: "workflow",
      field: "lanes",
      action: "set",
      workflowId: "lane-turn",
      value: parameters.lanes,
      expectedValue: parameters.expectedLanes,
      commandId: parameters.commandId,
    },
  });
}

async function submittedTurn(fixture: Scene, commandId: string) {
  const reply = await call(fixture, {
    operation: "run",
    parameters: {
      source: "ticket",
      workflowId: "lane-turn",
      commandId,
      submission: { ticket: commandId === "one" ? "900" : "901" },
    },
  });
  assert.equal(reply["kind"], "run-admitted", JSON.stringify(reply));
}

await test("CLV-377 real in-flight harness identities survive automatic lane apply and a later normal restart reads the private limit", () =>
  withoutChildren(async () => {
    const fixture = await laneScene();
    await workflow(fixture);
    await writeFile(
      join(fixture.root, "fake-board.mjs"),
      'process.stdout.write("# " + process.argv.at(-1) + ": lane fixture");',
    );
    const environment = {
      XDG_CONFIG_HOME: join(fixture.root, "config"),
      CLOVING_NEXT_COMMAND: '["false"]',
      CLOVING_QUEUE_SECONDS: "3600",
      CLOVING_QUEUE_LANES: undefined,
      CLOVING_QUEUE_WORKING_LANES: undefined,
      CLOVING_QUEUES: undefined,
    };
    await withLaneReloadProbe(fixture, {
      environment,
      body: async () => {
        const inventory = await call(fixture, {
          operation: "status",
          parameters: {},
        });
        assert.ok(
          Array.isArray(inventory["workflows"]) &&
            inventory["workflows"].includes("lane-turn"),
          JSON.stringify(inventory),
        );
        for (const commandId of ["one", "two"])
          await submittedTurn(fixture, commandId);
        await reached(async () =>
          (await prompts(fixture)).length === 2 ? true : undefined,
        ).catch(async (error: unknown) => {
          throw new Error(
            JSON.stringify(
              await call(fixture, { operation: "status", parameters: {} }),
            ),
            { cause: error },
          );
        });
        await appliedDuringTurns(fixture);
      },
    });
  }));

async function appliedDuringTurns(fixture: Scene) {
  const before = await call(fixture, { operation: "status", parameters: {} });
  const owned = await identities(fixture);
  const reduced = await lanes(fixture, {
    lanes: 1,
    expectedLanes: 2,
    commandId: "reduce",
  });
  assert.equal(reduced["kind"], "queue-setting", JSON.stringify(reduced));
  assert.equal(field(workflowQueue(reduced), "busy"), 2);
  assert.equal(field(workflowQueue(reduced), "lanes"), 1);
  assert.equal(field(workflowQueue(reduced, "lane-peer"), "lanes"), 5);
  assert.equal(field(reduced["globalQueue"], "configuredLanes"), null);
  assert.deepEqual(await identities(fixture), owned);
  for (const prompt of await prompts(fixture))
    process.kill(Number(prompt["pid"]), 0);
  assert.equal(
    (
      await lanes(fixture, {
        lanes: 1,
        expectedLanes: 2,
        commandId: "reduce",
      })
    )["replayed"],
    true,
  );
  assert.equal((await prompts(fixture)).length, 2);
  const full = await call(fixture, {
    operation: "run",
    parameters: {
      source: "ticket",
      workflowId: "lane-turn",
      commandId: "full",
      submission: { ticket: "902" },
    },
  });
  assert.equal(full["code"], "workflow-active");
  assert.equal(
    (
      await lanes(fixture, {
        lanes: 3,
        expectedLanes: 1,
        commandId: "increase",
      })
    )["kind"],
    "queue-setting",
  );
  assert.equal(
    (await call(fixture, { operation: "status", parameters: {} }))[
      "serviceStartedAt"
    ],
    before["serviceStartedAt"],
  );
  await appliedGlobalDuringTurns(fixture);
  assert.deepEqual(await identities(fixture), owned);
  assert.equal((await prompts(fixture)).length, 2);
  await checkedRestart(fixture, before);
}

async function appliedGlobalDuringTurns(fixture: Scene) {
  const global = await call(fixture, {
    operation: "queue-setting",
    parameters: {
      commandId: "global-reduce",
      scope: "global",
      field: "lanes",
      action: "set",
      expectedValue: 16,
      value: 1,
    },
  });
  assert.equal(global["kind"], "queue-setting", JSON.stringify(global));
  assert.equal(field(global["globalQueue"], "busy"), 2);
  assert.equal(field(global["globalQueue"], "lanes"), 1);
  assert.equal(field(workflowQueue(global), "lanes"), 3);
  assert.equal(field(workflowQueue(global, "lane-peer"), "lanes"), 5);
  const held = await call(fixture, {
    operation: "run",
    parameters: {
      source: "ticket",
      workflowId: "lane-turn",
      commandId: "global-full",
      submission: { ticket: "902" },
    },
  });
  assert.equal(held["code"], "queue-repository-full", JSON.stringify(held));
  await writeFile(join(fixture.root, "arm-reload"), "");
  await checkedLiveBrowser(fixture);
  const observed = await laneReloadDiagnostics(fixture);
  assert.doesNotMatch(String(observed["reload"]), /compiler-waiting/);
  await writeFile(join(fixture.root, "release-reload"), "");
}

async function checkedRestart(
  fixture: Scene,
  before: Readonly<Record<string, unknown>>,
) {
  await writeFile(join(fixture.root, "release-turn"), "");
  await reached(async () => {
    const status = await call(fixture, {
      operation: "status",
      parameters: {},
    });
    const runs = status["runs"];
    return Array.isArray(runs) &&
      runs.length === 2 &&
      runs.every((run) => field(run, "state") === "completed")
      ? true
      : undefined;
  });
  const restarted = await runCli(["restart", "--json"], {
    directory: fixture.repository,
    runtime: fixture.runtimeDirectory,
  });
  assert.equal(restarted.status, 0, restarted.stdout + restarted.stderr);
  const after = await call(fixture, { operation: "status", parameters: {} });
  assert.notEqual(after["serviceStartedAt"], before["serviceStartedAt"]);
  assert.equal(field(workflowQueue(after), "lanes"), 4);
  assert.equal(field(workflowQueue(after, "lane-peer"), "lanes"), 5);
  assert.equal(field(after["globalQueue"], "lanes"), 2);
  assert.equal(
    field(
      field(field(workflowQueue(after), "settings"), "workingLanes"),
      "value",
    ),
    4,
  );
  assert.equal((await prompts(fixture)).length, 2);
}

await test("CLV-377 concurrent CLI and queue edits preserve unrelated private fields and other queues", async () => {
  const fixture = await laneScene();
  const file = privateSettingsPath(
    { XDG_CONFIG_HOME: join(fixture.root, "config") },
    fixture.repository,
  );
  await Promise.all([
    changeConfigFile(file, {
      scope: "private",
      queueLanes: { workflowId: "lane-turn", lanes: 3 },
    }),
    changeConfigFile(file, {
      scope: "private",
      field: "merge.mode",
      action: "set",
      value: '"queue"',
    }),
    changeConfigFile(file, {
      scope: "private",
      queueLanes: { workflowId: "other", lanes: 4 },
    }),
  ]);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
    version: 1,
    merge: { mode: "queue" },
    queues: { "lane-turn": { lanes: 3 }, other: { lanes: 4 } },
  });
});

async function refusedOverride(fixture: Scene, expectedLanes: number) {
  const reply = await lanes(fixture, {
    lanes: 3,
    expectedLanes,
    commandId: `override-${String(expectedLanes)}`,
  });
  assert.equal(reply["code"], "queue-setting-failed", JSON.stringify(reply));
  assert.match(
    String(reply["detail"]),
    /CLOVING_QUEUES.*environment.*retained start/,
  );
  const status = await call(fixture, { operation: "status", parameters: {} });
  assert.equal(field(workflowQueue(status), "lanes"), expectedLanes);
  const file = privateSettingsPath(
    { XDG_CONFIG_HOME: join(fixture.root, "config") },
    fixture.repository,
  );
  assert.equal(existsSync(file), false);
}

await test("CLV-377 a real daemon refuses controlling environment and retained start overrides without writing", () =>
  withoutChildren(async () => {
    const fixture = await laneScene();
    await workflow(fixture);
    await fixture.start({
      XDG_CONFIG_HOME: join(fixture.root, "config"),
      CLOVING_QUEUES: '{"lane-turn":{"lanes":4}}',
      CLOVING_NEXT_COMMAND: '["false"]',
      CLOVING_QUEUE_SECONDS: "3600",
    });
    await refusedOverride(fixture, 4);
    const result = await runCli(
      ["restart", "--json", "--set", 'queues={"lane-turn":{"lanes":5}}'],
      { directory: fixture.repository, runtime: fixture.runtimeDirectory },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    await refusedOverride(fixture, 5);
  }));
