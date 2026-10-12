import { workflowRegistry } from "../src/service/registry.ts";
import { submissionHandler } from "../src/service/submission-handler.ts";
import { openedAuthority } from "./authority-actor-fixture.ts";
import { fakeRegistration, field } from "./service-fixture.ts";

const [directory = ""] = process.argv.slice(2);
const authority = await openedAuthority(directory);
const reply = await submissionHandler({
  authority,
  registry: workflowRegistry([fakeRegistration([])]),
  gateway: {
    execute: () =>
      Promise.resolve({ kind: "rejected", reason: "terminal-run" }),
  },
  clock: () => "2026-10-10T12:00:00.000Z",
  livenessMilliseconds: 1,
  followMilliseconds: 1,
  resolverMilliseconds: 3_600_000,
  textBytes: 1000,
  documentBytes: 1000,
})({
  workflowId: "develop",
  source: "prompt",
  submission: { prompt: "task" },
  commandId: "c-1",
});
await authority.close();
process.stdout.write(
  `replied ${String(field(field(reply, "error"), "code"))}\n`,
);
