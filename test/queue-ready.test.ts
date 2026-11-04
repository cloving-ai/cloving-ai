import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { test } from "node:test";
import type { Reply } from "../src/protocol.ts";
import type { Handle } from "../src/service/transport.ts";
import { withQueue } from "./issue-queue-fixture.ts";
import { queuePrelude, queueWorkflow } from "./daemon-queue-fixture.ts";
import { withConsumer } from "./world-host-fixture.ts";
import { call, eventually, field, withHarness } from "./service-fixture.ts";
import { readyTickets } from "../src/daemon/ticket-source.ts";
import { readyFields, readyList } from "../src/queue-state.ts";

const printed = JSON.stringify([
  { id: "590", readyAt: "2026-11-03T09:00:00Z" },
  { id: "586", readyAt: "2026-11-03T07:30:00Z" },
  { id: "DEMO-4", readyAt: "2026-11-03T08:15:00Z" },
]);

await test("CLV-286 the ready-ticket list reads a JSON list of ticket IDs and ready times", () => {
  assert.deepEqual(readyList(`${printed}\n`), {
    kind: "read",
    tickets: [
      { id: "590", readyAt: "2026-11-03T09:00:00Z" },
      { id: "586", readyAt: "2026-11-03T07:30:00Z" },
      { id: "DEMO-4", readyAt: "2026-11-03T08:15:00Z" },
    ],
  });
  assert.deepEqual(readyList("[]"), { kind: "read", tickets: [] });
});

await test("CLV-286 the ready-ticket list refuses output that is not a list of valid tickets", () => {
  const refused = {
    kind: "failed",
    detail:
      "The ready-ticket command must print a JSON list of objects with an id and a readyAt UTC time.",
  };
  for (const output of [
    "",
    "586",
    "{}",
    "not json",
    JSON.stringify([{ id: "586" }]),
    JSON.stringify([{ id: 586, readyAt: "2026-11-03T07:30:00Z" }]),
    JSON.stringify([{ id: "a b", readyAt: "2026-11-03T07:30:00Z" }]),
    JSON.stringify([{ id: "586", readyAt: "yesterday" }]),
    JSON.stringify([{ id: "586", readyAt: "2026-11-03T08:30:00+01:00" }]),
    JSON.stringify(["586"]),
  ])
    assert.deepEqual(readyList(output), refused, output);
});

await test("CLV-286 the queue status counts each ready ticket once without the skipped tickets and names the oldest ready time", () => {
  const list = readyList(printed);
  assert.deepEqual(readyFields(list, ["590"]), {
    ready: { count: 2, oldestAt: "2026-11-03T07:30:00Z" },
  });
  assert.deepEqual(readyFields(list, ["586", "590", "DEMO-4"]), {
    ready: { count: 0, oldestAt: null },
  });
  assert.deepEqual(
    readyFields({ kind: "failed", detail: "The command failed." }, []),
    { ready: { failure: "The command failed." } },
  );
  assert.deepEqual(readyFields(undefined, []), {});
  const repeated = readyList(
    JSON.stringify([
      { id: "586", readyAt: "2026-11-03T09:00:00Z" },
      { id: "586", readyAt: "2026-11-03T07:30:00Z" },
    ]),
  );
  assert.deepEqual(readyFields(repeated, []), {
    ready: { count: 1, oldestAt: "2026-11-03T07:30:00Z" },
  });
});

await test("CLV-286 the daemon runs the ready-ticket command with no added argument and reads its list", async () => {
  const open = new AbortController().signal;
  const script = (body: string) => [process.execPath, "-e", body, "--"];
  assert.deepEqual(
    await readyTickets(
      script(
        `if (process.argv.length > 1) process.exit(9); process.stdout.write(${JSON.stringify(printed)});`,
      ),
      open,
    ),
    readyList(printed),
  );
  assert.deepEqual(await readyTickets(script("process.exit(4)"), open), {
    kind: "failed",
    detail: "The ready-ticket command ended with the code 4: ",
  });
  assert.deepEqual(await readyTickets(script('console.log("586")'), open), {
    kind: "failed",
    detail:
      "The ready-ticket command must print a JSON list of objects with an id and a readyAt UTC time.",
  });
  const stopped = new AbortController();
  stopped.abort();
  assert.equal(
    (await readyTickets(script("setTimeout(() => {}, 5000)"), stopped.signal))
      .kind,
    "failed",
  );
});

function idle(state: { admissions: number }): Handle {
  return (request) => {
    if (request.operation === "run") state.admissions += 1;
    return Promise.resolve<Reply>(
      request.operation === "run"
        ? {
            kind: "error",
            error: { code: "no-ready-ticket", detail: "No ticket is ready." },
          }
        : { kind: "result", result: { runs: [], next: null } },
    );
  };
}

await test("CLV-286 the queue runs the ready-ticket command again after each queue interval and its control reports the latest list", async () => {
  const plain = { admissions: 0 };
  await withQueue({ handle: idle(plain) }, async (scene) => {
    await eventually(() => (plain.admissions > 1 ? true : undefined));
    assert.equal(scene.control()?.ready, undefined);
  });
  const listed = { admissions: 0 };
  await withQueue(
    {
      handle: idle(listed),
      readyCommand: [
        process.execPath,
        "-e",
        `process.stdout.write(${JSON.stringify(printed)})`,
      ],
    },
    async (scene) => {
      assert.deepEqual(
        await eventually(() => scene.control()?.ready),
        readyList(printed),
      );
    },
  );
});

await test("CLV-286 the queue lists the ready tickets at its start, before the first queue interval ends", async () => {
  await withQueue(
    {
      handle: idle({ admissions: 0 }),
      intervalMilliseconds: 60_000,
      readyCommand: [
        process.execPath,
        "-e",
        `process.stdout.write(${JSON.stringify(printed)})`,
      ],
    },
    async (scene) => {
      assert.deepEqual(
        await eventually(() => scene.control()?.ready),
        readyList(printed),
      );
    },
  );
});

await test("CLV-286 the queue checks for admission at each interval while one slow ready-ticket command runs, and a later run of the command replaces the list", async () => {
  const folder = await mkdtemp(join(tmpdir(), "cloving-ready-"));
  const hold = join(folder, "hold");
  const listFile = join(folder, "list.json");
  const starts = join(folder, "starts");
  await writeFile(hold, "");
  await writeFile(listFile, printed);
  const body = `import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
appendFileSync(${JSON.stringify(starts)}, "start\\n");
while (existsSync(${JSON.stringify(hold)})) await setTimeout(10);
process.stdout.write(readFileSync(${JSON.stringify(listFile)}, "utf8"));`;
  const state = { admissions: 0 };
  const later = JSON.stringify([
    { id: "591", readyAt: "2026-11-03T10:00:00Z" },
  ]);
  try {
    await withQueue(
      {
        handle: idle(state),
        readyCommand: [process.execPath, "--input-type=module", "-e", body],
      },
      async (scene) => {
        await eventually(() => readFile(starts, "utf8").catch(() => undefined));
        const seen = state.admissions;
        await eventually(() =>
          state.admissions > seen + 1 ? true : undefined,
        );
        assert.equal(scene.control()?.ready, undefined);
        assert.equal(await readFile(starts, "utf8"), "start\n");
        await rm(hold);
        assert.deepEqual(
          await eventually(() => scene.control()?.ready),
          readyList(printed),
        );
        await writeFile(listFile, later);
        await eventually(() =>
          isDeepStrictEqual(scene.control()?.ready, readyList(later))
            ? true
            : undefined,
        );
      },
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

await test("CLV-286 the service status of the queue counts the ready tickets that have no active run and wait for no dependency", () =>
  withHarness(async (harness) => {
    const service = await harness.start({
      workflows: [
        {
          ...harness.registration,
          manifest: { ...harness.registration.manifest, queue: true },
          admission: 2,
          resolver: {
            ...harness.registration.resolver,
            skippedTickets: () => [
              {
                ticketId: "590",
                reason: "ticket-dependency-open",
                dependencies: ["12"],
              },
            ],
            resolve: (request) =>
              Promise.resolve({
                kind: "resolved",
                input: { ticketId: request.submission["prompt"] },
              }),
          },
        },
      ],
      queue: {
        control: () => ({
          failedRunIds: [],
          drain: undefined,
          error: undefined,
          ready: readyList(printed),
        }),
        change: () => Promise.resolve({ kind: "changed" }),
      },
    });
    const admitted = await call(harness, {
      operation: "run",
      parameters: {
        workflowId: "develop",
        source: "prompt",
        submission: { prompt: "586" },
        commandId: "ticket-586",
      },
    });
    assert.equal(admitted["kind"], "run-admitted");
    const status = await call(harness, { operation: "status", parameters: {} });
    assert.deepEqual(field(field(status, "queue"), "ready"), {
      count: 1,
      oldestAt: "2026-11-03T08:15:00Z",
    });
    const read = await call(harness, { operation: "queue", parameters: {} });
    assert.deepEqual(field(read, "queue"), field(status, "queue"));
    await service.close();
  }));

await test("CLV-286 a daemon with a ready-ticket command shows the ready count and the oldest ready time in the queue status", () =>
  withConsumer(queueWorkflow, async (consumer) => {
    const result = await consumer.run(`${queuePrelude}
const printed = ${JSON.stringify(printed)};
const daemon = await launched({
  readyCommand: [process.execPath, "-e", "process.stdout.write(" + JSON.stringify(printed) + ")"],
});
try {
  const ready = await until(async () => (await asked("status")).queue?.ready);
  assert.deepEqual(ready, { count: 3, oldestAt: "2026-11-03T07:30:00Z" });
} finally { await daemon.close(); }
process.exit(0);
`);
    assert.equal(result.status, 0, result.stderr);
  }));
