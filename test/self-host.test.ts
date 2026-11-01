import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { candidatePackageRoot } from "./candidate-package-fixture.ts";
import { writeLocalWorkflow } from "./workflow-folder-fixture.ts";
import {
  ended,
  fakeClaude,
  field,
  items,
  reached,
  scene,
  withoutChildren,
  type Asked,
} from "./self-host-fixture.ts";
import { call, parsed, runCli } from "./service-fixture.ts";

const slowClaude = `
import { setTimeout as delay } from "node:timers/promises";
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const line = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
line({ type: "system", session_id: "session-1" });
if (process.argv.includes("--resume")) {
  if (process.argv.at(-1) !== "session-1" || !prompt.startsWith("This turn stopped because the Cloving daemon restarted.")) process.exit(2);
  line({ type: "result", subtype: "success", is_error: false, result: "The resumed task is done.\\nTicket status: complete", session_id: "session-1", total_cost_usd: 0.02 });
} else await delay(60000);
`;

function prompted(prompt: string, commandId: string): Record<string, unknown> {
  return {
    workflowId: "develop",
    source: "prompt",
    submission: { prompt },
    commandId,
  };
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

async function resumedTurn(): Promise<void> {
  const { directory, repository, runtimeDirectory, start } = await scene(
    slowClaude,
    join(candidatePackageRoot, "src/cli.ts"),
  );
  await writeLocalWorkflow(repository, { input: "prompt" });
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
  assert.equal(admitted["kind"], "run-admitted", JSON.stringify(admitted));
  const runId = String(admitted["runId"]);
  await reached(async () =>
    (await effects(runId)).slice(1).includes("running") ? runId : undefined,
  );
  await reached(async () => {
    const journal = join(directory, "journal");
    const [folder] = await readdir(journal);
    if (folder === undefined) return undefined;
    const attempt = await readFile(
      join(journal, folder, "attempt-1.json"),
      "utf8",
    ).catch(() => undefined);
    return attempt !== undefined &&
      field(JSON.parse(attempt), "sessionId") === "session-1"
      ? true
      : undefined;
  });
  assert.equal(await ended(first), 0);
  const second = await start();
  const decision = await reached(
    async () => items((await asked("questions", { runId }))["decisions"])[0],
  );
  const status = await asked("status", { runId });
  assert.match(
    String(field(items(field(status["run"], "workerTurns"))[0], "summary")),
    /The resumed task is done/,
  );
  assert.equal(field(decision, "type"), "approval");
  await approved(asked, { runId, decision });
  assert.deepEqual(await effects(runId), ["completed", "completed"]);
  assert.equal(await ended(second), 0);
}

await test("CLV-239 a daemon restart resumes its Claude turn and the workflow completes after approval", () =>
  withoutChildren(resumedTurn));

await test("CLV-070 start passes the next command to the daemon and run next admits the selected ticket", () =>
  withoutChildren(async () => {
    const { repository, runtimeDirectory, start } = await scene(
      fakeClaude.replace(
        "I added the file ticket-work.txt.",
        "I added the file ticket-work.txt.\\nTicket status: complete",
      ),
      join(candidatePackageRoot, "src/cli.ts"),
    );
    await writeLocalWorkflow(repository);
    const daemon = await start({
      CLOVING_NEXT_COMMAND: JSON.stringify([
        process.execPath,
        "-e",
        'if (process.argv.length !== 1) process.exit(2); console.log("CLV-900");',
      ]),
    });
    const admitted = await runCli(
      ["run", "develop", "--next", "--command-id", "c-next", "--json"],
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
    assert.equal(field(decision, "type"), "approval");
    const status = await call(
      { runtimeDirectory },
      { operation: "status", parameters: { runId: field(receipt, "runId") } },
    );
    assert.equal(field(status["run"], "ticketId"), "CLV-900");
    assert.equal(await ended(daemon), 0);
  }));
