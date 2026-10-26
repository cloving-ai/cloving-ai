import { send } from "./client.ts";

if (process.argv[1] === import.meta.filename) {
  const runtime = process.argv[2];
  if (runtime === undefined) process.exitCode = 1;
  else
    process.stdout.write(
      JSON.stringify(
        await send(runtime, { operation: "status", parameters: { limit: 1 } }),
      ) + "\n",
    );
}
