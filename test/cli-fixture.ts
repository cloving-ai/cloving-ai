import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { withFiles } from "./quality/files-fixture.ts";

export const workflowId = "workflow//./workflows/develop//develop";
export const helperStep =
  "step//cloving/workflows/steps/load-cycle@0.4.0//loadCycle";

const compiled = Object.fromEntries(
  [
    "client.mjs",
    "flow.mjs",
    "flow.mjs.__wf_tmp.js.debug.json",
    "steps.mjs",
    "steps.mjs.debug.json",
  ].map((name) => [`project with spaces/artifacts/${name}`, name]),
);

export const projectFiles: Readonly<Record<string, string>> = {
  ...compiled,
  "project with spaces/artifacts/manifest.json": JSON.stringify({
    steps: {
      "node_modules/cloving/dist/src/steps/load-cycle.js": {
        loadCycle: { stepId: helperStep },
      },
    },
    workflows: { "workflows/develop.ts": { develop: { workflowId } } },
  }),
  "project with spaces/node_modules/workflow/package.json":
    '{"name":"workflow","version":"5.1.0"}',
  "project with spaces/node_modules/@workflow/world-local/package.json":
    '{"name":"@workflow/world-local","version":"5.0.2"}',
  "project with spaces/node_modules/@workflow/core/package.json":
    '{"name":"@workflow/core","version":"5.1.0","dependencies":{"@workflow/world-local":"5.0.2"}}',
  "project with spaces/node_modules/@workflow/builders/package.json":
    '{"name":"@workflow/builders","version":"5.0.2"}',
  "project with spaces/package-lock.json": "{}",
  "project with spaces/prompts/implement.md": "Implement the change.\n",
  "project with spaces/cloving.workflow.json": JSON.stringify({
    schemaVersion: 1,
    name: "develop",
    workflowId,
    steps: [helperStep],
    capabilities: [],
    resources: ["prompts/implement.md"],
    artifacts: "artifacts",
  }),
};

export interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export async function withProject<Result>(
  files: Readonly<Record<string, string | null>>,
  inspect: (
    cli: (argumentsList: readonly string[]) => CliResult,
    directory: string,
  ) => Promise<Result> | Result,
): Promise<Result> {
  const entry = resolve("src/cli.ts");
  const merged = Object.fromEntries(
    Object.entries({ ...projectFiles, ...files }).filter(
      (entry): entry is [string, string] => entry[1] !== null,
    ),
  );
  return withFiles(merged, (root) => {
    const directory = resolve(root, "project with spaces");
    const cli = (argumentsList: readonly string[]): CliResult => {
      const result = spawnSync(process.execPath, [entry, ...argumentsList], {
        cwd: directory,
        encoding: "utf8",
        timeout: 15000,
      });
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    };
    return inspect(cli, directory);
  });
}
