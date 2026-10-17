import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  ended,
  field,
  git,
  items,
  reached,
  scene,
  withoutChildren,
  type Asked,
} from "./self-host-fixture.ts";
import { call, parsed, runCli } from "./service-fixture.ts";
import { watchedModel } from "./watch-fixture.ts";

async function watchedRun(directory: string): Promise<readonly unknown[]> {
  const model = await watchedModel(join(directory, "run"));
  const run = field(field(model, "runs"), 0);
  const turn = field(field(run, "turns"), 0);
  return [
    field(model, "service"),
    field(run, "state"),
    String(field(field(field(run, "decisions"), 0), "prompt")).slice(0, 60),
    field(turn, "outcome"),
    field(turn, "activity"),
  ];
}

const slowClaude = `
import { setTimeout as delay } from "node:timers/promises";
for await (const chunk of process.stdin) chunk.toString();
await delay(60000);
`;

function ticket(id: string, commandId: string): Record<string, unknown> {
  return {
    workflowId: "develop-ticket",
    source: "ticket",
    submission: { ticket: id },
    commandId,
  };
}

function prompted(prompt: string, commandId: string): Record<string, unknown> {
  return {
    workflowId: "develop-prompt",
    source: "prompt",
    submission: { prompt },
    commandId,
  };
}

async function reviewed(
  asked: Asked,
  work: {
    readonly runId: string;
    readonly repository: string;
    readonly directory: string;
  },
): Promise<unknown> {
  const { runId, repository } = work;
  const decision = await reached(
    async () => items((await asked("questions", { runId }))["decisions"])[0],
  );
  const prompt = String(field(decision, "prompt"));
  const [branch = ""] = /cloving\/clv-900-[a-f0-9]+/.exec(prompt) ?? [];
  assert.equal(field(decision, "type"), "approval");
  assert.match(
    prompt,
    /^Review the work of the Claude worker for the ticket CLV-900\./,
  );
  assert.match(prompt, /I added the file ticket-work\.txt\./);
  assert.match(prompt, /ticket-work\.txt \| 1 \+/);
  assert.match(
    git(repository, ["log", "--oneline", branch]),
    /Add the ticket work/,
  );
  assert.equal(
    git(repository, ["show", `${branch}:ticket-work.txt`]),
    "the last line of CLV-900\n",
  );
  await reached(async () => {
    const listed = await asked("events", { after: 0, limit: 100, runId });
    return JSON.stringify(listed["events"]).includes("gate.wait-registered")
      ? listed
      : undefined;
  });
  assert.deepEqual(await watchedRun(work.directory), [
    "up",
    "waiting_gate",
    "Review the work of the Claude worker for the ticket CLV-900.",
    "completed",
    [
      { kind: "say", text: "I add the file." },
      { kind: "tool", text: "Bash: git commit" },
      {
        kind: "result",
        text: "I added the file ticket-work.txt. (cost 0.01 USD)",
      },
    ],
  ]);
  return decision;
}

async function approved(
  asked: Asked,
  work: { readonly runId: string; readonly decision: unknown },
): Promise<unknown> {
  const { runId, decision } = work;
  const recorded = await asked("decision", {
    command: "approve",
    reference: field(decision, "decisionId"),
    expectedRevision: field(decision, "revision"),
    generation: field(decision, "generation"),
    subjectDigest: field(decision, "subjectDigest"),
    commandId: "c-approve",
  });
  assert.notEqual(recorded["kind"], "error", JSON.stringify(recorded));
  return await reached(async () => {
    const run = field(await asked("status", { runId }), "run");
    return field(run, "state") === "completed" ? run : undefined;
  });
}

async function ticketRun(): Promise<void> {
  const { directory, repository, runtimeDirectory, start, refused } =
    await scene();
  const asked: Asked = (operation, parameters) =>
    call({ runtimeDirectory }, { operation, parameters });
  assert.match(
    await refused("65"),
    /The daemon did not start: host-unavailable: invalid-host-bound: 65/,
  );
  const first = await start({ CLOVING_CODEX_COMMAND: "not JSON" });
  const empty = await asked("run", ticket(" ", "c-0"));
  assert.deepEqual(
    [empty["kind"], empty["code"]],
    ["error", "invalid-submission"],
  );
  assert.match(await refused(), /The daemon did not start: [a-z-]+: /);
  const absent = await asked("run", ticket("CLV-404", "c-404"));
  assert.deepEqual(
    [absent["kind"], absent["code"]],
    ["error", "ticket-not-available"],
  );
  const admitted = await asked("run", ticket("CLV-900", "c-1"));
  const runId = String(admitted["runId"]);
  const decision = await reviewed(asked, { runId, repository, directory });
  assert.equal(await ended(first), 0);
  assert.equal(existsSync(join(directory, "worktrees")), true);
  assert.equal(
    field(await watchedModel(join(directory, "run")), "service"),
    "down",
  );
  const second = await start();
  const state = await approved(asked, { runId, decision });
  assert.equal(field(field(state, "budget"), "spent"), 1);
  assert.equal(await ended(second), 0);
}

async function stoppedTurn(): Promise<void> {
  const { runtimeDirectory, start } = await scene(slowClaude);
  const asked: Asked = (operation, parameters) =>
    call({ runtimeDirectory }, { operation, parameters });
  const effects = async (runId: string): Promise<readonly unknown[]> => {
    const run = field(await asked("status", { runId }), "run");
    return [
      field(run, "state"),
      ...items(field(run, "effects")).map((effect) => field(effect, "state")),
    ];
  };
  const first = await start();
  const admitted = await asked("run", prompted("A long ticket.", "c-1"));
  const runId = String(admitted["runId"]);
  await reached(async () =>
    (await effects(runId)).slice(1).includes("running") ? runId : undefined,
  );
  assert.equal(await ended(first), 0);
  const second = await start();
  const shown = await reached(async () => {
    const [state, effect] = await effects(runId);
    return state === "completed" ? [state, effect] : undefined;
  });
  assert.deepEqual(shown, ["completed", "stopped"]);
  assert.equal(await ended(second), 0);
}

async function roundsRun(): Promise<void> {
  const { directory, repository, runtimeDirectory, start } = await scene();
  const asked: Asked = (operation, parameters) =>
    call({ runtimeDirectory }, { operation, parameters });
  const daemon = await start();
  const admitted = await asked("run", ticket("CLV-900", "c-1"));
  const runId = String(admitted["runId"]);
  const first = await reviewed(asked, { runId, repository, directory });
  const feedback = "Add a test for an empty list.";
  const denied = await asked("decision", {
    command: "deny",
    reference: field(first, "decisionId"),
    expectedRevision: field(first, "revision"),
    generation: field(first, "generation"),
    subjectDigest: field(first, "subjectDigest"),
    commandId: "c-deny",
    text: feedback,
  });
  assert.equal(denied["decision"], "denied", JSON.stringify(denied));
  const second = await reached(async () => {
    const [decision] = items(
      (await asked("questions", { runId }))["decisions"],
    );
    return field(decision, "gateId") === "review-2" ? decision : undefined;
  });
  const prompt = String(field(second, "prompt"));
  const place = /\nBranch: (.*)\nWork tree: .*\n/;
  const [shown = "", branch = ""] = place.exec(prompt) ?? [];
  assert.equal(shown, place.exec(String(field(first, "prompt")))?.[0]);
  assert.match(prompt, /\nRound: 2 of 3\n/);
  assert.match(
    prompt,
    /\nCommits:\n[0-9a-f]{7,} Add the feedback work\n[0-9a-f]{7,} Add the ticket work\n/,
  );
  assert.match(
    prompt,
    /\nChanged files:\n feedback-work\.txt \| 1 \+\n ticket-work\.txt +\| 1 \+\n/,
  );
  assert.equal(
    git(repository, ["show", `${branch}:feedback-work.txt`]),
    `${feedback}\n`,
  );
  assert.deepEqual(field(second, "feedback"), [
    { decisionId: field(first, "decisionId"), text: feedback },
  ]);
  const state = await approved(asked, { runId, decision: second });
  assert.equal(field(field(state, "budget"), "spent"), 2);
  assert.equal(await ended(daemon), 0);
}

await test("CLV-010 a stop of the daemon stops a Claude turn in work and reports it, and after the next start the run has an end with the stopped effect", () =>
  withoutChildren(stoppedTurn));

await test("CLV-016 the start command starts a daemon that refuses a host bound that is too large, a second daemon, an empty ticket ID and a ticket that the board does not have, reads one ticket by its ID from the ticket command, runs it with the Claude worker in a work tree, waits for the approval of the operator across a restart, and completes the run after the approval", () =>
  withoutChildren(ticketRun));

await test("CLV-062 a denial with a feedback text starts round 2 in the same work tree and on the same branch, its review lists the commits and the files of both rounds, and an approval completes the run", () =>
  withoutChildren(roundsRun));

await test("CLV-070 start passes the next command to the daemon and run next admits the selected ticket", () =>
  withoutChildren(async () => {
    const { repository, runtimeDirectory, start } = await scene();
    const daemon = await start({
      CLOVING_NEXT_COMMAND: JSON.stringify([
        process.execPath,
        "-e",
        'if (process.argv.length !== 1) process.exit(2); console.log("CLV-900");',
      ]),
    });
    const admitted = await runCli(
      ["run", "develop-ticket", "--next", "--command-id", "c-next", "--json"],
      { directory: repository, runtime: runtimeDirectory },
    );
    assert.equal(admitted.status, 0, admitted.stdout + admitted.stderr);
    const receipt = parsed(admitted);
    assert.equal(field(receipt, "kind"), "run-admitted");
    const decision = await reached(async () => {
      const reply = await call(
        { runtimeDirectory },
        {
          operation: "questions",
          parameters: { runId: field(receipt, "runId") },
        },
      );
      return items(reply["decisions"])[0];
    });
    assert.match(String(field(decision, "prompt")), /ticket CLV-900/);
    assert.equal(await ended(daemon), 0);
  }));
