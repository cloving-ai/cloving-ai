import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
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
  runStatus,
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
  await writeFile(
    step,
    source.replace(unavailable, `${unavailable}-after-update`),
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

await test("CLV-347 cloving restart --update in the middle of a turn updates the checkout, and the turn goes on with its pinned bundle and ends with its result", async () => {
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
      const pinned = field(await runStatus(fixture, runId), "workflow");
      const [bundle, ...otherBundles] = await workflowBundles(
        fixture.directory,
      );
      assert.deepEqual(otherBundles, []);
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
      assert.equal(field(run, "workflow"), pinned);
      assert.deepEqual(
        assistantTexts(await writing.watch.closed),
        writtenLines(writing.processId),
      );
    },
  );
});
