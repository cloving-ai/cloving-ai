import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { git } from "./claude-worker-fixture.ts";
import {
  committed,
  withGithub,
  type GithubScene,
  pullBody as body,
  pullTitle as title,
  treeOf as tree,
} from "./github-worker-fixture.ts";

const privateTexts = ["/home/private-person", "Secret-Word", "Privé"];
const call = { method: "open-pr", payload: { title, body } };

function onDefaultBranch(
  scene: GithubScene,
  change: { readonly name: string; readonly text: string },
): void {
  committed(scene.repository, change);
  git(scene.repository, ["push", "--quiet", "origin", "main"]);
}

function saved(
  tree: string,
  change: { readonly name: string; readonly text: string },
): string {
  committed(tree, change);
  git(tree, ["commit", "--quiet", "--amend", "-m", "Change a file"]);
  return git(tree, ["rev-parse", "HEAD"]);
}

function outcomeOf(report: {
  readonly outcome: string;
  readonly reason?: string;
}): readonly [string, string | undefined] {
  return [report.outcome, report.reason];
}

async function pushed(
  scene: GithubScene,
  change: (tree: string) => string,
): Promise<readonly [string, string | undefined, boolean]> {
  const worker = scene.worker({ privateTexts });
  await scene.perform(worker, { method: "prepare", payload: {} });
  const commit = change(tree(scene));
  const report = await scene.perform(worker, call);
  const remote = git(scene.origin, [
    "branch",
    "--list",
    "--format=%(objectname)",
    "cloving/ticket-one",
  ]);
  return [...outcomeOf(report), remote === commit];
}

await test("CLV-324 open-pr pushes a change that edits the line next to a line of the default branch with a private text or the home folder", () =>
  withGithub(async (scene) => {
    const lines = (last: string): string =>
      [
        `export const home = "${homedir()}";`,
        'export const notes = "/HOME/private-person/notes";',
        `export const last = ${last};`,
        "",
      ].join("\n");
    onDefaultBranch(scene, { name: "context.ts", text: lines("1") });
    const report = await pushed(scene, (place) =>
      saved(place, { name: "context.ts", text: lines("2") }),
    );
    assert.deepEqual(report, ["completed", undefined, true]);
  }));

await test("CLV-324 open-pr pushes a change that removes a line with a private text, or edits a file whose name on the default branch has a private text", () =>
  withGithub(async (scene) => {
    onDefaultBranch(scene, {
      name: "secret-word.ts",
      text: 'export const word = "the Secret-Word";\nexport const kept = 1;\n',
    });
    const report = await pushed(scene, (place) =>
      saved(place, {
        name: "secret-word.ts",
        text: "export const kept = 2;\n",
      }),
    );
    assert.deepEqual(report, ["completed", undefined, true]);
  }));

await test("CLV-324 open-pr refuses an added line with a private text that starts like a file header", () =>
  withGithub(async (scene) => {
    const report = await pushed(scene, (place) =>
      saved(place, {
        name: "notes.txt",
        text: "The notes.\n++ /home/PRIVATE-person/notes\n",
      }),
    );
    assert.deepEqual(report, ["failed", "private-path-in-change", false]);
  }));

await test("CLV-324 open-pr refuses a new empty file and a renamed file whose names have a private text in any case of letters, also with letters outside ASCII", () =>
  withGithub(async (scene) => {
    const empty = await pushed(scene, (place) =>
      saved(place, { name: "PRIVÉ-notes.ts", text: "" }),
    );
    assert.deepEqual(empty, ["failed", "private-path-in-change", false]);
    onDefaultBranch(scene, { name: "plain.ts", text: "export {};\n" });
    git(tree(scene), ["fetch", "--quiet", "origin"]);
    git(tree(scene), ["reset", "--quiet", "--hard", "origin/main"]);
    git(tree(scene), ["mv", "src/plain.ts", "src/secret-word.ts"]);
    git(tree(scene), ["commit", "--quiet", "-m", "Move the file"]);
    const renamed = await scene.perform(scene.worker({ privateTexts }), call);
    assert.deepEqual(outcomeOf(renamed), ["failed", "private-path-in-change"]);
  }));

await test("CLV-324 open-pr refuses an added line with a private text when the git settings ask for color and an external diff program", () =>
  withGithub(async (scene) => {
    const program = join(scene.directory, "external-diff.sh");
    writeFileSync(program, "#!/bin/sh\necho changed\n", { mode: 0o755 });
    git(scene.repository, ["config", "color.ui", "always"]);
    git(scene.repository, ["config", "diff.external", program]);
    const report = await pushed(scene, (place) =>
      saved(place, {
        name: "notes.ts",
        text: 'export const notes = "/home/private-person/notes";\n',
      }),
    );
    assert.deepEqual(report, ["failed", "private-path-in-change", false]);
  }));
