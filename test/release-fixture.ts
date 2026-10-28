import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withFiles } from "./quality/files-fixture.ts";

type StringRecord = Readonly<Record<string, string>>;
export type Command = readonly string[];

interface WorkflowStep {
  readonly id?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly if?: string;
  readonly "continue-on-error"?: boolean;
  readonly with?: Readonly<Record<string, string | boolean>>;
  readonly env?: StringRecord;
}

interface WorkflowStrategy {
  readonly "fail-fast": boolean;
  readonly matrix: Readonly<Record<string, readonly string[]>>;
}

interface WorkflowJob {
  readonly "runs-on": string;
  readonly "timeout-minutes": number;
  readonly steps: readonly WorkflowStep[];
  readonly if?: string;
  readonly needs?: string | readonly string[];
  readonly permissions?: StringRecord;
  readonly env?: StringRecord;
  readonly strategy?: WorkflowStrategy;
}

export interface ReleaseWorkflow {
  readonly on: Readonly<Record<string, StringRecord>>;
  readonly permissions: StringRecord;
  readonly jobs: {
    readonly quality: WorkflowJob;
    readonly quality_linux: WorkflowJob;
    readonly quality_linux_node: WorkflowJob;
    readonly publish: WorkflowJob;
  };
}

interface PackageMetadata {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly bin: StringRecord;
  readonly engines: StringRecord;
  readonly os: readonly string[];
  readonly cpu: readonly string[];
  readonly dependencies: StringRecord;
  readonly devDependencies: StringRecord;
  readonly private?: boolean;
  readonly repository?: StringRecord;
  readonly homepage?: string;
  readonly bugs?: StringRecord;
}

interface PackageLock {
  readonly version: string;
  readonly packages: { readonly "": PackageMetadata };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRecordOf<Value>(
  value: unknown,
  valid: (entry: unknown) => entry is Value,
): value is Readonly<Record<string, Value>> {
  return isRecord(value) && Object.values(value).every(valid);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringRecord(value: unknown): value is StringRecord {
  return isRecordOf(value, isString);
}

function isInput(value: unknown): value is string | boolean {
  return typeof value === "string" || typeof value === "boolean";
}

function isCommand(value: unknown): value is Command {
  return Array.isArray(value) && value.every(isString);
}

function isStep(value: unknown): value is WorkflowStep {
  if (!isRecord(value)) return false;
  return (
    ["id", "uses", "run", "if"].every(
      (name) => value[name] === undefined || isString(value[name]),
    ) &&
    (value["continue-on-error"] === undefined ||
      typeof value["continue-on-error"] === "boolean") &&
    (value["with"] === undefined || isRecordOf(value["with"], isInput)) &&
    (value["env"] === undefined || isStringRecord(value["env"]))
  );
}

function isStrategy(value: unknown): value is WorkflowStrategy {
  return (
    isRecord(value) &&
    typeof value["fail-fast"] === "boolean" &&
    isRecordOf(value["matrix"], isCommand)
  );
}

function validNeeds(value: unknown): boolean {
  return value === undefined || isString(value) || isCommand(value);
}

function optional(value: unknown, valid: (entry: unknown) => boolean): boolean {
  return value === undefined || valid(value);
}

function isJob(value: unknown): value is WorkflowJob {
  if (!isRecord(value)) return false;
  return (
    isString(value["runs-on"]) &&
    typeof value["timeout-minutes"] === "number" &&
    Array.isArray(value["steps"]) &&
    value["steps"].every(isStep) &&
    optional(value["if"], isString) &&
    validNeeds(value["needs"]) &&
    optional(value["strategy"], isStrategy) &&
    ["permissions", "env"].every((name) =>
      optional(value[name], isStringRecord),
    )
  );
}

function isWorkflow(value: unknown): value is ReleaseWorkflow {
  if (!isRecord(value)) return false;
  const jobs = value["jobs"];
  return (
    isRecordOf(value["on"], isStringRecord) &&
    isStringRecord(value["permissions"]) &&
    isRecord(jobs) &&
    isJob(jobs["quality"]) &&
    isJob(jobs["quality_linux"]) &&
    isJob(jobs["quality_linux_node"]) &&
    isJob(jobs["publish"])
  );
}

function isPackageMetadata(value: unknown): value is PackageMetadata {
  if (!isRecord(value)) return false;
  return (
    ["name", "version", "license"].every((name) => isString(value[name])) &&
    ["bin", "engines", "dependencies", "devDependencies"].every((name) =>
      isStringRecord(value[name]),
    ) &&
    isCommand(value["os"]) &&
    isCommand(value["cpu"]) &&
    (value["private"] === undefined || typeof value["private"] === "boolean") &&
    (value["homepage"] === undefined || isString(value["homepage"])) &&
    ["repository", "bugs"].every(
      (name) => value[name] === undefined || isStringRecord(value[name]),
    )
  );
}

function isPackageLock(value: unknown): value is PackageLock {
  if (!isRecord(value)) return false;
  const packages = value["packages"];
  return (
    isString(value["version"]) &&
    isRecord(packages) &&
    isPackageMetadata(packages[""])
  );
}

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
      assert.ok(isCommand(value), "Invalid release command");
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

export function script(workflow: ReleaseWorkflow, id: string): string {
  const run = steps(workflow, "publish").find((step) => step.id === id)?.run;
  assert.ok(typeof run === "string", `Missing shell step: ${id}`);
  return run;
}

function permits(workflow: ReleaseWorkflow, context: ReleaseContext): boolean {
  const expression = String(job(workflow, "publish").if).replace(
    /^\$\{\{\s*|\s*\}\}$/g,
    "",
  );
  const terms: Readonly<Record<string, boolean>> = {
    "success()":
      context.quality === "success" && context.quality_linux === "success",
    "needs.quality.result == 'success'": context.quality === "success",
    "needs.quality_linux.result == 'success'":
      context.quality_linux === "success",
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
  readonly quality: string;
  readonly quality_linux: string;
}

export const tagged: ReleaseContext = {
  github: {
    event_name: "push",
    ref_type: "tag",
    ref: `refs/tags/v${packageVersion}`,
    ref_name: `v${packageVersion}`,
  },
  quality: "success",
  quality_linux: "success",
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
