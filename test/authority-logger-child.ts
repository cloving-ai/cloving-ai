import { executePinned, openedAuthority } from "./authority-actor-fixture.ts";
import { storedGate } from "./authority-store-fixture.ts";

const authority = await openedAuthority(process.argv[2] ?? "", {
  instrumentation: () => {
    throw new Error("instrumentation failure");
  },
});
const receipt = await executePinned(authority, storedGate[0] ?? {});
process.stdout.write(`${JSON.stringify({ kind: receipt.kind })}\n`);
await authority.close();
