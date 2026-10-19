import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { test } from "node:test";
import timers, { setTimeout } from "node:timers/promises";
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
  await test(`CLV-142 reads a raw coverage recording completed after 600 milliseconds: ${JSON.stringify(unfinished)}`, async () => {
    await withFiles({}, async (directory) => {
      await requestedCoverage(directory);
      const recording = join(directory, "coverage/requested.json");
      const complete = await readFile(recording, "utf8");
      await writeFile(recording, unfinished);
      const completed = setTimeout(600).then(() =>
        writeFile(recording, complete),
      );
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
        await completed;
      }
    });
  });

for (const factor of [undefined, "3"])
  await test(`CLV-142 bounds coverage retries by five seconds times ${factor ?? "the default factor"}`, async () => {
    await withFiles(
      { "coverage/unfinished.json": '{"result":' },
      async (directory) => {
        const previous = process.env["CLOVING_CHECK_TIME_FACTOR"];
        const wait = timers.setTimeout;
        const clock = Object.getOwnPropertyDescriptor(performance, "now");
        const delays: number[] = [];
        let elapsed = 0;
        Object.defineProperty(performance, "now", {
          configurable: true,
          value: () => elapsed,
        });
        if (factor === undefined)
          delete process.env["CLOVING_CHECK_TIME_FACTOR"];
        else process.env["CLOVING_CHECK_TIME_FACTOR"] = factor;
        Object.defineProperty(timers, "setTimeout", {
          configurable: true,
          value: (delay: number) => {
            delays.push(delay);
            elapsed += delay;
            return Promise.resolve();
          },
        });
        syncBuiltinESMExports();
        try {
          await assert.rejects(
            collectCoverage(join(directory, "coverage"), []),
            SyntaxError,
          );
          assert.equal(elapsed, 5000 * Number(factor ?? 1));
          assert.equal(delays[0], 25);
          assert.ok(delays.length > 2);
          for (let index = 1; index < delays.length - 1; index += 1)
            assert.ok((delays[index] ?? 0) > (delays[index - 1] ?? 0));
        } finally {
          if (clock) Object.defineProperty(performance, "now", clock);
          else Reflect.deleteProperty(performance, "now");
          timers.setTimeout = wait;
          syncBuiltinESMExports();
          if (previous === undefined)
            delete process.env["CLOVING_CHECK_TIME_FACTOR"];
          else process.env["CLOVING_CHECK_TIME_FACTOR"] = previous;
        }
      },
    );
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
