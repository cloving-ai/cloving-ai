import { test } from "node:test";
import { cancelledGit, deadlineGit } from "./self-host-processes-fixture.ts";

const command = "fetch";

for (const signal of ["SIGINT", "SIGTERM", "daemon"])
  await test(`CLV-085 ${signal} cancels stalled git ${command} and waits for children`, () =>
    cancelledGit({ command, signal }));

await test(`CLV-085 stalled git ${command} reaches its deadline and polling recovers`, () =>
  deadlineGit(command));
