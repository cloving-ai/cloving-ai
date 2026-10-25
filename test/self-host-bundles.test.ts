import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  candidatePackageRoot,
  preparedProject,
} from "./candidate-package-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";
import { operatorFiles } from "./workflow-folder-fixture.ts";
import { testMilliseconds } from "./test-timing.ts";

async function bundleIds(store: string): Promise<string[]> {
  return (await readdir(store)).filter((name) => !name.startsWith("."));
}

async function retainedSnapshot(input: {
  readonly project: string;
  readonly retained: string;
  readonly declarations: unknown;
}) {
  assert.equal(
    await readFile(join(input.retained, "workflows/develop-prd.ts"), "utf8"),
    await readFile(
      join(candidatePackageRoot, "workflows/develop-prd.ts"),
      "utf8",
    ),
  );
  const dependencies = await readFile(
    join(input.retained, "dependencies.json"),
    "utf8",
  );
  assert.match(dependencies, /workflow/);
  assert.match(dependencies, /@workflow\/world-local/);
  assert.match(
    dependencies,
    new RegExp(process.version.replaceAll(".", "\\.")),
  );
  const artifacts = await readdir(join(input.project, "artifacts"));
  const originalBytes = await Promise.all(
    artifacts.map((file) => readFile(join(input.retained, "artifacts", file))),
  );
  for (const [index, file] of artifacts.entries())
    assert.deepEqual(
      originalBytes[index],
      await readFile(join(input.project, "artifacts", file)),
    );
  assert.deepEqual(
    JSON.parse(
      await readFile(join(input.retained, "declarations.json"), "utf8"),
    ),
    input.declarations,
  );
  return { artifacts, originalBytes };
}

await test("CLV-153 startup retains complete compiled generations after operator source edits and removal", () =>
  withFiles(operatorFiles("project", "candidate"), async (root) => {
    const settings = {
      project: join(root, "project"),
      repository: join(root, "repo"),
      home: root,
      xdgConfigHome: join(root, "config"),
    };
    const first = preparedProject(settings);
    assert.deepEqual(first["workflowRefusals"], []);
    assert.ok(
      JSON.stringify(first["declarations"]).includes(
        '"workflowId":"candidate"',
      ),
    );
    const store = join(root, "workflow-bundles");
    const [original] = await bundleIds(store);
    assert.ok(original);
    assert.equal(first["bundleDigest"], original);
    const retained = join(store, original);
    const { artifacts, originalBytes } = await retainedSnapshot({
      project: settings.project,
      retained,
      declarations: first["declarations"],
    });
    const file = join(root, "repo/.cloving/workflows/candidate.ts");
    const source = await readFile(file, "utf8");
    const operator = join(retained, "workflows/operators");
    const [name] = (await readdir(operator)).filter((name) =>
      name.endsWith(".ts"),
    );
    assert.ok(name);
    const retainedSource = join(operator, name);
    assert.equal(await readFile(retainedSource, "utf8"), source);
    await writeFile(
      file,
      source.replace('payload: "synthetic"', 'payload: "edited"'),
    );
    const edited = preparedProject(settings);
    assert.deepEqual(edited["declarations"], first["declarations"]);
    assert.equal((await bundleIds(store)).length, 2);
    await rm(file);
    const removed = preparedProject(settings);
    assert.equal(
      JSON.stringify(removed["declarations"]).includes(
        '"workflowId":"candidate"',
      ),
      false,
    );
    assert.equal((await bundleIds(store)).length, 3);
    assert.equal(await readFile(retainedSource, "utf8"), source);
    for (const [index, file] of artifacts.entries())
      assert.deepEqual(
        await readFile(join(retained, "artifacts", file)),
        originalBytes[index],
      );
  }));

await test("CLV-153 startup cannot reconstruct a missing generation but can retain an edited workflow", () =>
  withFiles(operatorFiles("project", "candidate"), async (root) => {
    const settings = {
      project: join(root, "project"),
      repository: join(root, "repo"),
      home: root,
      xdgConfigHome: join(root, "config"),
    };
    preparedProject(settings);
    const store = join(root, "workflow-bundles");
    const [original] = await bundleIds(store);
    assert.ok(original);
    const retained = join(store, original);
    await rm(retained, { recursive: true });
    assert.throws(
      () => preparedProject(settings),
      /pinned-workflow-unavailable/,
    );
    await assert.rejects(lstat(retained), { code: "ENOENT" });
    const file = join(root, "repo/.cloving/workflows/candidate.ts");
    const source = await readFile(file, "utf8");
    await writeFile(
      file,
      source.replace('payload: "synthetic"', 'payload: "edited"'),
    );
    const edited = preparedProject(settings);
    assert.deepEqual(edited["workflowRefusals"], []);
    const [current] = await bundleIds(store);
    assert.ok(current);
    assert.notEqual(current, original);
    await assert.rejects(lstat(retained), { code: "ENOENT" });
    assert.deepEqual(
      (await readdir(join(store, ".history"))).sort(),
      [original, current].sort(),
    );
  }));

await test("candidate package builds exclude the external compiler from runtime coverage", () =>
  withFiles({}, async (directory) => {
    const fixture = new URL("./candidate-package-fixture.ts", import.meta.url);
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(fixture.href)});`,
      ],
      {
        env: { ...process.env, NODE_V8_COVERAGE: directory },
        timeout: testMilliseconds(30_000),
        stdio: "pipe",
      },
    );
    const reports = await readdir(directory);
    assert.ok(reports.length > 0);
    const contents = await Promise.all(
      reports.map((name) => readFile(join(directory, name), "utf8")),
    );
    assert.ok(contents.some((report) => report.includes(fixture.href)));
    assert.ok(
      contents.every((report) => !report.includes("typescript/lib/_tsc.js")),
      "the TypeScript compiler must not generate runtime coverage",
    );
  }));

await test("CLV-202 bundled chats declarations abort startup before retaining a bundle", () =>
  withFiles({ "repo/marker": "" }, async (root) => {
    const declaration = join(
      candidatePackageRoot,
      "workflows/develop-prd.declaration.json",
    );
    await writeFile(
      declaration,
      JSON.stringify({
        workflowId: "retired-corpus",
        effectLimit: 1,
        capabilities: ["chats"],
        input: { maximumBytes: 1024, fields: {} },
      }),
    );
    try {
      assert.throws(
        () =>
          preparedProject({
            project: join(root, "project"),
            repository: join(root, "repo"),
            home: root,
            xdgConfigHome: join(root, "config"),
          }),
        /invalid-workflow-declaration: develop-prd\.declaration\.json/,
      );
      assert.deepEqual(await bundleIds(root), ["project", "repo"]);
    } finally {
      await rm(declaration);
    }
  }));
