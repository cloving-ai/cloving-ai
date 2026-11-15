import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  queueLaneWriter,
  queueLimitsSource,
} from "../src/daemon/queue-limits.ts";
import { parseConfiguration } from "../src/project-settings.ts";
import { settingsScene } from "./project-settings-fixture.ts";
import { rmSync } from "node:fs";

async function withSettings(
  body: (
    fixture: ReturnType<typeof settingsScene> & {
      readonly runtimeDirectory: string;
    },
  ) => Promise<void>,
) {
  const fixture = { ...settingsScene(), runtimeDirectory: "unused" };
  const previous = process.env["XDG_CONFIG_HOME"];
  process.env["XDG_CONFIG_HOME"] = fixture.environment.XDG_CONFIG_HOME;
  try {
    await body(fixture);
  } finally {
    if (previous === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = previous;
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

await test("CLV-377 lane apply reloads the saved valid pair and reads back effective limits", () =>
  withSettings(async (fixture) => {
    fixture.write(fixture.privateFile, {
      version: 1,
      queue: { workingLanes: 3 },
    });
    const initial = {
      lanes: 4,
      workingLanes: 3,
      sources: { lanes: "queue setting", workingLanes: "queue setting" },
    } as const;
    const source = queueLimitsSource({ queueLimits: initial });
    let reloads = 0;
    const write = queueLaneWriter(
      {
        ...fixture,
        reload: async () => {
          reloads += 1;
          assert.deepEqual(source.current("develop"), initial);
          const saved = parseConfiguration(
            await readFile(fixture.privateFile, "utf8"),
            "private",
          );
          assert.deepEqual(saved.queues, {
            develop: { lanes: 2, workingLanes: 2 },
          });
          source.replace({ lanes: 2, workingLanes: 2 });
          return { kind: "result", result: {} };
        },
      },
      source,
    );
    await write("develop", 2);
    assert.equal(reloads, 1);
    assert.deepEqual(source.current("develop"), { lanes: 2, workingLanes: 2 });
  }));

await test("CLV-377 a refused reload preserves running limits and reports the saved but unapplied setting", () =>
  withSettings(async (fixture) => {
    const source = queueLimitsSource({
      queueLimits: { lanes: 2, workingLanes: 2 },
    });
    const write = queueLaneWriter(
      {
        ...fixture,
        reload: () =>
          Promise.resolve({
            kind: "error",
            error: {
              code: "reload-failed",
              detail: "Fix the invalid workflow.",
            },
          }),
      },
      source,
    );
    await assert.rejects(
      write("develop", 3),
      /saved.*not applied.*Fix the invalid workflow/,
    );
    assert.equal(source.current("develop").lanes, 2);
    assert.equal(
      parseConfiguration(await readFile(fixture.privateFile, "utf8"), "private")
        .queues?.["develop"]?.lanes,
      3,
    );
  }));

await test("CLV-377 successful reload output cannot claim apply when effective readback differs", () =>
  withSettings(async (fixture) => {
    const source = queueLimitsSource({
      queueLimits: { lanes: 2, workingLanes: 2 },
    });
    const write = queueLaneWriter(
      {
        ...fixture,
        reload: () => Promise.resolve({ kind: "result", result: {} }),
      },
      source,
    );
    await assert.rejects(write("develop", 3), /not applied.*2.*default/);
  }));

await test("CLV-377 an implicit working cap keeps following the total after saving", () =>
  withSettings(async (fixture) => {
    const source = queueLimitsSource({
      queueLimits: { lanes: 4, workingLanes: 4 },
    });
    const write = queueLaneWriter(
      {
        ...fixture,
        reload: async () => {
          const saved = parseConfiguration(
            await readFile(fixture.privateFile, "utf8"),
            "private",
          );
          assert.deepEqual(saved.queues, { develop: { lanes: 2 } });
          source.replace({ lanes: 2, workingLanes: 2 });
          return { kind: "result", result: {} };
        },
      },
      source,
    );
    await write("develop", 2);
  }));

await test("CLV-377 an environment or retained start queues override refuses before writing or reloading", () =>
  withSettings(async (fixture) => {
    const source = queueLimitsSource({
      queueLimits: { lanes: 2, workingLanes: 2 },
    });
    let reloads = 0;
    const write = queueLaneWriter(
      {
        ...fixture,
        settingSources: { queues: "environment" },
        reload: () => {
          reloads += 1;
          return Promise.resolve({ kind: "result", result: {} });
        },
      },
      source,
    );
    await assert.rejects(
      write("develop", 3),
      /CLOVING_QUEUES.*environment.*retained start/,
    );
    assert.equal(reloads, 0);
    await assert.rejects(access(fixture.privateFile), { code: "ENOENT" });
  }));

await test("CLV-377 a stale running private working cap cannot undo a concurrent CLI unset", () =>
  withSettings(async (fixture) => {
    fixture.write(fixture.privateFile, {
      version: 1,
      queues: { develop: { lanes: 4 } },
    });
    const source = queueLimitsSource({
      queueLimits: {
        lanes: 4,
        workingLanes: 3,
        sources: {
          lanes: "queues setting (private file)",
          workingLanes: "queues setting (private file)",
        },
      },
    });
    const write = queueLaneWriter(
      {
        ...fixture,
        reload: async () => {
          assert.deepEqual(
            parseConfiguration(
              await readFile(fixture.privateFile, "utf8"),
              "private",
            ).queues,
            { develop: { lanes: 2 } },
          );
          source.replace({ lanes: 2, workingLanes: 2 });
          return { kind: "result", result: {} };
        },
      },
      source,
    );
    await write("develop", 2);
  }));

await test("CLV-377 removing a private cap still respects surviving project queue and general caps", async () => {
  for (const project of [
    { queue: { workingLanes: 3 } },
    { queues: { develop: { workingLanes: 3 } } },
    { queues: { develop: { workingLanes: 1 } } },
  ]) {
    await withSettings(async (fixture) => {
      fixture.write(fixture.project, { version: 1, ...project });
      const source = queueLimitsSource({
        queueLimits: { lanes: 4, workingLanes: 3 },
      });
      const lower = project.queues?.develop.workingLanes === 1;
      const write = queueLaneWriter(
        {
          ...fixture,
          reload: async () => {
            const saved = parseConfiguration(
              await readFile(fixture.privateFile, "utf8"),
              "private",
            );
            assert.deepEqual(saved.queues, {
              develop: lower ? { lanes: 2 } : { lanes: 2, workingLanes: 2 },
            });
            source.replace({ lanes: 2, workingLanes: lower ? 1 : 2 });
            return { kind: "result", result: {} };
          },
        },
        source,
      );
      await write("develop", 2);
    });
  }
});
