import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { record } from "../src/protocol.ts";
import { analyzeWorkflowCandidate } from "../tools/workflow-candidate-source.ts";
import {
  candidatePackageRoot,
  loadWorkflowFolders,
  preparedProject,
} from "./candidate-package-fixture.ts";
import { withDoctor, type DoctorScene } from "./doctor-fixture.ts";

const localMethods = ["reviewByPerson", "run-turn", "waitForDecision"];

async function initializedLocally(scene: DoctorScene): Promise<string> {
  const harness = await scene.program(
    "claude",
    'if (process.argv[2] === "--version") console.log("1.0.0 (Claude Code)"); else process.exit(7);',
  );
  const result = spawnSync(
    process.execPath,
    [resolve("src/cli.ts"), "init", "--local", "--harness", harness],
    { cwd: scene.repository, env: scene.environment, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return join(scene.repository, ".cloving/workflows");
}

function folders(scene: DoctorScene) {
  return {
    repository: scene.repository,
    home: scene.root,
    xdgConfigHome: join(scene.root, "config"),
  };
}

await test("#820 a fresh local init passes normal admission with one manual workflow and no GitHub effect", () =>
  withDoctor(async (scene) => {
    const folder = await initializedLocally(scene);
    const loaded = await loadWorkflowFolders(folders(scene));
    assert.deepEqual(loaded.refusals, []);
    assert.equal(loaded.candidates.length, 1);
    const [candidate] = loaded.candidates;
    assert.ok(candidate);
    assert.equal(
      candidate.source,
      await readFile(join(folder, "develop.ts"), "utf8"),
    );
    assert.doesNotMatch(candidate.source, /developFeed|protectedEffect|feed-/);
    const { analysis } = analyzeWorkflowCandidate(candidate.source, {
      packageRoot: candidatePackageRoot,
      helpers: candidate.helpers,
    });
    assert.deepEqual(Object.keys(analysis.workflows ?? {}), ["develop"]);
    const effects = analysis.workflows?.["develop"]?.effects ?? [];
    assert.deepEqual(
      Array.from(new Set(effects.map((effect) => effect.method))).sort(),
      localMethods,
    );
    assert.equal(
      effects.some((effect) => effect.capability === "github"),
      false,
    );
    const declaration = record(JSON.parse(candidate.declaration));
    const workflow = record(declaration?.["workflow"]);
    assert.ok(workflow);
    assert.equal(workflow["queue"], undefined);
    assert.deepEqual(workflow["capabilities"], ["claude"]);
    assert.deepEqual(declaration?.["methods"], { claude: ["run-turn"] });
  }));

await test("#820 a fresh local init compiles with the SDK to one develop workflow without a queue", () =>
  withDoctor(async (scene) => {
    await initializedLocally(scene);
    const prepared = preparedProject({
      ...folders(scene),
      project: join(scene.root, "project"),
    });
    assert.deepEqual(prepared["workflowRefusals"], []);
    const declarations = prepared["declarations"];
    assert.ok(Array.isArray(declarations));
    assert.equal(declarations.length, 1);
    const develop = record(declarations[0]);
    assert.equal(develop?.["workflowId"], "develop");
    assert.equal(develop["functionName"], "develop");
    assert.equal(develop["queue"], undefined);
    assert.deepEqual(develop["capabilities"], ["claude"]);
    assert.deepEqual(Object.keys(record(prepared["manifests"]) ?? {}), [
      "develop",
    ]);
  }));

await test("#820 a fresh local init removes a renamed develop feed when another workflow owns its name", () =>
  withDoctor(async (scene) => {
    const reserved = join(scene.repository, ".cloving/workflows/reserved.ts");
    await mkdir(dirname(reserved), { recursive: true });
    await writeFile(
      reserved,
      'export async function developFeed() {\n  "use workflow";\n  return {};\n}\n',
    );
    const folder = await initializedLocally(scene);
    assert.match(
      await readFile(join(folder, "develop/feed-tests.ts"), "utf8"),
      /developFeedWorkflow/,
    );
    const loaded = await loadWorkflowFolders(folders(scene));
    assert.deepEqual(
      loaded.refusals.filter((refusal) => refusal.label === "develop.ts"),
      [],
    );
    const develop = loaded.candidates.find(
      (candidate) => candidate.baseName === "develop",
    );
    assert.ok(develop);
    assert.doesNotMatch(develop.source, /developFeed|protectedEffect|feed-/);
    const declaration = record(JSON.parse(develop.declaration));
    assert.equal(record(declaration?.["workflow"])?.["queue"], undefined);
    assert.deepEqual(declaration?.["methods"], { claude: ["run-turn"] });
  }));

await test("#820 normal admission still refuses an undeclared extra workflow function in the local preset", () =>
  withDoctor(async (scene) => {
    const folder = await initializedLocally(scene);
    await appendFile(
      join(folder, "develop.ts"),
      '\nexport async function developExtra() {\n  "use workflow";\n  return { kind: "blocked" as const };\n}\n',
    );
    const loaded = await loadWorkflowFolders(folders(scene));
    assert.equal(loaded.candidates.length, 0);
    assert.deepEqual(loaded.refusals, [
      { scope: "project", label: "develop.ts", codes: ["unsupported-source"] },
    ]);
  }));
