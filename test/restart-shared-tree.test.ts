import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { field } from "./self-host-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";
import {
  admittedTurn,
  finishedRun,
  restartedTurns,
  startedTurn,
  until,
  withTurnHost,
} from "./restart-turn-fixture.ts";

const sharedTurns = `
import { spawn } from "node:child_process";
import { existsSync, renameSync, writeFileSync } from "node:fs";
let prompt = "";
for await (const chunk of process.stdin) prompt += chunk;
const name = prompt.includes("Turn a") ? "a" : "b";
const place = (file) => new URL("./" + file, import.meta.url);
const noted = (file, text) => {
  writeFileSync(place(file + ".part"), text);
  renameSync(place(file + ".part"), place(file));
};
const line = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
line({ type: "system", subtype: "init", session_id: "session-" + name });
if (name === "b") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "ignore" });
  noted("turn-b-child.pid", String(child.pid));
}
noted("turn-" + name + ".pid", String(process.pid));
while (!existsSync(place("end-" + name))) await new Promise((done) => setTimeout(done, 100));
line({ type: "result", subtype: "success", is_error: false, result: "Turn " + name + " ended.", total_cost_usd: 0.25, session_id: "session-" + name, num_turns: 1 });
process.exit(0);
`;

function alive(processId: number): boolean {
  try {
    return process.kill(processId, 0);
  } catch {
    return false;
  }
}

async function noted(root: string, name: string): Promise<number> {
  return await until(async () => {
    const file = join(root, `${name}.pid`);
    return existsSync(file) ? Number(await readFile(file, "utf8")) : undefined;
  });
}

function keptLine(processId: number, runId: string): RegExp {
  return new RegExp(
    `^turn: kept process ${String(processId)} \\(.+\\) of the active run ${runId} in the work tree `,
    "m",
  );
}

await test(
  "CLV-347 after a restart, the end of turn A in a shared work tree keeps turn B and its child, and the service log has a kept process line for each process of turn B",
  { timeout: 120_000 },
  () =>
    withTurnHost({ script: sharedTurns }, async ({ fixture, output }) => {
      const runA = await admittedTurn(fixture, "a");
      await startedTurn(fixture, runA);
      await noted(fixture.root, "turn-a");
      const runB = await admittedTurn(fixture, "b");
      const turnB = await startedTurn(fixture, runB);
      const turnProcess = await noted(fixture.root, "turn-b");
      const child = await noted(fixture.root, "turn-b-child");
      const turns = await restartedTurns(fixture, []);
      assert.deepEqual(field(turns, "connected"), [runA, runB].sort());
      await writeFile(join(fixture.root, "end-a"), "");
      const endedA = await finishedRun(fixture, runA);
      assert.equal(field(endedA, "state"), "completed", JSON.stringify(endedA));
      const processes = [turnB.launch.processId, turnProcess, child];
      await until(
        () =>
          Promise.resolve(
            processes.every((processId) =>
              keptLine(processId, runB).test(output()),
            )
              ? true
              : undefined,
          ),
        testMilliseconds(10_000),
      ).catch(() => undefined);
      for (const processId of processes) {
        assert.equal(alive(processId), true, String(processId));
        assert.match(output(), keptLine(processId, runB));
      }
      await writeFile(join(fixture.root, "end-b"), "");
      const endedB = await finishedRun(fixture, runB);
      assert.equal(field(endedB, "state"), "completed", JSON.stringify(endedB));
    }),
);
