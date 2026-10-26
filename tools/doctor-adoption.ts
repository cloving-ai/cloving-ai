import { selectRuntimeDirectory } from "./self-host-runtime.ts";

const [runtime, repository, legacyRuntime, adoptionRecord] =
  process.argv.slice(2);
if (runtime === undefined || repository === undefined) process.exitCode = 1;
else
  process.stdout.write(
    JSON.stringify(
      await selectRuntimeDirectory({
        runtime,
        repository,
        legacyRuntime,
        adoptionRecord,
      }),
    ) + "\n",
  );
