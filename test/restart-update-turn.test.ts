import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { workflowPin } from "../src/broker/workflow-pin.ts";
import { admitCompiled } from "../src/cli/validate.ts";
import { staleBuild } from "../tools/restart-build.ts";
import { field } from "./self-host-fixture.ts";
import { call } from "./service-fixture.ts";
import {
  admittedTurn,
  assistantTexts,
  finishedRun,
  lineTurn,
  productGit,
  restartedTurns,
  pinnedWorkflow,
  withTurnHost,
  workflowBundles,
  writingTurn,
  writtenLines,
} from "./restart-turn-fixture.ts";

const unavailable = "cloving-host-unavailable";

async function updatedOrigin(product: string): Promise<string> {
  const git = productGit(product);
  const origin = join(product, "..", "product-origin.git");
  execFileSync("git", ["clone", "-q", "--bare", product, origin]);
  git(["remote", "add", "origin", origin]);
  const old = git(["rev-parse", "HEAD"]);
  const step = join(product, "src/steps/protected-effect.ts");
  const source = await readFile(step, "utf8");
  assert.match(source, /return await bridge\.effect\(request\);/);
  await writeFile(
    step,
    source
      .replace(unavailable, `${unavailable}-after-update`)
      .replace(
        "return await bridge.effect(request);",
        `await bridge.effect(request);\n  return { kind: "unavailable", reason: "${unavailable}-after-update" };`,
      ),
  );
  git(["add", "src/steps/protected-effect.ts"]);
  git(["commit", "-qm", "Update the product"]);
  const target = git(["rev-parse", "HEAD"]);
  git(["push", "-q", "origin", "main"]);
  git(["reset", "-q", "--hard", old]);
  git(["fetch", "-q", "origin"]);
  git(["remote", "set-head", "origin", "main"]);
  return target;
}

async function bundlePin(directory: string, bundle: string): Promise<string> {
  const folder = join(directory, "workflow-bundles", bundle);
  const names = (await readdir(folder)).filter((name) =>
    name.endsWith(".workflow.json"),
  );
  assert.equal(names.length, 1);
  const file = join(folder, String(names[0]));
  const admission = await admitCompiled(file, {
    file,
    capabilities: ["claude"],
  });
  assert.equal(admission.kind, "admitted", JSON.stringify(admission));
  return workflowPin({ ...admission.manifest, bundleDigest: bundle });
}

await test(
  "CLV-347 cloving restart --update in the middle of a turn updates the checkout, and the turn goes on with its pinned bundle and ends with its result",
  { timeout: 120_000 },
  async () => {
    const update = { target: "" };
    await withTurnHost(
      {
        script: lineTurn,
        prepare: async (product) => {
          update.target = await updatedOrigin(product);
        },
      },
      async (scene) => {
        const { fixture, product } = scene;
        const git = productGit(product);
        assert.equal(
          await staleBuild(product, (argumentsList) =>
            Promise.resolve(git(argumentsList)),
          ),
          false,
        );
        const runId = await admittedTurn(fixture, "update");
        const writing = await writingTurn(scene, runId);
        const pinned = await pinnedWorkflow(fixture, runId);
        assert.equal(typeof pinned, "string");
        const [bundle, ...otherBundles] = await workflowBundles(
          fixture.directory,
        );
        assert.deepEqual(otherBundles, []);
        assert.equal(
          pinned,
          await bundlePin(fixture.directory, String(bundle)),
        );
        const turns = await restartedTurns(fixture, ["--update"]);
        assert.deepEqual(field(turns, "connected"), [runId]);
        assert.equal(git(["rev-parse", "HEAD"]), update.target);
        const status = await call(fixture, {
          operation: "status",
          parameters: {},
        });
        assert.equal(status["serviceCommit"], update.target);
        assert.match(
          await readFile(
            join(product, "dist/src/steps/protected-effect.js"),
            "utf8",
          ),
          /-after-update/,
        );
        const updatedBundles = await workflowBundles(fixture.directory);
        assert.equal(updatedBundles.length, 2, updatedBundles.join(" "));
        assert.ok(updatedBundles.includes(String(bundle)));
        const run = await finishedRun(fixture, runId);
        assert.equal(field(run, "state"), "completed", JSON.stringify(run));
        assert.equal(await pinnedWorkflow(fixture, runId), pinned);
        assert.deepEqual(
          assistantTexts(await writing.watch.closed),
          writtenLines(writing.processId),
        );
      },
    );
  },
);
