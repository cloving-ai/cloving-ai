import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { queueJournal } from "../src/daemon/queue-journal.ts";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { queueSettingWriter } from "../src/daemon/queue-setting-writer.ts";
import { queueLimitsSource } from "../src/daemon/queue-limits.ts";
import { parseConfiguration } from "../src/project-settings.ts";
import { settingsScene } from "./project-settings-fixture.ts";
import type { QueueSettingRequest } from "../src/queue-setting-operation.ts";
import type { DeclaredWorkflow } from "../src/workflow-declaration.ts";
import type { QueueLimitsSource } from "../src/daemon/queue-limits.ts";

const request: QueueSettingRequest = {
  commandId: "save-global",
  scope: "global",
  field: "lanes",
  action: "set",
  expectedValue: 16,
  value: 3,
};
const saved = {
  version: 1,
  queue: { lanes: 4, globalLanes: 3 },
  queues: { beta: { lanes: 5 } },
};

await test("CLV-377 the advanced global work cap persists and reads back independently of total and workflow lanes", () =>
  withSettings(async (scene) => {
    scene.write(scene.privateFile, {
      ...saved,
      queue: { lanes: 4, globalLanes: 4 },
    });
    scene.source.replace({ lanes: 4, workingLanes: 4, global: { lanes: 4 } });
    const outcome = await scene.edit()(
      {
        ...request,
        commandId: "work-cap",
        field: "workingLanes",
        expectedValue: 4,
        value: 2,
      },
      () => {
        scene.source.replace({
          lanes: 4,
          workingLanes: 4,
          global: { lanes: 4, workingLanes: 2 },
        });
        return Promise.resolve({ kind: "result", result: {} });
      },
    );
    assert.equal(outcome.kind, "changed");
    assert.deepEqual(JSON.parse(await readFile(scene.privateFile, "utf8")), {
      ...saved,
      queue: { lanes: 4, globalLanes: 4, globalWorkingLanes: 2 },
    });
  }));

function declaration(lanes: number): DeclaredWorkflow {
  return {
    workflowId: "alpha",
    functionName: "alpha",
    effectLimit: 1,
    capabilities: ["claude"],
    input: { maximumBytes: 1024, fields: { ticket: { type: "ticket" } } },
    queue: { lanes },
  };
}

function declaredLimits(lanes: number) {
  return {
    lanes,
    workingLanes: lanes,
    sources: {
      lanes: "declaration" as const,
      workingLanes: "default" as const,
    },
  };
}

function declarationReload(
  source: QueueLimitsSource,
  values: { readonly declared: number; readonly effective: number },
) {
  source.replace(
    {
      ...declaredLimits(values.effective),
      declarations: [declaration(values.declared)],
    },
    { alpha: declaredLimits(values.effective) },
  );
}

await test("CLV-377 edits and inherited readback use the declaration from the latest successful reload", () =>
  withSettings(async (scene) => {
    scene.write(scene.privateFile, { version: 1 });
    const initial = [declaration(2)];
    const source = queueLimitsSource({ declarations: initial });
    const edit = queueSettingWriter(
      {
        repository: scene.repository,
        directory: join(scene.root, "declaration-runtime"),
        declarations: initial,
      },
      source,
    );
    declarationReload(source, { declared: 6, effective: 6 });
    const set: QueueSettingRequest = {
      commandId: "after-reload",
      scope: "workflow",
      workflowId: "alpha",
      field: "lanes",
      action: "set",
      expectedValue: 6,
      value: 5,
    };
    assert.equal(
      (
        await edit(set, () => {
          source.replace(declaredLimits(5), { alpha: declaredLimits(5) });
          return Promise.resolve({ kind: "result", result: {} });
        })
      ).kind,
      "changed",
    );
    declarationReload(source, { declared: 8, effective: 5 });
    const inherited = await edit(
      {
        ...set,
        commandId: "inherit-latest",
        expectedValue: 5,
        action: "inherit",
        value: undefined,
      },
      () => {
        source.replace(declaredLimits(8), { alpha: declaredLimits(8) });
        return Promise.resolve({ kind: "result", result: {} });
      },
    );
    assert.equal(inherited.kind, "changed", JSON.stringify(inherited));
    assert.equal(source.current("alpha").lanes, 8);
  }));

await test("CLV-377 resetting six private lanes reads four from a declaration reloaded after startup at two", () =>
  withSettings(async (scene) => {
    scene.write(scene.privateFile, {
      version: 1,
      queues: { alpha: { lanes: 6 } },
    });
    const initial = [declaration(2)];
    const source = queueLimitsSource({ declarations: initial });
    declarationReload(source, { declared: 4, effective: 6 });
    const edit = queueSettingWriter(
      {
        repository: scene.repository,
        directory: join(scene.root, "reset-runtime"),
        declarations: initial,
      },
      source,
    );
    const outcome = await edit(
      {
        commandId: "reset-six-to-four",
        scope: "workflow",
        workflowId: "alpha",
        field: "lanes",
        expectedValue: 6,
        action: "inherit",
      },
      () => {
        source.replace(declaredLimits(4), { alpha: declaredLimits(4) });
        return Promise.resolve({ kind: "result", result: {} });
      },
    );
    assert.equal(outcome.kind, "changed", JSON.stringify(outcome));
    assert.equal(source.current("alpha").lanes, 4);
  }));

await test("CLV-377 a lost successful inheritance reply replays its receipt without a second reload", () =>
  withSettings(async (scene) => {
    scene.write(scene.privateFile, saved);
    scene.source.replace({ lanes: 4, workingLanes: 4, global: { lanes: 3 } });
    let reloads = 0;
    const reload = () => {
      reloads += 1;
      scene.source.replace({ lanes: 4, workingLanes: 4 });
      return Promise.resolve({ kind: "result" as const, result: {} });
    };
    const inherit = {
      ...request,
      commandId: "reset",
      expectedValue: 3,
      action: "inherit" as const,
      value: undefined,
    };
    assert.equal((await scene.edit()(inherit, reload)).kind, "changed");
    assert.equal((await scene.edit()(inherit, reload)).kind, "replayed");
    assert.equal(reloads, 1);
  }));

await test("CLV-377 an ambiguous pending save cannot recreate a newer same-value inherited setting", () =>
  withSettings(async (scene) => {
    const pending = {
      ...request,
      scope: "workflow" as const,
      workflowId: "alpha",
      value: 2,
      expectedValue: 4,
    };
    const directory = join(scene.root, "runtime/queue-settings");
    await mkdir(directory, { recursive: true });
    const journal = await queueJournal(directory);
    journal.controls.push({ ...pending, command: "setting", saved: false });
    await journal.save();
    scene.write(scene.privateFile, { version: 1, queue: { lanes: 2 } });
    scene.source.replace({ lanes: 2, workingLanes: 2 });
    const before = await readFile(scene.privateFile, "utf8");
    const result = await scene.edit()(pending, () => {
      throw new Error("Must not reload");
    });
    assert.equal(result.kind, "unavailable");
    assert.equal(await readFile(scene.privateFile, "utf8"), before);
  }));

await test("CLV-377 a late retry whose detailed receipt expired cannot repeat a write after a newer CLI reset", () =>
  withSettings(async (scene) => {
    const reload = () => {
      scene.source.replace({ lanes: 4, workingLanes: 4, global: { lanes: 3 } });
      return Promise.resolve({ kind: "result" as const, result: {} });
    };
    assert.equal((await scene.edit()(request, reload)).kind, "changed");
    const journal = await queueJournal(
      join(scene.root, "runtime/queue-settings"),
    );
    journal.controls.splice(0);
    await journal.save();
    scene.write(scene.privateFile, { version: 1, queue: { lanes: 4 } });
    scene.source.replace({ lanes: 4, workingLanes: 4 });
    const before = await readFile(scene.privateFile, "utf8");
    const result = await scene.edit()(request, () => {
      throw new Error("Must not reload an expired request");
    });
    assert.equal(result.kind, "unavailable");
    assert.equal(await readFile(scene.privateFile, "utf8"), before);
  }));

function fixture() {
  const scene = settingsScene();
  const source = queueLimitsSource({
    queueLimits: { lanes: 4, workingLanes: 4 },
  });
  const settings = {
    repository: scene.repository,
    directory: join(scene.root, "runtime"),
  };
  scene.write(scene.privateFile, { ...saved, queue: { lanes: 4 } });
  return { ...scene, source, edit: () => queueSettingWriter(settings, source) };
}

async function withSettings(
  body: (scene: ReturnType<typeof fixture>) => Promise<void>,
) {
  const scene = fixture();
  const previous = process.env["XDG_CONFIG_HOME"];
  process.env["XDG_CONFIG_HOME"] = scene.environment.XDG_CONFIG_HOME;
  try {
    await body(scene);
  } finally {
    if (previous === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = previous;
    rmSync(scene.root, { recursive: true, force: true });
  }
}

await test("CLV-377 typed settings persist and retain a lost-response receipt across reopening without overwriting newer edits", () =>
  withSettings(async (scene) => {
    let reloads = 0;
    const reload = async () => {
      reloads += 1;
      assert.deepEqual(
        parseConfiguration(
          await readFile(scene.privateFile, "utf8"),
          "private",
        ),
        saved,
      );
      scene.source.replace({ lanes: 4, workingLanes: 4, global: { lanes: 3 } });
      return { kind: "result" as const, result: {} };
    };
    assert.equal((await scene.edit()(request, reload)).kind, "changed");
    assert.equal((await scene.edit()(request, reload)).kind, "replayed");
    assert.equal(reloads, 1);
    scene.write(scene.privateFile, { version: 1, queue: { globalLanes: 4 } });
    assert.equal((await scene.edit()(request, reload)).kind, "unavailable");
    scene.write(scene.privateFile, saved);
    assert.equal(
      (await scene.edit()({ ...request, value: 4 }, reload)).kind,
      "conflicting-command",
    );
    assert.equal(
      (
        await scene.edit()(
          { ...request, commandId: "stale", expectedValue: 16 },
          reload,
        )
      ).kind,
      "stale",
    );
  }));

await test("CLV-377 reload refusal and unchanged inherited readback cannot claim an applied setting", () =>
  withSettings(async (scene) => {
    scene.source.replace({ lanes: 4, workingLanes: 4, global: { lanes: 3 } });
    scene.write(scene.privateFile, saved);
    const refused = await scene.edit()(
      { ...request, commandId: "refused", expectedValue: 3, value: 2 },
      () =>
        Promise.resolve({
          kind: "error",
          error: { code: "invalid-workflow", detail: "Fix the workflow" },
        }),
    );
    assert.equal(refused.kind, "unavailable");
    assert.equal(Reflect.get(refused, "saved"), true);
    assert.match(
      JSON.stringify(refused),
      /saved.*not applied.*Fix the workflow/,
    );
    assert.equal(scene.source.current().global?.lanes, 3);
    scene.write(scene.privateFile, { version: 1, queue: { globalLanes: 3 } });
    const inherit = {
      ...request,
      commandId: "inherit",
      action: "inherit" as const,
      value: undefined,
      expectedValue: 3,
    };
    const unchanged = await scene.edit()(inherit, () =>
      Promise.resolve({ kind: "result", result: {} }),
    );
    assert.equal(unchanged.kind, "unavailable");
    assert.equal(Reflect.get(unchanged, "saved"), true);
    const beforeRetry = await readFile(scene.privateFile, "utf8");
    const retried = await scene.edit()(inherit, () => {
      scene.source.replace({ lanes: 4, workingLanes: 4 });
      return Promise.resolve({ kind: "result", result: {} });
    });
    assert.equal(retried.kind, "changed");
    assert.equal(await readFile(scene.privateFile, "utf8"), beforeRetry);
  }));
