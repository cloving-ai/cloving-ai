import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { candidatePackageRoot } from "./candidate-package-fixture.ts";
import { bundledWorkflowIds } from "../src/workflow-discovery.ts";
import { call } from "./service-fixture.ts";
import {
  ended,
  field,
  reached,
  scene,
  withoutChildren,
} from "./self-host-fixture.ts";
import {
  writeDeclaredWorkflow,
  writeLocalWorkflow,
} from "./workflow-folder-fixture.ts";

const entry = join(candidatePackageRoot, "src/cli.ts");

for (const template of ["develop", "idea-to-issue"] as const)
  await test(`CLV-261 the shared project fixture registers ${template} once at daemon startup`, () =>
    withoutChildren(async () => {
      const fixture = await scene(undefined, entry);
      await writeDeclaredWorkflow(fixture.repository, template);
      const expected =
        template === "develop" ? [template] : ["develop", template];
      for (const name of expected) {
        const declaration = `${name}.declaration.json`;
        assert.equal(
          await readFile(
            join(fixture.repository, ".cloving/workflows", declaration),
            "utf8",
          ),
          await readFile(
            new URL(`../templates/${name}/${declaration}`, import.meta.url),
            "utf8",
          ),
        );
      }
      const daemon = await fixture.start({
        CLOVING_NEXT_COMMAND: undefined,
        CLOVING_QUEUE_LANES: undefined,
        CLOVING_QUEUE_SECONDS: undefined,
      });
      try {
        const listed = await call(fixture, {
          operation: "status",
          parameters: {},
        });
        assert.deepEqual(listed["workflowRefusals"], []);
        assert.ok(Array.isArray(listed["workflows"]));
        assert.deepEqual(
          listed["workflows"].filter(
            (id: unknown) =>
              typeof id === "string" &&
              !Object.values(bundledWorkflowIds).some(
                (bundled) => id === bundled,
              ),
          ),
          expected,
        );
      } finally {
        assert.equal(await ended(daemon), 0);
      }
    }));

await test("CLV-261 the local develop fixture reaches worker review", () =>
  withoutChildren(async () => {
    const fixture = await scene(undefined, entry);
    await writeLocalWorkflow(fixture.repository);
    const daemon = await fixture.start();
    try {
      const admitted = await call(fixture, {
        operation: "run",
        parameters: {
          workflowId: "develop",
          source: "input",
          submission: { ticket: "CLV-900" },
          commandId: "local-fixture",
        },
      });
      assert.equal(admitted["kind"], "run-admitted");
      const run = await reached(async () => {
        const shown = await call(fixture, {
          operation: "status",
          parameters: { runId: admitted["runId"] },
        });
        return ["waiting_gate", "completed", "failed"].includes(
          String(field(shown["run"], "state")),
        )
          ? shown["run"]
          : undefined;
      });
      assert.equal(field(run, "state"), "waiting_gate");
      assert.equal(field(field(run, "workerTurns"), "length"), 1);
    } finally {
      assert.equal(await ended(daemon), 0);
    }
  }));
