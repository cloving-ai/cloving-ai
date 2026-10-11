import { openAuthority } from "../src/broker/actor/authority.ts";

process.stdout.write("ready\n");
await new Promise((resolve) => process.stdin.once("data", resolve));
const opening = await openAuthority(process.argv[2] ?? "");
const outcome =
  opening.kind === "opened" ? "opened" : `refused ${opening.reason}`;
process.stdout.write(`${outcome}\n`);
setInterval(() => opening, 60000);
