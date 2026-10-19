import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import filesystem from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { collectCoverage } from "../../quality/coverage-report.ts";
import { withFiles } from "./files-fixture.ts";

function collected(directory: string) {
  const result = spawnSync(
    process.execPath,
    [
      "--max-old-space-size=128",
      resolve("quality/coverage-command.ts"),
      join(directory, "coverage"),
      join(directory, "main.js"),
    ],
    { encoding: "utf8", timeout: 30000 },
  );
  assert.equal(result.error, undefined, result.stderr);
  return result;
}

async function requestedCoverage(directory: string): Promise<void> {
  const source = "export const value = 1;";
  await mkdir(join(directory, "coverage"));
  await writeFile(join(directory, "main.js"), source);
  await writeFile(
    join(directory, "coverage/requested.json"),
    JSON.stringify({
      result: [
        {
          scriptId: "1",
          url: pathToFileURL(join(directory, "main.js")).href,
          functions: [
            {
              functionName: "",
              isBlockCoverage: true,
              ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }],
            },
          ],
        },
      ],
    }),
  );
}

for (const unfinished of ["", '{"result":'])
  await test(`CLV-123 waits for an unfinished raw coverage recording: ${JSON.stringify(unfinished)}`, async () => {
    await withFiles({}, async (directory) => {
      await requestedCoverage(directory);
      const recording = join(directory, "coverage/requested.json");
      const read = filesystem.readFile;
      const complete = await read(recording, "utf8");
      await writeFile(recording, unfinished);
      Object.defineProperty(filesystem, "readFile", {
        configurable: true,
        value: async (file: string, encoding: "utf8") => {
          const content = await read(file, encoding);
          if (file === recording && content === unfinished)
            await writeFile(recording, complete);
          return content;
        },
      });
      syncBuiltinESMExports();
      try {
        assert.deepEqual(
          await collectCoverage(join(directory, "coverage"), [
            join(directory, "main.js"),
          ]),
          [
            {
              path: join(directory, "main.js"),
              lines: 100,
              statements: 100,
              functions: 100,
              branches: 100,
            },
          ],
        );
      } finally {
        filesystem.readFile = read;
        syncBuiltinESMExports();
      }
    });
  });

for (const content of ["", '{"result":'])
  await test(`CLV-123 rejects a permanently unfinished recording: ${JSON.stringify(content)}`, async () => {
    await withFiles({}, async (directory) => {
      await requestedCoverage(directory);
      await writeFile(join(directory, "coverage/unfinished.json"), content);
      const result = collected(directory);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Unexpected end of JSON input/);
    });
  });

await test("QG-18 collects requested coverage within a bounded heap despite large unrelated process recordings", async () => {
  await withFiles({}, async (directory) => {
    await requestedCoverage(directory);
    const expected = collected(directory);
    assert.equal(expected.status, 0, expected.stderr);
    const unrelated = JSON.stringify({
      result: Array.from({ length: 1024 }, (_, index) => ({
        scriptId: String(index),
        url: `file:///unrelated/${"x".repeat(4096)}/${String(index)}.js`,
        functions: [
          {
            functionName: "",
            isBlockCoverage: true,
            ranges: [{ startOffset: 0, endOffset: 1, count: 1 }],
          },
        ],
      })),
    });
    for (let index = 0; index < 48; index += 1)
      await writeFile(
        join(directory, "coverage", `unrelated-${String(index)}.json`),
        unrelated,
      );
    const result = collected(directory);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected.stdout);
    const report: unknown = JSON.parse(result.stdout);
    assert.deepEqual(report, [
      {
        path: join(directory, "main.js"),
        lines: 100,
        statements: 100,
        functions: 100,
        branches: 100,
      },
    ]);
  });
});

await test("QG-18 validates unrelated raw coverage before filtering it", async () => {
  await withFiles({}, async (directory) => {
    await requestedCoverage(directory);
    await writeFile(
      join(directory, "coverage/unrelated.json"),
      JSON.stringify({
        result: [{ scriptId: "2", url: "node:fs", functions: [] }],
      }),
    );
    const result = collected(directory);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid-raw-coverage/);
  });
});
