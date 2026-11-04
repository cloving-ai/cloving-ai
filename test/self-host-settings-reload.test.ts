import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { test } from "node:test";
import { record, type Fields } from "../src/protocol.ts";
import { operatorQuestion } from "./operator-restart-fixture.ts";
import {
  field,
  reached,
  scene,
  withoutChildren,
  type Scene,
} from "./self-host-fixture.ts";
import { call, runCli } from "./service-fixture.ts";
import { candidateDeclaration } from "./workflow-candidate-fixtures.ts";

const standInTurn = `
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
for await (const chunk of process.stdin) void chunk;
appendFileSync(join(import.meta.dirname, "turns.log"), JSON.stringify(process.argv.slice(2)) + "\\n");
writeFileSync(join(import.meta.dirname, "turn-started"), "");
while (!existsSync(join(import.meta.dirname, "release-turn"))) await delay(50);
const line = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
line({ type: "system", subtype: "init", session_id: "session-1" });
line({ type: "result", subtype: "success", is_error: false, result: "The review is done.", total_cost_usd: 0.01, usage: { input_tokens: 1000000, cache_read_input_tokens: 0, output_tokens: 0 }, session_id: "session-1", num_turns: 1 });
`;

const startEnvironment = {
  CLOVING_PROFILES: undefined,
  CLOVING_SELF_UPDATE_SECONDS: undefined,
  CLOVING_NOTIFY_COMMAND: undefined,
  CLOVING_QUEUE_SECONDS: undefined,
  CLOVING_QUEUE_LANES: undefined,
  CLOVING_TOKEN_PRICES: undefined,
  CLOVING_FALLBACK_MODELS: undefined,
  CLOVING_WORKFLOW_FOLDER: undefined,
};

function price(input: number) {
  return { input, cachedInput: 0, output: 0 };
}

async function reviewWorkflow(fixture: Scene): Promise<void> {
  const folder = join(fixture.repository, ".cloving/workflows");
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "review.ts"),
    `
import { protectedEffect } from "cloving/workflows/steps/protected-effect";
export async function reviewTurn(input: { cycleId: string }) {
  "use workflow";
  const turn = await protectedEffect({ scope: { phase: "review", operation: "turn", round: 1 }, capability: "claude", method: "run-turn:review", target: input.cycleId, payload: "Do the stand-in review.", units: 1 });
  return { kind: turn.kind === "completed" ? "handoff_requested" : "blocked", reason: "review" };
}`,
  );
  await writeFile(
    join(folder, "review.declaration.json"),
    JSON.stringify({
      ...candidateDeclaration,
      workflow: { ...candidateDeclaration.workflow, workflowId: "review" },
      methods: { claude: ["run-turn:review"] },
    }),
  );
}

async function triageWorkflow(folder: string): Promise<void> {
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "triage.ts"),
    `
import { waitForDecision } from "cloving/workflows/steps/wait-for-decision";
export async function triageOperator() {
  "use workflow";
  const decision = await waitForDecision({ gateId: "operator-answer", kind: "question", prompt: "triage" });
  return { kind: decision.decision === "answered" ? "handoff_requested" : "blocked", reason: "triage" };
}`,
  );
  await writeFile(
    join(folder, "triage.declaration.json"),
    JSON.stringify({
      ...candidateDeclaration,
      workflow: { ...candidateDeclaration.workflow, workflowId: "triage" },
    }),
  );
}

async function privateSettings(fixture: Scene, contents: string) {
  const id = createHash("sha256")
    .update(fixture.repository)
    .digest("hex")
    .slice(0, 8);
  const folder = join(fixture.root, "config/cloving/projects");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `repository-${id}.json`), contents);
}

function settingsText(settings: Fields): string {
  return JSON.stringify({ version: 1, ...settings });
}

function submitted(fixture: Scene, workflowId: string) {
  return call(fixture, {
    operation: "run",
    parameters: {
      workflowId,
      source: "declared",
      commandId: `${workflowId}-${String(Date.now())}`,
      submission: {},
    },
  });
}

async function completed(fixture: Scene, runId: string): Promise<void> {
  await reached(async () => {
    const status = await call(fixture, {
      operation: "status",
      parameters: { runId },
    });
    return field(status["run"], "state") === "completed" ? true : undefined;
  });
}

async function reloadReply(
  fixture: Scene,
): Promise<{ readonly status: number | null; readonly reply: Fields }> {
  const result = await runCli(["reload", "--json"], {
    directory: fixture.repository,
    runtime: fixture.runtimeDirectory,
  });
  return {
    status: result.status,
    reply: record(JSON.parse(result.stdout)) ?? {},
  };
}

async function reloaded(fixture: Scene): Promise<Fields> {
  const { status, reply } = await reloadReply(fixture);
  assert.equal(status, 0, JSON.stringify(reply));
  return reply;
}

async function refusal(fixture: Scene): Promise<unknown> {
  const { status, reply } = await reloadReply(fixture);
  assert.equal(status, 1, JSON.stringify(reply));
  return reply["code"];
}

async function turnStarted(fixture: Scene): Promise<void> {
  await reached(() =>
    Promise.resolve(
      existsSync(join(fixture.root, "turn-started")) ? true : undefined,
    ),
  );
  await rm(join(fixture.root, "turn-started"));
}

async function turnModels(fixture: Scene): Promise<readonly string[]> {
  const log = await readFile(join(fixture.root, "turns.log"), "utf8");
  return log
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const argumentsList: unknown = JSON.parse(line);
      assert.ok(Array.isArray(argumentsList));
      return String(argumentsList[argumentsList.indexOf("--model") + 1]);
    });
}

async function estimatedCosts(fixture: Scene): Promise<readonly unknown[]> {
  const journal = join(fixture.directory, "journal");
  const costs: [string, unknown][] = [];
  for (const name of await readdir(journal)) {
    const folder = join(journal, name);
    if (!existsSync(join(folder, "result.json"))) continue;
    const started = record(
      JSON.parse(await readFile(join(folder, "started.json"), "utf8")),
    );
    const outcome = record(
      JSON.parse(await readFile(join(folder, "result.json"), "utf8")),
    );
    const result = record(JSON.parse(String(outcome?.["result"])));
    costs.push([String(started?.["startedAt"]), result?.["estimatedCostUsd"]]);
  }
  return costs
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([, cost]) => cost);
}

async function changedDuringTurn(fixture: Scene): Promise<void> {
  const first = await submitted(fixture, "review");
  assert.equal(first["kind"], "run-admitted", JSON.stringify(first));
  await turnStarted(fixture);
  await privateSettings(
    fixture,
    settingsText({
      profiles: { review: { model: "new-model" } },
      tokenPrices: { "start-model": price(3), "new-model": price(5) },
      fallbackModels: ["new-fallback"],
      queue: { lanes: 2 },
      notify: { command: ["notify-stand-in"] },
    }),
  );
  const reply = await reloaded(fixture);
  assert.equal(reply["status"], "unchanged");
  assert.deepEqual(reply["reloadedFields"], [
    "fallbackModels",
    "profiles",
    "tokenPrices",
  ]);
  assert.deepEqual(reply["restartFields"], ["notify.command", "queue.lanes"]);
  const second = await submitted(fixture, "review");
  assert.equal(second["kind"], "run-admitted", JSON.stringify(second));
  await turnStarted(fixture);
  await writeFile(join(fixture.root, "release-turn"), "");
  await completed(fixture, String(first["runId"]));
  await completed(fixture, String(second["runId"]));
  assert.deepEqual(await turnModels(fixture), ["start-model", "new-model"]);
}

async function refusedReloads(fixture: Scene): Promise<void> {
  await privateSettings(fixture, "not JSON");
  assert.equal(await refusal(fixture), "invalid-config-json");
  await privateSettings(
    fixture,
    settingsText({
      profiles: { review: { model: "third-model", harness: "unknown" } },
    }),
  );
  assert.equal(await refusal(fixture), "harness-no-worker");
  await privateSettings(
    fixture,
    settingsText({
      profiles: { review: { model: "new-model" } },
      tokenPrices: { "start-model": price(3), "new-model": price(5) },
      fallbackModels: ["new-fallback"],
      queue: { lanes: 2 },
      notify: { command: ["notify-stand-in"] },
    }),
  );
  const kept = await reloaded(fixture);
  assert.deepEqual(kept["reloadedFields"], []);
  assert.deepEqual(kept["restartFields"], ["notify.command", "queue.lanes"]);
  await privateSettings(
    fixture,
    settingsText({
      profiles: { review: { model: "third-model", harness: "unknown" } },
    }),
  );
  assert.equal(await refusal(fixture), "harness-no-worker");
  const third = await submitted(fixture, "review");
  await completed(fixture, String(third["runId"]));
  assert.deepEqual(await turnModels(fixture), [
    "start-model",
    "new-model",
    "new-model",
  ]);
}

await test("CLV-253 cloving reload gives new profile turns the new private profiles and prices, keeps the turn in work, and names the restart fields", () =>
  withoutChildren(async () => {
    const fixture = await scene(standInTurn);
    await reviewWorkflow(fixture);
    await privateSettings(
      fixture,
      settingsText({
        profiles: { review: { model: "start-model" } },
        tokenPrices: { "start-model": price(2), "new-model": price(2) },
      }),
    );
    await fixture.start({
      ...startEnvironment,
      XDG_CONFIG_HOME: join(fixture.root, "config"),
    });
    await changedDuringTurn(fixture);
    assert.deepEqual(await estimatedCosts(fixture), [2, 5]);
    await refusedReloads(fixture);
  }));

async function profilesFile(fixture: Scene, contents: string) {
  await writeFile(join(fixture.root, "profiles.json"), contents);
}

async function nextModel(fixture: Scene): Promise<string | undefined> {
  const run = await submitted(fixture, "review");
  assert.equal(run["kind"], "run-admitted", JSON.stringify(run));
  await completed(fixture, String(run["runId"]));
  return (await turnModels(fixture)).at(-1);
}

await test("CLV-253 with a relative CLOVING_PROFILES path the reload reads that file again, ignores the private profiles, and applies a new workflow folder", () =>
  withoutChildren(async () => {
    const fixture = await scene(standInTurn);
    await writeFile(join(fixture.root, "release-turn"), "");
    await reviewWorkflow(fixture);
    await profilesFile(
      fixture,
      JSON.stringify({ profiles: { review: { model: "file-model" } } }),
    );
    await privateSettings(
      fixture,
      settingsText({ profiles: { review: { model: "private-model" } } }),
    );
    await fixture.start({
      ...startEnvironment,
      XDG_CONFIG_HOME: join(fixture.root, "config"),
      CLOVING_PROFILES: relative(
        fixture.repository,
        join(fixture.root, "profiles.json"),
      ),
    });
    await privateSettings(
      fixture,
      settingsText({ profiles: { review: { model: "changed-private" } } }),
    );
    const ignored = await reloaded(fixture);
    assert.deepEqual(ignored["reloadedFields"], []);
    assert.deepEqual(ignored["restartFields"], []);
    assert.equal(await nextModel(fixture), "file-model");
    await profilesFile(
      fixture,
      JSON.stringify({ profiles: { review: { model: "changed-file" } } }),
    );
    assert.deepEqual((await reloaded(fixture))["reloadedFields"], ["profiles"]);
    assert.equal(await nextModel(fixture), "changed-file");
    await profilesFile(fixture, "not JSON");
    assert.equal(await refusal(fixture), "invalid-profiles");
    assert.equal(await nextModel(fixture), "changed-file");
    await profilesFile(
      fixture,
      JSON.stringify({ profiles: { review: { model: "changed-file" } } }),
    );
    const folder = join(fixture.root, "team-workflows");
    await triageWorkflow(folder);
    await privateSettings(fixture, settingsText({ workflows: { folder } }));
    const moved = await reloaded(fixture);
    assert.deepEqual(moved["reloadedFields"], ["workflows.folder"]);
    assert.deepEqual(moved["workflows"], ["review", "triage"]);
    const triage = await submitted(fixture, "triage");
    assert.equal(triage["kind"], "run-admitted", JSON.stringify(triage));
    await operatorQuestion(fixture, String(triage["runId"]));
  }));
