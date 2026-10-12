import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [directory, name, payload] = process.argv.slice(2);
if (directory === undefined || name === undefined || payload === undefined)
  throw new Error("missing-worker-arguments");

appendFileSync(
  join(directory, "launch.log"),
  `${JSON.stringify({ name, worker: `worker-${String(process.pid)}` })}\n`,
);
writeFileSync(join(directory, `${name}.input`), payload);
for (let waited = 0; waited < 30_000; waited += 20) {
  if (existsSync(join(directory, `${name}.finish`))) break;
  await delay(20);
}
writeFileSync(join(directory, `${name}.result`), `result of ${payload}`);
