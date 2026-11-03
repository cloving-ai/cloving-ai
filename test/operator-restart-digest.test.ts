import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { candidatePackageRoot } from "./candidate-package-fixture.ts";
import {
  answeredOperator,
  operatorQuestion,
  waitingOperator,
  type OperatorRestart,
} from "./operator-restart-fixture.ts";
import { scene, withoutChildren } from "./self-host-fixture.ts";
import { stopChild } from "./stop-child.ts";
import { candidateDeclaration } from "./workflow-candidate-fixtures.ts";

const helpers = {
  scope: "project",
  separator: ":",
  version: "v1",
  gate: "operator-answer",
  override: "submitted-override",
  handoff: "handoff_requested",
  blocked: "blocked",
  answered: "answered",
};

async function sameSources(fixture: OperatorRestart): Promise<void> {
  const folder = join(fixture.repository, ".cloving/workflows");
  for (const [name, value] of Object.entries(helpers)) {
    await mkdir(join(folder, "project", name), { recursive: true });
    await writeFile(
      join(folder, "project", name, "value.ts"),
      `export const ${name} = ${JSON.stringify(value)};\n`,
    );
  }
  await writeFile(
    join(folder, "project.ts"),
    `${Object.keys(helpers)
      .map((name) => `import { ${name} } from "./project/${name}/value.ts";`)
      .join("\n")}
import { waitForDecision } from "cloving/workflows/steps/wait-for-decision";
export async function projectOperator(input: { cycleId: string; repository: string; input: { repository: string } }) {
  "use workflow";
  const decision = await waitForDecision({ gateId: gate, kind: "question", prompt: scope + separator + version });
  return { kind: decision.decision === answered && decision.answer === version && input.repository === ${JSON.stringify(fixture.repository)} && input.input.repository === override ? handoff : blocked, reason: version };
}`,
  );
  await writeFile(
    join(folder, "project.declaration.json"),
    JSON.stringify({
      ...candidateDeclaration,
      workflow: {
        ...candidateDeclaration.workflow,
        workflowId: "project-operator",
        input: {
          maximumBytes: 1024,
          fields: { repository: { type: "string" } },
        },
      },
    }),
  );
}

async function bundleIds(store: string): Promise<string[]> {
  return (await readdir(store)).filter(
    (name) => !name.startsWith(".") && name !== "node_modules",
  );
}

async function stoppedAfter<Result>(
  child: ChildProcess,
  work: () => Promise<Result>,
): Promise<Result> {
  try {
    return await work();
  } finally {
    await stopChild(child);
    assert.equal(child.exitCode, 0);
  }
}

await test("CLV-277 a restart with the same sources keeps the bundle digest and continues the active run", () =>
  withoutChildren(async () => {
    const fixture = await scene(
      'throw new Error("unexpected-effect");',
      join(candidatePackageRoot, "src/cli.ts"),
    );
    await sameSources(fixture);
    const start = () =>
      fixture.start({
        XDG_CONFIG_HOME: join(fixture.root, "config"),
        CLOVING_SELF_UPDATE_SECONDS: undefined,
        CLOVING_NOTIFY_COMMAND: "[]",
      });
    const store = join(fixture.directory, "workflow-bundles");
    const waiting = await stoppedAfter(await start(), () =>
      waitingOperator(fixture, { scope: "project", version: "v1" }),
    );
    const pinned = await bundleIds(store);
    assert.equal(pinned.length, 1);
    await stoppedAfter(await start(), async () => {
      assert.deepEqual(await bundleIds(store), pinned);
      assert.deepEqual(
        await operatorQuestion(fixture, waiting.runId),
        waiting.question,
      );
      await answeredOperator(fixture, { runId: waiting.runId, version: "v1" });
    });
  }));
