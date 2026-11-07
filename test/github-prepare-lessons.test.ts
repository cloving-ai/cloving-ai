import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { git, resultOf } from "./claude-worker-fixture.ts";
import {
  withGithub,
  type GithubScene,
  treeOf as tree,
} from "./github-worker-fixture.ts";

const lessonsText =
  "- 2026-11-05 CLV-296: Do not assert exact timer values in tests.\n";

function pushed(scene: GithubScene, write: (repository: string) => void) {
  write(scene.repository);
  git(scene.repository, ["add", "."]);
  git(scene.repository, ["commit", "--quiet", "-m", "Change the lessons"]);
  git(scene.repository, ["push", "--quiet", "origin", "main"]);
  return git(scene.repository, ["rev-parse", "HEAD"]);
}

function lessonsFile(text: string) {
  return (repository: string) => {
    mkdirSync(join(repository, ".cloving"), { recursive: true });
    writeFileSync(join(repository, ".cloving/lessons.md"), text);
  };
}

async function prepared(scene: GithubScene, payload: object) {
  const report = await scene.perform(scene.worker(), {
    method: "prepare",
    payload,
  });
  assert.equal(report.outcome, "completed", JSON.stringify(report));
  return resultOf(report.result);
}

await test("CLV-303 prepare with lessons returns the lessons file of the default branch", () =>
  withGithub(async (scene) => {
    const newest = pushed(scene, lessonsFile(lessonsText));
    assert.deepEqual(await prepared(scene, { lessons: true }), {
      branch: "cloving/ticket-one",
      worktree: tree(scene),
      base: "main",
      startCommit: newest,
      lessons: { text: lessonsText, bytes: lessonsText.length },
    });
  }));

await test("CLV-303 prepare gives an empty text for a missing lessons file and no lessons without the request", () =>
  withGithub(async (scene) => {
    assert.deepEqual((await prepared(scene, { lessons: true }))["lessons"], {
      text: "",
      bytes: 0,
    });
    assert.equal(Object.hasOwn(await prepared(scene, {}), "lessons"), false);
  }));

await test("CLV-303 prepare gives the first 16384 bytes of a larger lessons file", () =>
  withGithub(async (scene) => {
    const text = "- 2026-11-06 CLV-303: Keep the file short.\n".repeat(500);
    pushed(scene, lessonsFile(text));
    assert.deepEqual((await prepared(scene, { lessons: true }))["lessons"], {
      text: text.slice(0, 16384),
      bytes: text.length,
    });
  }));

await test("CLV-303 prepare refuses a lessons request that is not true", () =>
  withGithub(async (scene) => {
    const worker = scene.worker();
    for (const lessons of [false, "yes", 1, null]) {
      const report = await scene.perform(worker, {
        method: "prepare",
        payload: { lessons },
      });
      assert.deepEqual(
        [report.outcome, report.reason],
        ["failed", "invalid-payload"],
      );
    }
  }));

for (const link of [
  {
    name: "a link as the lessons file",
    write: (repository: string) => {
      mkdirSync(join(repository, ".cloving"), { recursive: true });
      symlinkSync("../README.md", join(repository, ".cloving/lessons.md"));
    },
  },
  {
    name: "a link as the .cloving folder",
    write: (repository: string) => {
      lessonsFile(lessonsText)(join(repository, "notes"));
      symlinkSync("notes/.cloving", join(repository, ".cloving"));
    },
  },
])
  await test(`CLV-303 prepare refuses ${link.name}`, () =>
    withGithub(async (scene) => {
      pushed(scene, link.write);
      const report = await scene.perform(scene.worker(), {
        method: "prepare",
        payload: { lessons: true },
      });
      assert.deepEqual(
        [report.outcome, report.reason],
        ["failed", "lessons-not-a-file"],
      );
    }));
