import { openAuthorityStore } from "../src/broker/authority-store.ts";

process.stdout.write("ready\n");
process.stdin.once("data", () => {
  const opening = openAuthorityStore(process.argv[2] ?? "");
  const outcome =
    opening.kind === "opened" ? "opened" : `refused ${opening.reason}`;
  process.stdout.write(`${outcome}\n`);
  setInterval(() => undefined, 60000);
});
