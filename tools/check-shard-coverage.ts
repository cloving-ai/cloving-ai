import { checkCoverage } from "../quality/coverage.ts";
import { proposedModulePolicy } from "../quality/module-policy.ts";
import { productionFiles } from "../quality/production-inventory.ts";
import { joinShardCoverage } from "../quality/shard-coverage.ts";
import { sourceFiles } from "../quality/source-files.ts";

const directory = process.cwd();
const files = productionFiles({
  files: await sourceFiles(directory),
  roles: proposedModulePolicy(directory).roles,
});
const report = await joinShardCoverage(directory, {
  directories: process.argv.slice(2),
  files,
});
checkCoverage(report, files);
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
