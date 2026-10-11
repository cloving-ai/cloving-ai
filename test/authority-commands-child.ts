import { openedAuthority } from "./authority-actor-fixture.ts";
import {
  answeredQuestion,
  executeTyped,
} from "./authority-decision-fixture.ts";

const authority = await openedAuthority(process.argv[2] ?? "");
for (const step of answeredQuestion)
  process.stdout.write(
    `receipt ${JSON.stringify(await executeTyped(authority, step))}\n`,
  );
process.stdout.write("committed\n");
setInterval(() => authority, 60000);
