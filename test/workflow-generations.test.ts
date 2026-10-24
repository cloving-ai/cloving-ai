import assert from "node:assert/strict";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { workflowGenerations } from "../src/daemon/workflow-generations.ts";
import { workflowRegistry } from "../src/service/registry.ts";
import { bundled } from "./service-bundle-fixture.ts";
import { withHarness } from "./service-fixture.ts";
import { changedManifest } from "./service-views.ts";

await test("CLV-161 retained generation resolution requires a validated bundle and its matching compiled function", () =>
  withHarness(async (harness) => {
    const saved = await bundled(harness);
    const directory = join(harness.stateDirectory, "workflow-bundles");
    await rename(saved.workflowBundles.directory, directory);
    const manifest = saved.workflows[0]?.manifest;
    assert.ok(manifest);
    const current = () => Promise.resolve("current");
    const original = Object.assign(() => Promise.resolve("original"), {
      workflowId: manifest.workflowId,
    });
    const handler = () => Promise.resolve(new Response("handled"));
    const settings = {
      directory: harness.stateDirectory,
      repository: harness.projectDirectory,
      registrations: [{ ...harness.registration, manifest: changedManifest }],
      table: [
        {
          workflowId: harness.registration.workflowId,
          functionName: "current",
        },
      ],
      workflows: { current },
      handler,
    };
    const loaded: string[] = [];
    const generations = workflowGenerations({
      ...settings,
      loadBundle: (path) => {
        loaded.push(path);
        return Promise.resolve({
          workflows: {
            scalar: 1,
            empty: null,
            missing: undefined,
            wrong: current,
            original,
          },
          handler,
        });
      },
    });
    assert.equal(await generations.resolve(undefined), undefined);
    assert.deepEqual(await generations.resolve(changedManifest), {
      workflow: current,
      handler,
    });
    assert.equal(loaded.length, 0);
    assert.deepEqual(await generations.resolve(manifest), {
      workflow: original,
      handler,
    });
    assert.deepEqual(loaded, [join(directory, saved.bundleDigest)]);
    assert.equal(await generations.available(manifest), manifest);
    await rm(join(directory, saved.bundleDigest), { recursive: true });
    assert.equal(await generations.available(manifest), undefined);
    assert.equal(loaded.length, 2);
  }));

await test("CLV-161 unavailable retained executables never fall back to current functions", () =>
  withHarness(async (harness) => {
    const saved = await bundled(harness);
    await rename(
      saved.workflowBundles.directory,
      join(harness.stateDirectory, "workflow-bundles"),
    );
    const manifest = saved.workflows[0]?.manifest;
    assert.ok(manifest);
    const settings = {
      directory: harness.stateDirectory,
      repository: harness.projectDirectory,
      registrations: [{ ...harness.registration, manifest: changedManifest }],
      table: [
        {
          workflowId: harness.registration.workflowId,
          functionName: "current",
        },
      ],
      workflows: {},
      handler: () => Promise.resolve(new Response("current")),
    };
    assert.equal(
      await workflowGenerations(settings).resolve(changedManifest),
      undefined,
    );
    assert.equal(
      await workflowGenerations(settings).resolve(
        harness.registration.manifest,
      ),
      undefined,
    );
    assert.equal(
      await workflowGenerations(settings).resolve(manifest),
      undefined,
    );
    const missing = workflowGenerations({
      ...settings,
      loadBundle: () =>
        Promise.resolve({
          workflows: { wrong: () => Promise.resolve("wrong") },
          handler: settings.handler,
        }),
    });
    assert.equal(await missing.resolve(manifest), undefined);
    const failed = workflowGenerations({
      ...settings,
      loadBundle: () => Promise.reject(new Error("unloadable bundle")),
    });
    assert.equal(await failed.resolve(manifest), undefined);
    assert.equal(await workflowRegistry([]).bundle(manifest), undefined);
    assert.equal(
      await workflowRegistry([]).bundle(harness.registration.manifest),
      undefined,
    );
  }));
