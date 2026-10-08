import { collectCoverage } from "./coverage-report.ts";

const [directory, ...files] = process.argv.slice(2);
if (!directory || files.length === 0)
  throw new Error("missing-coverage-inputs");
process.stdout.write(JSON.stringify(await collectCoverage(directory, files)));
