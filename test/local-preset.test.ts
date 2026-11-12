import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { record } from "../src/protocol.ts";
import { applyLocalPreset } from "../tools/local-preset.ts";
import { copyTemplate } from "../tools/template-copy.ts";
import { templateRoot } from "../tools/template-files.ts";
import { withFiles } from "./quality/files-fixture.ts";

await test("the local preset applies the nine first-run choices in code", () =>
  withFiles({}, async (directory) => {
    const folder = join(directory, "workflows");
    await copyTemplate({
      root: templateRoot(),
      name: "develop",
      id: "develop",
      folder,
      takenNames: new Set(),
      timeZone: "UTC",
    });
    await applyLocalPreset({ folder, id: "develop" });
    await assertWorkflow(folder);
    await assertDeclaration(folder);
    await assertChoices(folder);
  }));

async function assertWorkflow(folder: string) {
  const workflow = await readFile(join(folder, "develop.ts"), "utf8");
  assert.match(workflow, /localRound as developRound/);
  assert.match(workflow, /promptInput\(request\)/);
  assert.doesNotMatch(
    workflow,
    /preparePull|ticketInput|blockTicket|labelTicket/,
  );
}

async function assertDeclaration(folder: string) {
  const parsed: unknown = JSON.parse(
    await readFile(join(folder, "develop.declaration.json"), "utf8"),
  );
  const declaration = record(parsed);
  const workflow = record(declaration?.["workflow"]);
  const input = record(workflow?.["input"]);
  assert.ok(declaration);
  assert.ok(workflow);
  assert.ok(input);
  assert.deepEqual(workflow["capabilities"], ["claude"]);
  assert.equal(workflow["queue"], undefined);
  assert.equal(workflow["effectLimit"], 87);
  assert.deepEqual(input["fields"], { prompt: { type: "string" } });
  assert.deepEqual(declaration["methods"], { claude: ["run-turn"] });
}

async function assertChoices(folder: string) {
  const scenarios = await readFile(
    join(folder, "develop/scenarios.ts"),
    "utf8",
  );
  for (const choice of [
    'input: "task-text"',
    'select: "person"',
    'verify: "none"',
    'accept: "person"',
    'merge: "local"',
    'partial: "person"',
    'recovery: "stop"',
    'lessons: "none"',
    'demo: "none"',
  ])
    assert.match(scenarios, new RegExp(choice));
  assert.match(
    await readFile(join(folder, "develop/recovery.ts"), "utf8"),
    /recovery = "stop"/,
  );
  assert.match(
    await readFile(join(folder, "develop/lessons.ts"), "utf8"),
    /lessons = "none"/,
  );
  const accept = await readFile(join(folder, "develop/accept.ts"), "utf8");
  assert.match(accept, /reviewByPerson\(\{ subject \}\)/);
  assert.doesNotMatch(accept, /greptile/);
}
