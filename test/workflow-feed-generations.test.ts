import assert from "node:assert/strict";
import { test } from "node:test";
import { workflowGenerations } from "../src/daemon/workflow-generations.ts";
import { workflowRegistry } from "../src/service/registry.ts";
import { withHarness } from "./service-fixture.ts";
import { bundled } from "./service-bundle-fixture.ts";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";

await test("CLV-362 current feed pins select the feed function and never the work function", () =>
  withHarness(async (harness) => {
    const manifest = {
      ...harness.registration.manifest,
      workflowId: "workflow//./workflows/triage//triageFeed",
    };
    const work = () => Promise.resolve("work");
    const feed = () => Promise.resolve({ picks: [], skipped: [] });
    const handler = () => Promise.resolve(new Response("handled"));
    const settings = {
      directory: harness.stateDirectory,
      repository: harness.projectDirectory,
      registrations: [
        {
          ...harness.registration,
          feed: { functionName: "triageFeed", effectLimit: 3, manifest },
        },
      ],
      table: [{ workflowId: "develop", functionName: "work" }],
      workflows: { work, triageFeed: feed },
      handler,
    };
    const registry = workflowRegistry(settings.registrations);
    assert.deepEqual(registry.workflowIds, ["develop"]);
    assert.equal(registry.byId("triageFeed"), undefined);
    const generations = workflowGenerations(settings);
    assert.deepEqual(await generations.resolve(manifest), {
      workflow: feed,
      handler,
    });
    assert.equal(await generations.available(manifest), manifest);
    assert.deepEqual(await generations.resolve(harness.registration.manifest), {
      workflow: work,
      handler,
    });
    generations.replace({ ...settings, workflows: { work } });
    assert.equal(await generations.resolve(manifest), undefined);
    generations.replace({ ...settings, workflows: { work, triageFeed: 1 } });
    assert.equal(await generations.resolve(manifest), undefined);
  }));

await test("CLV-362 a retained feed pin uses its original bundle after the current feed changes", () =>
  withHarness(async (harness) => {
    const saved = await bundled(harness);
    const directory = join(harness.stateDirectory, "workflow-bundles");
    await rename(saved.workflowBundles.directory, directory);
    const originalManifest = {
      ...harness.registration.manifest,
      workflowId: "workflow//./workflows/triage//triageFeed",
      bundleDigest: saved.bundleDigest,
    };
    const currentManifest = {
      ...originalManifest,
      bundleDigest: "b".repeat(64),
    };
    const original = Object.assign(() => Promise.resolve("original feed"), {
      workflowId: originalManifest.workflowId,
    });
    const current = () => Promise.resolve("current feed");
    const handler = () => Promise.resolve(new Response("retained"));
    const loaded: string[] = [];
    const generations = workflowGenerations({
      directory: harness.stateDirectory,
      repository: harness.projectDirectory,
      registrations: [
        {
          ...harness.registration,
          feed: {
            functionName: "triageFeed",
            effectLimit: 3,
            manifest: currentManifest,
          },
        },
      ],
      table: [],
      workflows: { triageFeed: current },
      handler,
      loadBundle: (path) => {
        loaded.push(path);
        return Promise.resolve({ workflows: { original }, handler });
      },
    });
    assert.deepEqual(await generations.resolve(currentManifest), {
      workflow: current,
      handler,
    });
    assert.equal(loaded.length, 0);
    assert.deepEqual(await generations.resolve(originalManifest), {
      workflow: original,
      handler,
    });
    assert.deepEqual(loaded, [join(directory, saved.bundleDigest)]);
    await rm(join(directory, saved.bundleDigest), { recursive: true });
    assert.equal(await generations.resolve(originalManifest), undefined);
  }));

await test("CLV-362 an unavailable queue cannot resolve its current feed function", () =>
  withHarness(async (harness) => {
    const manifest = {
      ...harness.registration.manifest,
      workflowId: "workflow//./workflows/triage//triageFeed",
    };
    const generations = workflowGenerations({
      directory: harness.stateDirectory,
      repository: harness.projectDirectory,
      registrations: [
        {
          ...harness.registration,
          availability: "unavailable",
          feed: { functionName: "triageFeed", effectLimit: 3, manifest },
        },
      ],
      table: [{ workflowId: "develop", functionName: "work" }],
      workflows: {
        work: () => Promise.resolve("work"),
        triageFeed: () => Promise.resolve({ picks: [], skipped: [] }),
      },
      handler: () => Promise.resolve(new Response("handled")),
    });
    assert.equal(
      await generations.resolve(harness.registration.manifest),
      undefined,
    );
    assert.equal(await generations.resolve(manifest), undefined);
    assert.equal(await generations.available(manifest), undefined);
  }));
