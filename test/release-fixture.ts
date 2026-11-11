import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmod, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withFiles } from "./quality/files-fixture.ts";

import {
  isWorkflow,
  isPackageMetadata,
  isPackageLock,
} from "./release-schema-fixture.ts";
import type {
  ReleaseWorkflow,
  PackageMetadata,
  PackageLock,
  WorkflowJob,
  WorkflowStep,
  Command,
} from "./release-schema-fixture.ts";
export type { Command } from "./release-schema-fixture.ts";

export async function releaseWorkflow(
  directory = join(import.meta.dirname, ".."),
): Promise<ReleaseWorkflow> {
  const parsed: unknown = JSON.parse(
    await readFile(join(directory, ".github/workflows/ci.yml"), "utf8"),
  );
  assert.ok(isWorkflow(parsed), "Invalid release workflow");
  return parsed;
}

export async function metadata(
  directory = join(import.meta.dirname, ".."),
): Promise<{
  readonly manifest: PackageMetadata;
  readonly lock: PackageLock;
}> {
  const manifest: unknown = JSON.parse(
    await readFile(join(directory, "package.json"), "utf8"),
  );
  const lock: unknown = JSON.parse(
    await readFile(join(directory, "package-lock.json"), "utf8"),
  );
  assert.ok(
    isPackageMetadata(manifest) && isPackageLock(lock),
    "Invalid release metadata",
  );
  return { manifest, lock };
}

export const packageVersion = (await metadata()).manifest.version;

export function parseCommands(content: string): readonly Command[] {
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const value: unknown = JSON.parse(line);
      assert.ok(
        Array.isArray(value) &&
          value.every((part: unknown) => typeof part === "string"),
        "Invalid release command",
      );
      return value;
    });
}

export function job(
  workflow: ReleaseWorkflow,
  name: keyof ReleaseWorkflow["jobs"],
): WorkflowJob {
  return workflow.jobs[name];
}

export function steps(
  workflow: ReleaseWorkflow,
  name: keyof ReleaseWorkflow["jobs"],
): readonly WorkflowStep[] {
  return job(workflow, name).steps;
}

export function runs(
  workflow: ReleaseWorkflow,
  name: keyof ReleaseWorkflow["jobs"],
): readonly string[] {
  return steps(workflow, name)
    .map((step) => step.run)
    .filter((run) => run !== undefined);
}

export function script(workflow: ReleaseWorkflow, id: string): string {
  const run = steps(workflow, "publish").find((step) => step.id === id)?.run;
  assert.ok(typeof run === "string", `Missing shell step: ${id}`);
  return run;
}

const prepareShellFixture = `
test() {
  [[ "$*" == "-x /bin/zsh" ]] || exit 90
  return "$ZSH_STATUS"
}
curl() {
  [[ "\${*:1:8}" == '--fail --silent --show-error --location --connect-timeout 20 --max-time 25' && "\${9}" == -o ]] || exit 94
  printf 'curl %s %s\\n' "$(basename "\${10}")" "\${11}"
  local host="\${11#https://}"
  [[ " $CURL_DOWN " == *" \${host%%/*} "* ]] && return 6
  return "$CURL_STATUS"
}
sha256sum() {
  [[ "$*" == '--check --strict --quiet' ]] || exit 96
  printf 'sha256sum\\n'
  cat > "$CHECK_FILE"
  return "$CHECK_STATUS"
}
sudo() {
  [[ "$1" == dpkg && "$2" == -i && $# == 4 ]] || exit 91
  printf 'dpkg -i %s %s\\n' "$(basename "$3")" "$(basename "$4")"
  return "$INSTALL_STATUS"
}
`;

export function prepareShellAttempt(
  workflow: ReleaseWorkflow,
  environment: Readonly<Record<string, string>>,
): SpawnSyncReturns<string> {
  const run = steps(workflow, "quality_linux_node").find(
    (step) => step.id === "prepare-shells",
  )?.run;
  assert.ok(typeof run === "string");
  return spawnSync(
    "/bin/bash",
    ["-e", "-o", "pipefail", "-c", prepareShellFixture + run],
    {
      env: { PATH: "/usr/bin:/bin", ...environment },
      encoding: "utf8",
      timeout: 10000,
    },
  );
}

function permits(workflow: ReleaseWorkflow, context: ReleaseContext): boolean {
  const expression = String(job(workflow, "publish").if).replace(
    /^\$\{\{\s*|\s*\}\}$/g,
    "",
  );
  const terms: Readonly<Record<string, boolean>> = {
    "success()": context.release_check === "success",
    "needs.release_check.result == 'success'":
      context.release_check === "success",
    "github.event_name == 'push'": context.github.event_name === "push",
    "github.ref_type == 'tag'": context.github.ref_type === "tag",
    "startsWith(github.ref, 'refs/tags/v')": context.github.ref
      .toLowerCase()
      .startsWith("refs/tags/v"),
  };
  return expression.split(" && ").every((term) => {
    assert.ok(term in terms, `Unsupported release condition: ${term}`);
    return terms[term] === true;
  });
}

export interface ReleaseContext {
  readonly github: {
    readonly event_name: string;
    readonly ref_type: string;
    readonly ref: string;
    readonly ref_name: string;
  };
  readonly release_check: string;
}

export const tagged: ReleaseContext = {
  github: {
    event_name: "push",
    ref_type: "tag",
    ref: `refs/tags/v${packageVersion}`,
    ref_name: `v${packageVersion}`,
  },
  release_check: "success",
};

const fake = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const command = process.argv[1].split("/").at(-1);
const args = process.argv.slice(2);
const state = JSON.parse(readFileSync("scenario.json", "utf8"));
appendFileSync("commands.jsonl", JSON.stringify([command, ...args]) + "\\n");
if (command === "npm" && args[0] === "view" && existsSync("published")) {
  console.log(JSON.stringify(${JSON.stringify(packageVersion)})); process.exit(0);
}
if (command === "npm" && args[0] === "view") {
  console.log(state.registry);
  process.exit(state.registryExit);
}
if (command === "npm" && args[0] === "publish" && state.publishExit) process.exit(state.publishExit);
if (command === "npm" && args[0] === "publish") {
  writeFileSync("published", "yes"); process.exit(0);
}
if (command === "gh" && args[0] === "api" && existsSync("released")) {
  console.log("HTTP/2.0 200 OK\\n\\n{}"); process.exit(0);
}
if (command === "gh" && args[0] === "api") {
  console.log("HTTP/2.0 " + state.releaseStatus + "\\n\\n{}"); process.exit(1);
}
if (command === "gh" && args[0] === "release" && args[1] === "create") {
  writeFileSync("released", "yes"); process.exit(0);
}
throw new Error("Unexpected fake command: " + JSON.stringify(args));
`;

export interface ReleaseScenario {
  readonly registry?: string;
  readonly registryExit?: number;
  readonly publishExit?: number;
  readonly releaseStatus?: string;
  readonly attempts?: number;
  readonly context?: ReleaseContext;
}

function runScripts(
  workflow: ReleaseWorkflow,
  scene: { readonly directory: string; readonly context: ReleaseContext },
): number {
  const { directory, context } = scene;
  for (const id of ["validate-tag", "publish-package", "github-release"]) {
    const result = spawnSync(
      "/bin/bash",
      ["-e", "-o", "pipefail", "-c", script(workflow, id)],
      {
        cwd: directory,
        env: {
          ...process.env,
          PATH: `${join(directory, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`,
          GITHUB_REF: context.github.ref,
          GITHUB_REF_NAME: context.github.ref_name,
          GITHUB_REPOSITORY: "cloving-ai/cloving-ai",
          GITHUB_SHA: "a".repeat(40),
          NPM_CONFIG_REGISTRY: "https://registry.npmjs.org",
        },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, null, result.stderr);
    if (result.status !== 0) return Number(result.status);
  }
  return 0;
}

export async function releaseAttempt(scenario: ReleaseScenario = {}): Promise<{
  readonly statuses: readonly number[];
  readonly commands: readonly Command[];
}> {
  const workflow = await releaseWorkflow();
  const context = scenario.context ?? tagged;
  if (!permits(workflow, context)) return { statuses: [], commands: [] };
  return withFiles(
    {
      "package.json": JSON.stringify({
        name: "cloving",
        version: packageVersion,
        type: "module",
      }),
      "bin/npm": fake,
      "bin/gh": fake,
      "scenario.json": JSON.stringify({
        registry: '{"error":{"code":"E404"}}',
        registryExit: 1,
        releaseStatus: "404 Not Found",
        ...scenario,
      }),
      "commands.jsonl": "",
    },
    async (directory) => {
      for (const name of ["npm", "gh"])
        await chmod(join(directory, "bin", name), 0o755);
      const statuses: number[] = [];
      for (let count = 0; count < (scenario.attempts ?? 1); count += 1) {
        statuses.push(runScripts(workflow, { directory, context }));
      }
      const commands = parseCommands(
        await readFile(join(directory, "commands.jsonl"), "utf8"),
      );
      return { statuses, commands };
    },
  );
}

export const gateRun = [
  ': > "$CLOVING_TEST_PROGRESS_FILE"',
  'tail -n +1 -f "$CLOVING_TEST_PROGRESS_FILE" &',
  "progress=$!",
  "trap 'kill \"$progress\"' EXIT",
  "npm run check:quality",
].join("\n");

export const changedPathsRun = [
  'git diff --name-only --no-renames -z HEAD^1 HEAD > "$RUNNER_TEMP/changed-paths"',
  'echo "CLOVING_CHANGED_PATHS=$RUNNER_TEMP/changed-paths" >> "$GITHUB_ENV"',
].join("\n");
