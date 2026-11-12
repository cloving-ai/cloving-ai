import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { clientCommand } from "../src/cli/runtime-directory.ts";
import { record } from "../src/protocol.ts";
import { applyLocalPreset } from "../tools/local-preset.ts";
import { localCommand, localCommandPrefix } from "../tools/template-command.ts";
import { copyTemplate } from "../tools/template-copy.ts";
import { templateRoot } from "../tools/template-files.ts";
import { workflowTestLoader } from "../tools/workflow-test-loader.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

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
    await assertCopiedTests(directory, folder);
  }));

await test("the local preset rejects a workflow that lost an expected line", () =>
  withFiles({}, async (directory) => {
    const folder = await copiedDevelop(directory);
    await writeFile(join(folder, "develop.ts"), "not the develop workflow\n");
    await assert.rejects(
      applyLocalPreset({ folder, id: "develop" }),
      /local-preset-mismatch/,
    );
  }));

await test("the local preset rejects a workflow that still names a removed step", () =>
  withFiles({}, async (directory) => {
    const folder = await copiedDevelop(directory);
    const path = join(folder, "develop.ts");
    await writeFile(path, `${await readFile(path, "utf8")}\npreparePull\n`);
    await assert.rejects(
      applyLocalPreset({ folder, id: "develop" }),
      /local-preset-mismatch/,
    );
  }));

await test("the local preset rejects a declaration that has no workflow input", () =>
  withFiles({}, async (directory) => {
    const texts = ["[]\n", "{}\n", '{"workflow":{}}\n'];
    for (const [index, text] of texts.entries()) {
      const folder = await copiedDevelop(join(directory, String(index)));
      await writeFile(join(folder, "develop.declaration.json"), text);
      await assert.rejects(
        applyLocalPreset({ folder, id: "develop" }),
        /local-preset-mismatch/,
      );
    }
  }));

await test("a local command prefix names this program", () => {
  const packagePath = "/usr/local/lib/node_modules/cloving/tools";
  const oldPath = "/home/user/_npx-old/cloving/tools";
  assert.equal(
    localCommandPrefix({ packagePath, version: "9.9.9" }),
    "cloving",
  );
  assert.equal(
    localCommandPrefix({ packagePath: oldPath, version: "9.9.9" }),
    "cloving",
  );
  assert.equal(
    localCommand({
      prefix: "cloving",
      command: "start",
      repository: "/work/my repo",
    }),
    "cloving start --repository '/work/my repo'",
  );
});

await test("a printed start command puts the command before the repository", () => {
  const packagePath = "/home/user/.npm/_npx/abc/node_modules/cloving/tools";
  const printed = clientCommand({}, { packagePath, repository: "/work/repo" });
  const version = /cloving@(\S+)/.exec(printed)?.[1];
  assert.ok(version);
  const prefix = localCommandPrefix({ packagePath, version });
  assert.equal(`${prefix} --repository /work/repo`, printed);
  assert.equal(
    localCommand({ prefix, command: "start", repository: "/work/repo" }),
    `${prefix} start --repository /work/repo`,
  );
  assert.equal(
    localCommand({
      prefix: localCommandPrefix({
        packagePath,
        version: "9.9.9",
        runtimeDirectory: "/run dir",
      }),
      command: "start",
      repository: "/work/my repo",
    }),
    "CLOVING_RUNTIME_DIR='/run dir' npx cloving@9.9.9 start --repository '/work/my repo'",
  );
  assert.equal(
    localCommand({
      prefix: localCommandPrefix({ packagePath, version: "9.9.9" }),
      command: "start",
      repository: "/work/o'brien",
    }),
    "npx cloving@9.9.9 start --repository '/work/o'\\''brien'",
  );
  assert.equal(
    localCommand({
      prefix: localCommandPrefix({
        packagePath: "/usr/local/lib/node_modules/cloving/tools",
        version: "9.9.9",
        runtimeDirectory: "",
      }),
      command: "questions",
      repository: "/work/my repo",
    }),
    "cloving questions --repository '/work/my repo'",
  );
});

async function copiedDevelop(directory: string): Promise<string> {
  const folder = join(directory, "workflows");
  await copyTemplate({
    root: templateRoot(),
    name: "develop",
    id: "develop",
    folder,
    takenNames: new Set(),
    timeZone: "UTC",
  });
  return folder;
}

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

async function assertCopiedTests(directory: string, folder: string) {
  const copied = await readFile(join(folder, "develop.test.ts"), "utf8");
  assert.match(copied, /prompt-input-required/);
  assert.doesNotMatch(copied, /flow-tests/);
  const output = runCopiedTests(directory, folder);
  assert.match(output, /hands off without GitHub/);
  assert.doesNotMatch(output, /not ok|✖/);
}

function runCopiedTests(directory: string, folder: string): string {
  try {
    return execFileSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--import",
        workflowTestLoader(),
        "--test",
        join(folder, "develop.test.ts"),
      ],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: testMilliseconds(60000),
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      },
    );
  } catch (error) {
    throw new Error(
      `${childOutput(error, "stdout")}\n${childOutput(error, "stderr")}`,
      { cause: error },
    );
  }
}

function childOutput(error: unknown, key: "stdout" | "stderr"): string {
  if (typeof error !== "object" || error === null || !(key in error)) return "";
  const value: unknown = Reflect.get(error, key);
  return typeof value === "string" ? value : "";
}
