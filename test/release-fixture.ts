import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { field, items } from "./self-host-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";

export async function releaseWorkflow(): Promise<unknown> {
  const parsed: unknown = JSON.parse(
    await readFile(
      join(import.meta.dirname, "../.github/workflows/ci.yml"),
      "utf8",
    ),
  );
  return parsed;
}

export function job(workflow: unknown, name: string): unknown {
  return field(field(workflow, "jobs"), name);
}

export function steps(workflow: unknown, name: string): readonly unknown[] {
  return items(field(job(workflow, name), "steps"));
}

export function script(workflow: unknown, id: string): string {
  const step = steps(workflow, "publish").find(
    (step) => field(step, "id") === id,
  );
  const run = field(step, "run");
  assert.equal(typeof run, "string", `Missing shell step: ${id}`);
  return String(run);
}

function permits(workflow: unknown, context: ReleaseContext): boolean {
  const expression = String(field(job(workflow, "publish"), "if")).replace(
    /^\$\{\{\s*|\s*\}\}$/g,
    "",
  );
  const terms: Readonly<Record<string, boolean>> = {
    "success()": context.quality === "success",
    "needs.quality.result == 'success'": context.quality === "success",
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
}

export const tagged: ReleaseContext = {
  github: {
    event_name: "push",
    ref_type: "tag",
    ref: "refs/tags/v1.0.0",
    ref_name: "v1.0.0",
  },
  quality: "success",
};

const fake = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const command = process.argv[1].split("/").at(-1);
const args = process.argv.slice(2);
const state = JSON.parse(readFileSync("scenario.json", "utf8"));
appendFileSync("commands.jsonl", JSON.stringify([command, ...args]) + "\\n");
if (command === "npm" && args[0] === "view") {
  if (existsSync("published")) { console.log(JSON.stringify("1.0.0")); process.exit(0); }
  console.log(state.registry);
  process.exit(state.registryExit);
}
if (command === "npm" && args[0] === "publish") {
  if (state.publishExit) process.exit(state.publishExit);
  writeFileSync("published", "yes"); process.exit(0);
}
if (command === "gh" && args[0] === "api") {
  if (existsSync("released")) { console.log("HTTP/2.0 200 OK\\n\\n{}"); process.exit(0); }
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
  workflow: unknown,
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
  readonly commands: readonly unknown[];
}> {
  const workflow = await releaseWorkflow();
  const context = scenario.context ?? tagged;
  if (!permits(workflow, context)) return { statuses: [], commands: [] };
  return withFiles(
    {
      "package.json": JSON.stringify({
        name: "cloving",
        version: "1.0.0",
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
      const commands = (
        await readFile(join(directory, "commands.jsonl"), "utf8")
      )
        .split("\n")
        .filter(Boolean)
        .map((line): unknown => JSON.parse(line));
      return { statuses, commands };
    },
  );
}
