import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cli, cliOptions } from "./cli-workflows-fixture.ts";
import { candidatePackageRoot } from "./candidate-package-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { record } from "../src/protocol.ts";
import { isCandidateDeclaration } from "../src/workflow-candidate.ts";
import { candidateDeclaration } from "./workflow-candidate-fixtures.ts";
import {
  readTemplate,
  templateList,
  templateRoot,
} from "../tools/template-files.ts";
import {
  developTemplate,
  filesBelow,
  listed,
  packagedEntry,
  repository,
  templates,
  templateFiles,
} from "./cli-templates-fixture.ts";

await test("CLV-227 the built CLI exposes the template copy command", () =>
  withFiles(repository, (root) => {
    const result = spawnSync(
      process.execPath,
      [
        join(candidatePackageRoot, "dist/src/cli.js"),
        "templates",
        "copy",
        "--help",
      ],
      cliOptions(root),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /cloving templates copy <name>/);
  }));

function summaryOf(name: string): unknown {
  return record(
    JSON.parse(readFileSync(`templates/${name}/template.json`, "utf8")),
  )?.["summary"];
}

await test("CLV-223 templates list gives each template with its summary and point count", () =>
  withFiles(repository, (root) => {
    const result = templates(root, ["list", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const template = record(developTemplate);
    const points = template?.["points"];
    assert.ok(Array.isArray(points));
    assert.deepEqual(JSON.parse(result.stdout), [
      { name: "answer-review", summary: summaryOf("answer-review"), points: 1 },
      {
        name: "dependency-audit",
        summary: summaryOf("dependency-audit"),
        points: 0,
      },
      {
        name: "dependency-ticket",
        summary: summaryOf("dependency-ticket"),
        points: 0,
      },
      {
        name: "develop",
        summary: template?.["summary"],
        points: points.length,
      },
      { name: "idea-to-issue", summary: summaryOf("idea-to-issue"), points: 3 },
      { name: "patrol", summary: summaryOf("patrol"), points: 1 },
      { name: "rescue-pr", summary: summaryOf("rescue-pr"), points: 2 },
      { name: "review-day", summary: summaryOf("review-day"), points: 2 },
      { name: "triage-issue", summary: summaryOf("triage-issue"), points: 1 },
    ]);
    const human = templates(root, ["list"]);
    assert.match(
      human.stdout,
      /^answer-review: .+ \(1 decision points\)\ndependency-audit: .+ \(0 decision points\)\ndependency-ticket: .+ \(0 decision points\)\ndevelop: .+ \(9 decision points\)\nidea-to-issue: .+ \(3 decision points\)\npatrol: .+ \(1 decision points\)\nrescue-pr: .+ \(2 decision points\)\nreview-day: .+ \(2 decision points\)\ntriage-issue: .+ \(1 decision points\)\n$/,
    );
  }));

await test("CLV-223 templates show gives the template description and its workflow files", () =>
  withFiles(repository, async (root) => {
    const result = templates(root, ["show", "develop", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    const shown = record(JSON.parse(result.stdout));
    assert.deepEqual(shown?.["template"], developTemplate);
    const expected = await templateFiles();
    assert.deepEqual(shown?.["files"], expected);
    assert.ok(expected.includes("develop.ts"));
    assert.ok(expected.includes("develop.declaration.json"));
    assert.ok(expected.includes("develop.test.ts"));
    assert.ok(expected.some((file) => file.startsWith("develop/")));
  }));

await test("CLV-223 templates copy writes the workflow parts and the start admits the copy", () =>
  withFiles(repository, async (root) => {
    const result = templates(root, ["copy", "develop"]);
    assert.equal(result.status, 0, result.stderr);
    const folder = join(root, "repo/.cloving/workflows");
    const expected = await templateFiles();
    assert.deepEqual(await filesBelow(folder), expected);
    const declaration = record(
      JSON.parse(
        await readFile(join(folder, "develop.declaration.json"), "utf8"),
      ),
    );
    assert.equal(declaration?.["template"], "develop");
    assert.match(result.stdout, /input: What should the workflow develop\?/);
    assert.match(result.stdout, /cloving workflows test develop/);
    const develop = listed(root).find(
      (item) => item["workflowId"] === "develop",
    );
    assert.equal(develop?.["admitted"], true, JSON.stringify(develop));
  }));

await test("CLV-223 templates copy with an id renames the files, the workflow and its function", () =>
  withFiles(repository, async (root) => {
    assert.equal(templates(root, ["copy", "develop"]).status, 0);
    const copied = templates(root, ["copy", "develop", "--id", "site-develop"]);
    assert.equal(copied.status, 0, copied.stderr);
    assert.match(copied.stdout + copied.stderr, /queue-workflow-conflict/);
    const folder = join(root, "repo/.cloving/workflows");
    const source = await readFile(join(folder, "site-develop.ts"), "utf8");
    assert.match(source, /export async function siteDevelop\(/);
    assert.match(source, /from "\.\/site-develop\/round\.ts"/);
    assert.doesNotMatch(source, /"\.\/develop\//);
    const helpers = await filesBelow(join(folder, "site-develop"));
    assert.ok(helpers.length > 0);
    for (const helper of helpers)
      assert.doesNotMatch(
        await readFile(join(folder, "site-develop", helper), "utf8"),
        /"\.\.\/develop\.ts"|\bdevelop\(/,
      );
    const declarationFile = join(folder, "site-develop.declaration.json");
    const declaration = record(
      JSON.parse(await readFile(declarationFile, "utf8")),
    );
    const workflow = record(declaration?.["workflow"]);
    assert.equal(workflow?.["workflowId"], "site-develop");
    assert.equal(declaration?.["template"], "develop");
    await writeFile(
      declarationFile,
      JSON.stringify({
        ...declaration,
        workflow: { ...workflow, queue: false },
      }),
    );
    const admitted = listed(root).filter(
      (item) =>
        ["develop", "site-develop"].includes(String(item["workflowId"])) &&
        item["admitted"] === true,
    );
    assert.equal(admitted.length, 2, JSON.stringify(listed(root)));
    const tested = cli(root, {
      args: ["test", "site-develop"],
      entry: packagedEntry,
    });
    assert.equal(tested.status, 0, tested.stdout + tested.stderr);
  }));

await test("CLV-223 templates commands refuse unknown templates and invalid ids", () =>
  withFiles(repository, (root) => {
    const unknown = templates(root, ["copy", "missing"]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /unknown-template: missing/);
    for (const id of ["Site Develop", "develop-", "../develop"]) {
      const invalid = templates(root, ["copy", "develop", "--id", id]);
      assert.notEqual(invalid.status, 0);
      assert.match(invalid.stderr, /invalid-workflow-id/);
    }
    const wrong = templates(root, ["remove", "develop"]);
    assert.equal(wrong.status, 2);
    assert.match(wrong.stderr, /invalid-invocation/);
  }));

await test("CLV-223 a declaration may name its template", () => {
  const valid = { ...candidateDeclaration, template: "develop" };
  assert.equal(isCandidateDeclaration(valid), true);
  for (const template of [5, "", "Develop", "-develop"])
    assert.equal(
      isCandidateDeclaration({ ...candidateDeclaration, template }),
      false,
      String(template),
    );
});

await test("CLV-223 templates help, text output and invalid invocations", () =>
  withFiles(repository, (root) => {
    for (const args of [["--help"], ["list", "--help"]]) {
      const help = templates(root, args);
      assert.equal(help.status, 0, help.stderr);
      assert.match(help.stdout, /cloving templates copy <name>/);
    }
    const shown = templates(root, ["show", "develop"]);
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /^develop: /);
    assert.match(
      shown.stdout,
      /\n {2}input: .+\n {4}- ticket: .+ \(default\)\n/,
    );
    assert.match(shown.stdout, /Files:\n {2}develop\.declaration\.json\n/);
    for (const args of [
      ["list", "develop"],
      ["show"],
      ["show", "develop", "extra"],
      ["show", "develop", "--id", "other"],
      ["list", "--repository", "elsewhere"],
    ]) {
      const wrong = templates(root, args);
      assert.equal(wrong.status, 2, args.join(" "));
      assert.match(wrong.stderr, /invalid-invocation/);
    }
  }));

await test("CLV-223 template files skip invalid template folders and need a package root", () =>
  withFiles(
    {
      "templates/good/template.json": JSON.stringify({
        summary: "Good.",
        points: [{ id: "one" }],
      }),
      "templates/good/good.ts": "export const good = 1;\n",
      "templates/broken/template.json": JSON.stringify({ points: [] }),
      "templates/Bad/template.json": JSON.stringify({
        summary: "Bad.",
        points: [],
      }),
      "templates/empty/.gitkeep": "",
    },
    async (root) => {
      const templatesRoot = join(root, "templates");
      assert.deepEqual(await templateList(templatesRoot), [
        { name: "good", summary: "Good.", points: 1 },
      ]);
      await assert.rejects(readTemplate(templatesRoot, "broken"), {
        message: "invalid-template: broken",
      });
      await assert.rejects(readTemplate(templatesRoot, "empty"), {
        message: "unknown-template: empty",
      });
      assert.throws(() => templateRoot(root), {
        message: "templates-not-found",
      });
      assert.equal(templateRoot(), join(process.cwd(), "templates"));
    },
  ));

await test("CLV-301 template scripts name a template file and a setting", () => {
  const description = (scripts: unknown) =>
    JSON.stringify({ summary: "Scripts.", points: [{ id: "one" }], scripts });
  const script = { file: "one/next.ts", setting: "tickets.nextCommand" };
  const invalid = [
    "one/next.ts",
    [null],
    [{ ...script, file: "one/missing.ts" }],
    [{ ...script, setting: "tickets next" }],
    [{ setting: script.setting }],
  ];
  return withFiles(
    {
      "templates/one/template.json": description([script]),
      "templates/one/one/next.ts": "export {};\n",
      ...Object.fromEntries(
        invalid.flatMap((scripts, index) => [
          [`templates/bad${String(index)}/template.json`, description(scripts)],
          [`templates/bad${String(index)}/one/next.ts`, "export {};\n"],
        ]),
      ),
    },
    async (root) => {
      const templatesRoot = join(root, "templates");
      assert.deepEqual((await readTemplate(templatesRoot, "one")).scripts, [
        script,
      ]);
      for (const index of invalid.keys())
        await assert.rejects(
          readTemplate(templatesRoot, `bad${String(index)}`),
          { message: `invalid-template: bad${String(index)}` },
          String(index),
        );
    },
  );
});
