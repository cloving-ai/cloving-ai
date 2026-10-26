import { stopChildGroup } from "./stop-child.ts";
import {
  operatorFiles,
  operatorRefusals,
  runOperator,
} from "./operator-startup-fixture.ts";
import { packagedFontFiles, servedFonts } from "./watch-font-fixture.ts";
import { packedWorkflowFolders } from "./packed-workflow-folders.ts";
import { packedWorkflowTesting } from "./packed-workflow-testing.ts";
import {
  packedDecisionFiles,
  packedNotifyCommand,
  runPackedDecision,
} from "./packed-decision-wait.ts";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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
import {
  candidateDeclaration,
  candidateEffectExpression,
  candidateSource,
  combinedCandidateSource,
  validCandidateSource,
} from "./workflow-candidate-fixtures.ts";

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

function command(
  executable: string,
  options: {
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env?: NodeJS.ProcessEnv;
  },
): string {
  const result = spawnSync(executable, options.args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.stderr);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout;
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
    [],
  );
  assert.deepEqual(
    paths.filter((path) =>
      /(?:^|\/)(?:test|quality|state|run)(?:\/|$)|prd.*\.md$/i.test(path),
    ),
    [],
  );
  await writeFile(
    join(root, "package.json"),
    '{"name":"packed-consumer","private":true,"type":"module"}',
  );
  command("npm", {
    args: [
      "install",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      join(root, String(field(archive, "filename"))),
    ],
    cwd: root,
  });
  await packagedFontFiles(join(root, "node_modules/cloving"));
  return join(root, "node_modules/.bin/cloving");
}

async function ready(
  child: ChildProcess,
  output: { text: string },
): Promise<string> {
  for (let count = 0; count < testMilliseconds(30_000) / 20; count += 1) {
    assert.equal(
      child.exitCode,
      null,
      `Installed startup exited: ${output.text}`,
    );
    assert.equal(child.signalCode, null, output.text);
    const address = /Watch page: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(
      output.text,
    )?.[1];
    if (output.text.includes("Cloving runs") && address !== undefined)
      return address;
    await delay(20);
  }
  throw new Error(`Installed startup did not become ready: ${output.text}`);
}

function boundedExit(closed: Promise<number | null>): Promise<number | null> {
  return new Promise((settle, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Installed startup did not stop"));
    }, 10000);
    closed.then(
      (status) => {
        clearTimeout(timer);
        settle(status);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(new Error("Installed startup failed", { cause: error }));
      },
    );
  });
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

async function candidateAdmission(root: string): Promise<void> {
  await writeFile(
    join(root, "candidate-admission.mjs"),
    `
import assert from "node:assert/strict";
import { admitWorkflowCandidate } from "./node_modules/cloving/dist/tools/admit-workflow.js";
const declaration = ${JSON.stringify(candidateDeclaration)};
const admitted = await admitWorkflowCandidate({ source: ${JSON.stringify(validCandidateSource)}, declaration });
assert.equal(admitted.kind, "admitted");
assert.match(admitted.artifactDigest, /^[0-9a-f]{64}$/);
assert.deepEqual(await admitWorkflowCandidate({ source: ${JSON.stringify(combinedCandidateSource)}, declaration }), { kind: "refused", codes: ["missing-export", "undeclared-effect"] });
assert.deepEqual(await admitWorkflowCandidate({ source: ${JSON.stringify(`process.exit(99);\n${validCandidateSource}`)}, declaration }), { kind: "refused", codes: ["direct-effect"] });
assert.deepEqual(await admitWorkflowCandidate({ source: ${JSON.stringify(`Math.valueOf().random();\n${validCandidateSource}`)}, declaration }), { kind: "refused", codes: ["direct-effect"] });
const earlyExit = await admitWorkflowCandidate({ source: ${JSON.stringify(candidateSource(`for (let index = 0; index < 3; index++) { await ${candidateEffectExpression}; break; }`).replace('"cloving/workflows"', '"cloving/workflows/steps/protected-effect"'))}, declaration });
assert.equal(earlyExit.kind, "admitted");
const commandSource = ${JSON.stringify(`import { runCommand } from "cloving/workflows/steps/run-command";
export async function scan() {
  "use workflow";
  return await runCommand({ scope: { phase: "scan", operation: "reviews", round: 1 }, name: "review-requests", input: {} });
}`)};
const commandDeclaration = { workflow: { ...declaration.workflow, capabilities: ["command"], commands: ["review-requests"] }, methods: { command: ["run:review-requests"] } };
const command = await admitWorkflowCandidate({ source: commandSource, declaration: commandDeclaration });
assert.equal(command.kind, "admitted", JSON.stringify(command));
assert.match(command.artifactDigest, /^[0-9a-f]{64}$/);
process.stdout.write("candidate-admission-ok");
`,
  );
  assert.equal(
    command(process.execPath, {
      args: ["--no-strip-types", "candidate-admission.mjs"],
      cwd: root,
    }),
    "candidate-admission-ok",
  );
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
  command(executable, { args: ["--help"], cwd: root, env });
  const child = spawn(executable, ["start"], {
    cwd: root,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise<number | null>((settle) =>
    child.once("close", settle),
  );
  const output = { text: "" };
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (bytes: Buffer) => {
      output.text += bytes.toString();
    });
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
    await candidateAdmission(root);
    child.kill("SIGTERM");
    assert.equal(await boundedExit(closed), 0);
    assert.throws(() => process.kill(-Number(child.pid), 0), { code: "ESRCH" });
  } finally {
    await stopChildGroup(child);
    await boundedExit(closed);
  }
}

await test("CLV-096 an omitted-dev packed installation compiles, registers, serves watch and stops without a checkout", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cloving-packed-")));
  try {
    command("git", { args: ["init", "-q"], cwd: root });
    await running(root, await installed(root));
    await packedWorkflowFolders(root);
    await packedWorkflowTesting(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
