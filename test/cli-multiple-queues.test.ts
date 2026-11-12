import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { SubmissionContract } from "../src/submission.ts";
import { record } from "../src/protocol.ts";
import { scene } from "./self-host-fixture.ts";
import {
  cli,
  privateSettings,
  startOutput,
  statusOf,
  workflowFile,
} from "./cli-start-declared-queue-fixture.ts";

await test("CLV-360 start uses each declared queue configuration", async () => {
  const fixture = await scene();
  const fields: SubmissionContract["fields"] = { ticket: { type: "ticket" } };
  await workflowFile(join(fixture.repository, ".cloving/workflows"), {
    name: "projectqueue",
    fields,
    queue: { lanes: 2 },
  });
  await workflowFile(join(fixture.root, "config/cloving/workflows"), {
    name: "userqueue",
    fields,
    queue: {},
  });
  await privateSettings(fixture, {
    queues: { userqueue: { lanes: 3, everySeconds: 20 } },
  });
  const output = await startOutput(fixture, {
    environment: {
      CLOVING_NEXT_COMMAND: JSON.stringify(["true"]),
      CLOVING_TICKET_COMMAND: JSON.stringify(["true"]),
    },
    inspect: () => {
      const complete = statusOf(fixture);
      const queues = complete["queues"];
      assert.ok(Array.isArray(queues));
      assert.deepEqual(
        queues.map((value: unknown) => {
          const queue = record(value);
          return [
            queue?.["workflowId"],
            queue?.["lanes"],
            record(record(queue?.["settings"])?.["everySeconds"])?.["value"],
          ];
        }),
        [
          ["projectqueue", 2, 120],
          ["userqueue", 3, 20],
        ],
        JSON.stringify(complete),
      );
      const updated = cli(fixture, [
        "config",
        "set",
        "queues",
        '{"userqueue":{"lanes":4,"everySeconds":20}}',
        "--private",
      ]);
      assert.equal(updated.status, 0, updated.stdout + updated.stderr);
      const reloaded = cli(fixture, ["reload", "--json"]);
      assert.equal(reloaded.status, 0, reloaded.stdout + reloaded.stderr);
      const after = statusOf(fixture)["queues"];
      assert.ok(Array.isArray(after));
      assert.deepEqual(
        after.map((value: unknown) => record(value)?.["lanes"]),
        [2, 4],
      );
    },
  });
  assert.match(output, /Cloving runs/);
});
