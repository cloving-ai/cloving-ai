import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { record } from "../src/protocol.ts";
import { resultOf } from "./claude-worker-fixture.ts";
import {
  committed,
  pullBody as body,
  pullTitle as title,
  treeOf as tree,
  withGithub,
  type GithubScene,
} from "./github-worker-fixture.ts";

function retitled(scene: GithubScene, changed: string): void {
  const file = join(scene.directory, "gh-state.json");
  const state = record(JSON.parse(readFileSync(file, "utf8"))) ?? {};
  const pulls = Array.isArray(state["prs"]) ? state["prs"] : [];
  writeFileSync(
    file,
    JSON.stringify({
      ...state,
      prs: pulls.map((pull: unknown) => ({ ...record(pull), title: changed })),
    }),
  );
}

await test("CLV-334 open-pr records the title of the pull request it opens, and a later call records the current title on GitHub", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    await scene.perform(worker, { method: "prepare", payload: {} });
    committed(tree(scene), { name: "one.ts", text: "1;\n" });
    const call = { method: "open-pr", payload: { title, body } };
    const opening = await scene.perform(worker, call);
    assert.equal(resultOf(opening.result)["title"], title);
    retitled(scene, "SID-4820: Filter and page Notion database files");
    committed(tree(scene), { name: "two.ts", text: "2;\n" });
    const again = await scene.perform(worker, call);
    assert.equal(
      resultOf(again.result)["title"],
      "SID-4820: Filter and page Notion database files",
    );
    assert.deepEqual(
      scene.state().prs.map((pull) => pull["title"]),
      ["SID-4820: Filter and page Notion database files"],
    );
  }));
