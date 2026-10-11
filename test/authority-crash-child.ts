import {
  executeStored,
  opened,
  storedGate,
} from "./authority-store-fixture.ts";

const { store } = await opened(process.argv[2] ?? "");
for (const command of storedGate) {
  const receipt = await executeStored(store, command);
  process.stdout.write(`receipt ${JSON.stringify(receipt)}\n`);
}
process.stdout.write("awaiting-dispatch\n");
setInterval(() => store, 60000);
