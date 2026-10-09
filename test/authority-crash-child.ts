import {
  executeStored,
  opened,
  storedGate,
} from "./authority-store-fixture.ts";

const { store } = opened(process.argv[2] ?? "");
for (const command of storedGate) {
  const receipt = executeStored(store, command);
  process.stdout.write(`receipt ${JSON.stringify(receipt)}\n`);
}
process.stdout.write("awaiting-dispatch\n");
setInterval(() => undefined, 60000);
