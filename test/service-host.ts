import { appendFile, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { record } from "../src/protocol.ts";
import { startService } from "../src/service/service.ts";
import { fakeRegistration, items, testTiming } from "./service-fixture.ts";

const [stateDirectory, runtimeDirectory, deliveries, mode] =
  process.argv.slice(2);
if (
  stateDirectory === undefined ||
  runtimeDirectory === undefined ||
  deliveries === undefined
)
  throw new Error("usage: service-host <state> <runtime> <deliveries> <mode>");
const recordFile = deliveries;

async function recorded(): Promise<readonly string[]> {
  const lines = await readFile(recordFile, "utf8").catch(() => "");
  return lines
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => String(record(JSON.parse(line))?.["operationId"]));
}

function held(): Promise<never> {
  process.stdout.write("holding\n");
  return new Promise(() => undefined);
}

const opening = await startService({
  stateDirectory,
  runtimeDirectory,
  workflows: [fakeRegistration([])],
  timing: testTiming,
  delivery: {
    reconcile: async (intent) => {
      const index = (await recorded()).indexOf(intent.operationId);
      return index < 0
        ? { kind: "absent" }
        : { kind: "accepted", receipt: `wrun-${String(index + 1)}` };
    },
    deliver: async (intent) => {
      if (mode === "hold-continuation" && intent.kind === "continue-run")
        return held();
      if (mode === "accept-start-without-reply") {
        await appendFile(recordFile, `${JSON.stringify(intent)}\n`);
        return held();
      }
      await appendFile(recordFile, `${JSON.stringify(intent)}\n`);
      return { receipt: `wrun-${String((await recorded()).length)}` };
    },
  },
});
if (opening.kind !== "started")
  throw new Error(`${opening.reason}: ${opening.detail}`);
const { service } = opening;

process.on("SIGTERM", () => {
  service
    .close()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
});
process.stdout.write("ready\n");
for await (const line of createInterface({ input: process.stdin })) {
  const request = record(JSON.parse(line));
  const result = await service.worker.submit(
    record(request?.["command"]) ?? {},
    items(request?.["documents"]).map(String),
  );
  process.stdout.write(`result ${JSON.stringify(result)}\n`);
}
