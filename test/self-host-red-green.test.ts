import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { candidatePackageRoot } from "./candidate-package-fixture.ts";
import { call } from "./service-fixture.ts";
import {
  ended,
  field,
  reached,
  scene,
  withoutChildren,
} from "./self-host-fixture.ts";

const entry = join(candidatePackageRoot, "src/cli.ts");

for (const override of [
  undefined,
  { test: ["node", "--test"], testFiles: ["spec/"] },
])
  await test(`CLV-248 a registered command receives resolved red-green settings with override ${JSON.stringify(override)}`, () =>
    withoutChildren(async () => {
      const fixture = await scene(undefined, entry);
      writeInspectionWorkflow(fixture.repository);
      const redGreen = { test: ["node", "--test"], testFiles: ["test/"] };
      const capture = join(fixture.root, "command-settings.json");
      writeFileSync(
        join(fixture.repository, ".cloving/config.json"),
        JSON.stringify({
          version: 1,
          checks: { redGreen },
        }),
      );
      const daemon = await fixture.start({
        CLOVING_RED_GREEN:
          override === undefined ? undefined : JSON.stringify(override),
        CLOVING_COMMAND_SECONDS: "120",
        CLOVING_COMMANDS: JSON.stringify({
          inspect: [
            process.execPath,
            "-e",
            `require("node:fs").writeFileSync(${JSON.stringify(capture)},JSON.stringify({redGreen:process.env.CLOVING_RED_GREEN,seconds:process.env.CLOVING_COMMAND_SECONDS}))`,
          ],
        }),
      });
      try {
        const admitted = await call(fixture, {
          operation: "run",
          parameters: {
            workflowId: "inspect",
            source: "input",
            submission: {},
            commandId: "inspect-settings",
          },
        });
        assert.equal(
          admitted["kind"],
          "run-admitted",
          JSON.stringify(admitted),
        );
        const run = await reached(async () => {
          const shown = await call(fixture, {
            operation: "status",
            parameters: { runId: admitted["runId"] },
          });
          return field(shown["run"], "state") === "completed"
            ? shown["run"]
            : undefined;
        });
        assert.equal(field(field(run, "outcome"), "kind"), "handoff_requested");
        assert.deepEqual(JSON.parse(readFileSync(capture, "utf8")), {
          redGreen: JSON.stringify(override ?? redGreen),
          seconds: "120",
        });
      } finally {
        assert.equal(await ended(daemon), 0);
      }
    }));

function writeInspectionWorkflow(repository: string): void {
  const folder = join(repository, ".cloving/workflows");
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "inspect.ts"),
    `import { runCommand } from "cloving/workflows/steps/run-command";
export async function inspect() {
  "use workflow";
  await runCommand({ scope: { phase: "inspect", operation: "settings", round: 1 }, name: "inspect", input: {} });
  return { kind: "handoff_requested" };
}`,
  );
  writeFileSync(
    join(folder, "inspect.declaration.json"),
    JSON.stringify({
      workflow: {
        workflowId: "inspect",
        effectLimit: 1,
        capabilities: ["command"],
        commands: ["inspect"],
        input: { maximumBytes: 64, fields: {} },
      },
      methods: { command: ["run:inspect"] },
    }),
  );
}
