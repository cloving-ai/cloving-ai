import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { withFiles } from "./quality/files-fixture.ts";
import { fields, items } from "./service-fixture.ts";

const execute = promisify(execFile);
const entry = resolve("src/cli.ts");

export interface DoctorScene {
  readonly root: string;
  readonly repository: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly program: (name: string, body: string) => Promise<string>;
  readonly report: (environment?: NodeJS.ProcessEnv) => Promise<DoctorOutput>;
}

export interface DoctorOutput {
  readonly status: number;
  readonly version: unknown;
  readonly checks: readonly Readonly<Record<string, unknown>>[];
}

export function check(output: DoctorOutput, code: string) {
  const found = output.checks.find((item) => item["code"] === code);
  assert.ok(found, `Missing ${code}`);
  return found;
}

export function withDoctor(use: (scene: DoctorScene) => Promise<void> | void) {
  return withFiles(
    { "repository/file": "", "bin/placeholder": "" },
    async (root) => use(await doctorScene(root)),
  );
}

async function doctorScene(root: string): Promise<DoctorScene> {
  const repository = join(root, "repository");
  execFileSync("git", ["init", "-q", "-b", "main", repository]);
  execFileSync("git", [
    "-C",
    repository,
    "remote",
    "add",
    "origin",
    "git@github.com:example/project.git",
  ]);
  await symlink("/usr/bin/git", join(root, "bin/git"));
  const environment = {
    HOME: root,
    NODE_V8_COVERAGE: process.env["NODE_V8_COVERAGE"],
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    PATH: join(root, "bin"),
    SHELL: "/missing-shell",
    CLOVING_TICKET_COMMAND: JSON.stringify([process.execPath]),
    CLOVING_NEXT_COMMAND: JSON.stringify([process.execPath]),
    CLOVING_CHECK_COMMAND: JSON.stringify([process.execPath]),
    CLOVING_PRIVATE_TEXTS: '["private example"]',
    CLOVING_QUEUE_SECONDS: "30",
  };
  const program = async (name: string, body: string) => {
    const path = join(root, "bin", name);
    await writeFile(path, `#!${process.execPath}\n${body}\n`);
    await chmod(path, 0o755);
    return path;
  };
  await fakePrograms({ root, program });
  return {
    root,
    repository,
    environment,
    program,
    report: sceneReport({ repository, environment }),
  };
}

async function fakePrograms(scene: Pick<DoctorScene, "root" | "program">) {
  await scene.program(
    "claude",
    'if (process.argv[2] !== "--version") process.exit(91); console.log("2.1.1 (Claude Code)")',
  );
  await scene.program(
    "codex",
    'if (process.argv[2] !== "--version") process.exit(91); console.log("codex-cli 0.100.0")',
  );
  await scene.program(
    "gh",
    `
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(join(scene.root, "github-reads"))}, JSON.stringify(process.argv.slice(2)) + "\\n");
const [command, subcommand] = process.argv.slice(2);
if (command === "auth" && subcommand === "status") process.exit(0);
if (command === "pr" && subcommand === "list") console.log('[{"number":1}]');
else if (command === "api") console.log('[{"user":{"login":"greptile-apps[bot]"}}]');
else process.exit(91);
`,
  );
}

function sceneReport(
  location: Pick<DoctorScene, "repository" | "environment">,
): DoctorScene["report"] {
  return async (overrides: NodeJS.ProcessEnv = {}) => {
    const result = await execute(
      process.execPath,
      [entry, "doctor", "--json"],
      {
        cwd: location.repository,
        env: { ...location.environment, ...overrides },
        timeout: 20000,
      },
    ).then(
      (output) => ({ ...output, status: 0 }),
      (error: unknown) => {
        assert.ok(
          error instanceof Error &&
            "stdout" in error &&
            "stderr" in error &&
            "code" in error,
          String(error),
        );
        return {
          stdout: String(error.stdout),
          stderr: String(error.stderr),
          status: Number(error.code),
        };
      },
    );
    assert.equal(result.stderr, "");
    const output = fields(JSON.parse(result.stdout));
    return {
      status: result.status,
      version: output["version"],
      checks: items(output["checks"]).map(fields),
    };
  };
}

export async function settings(scene: DoctorScene, value: unknown) {
  const path = join(scene.repository, ".cloving/config.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

export async function githubReads(scene: DoctorScene) {
  return readFile(join(scene.root, "github-reads"), "utf8");
}
