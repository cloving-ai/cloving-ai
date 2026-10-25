import { runRelay } from "./relay/relay-service.ts";

process.exitCode = await runRelay(process.env, {
  stopped: new Promise((settle) => {
    process.once("SIGTERM", settle);
    process.once("SIGINT", settle);
  }),
  error: (line) => process.stderr.write(line),
});
