import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { writeLocalWorkflow } from "./workflow-folder-fixture.ts";
import {
  ended,
  field,
  items,
  reached,
  scene,
  withoutChildren,
} from "./self-host-fixture.ts";
import { call, parsed, runCli } from "./service-fixture.ts";

const note = "Merge the branch of the first run first.";

const failingOnce = `
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const log = new URL("./prompts.log", import.meta.url);
const first = !existsSync(log);
appendFileSync(log, JSON.stringify(prompt) + "\\n");
const line = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
line({ type: "system", subtype: "init", session_id: "session-1" });
if (first) {
  line({ type: "result", subtype: "error_during_execution", is_error: true, result: "The tests failed.", total_cost_usd: 0.01, session_id: "session-1", num_turns: 1 });
  process.exit(1);
}
writeFileSync("note-work.txt", "work\\n");
execFileSync("git", ["add", "note-work.txt"]);
execFileSync("git", ["-c", "user.name=Worker", "-c", "user.email=worker@example.invalid", "commit", "-q", "-m", "Add the work"]);
line({ type: "result", subtype: "success", is_error: false, result: "I merged the branch.\\nTicket status: complete", total_cost_usd: 0.01, session_id: "session-2", num_turns: 1 });
`;

async function prompts(root: string): Promise<readonly string[]> {
  const text = await readFile(join(root, "prompts.log"), "utf8").catch(
    () => "",
  );
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => String(JSON.parse(line)));
}

type Fixture = Awaited<ReturnType<typeof scene>>;

function statusOf(fixture: Fixture) {
  return async (runId: string): Promise<unknown> =>
    (await call(fixture, { operation: "status", parameters: { runId } }))[
      "run"
    ];
}

async function failedRun(fixture: Fixture): Promise<string> {
  const admitted = await call(fixture, {
    operation: "run",
    parameters: {
      workflowId: "develop",
      source: "ticket",
      submission: { ticket: "CLV-900" },
      commandId: "note-first",
    },
  });
  const runId = String(admitted["runId"]);
  await reached(async () =>
    field(await statusOf(fixture)(runId), "state") === "failed"
      ? true
      : undefined,
  );
  return runId;
}

async function receivedNote(fixture: Fixture, runId: string): Promise<unknown> {
  return reached(async () => {
    const [shown] = items(field(await statusOf(fixture)(runId), "notes"));
    const turn = field(shown, "receivedBy");
    const logged = (await prompts(fixture.root)).length === 2;
    return typeof turn === "string" && logged ? shown : undefined;
  });
}

await test("CLV-326 cloving run continue with --note gives the note to the first new Claude turn, and status shows the turn that got it", () =>
  withoutChildren(async () => {
    const fixture = await scene(failingOnce);
    await writeLocalWorkflow(fixture.repository);
    const daemon = await fixture.start();
    const environment = {
      directory: fixture.repository,
      runtime: fixture.runtimeDirectory,
    };
    try {
      const runId = await failedRun(fixture);
      const reply = parsed(
        await runCli(
          ["run", "continue", runId, "--from", "implement/claude-turn"].concat([
            "--note",
            note,
            "--json",
          ]),
          environment,
        ),
      );
      assert.equal(reply["kind"], "run-continued", JSON.stringify(reply));
      const continued = String(reply["runId"]);
      const received = await receivedNote(fixture, continued);
      const [first, second] = await prompts(fixture.root);
      assert.equal(first?.includes("Notes from the operator:"), false);
      assert.equal(
        second?.startsWith(`Notes from the operator:\n\n${note}\n\n`),
        true,
        String(second),
      );
      assert.equal(field(received, "text"), note);
      assert.equal(field(received, "source"), "continue");
      const text = await runCli(["status", continued], environment);
      assert.match(
        text.stdout,
        /\nNote at [0-9T:.-]+Z, got by implement\/claude-turn\/1: Merge the branch of the first run first\.\n/,
      );
    } finally {
      assert.equal(await ended(daemon), 0);
    }
  }));
