import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
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

const note = "Change only src/cli.ts.";

const steeredClaude = `
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const resumed = process.argv.indexOf("--resume");
const session = resumed < 0 ? null : process.argv[resumed + 1];
appendFileSync(new URL("./prompts.log", import.meta.url), JSON.stringify({ prompt, session }) + "\\n");
const line = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
line({ type: "system", subtype: "init", session_id: "session-1" });
if (session === null) setInterval(() => undefined, 1000);
else {
  writeFileSync("steer-work.txt", "work\\n");
  execFileSync("git", ["add", "steer-work.txt"]);
  execFileSync("git", ["-c", "user.name=Worker", "-c", "user.email=worker@example.invalid", "commit", "-q", "-m", "Add the work"]);
  line({ type: "result", subtype: "success", is_error: false, result: "I changed only src/cli.ts.\\nTicket status: complete", total_cost_usd: 0.01, session_id: "session-1", num_turns: 1 });
}
`;

interface Logged {
  readonly prompt: string;
  readonly session: string | null;
}

async function logged(root: string): Promise<readonly Logged[]> {
  const text = await readFile(join(root, "prompts.log"), "utf8").catch(
    () => "",
  );
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const value: unknown = JSON.parse(line);
      const session = field(value, "session");
      return {
        prompt: String(field(value, "prompt")),
        session: typeof session === "string" ? session : null,
      };
    });
}

async function sessionRecorded(journal: string): Promise<true | undefined> {
  const folders = await readdir(journal).catch(() => []);
  for (const folder of folders) {
    const text = await readFile(
      join(journal, folder, "attempt-1.json"),
      "utf8",
    ).catch(() => "{}");
    const value: unknown = JSON.parse(text);
    if (field(value, "sessionId") === "session-1") return true;
  }
  return undefined;
}

await test("CLV-327 cloving steer --now stops a Claude turn that records a session and resumes the same session with the note, and the turn keeps its round", () =>
  withoutChildren(async () => {
    const fixture = await scene(steeredClaude);
    await writeLocalWorkflow(fixture.repository);
    const daemon = await fixture.start();
    const environment = {
      directory: fixture.repository,
      runtime: fixture.runtimeDirectory,
    };
    const statusOf = async (runId: string): Promise<unknown> =>
      (await call(fixture, { operation: "status", parameters: { runId } }))[
        "run"
      ];
    try {
      const admitted = await call(fixture, {
        operation: "run",
        parameters: {
          workflowId: "develop",
          source: "ticket",
          submission: { ticket: "CLV-900" },
          commandId: "steer-first",
        },
      });
      const runId = String(admitted["runId"]);
      await reached(() => sessionRecorded(join(fixture.directory, "journal")));
      const reply = parsed(
        await runCli(
          ["steer", runId, "--text", note, "--now", "--json"],
          environment,
        ),
      );
      assert.equal(reply["kind"], "run-noted", JSON.stringify(reply));
      assert.equal(reply["delivery"], "now");
      const received = await reached(async () => {
        const [shown] = items(field(await statusOf(runId), "notes"));
        const turn = field(shown, "receivedBy");
        return typeof turn === "string" ? shown : undefined;
      });
      await reached(async () =>
        (await logged(fixture.root)).length === 2 ? true : undefined,
      );
      assert.deepEqual(await logged(fixture.root).then((all) => all[1]), {
        prompt: `A person sent this note while you worked:\n\n${note}`,
        session: "session-1",
      });
      assert.equal(field(received, "source"), "steer");
      assert.equal(field(received, "receivedBy"), reply["operationId"]);
      const text = await runCli(["status", runId], environment);
      assert.match(
        text.stdout,
        /\nNote at [0-9T:.-]+Z from steer, got by implement\/claude-turn\/1: Change only src\/cli\.ts\.\n/,
      );
    } finally {
      assert.equal(await ended(daemon), 0);
    }
  }));
