import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { candidatePackageRoot } from "./candidate-package-fixture.ts";
import { call } from "./service-fixture.ts";
import { ended, scene, withoutChildren } from "./self-host-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";
import {
  candidateDeclaration,
  validCandidateSource,
} from "./workflow-candidate-fixtures.ts";

const entry = join(candidatePackageRoot, "src/cli.ts");

async function writeLimitedWorkflow(repository: string): Promise<void> {
  const folder = join(repository, ".cloving/workflows");
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "limited.ts"),
    validCandidateSource.replaceAll("candidate", "limited"),
  );
  await writeFile(
    join(folder, "limited.declaration.json"),
    JSON.stringify({
      ...candidateDeclaration,
      workflow: {
        ...candidateDeclaration.workflow,
        workflowId: "limited",
        effectLimit: 150,
      },
    }),
  );
}

await test("CLV-308 the daemon registers an effect limit of 150 only under a raised operator maximum", () =>
  withoutChildren(async () => {
    const fixture = await scene(undefined, entry);
    await writeLimitedWorkflow(fixture.repository);
    const listed = async (environment: Readonly<Record<string, string>>) => {
      const daemon = await fixture.start({
        CLOVING_NEXT_COMMAND: undefined,
        CLOVING_QUEUE_LANES: undefined,
        CLOVING_QUEUE_SECONDS: undefined,
        ...environment,
      });
      try {
        const status = await call(fixture, {
          operation: "status",
          parameters: {},
        });
        return {
          workflows: status["workflows"],
          workflowRefusals: status["workflowRefusals"],
        };
      } finally {
        assert.equal(await ended(daemon), 0);
      }
    };
    assert.deepEqual(await listed({}), {
      workflows: [],
      workflowRefusals: [
        {
          scope: "project",
          label: "limited.ts",
          codes: ["effect-limit-above-maximum"],
        },
      ],
    });
    assert.deepEqual(await listed({ CLOVING_LIMIT_EFFECTS: "200" }), {
      workflows: ["limited"],
      workflowRefusals: [],
    });
  }));

await test("CLV-308 the reload program registers workflows under the operator maximums of the start", () =>
  withFiles({ "repo/marker": "", "host/marker": "" }, async (root) => {
    const repository = join(root, "repo");
    await writeLimitedWorkflow(repository);
    const reloaded = (limits: Readonly<Record<string, number>>) => {
      const result = spawnSync(
        process.execPath,
        [
          join(import.meta.dirname, "../tools/self-host-reload.ts"),
          JSON.stringify({
            directory: join(root, "host"),
            repository,
            home: root,
            xdgConfigHome: join(root, "config"),
            limits,
          }),
        ],
        { encoding: "utf8", timeout: testMilliseconds(90_000) },
      );
      const output: unknown = JSON.parse(result.stdout);
      return output;
    };
    assert.partialDeepStrictEqual(reloaded({ effects: 100, chain: 5 }), {
      workflowRefusals: [
        {
          scope: "project",
          label: "limited.ts",
          codes: ["effect-limit-above-maximum"],
        },
      ],
    });
    assert.partialDeepStrictEqual(reloaded({ effects: 200, chain: 2 }), {
      workflowRefusals: [],
      workflows: [{ workflowId: "limited", admitted: true }],
      declarations: [{ workflowId: "limited", chainLimit: 2 }],
    });
  }));

await test("CLV-308 cloving workflows list applies limits.effects of the project file", () =>
  withFiles({ "repo/marker": "" }, async (root) => {
    const repository = join(root, "repo");
    await writeLimitedWorkflow(repository);
    await writeFile(
      join(repository, ".cloving/config.json"),
      JSON.stringify({ version: 1, limits: { effects: 200 } }),
    );
    const result = spawnSync(
      process.execPath,
      [
        join(import.meta.dirname, "../src/cli.ts"),
        "workflows",
        "list",
        "--json",
        "--repository",
        repository,
      ],
      {
        encoding: "utf8",
        timeout: testMilliseconds(90_000),
        env: { PATH: process.env["PATH"], HOME: root },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const listed: unknown = JSON.parse(result.stdout);
    assert.partialDeepStrictEqual(listed, [
      { workflowId: "limited", admitted: true, codes: [] },
    ]);
  }));
