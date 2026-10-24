import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { runCommand } from "../quality/command.ts";
import { inspectGenerated } from "../quality/generated-output.ts";
import { sourceFiles } from "../quality/source-files.ts";
import {
  parseCheckTimeFactor,
  testCommand,
} from "../quality/test-execution.ts";

function durationRecord(
  directory: string,
  run: { readonly tests: readonly string[]; readonly report: unknown },
): Record<string, number> {
  const { tests, report } = run;
  if (!report || typeof report !== "object" || Array.isArray(report))
    throw new Error("invalid-test-duration-record");
  if (tests.length === 0 || Object.keys(report).length !== tests.length)
    throw new Error("incomplete-test-duration-record");
  const durations: Record<string, number> = {};
  for (const file of tests) {
    const path = relative(directory, file);
    const seconds: unknown = Reflect.get(report, path);
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0)
      throw new Error(`missing-test-duration: ${path}`);
    durations[path] = seconds;
  }
  return durations;
}

const directory = process.cwd();
const timeFactor = parseCheckTimeFactor(
  process.env["CLOVING_CHECK_TIME_FACTOR"],
);
const generated = await inspectGenerated(directory);
const files = await sourceFiles(directory, { generated: generated.outputs });
const tests = files.filter((file) =>
  /\.test\.(?:ts|mts|cts|js|mjs|cjs)$/.test(file),
);
const temporary = mkdtempSync(join(tmpdir(), "cloving-test-durations-"));
try {
  const output = runCommand(
    testCommand(directory, {
      tests,
      timeFactor,
      coverageDirectory: temporary,
      reporter: "durations",
    }),
  );
  const durations = durationRecord(directory, {
    tests,
    report: JSON.parse(output),
  });
  writeFileSync(
    join(directory, "quality/test-durations.json"),
    JSON.stringify(durations, null, 2) + "\n",
  );
} finally {
  rmSync(temporary, { recursive: true, maxRetries: 3, retryDelay: 100 });
}
