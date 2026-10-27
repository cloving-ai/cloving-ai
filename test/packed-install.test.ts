import { packedCandidateAdmission } from "./packed-candidate-admission.ts";
import {
  packedDevelopTemplate,
  packedTemplateSources,
} from "./develop-template-fixture.ts";
import { packedDoctor } from "./packed-doctor.ts";
import { stopChildGroup } from "./stop-child.ts";
import {
  operatorFiles,
  operatorRefusals,
  runOperator,
} from "./operator-startup-fixture.ts";
import { packagedFontFiles, servedFonts } from "./watch-font-fixture.ts";
import { packedWorkflowFolders } from "./packed-workflow-folders.ts";
import { packedWorkflowTesting } from "./packed-workflow-testing.ts";
import { startPackedHost, ready, boundedExit } from "./packed-host-fixture.ts";
import {
  packedPollingFiles,
  startPackedPolling,
  resumePackedPolling,
} from "./packed-sleep-polling.ts";
import {
  packedDecisionFiles,
  packedNotifyCommand,
  runPackedDecision,
} from "./packed-decision-wait.ts";
import assert from "node:assert/strict";
import {
  installPacked,
  packedCommand as command,
} from "./packed-install-fixture.ts";
import {
  mkdtemp,
  readFile,
  lstat,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { field, items } from "./self-host-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";
import { reviewStages } from "./watch-board-fixture.ts";

const checkout = resolve(import.meta.dirname, "..");

interface PackageMetadata {
  readonly exports: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

function packageMetadata(value: unknown): value is PackageMetadata {
  const exports = field(value, "exports");
  if (!exports || typeof exports !== "object" || Array.isArray(exports))
    return false;
  return Object.values(exports).every(
    (entry: unknown) =>
      entry !== null &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      Object.values(entry).every(
        (target: unknown) => typeof target === "string",
      ),
  );
}

async function installed(root: string): Promise<string> {
  await rm(join(checkout, "dist"), { recursive: true, force: true });
  command("npm", { args: ["run", "build"], cwd: checkout });
  const packed: unknown = JSON.parse(
    command("npm", {
      args: ["pack", "--ignore-scripts", "--json", "--pack-destination", root],
      cwd: checkout,
    }),
  );
  const archive = items(packed)[0];
  const paths = items(field(archive, "files")).map((file) =>
    String(field(file, "path")),
  );
  assert.ok(paths.length > 100);
  assert.deepEqual(
    paths.filter((path) => path.endsWith(".ts") && !path.endsWith(".d.ts")),
    packedTemplateSources,
  );
  assert.deepEqual(
    paths.filter((path) =>
      /(?:^|\/)(?:test|quality|state|run)(?:\/|$)|prd.*\.md$/i.test(path),
    ),
    [],
  );
  await installPacked(root, {
    archive: join(root, String(field(archive, "filename"))),
    checkout,
  });
  await packagedFontFiles(join(root, "node_modules/cloving"));
  await packedDevelopTemplate(join(root, "node_modules/cloving"));
  await packedStages(root);
  return join(root, "node_modules/.bin/cloving");
}

async function packedStages(root: string): Promise<void> {
  const declaration = await readFile(
    join(root, "node_modules/cloving/dist/src/workflow-declaration.d.ts"),
    "utf8",
  );
  assert.match(declaration, /readonly gateIds\?: readonly string\[\]/);
  await writeFile(
    join(root, "stages.mjs"),
    `
import assert from "node:assert/strict";
import { isWorkflowDeclaration } from "./node_modules/cloving/dist/src/workflow-declaration.js";
import { currentStepOf } from "./node_modules/cloving/dist/src/cli/watch-board.js";
import { workflowDeclarations, workflowManifests } from "./node_modules/cloving/dist/tools/self-host-workflows.js";
import { mkdir, writeFile } from "node:fs/promises";
const declaration = { workflowId: "review-flow", effectLimit: 1, capabilities: ["claude"], input: { maximumBytes: 4096, fields: {} } };
assert.ok(isWorkflowDeclaration(declaration));
const stages = ${JSON.stringify(reviewStages)};
assert.ok(isWorkflowDeclaration({ ...declaration, stages }));
await mkdir("stage-workflows");
await writeFile("stage-workflows/review-flow.js", "export {};");
const manifests = workflowManifests({ workflows: { "stage-workflows/review-flow.js": { review: { workflowId: "workflow//./review-flow//review" } } } });
for (const value of [declaration, { ...declaration, stages }]) {
  await writeFile("stage-workflows/review-flow.declaration.json", JSON.stringify(value));
  assert.deepEqual(await workflowDeclarations("stage-workflows", manifests), [{ ...value, functionName: "review" }]);
}
assert.deepEqual(currentStepOf([{ sequence: 1, type: "gate.opened", recordedAt: "2026-10-14T12:00:00Z", payload: { gateId: "team-review", gateKind: "approval" } }], { workflowId: "review-flow", stages }), { name: "Team review", startedAt: "2026-10-14T12:00:00Z" });
`,
  );
  command(process.execPath, { args: ["stages.mjs"], cwd: root });
}

async function artifacts(root: string): Promise<void> {
  const project = join(root, "host/project");
  const manifest: unknown = JSON.parse(
    await readFile(join(project, "artifacts/manifest.json"), "utf8"),
  );
  assert.match(JSON.stringify(field(manifest, "workflows")), /developTicket/);
  assert.match(JSON.stringify(field(manifest, "steps")), /step\/\/cloving\//);
  for (const name of ["flow.mjs", "steps.mjs", "client.mjs"])
    assert.ok(
      (await readFile(join(project, "artifacts", name), "utf8")).length > 100,
    );
  const launcher = await readFile(join(project, "main.mjs"), "utf8");
  assert.match(launcher, /dist\/src\/daemon\/daemon\.js/);
  assert.doesNotMatch(launcher, /\.ts["']/);
  await assert.rejects(readFile(join(root, "worker-called")), {
    code: "ENOENT",
  });
}

async function inventory(root: string): Promise<void> {
  const product = join(root, "node_modules/cloving");
  for (const name of [
    "self-host",
    "self-host-project",
    "compile-workflows",
    "self-host-processes",
    "self-update-host",
    "self-update",
    "workflow-manifest",
    "admit-workflow",
    "workflow-folders",
    "workflow-folder-capture",
  ])
    assert.ok(
      (await readFile(join(product, "dist/tools", `${name}.js`))).length > 0,
    );
  assert.ok(
    (await readFile(join(product, "dist/workflows/develop-ticket.js"))).length >
      0,
  );
  const parsed: unknown = JSON.parse(
    await readFile(join(product, "package.json"), "utf8"),
  );
  assert.ok(packageMetadata(parsed));
  const metadata: PackageMetadata = parsed;
  for (const entry of Object.values(metadata.exports)) {
    for (const target of Object.values(entry)) {
      assert.ok((await readFile(join(product, target))).length > 0);
    }
  }
  for (const name of [
    "src",
    "tools",
    "test",
    "quality",
    "PRD.md",
    "node_modules",
  ])
    await assert.rejects(lstat(join(product, name)), { code: "ENOENT" });
  const compiler: unknown = JSON.parse(
    await readFile(join(root, "node_modules/typescript/package.json"), "utf8"),
  );
  assert.equal(field(compiler, "version"), "6.0.3");
}

async function environment(root: string): Promise<NodeJS.ProcessEnv> {
  await writeFile(
    join(root, "fake-worker.mjs"),
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(join(root, "worker-called"))}, "called"); process.exit(1);`,
  );
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) =>
          !name.startsWith("CLOVING_") &&
          name !== "NODE_OPTIONS" &&
          name !== "NODE_PATH",
      ),
    ),
    NODE_OPTIONS: "--no-strip-types",
    XDG_CONFIG_HOME: join(root, "config"),
    CLOVING_RUNTIME_DIR: join(root, "host/run"),
    CLOVING_WATCH_PORT: "0",
    CLOVING_CLAUDE_COMMAND: JSON.stringify([
      process.execPath,
      join(root, "fake-worker.mjs"),
    ]),
    CLOVING_GH_COMMAND: JSON.stringify([
      process.execPath,
      join(root, "fake-worker.mjs"),
    ]),
    CLOVING_NOTIFY_COMMAND: packedNotifyCommand(root),
    CLOVING_NEXT_COMMAND: "[]",
    CLOVING_TICKET_COMMAND: "[]",
    CLOVING_CHECK_COMMAND: "[]",
    CLOVING_COMMANDS: JSON.stringify({
      "approval-status": [process.execPath, join(root, "approval-status.cjs")],
    }),
    CLOVING_COMMAND_SECONDS: "10",
  };
}

function registrations(
  root: string,
  settings: { executable: string; env: NodeJS.ProcessEnv },
): void {
  const status = command(settings.executable, {
    args: ["status", "--json"],
    cwd: root,
    env: settings.env,
  });
  for (const name of [
    "develop-ticket",
    "develop-prompt",
    "develop-issue",
    "develop-prd",
  ])
    assert.match(status, new RegExp(name));
  const document: unknown = JSON.parse(status);
  assert.deepEqual(field(document, "runs"), []);
  assert.deepEqual(field(document, "workflowRefusals"), operatorRefusals);
  for (const workflow of ["project-run", "user-run"])
    assert.ok(items(field(document, "workflows")).includes(workflow));
}

async function phoneStatus(
  root: string,
  settings: { executable: string; env: NodeJS.ProcessEnv },
): Promise<void> {
  let status: unknown = {};
  for (let attempt = 0; attempt < 100; attempt += 1) {
    status = JSON.parse(
      command(settings.executable, {
        args: ["phone", "status", "--json"],
        cwd: root,
        env: settings.env,
      }),
    );
    if (field(status, "relay") === "on") break;
    await delay(testMilliseconds(100));
  }
  assert.deepEqual(
    [field(status, "relay"), field(status, "registered")],
    ["on", false],
  );
}

async function running(root: string, executable: string): Promise<void> {
  const env = await environment(root);
  const fixture = {
    root,
    repository: root,
    runtimeDirectory: join(root, "host/run"),
  };
  const files = await operatorFiles(fixture);
  await packedDecisionFiles(root);
  await packedPollingFiles(root);
  command(executable, { args: ["--help"], cwd: root, env });
  const { child, closed, output } = startPackedHost({ root, executable, env });
  try {
    const address = await ready(child, output);
    registrations(root, { executable, env });
    await phoneStatus(root, { executable, env });
    await runOperator(fixture, "project-run");
    await runOperator(fixture, "user-run");
    await runPackedDecision(root, { executable, env, address });
    for (const [name, bytes] of Object.entries(files))
      assert.equal(await readFile(name, "utf8"), bytes);
    const page = await fetch(address, { signal: AbortSignal.timeout(5000) });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Cloving/);
    await servedFonts(address, join(root, "node_modules/cloving"));
    await artifacts(root);
    await inventory(root);
    await packedCandidateAdmission(root);
    const polling = await startPackedPolling(root);
    child.kill("SIGTERM");
    assert.equal(await boundedExit(closed), 0);
    assert.throws(() => process.kill(-Number(child.pid), 0), { code: "ESRCH" });
    await resumePackedPolling(root, { executable, env, checkpoint: polling });
  } finally {
    await stopChildGroup(child);
    await boundedExit(closed);
  }
}

await test("CLV-096 an omitted-dev packed installation compiles, registers, serves watch and stops without a checkout", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cloving-packed-")));
  try {
    command("git", { args: ["init", "-q"], cwd: root });
    const executable = await installed(root);
    await packedDoctor(root);
    await running(root, executable);
    await packedWorkflowFolders(root);
    await packedWorkflowTesting(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
