import { availableParallelism } from "node:os";
import { run } from "node:test";
import { parseTestConcurrency } from "./test-execution.ts";
import reportDurations from "./test-duration-reporter.ts";
import reportTests from "./test-reporter.ts";

const [reporterArgument, concurrencyArgument, ...files] = process.argv.slice(2);
if (
  files.length === 0 ||
  !concurrencyArgument?.startsWith("--test-concurrency=") ||
  !["--test-reporter=gate", "--test-reporter=durations"].includes(
    reporterArgument ?? "",
  )
)
  throw new Error("invalid-test-runner-arguments");
const concurrency = parseTestConcurrency(
  concurrencyArgument.slice("--test-concurrency=".length),
  availableParallelism(),
);
const reporter =
  reporterArgument === "--test-reporter=durations"
    ? reportDurations
    : reportTests;
try {
  for await (const chunk of reporter(
    run({ files, concurrency, isolation: "process" }).on(
      "test:summary",
      (summary) => {
        if (!summary.success) process.exitCode = 1;
      },
    ),
  ))
    process.stdout.write(chunk);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
