import { send } from "./client.ts";

async function main(): Promise<void> {
  const runtime = process.argv[2];
  if (runtime === undefined) {
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    JSON.stringify(
      await send(runtime, { operation: "status", parameters: { limit: 1 } }),
    ) + "\n",
  );
}

if (process.argv[1] === import.meta.filename) await main();
