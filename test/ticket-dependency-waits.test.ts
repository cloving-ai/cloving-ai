import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ticketDependencyWaits } from "../src/daemon/ticket-dependency-waits.ts";
import { issueResolver } from "../src/daemon/ticket-registration.ts";
import { call, withHarness } from "./service-fixture.ts";

const ticket =
  "# Task\nGitHub issue: example/project#900\n## Dependencies\nNeeds #12 and #13.";
const signal = new AbortController().signal;

await test("CLV-184 a full service still identifies an alias of its active issue", () =>
  withHarness(async (harness) => {
    const resolver = issueResolver({
      repository: harness.projectDirectory,
      command: [
        process.execPath,
        "-e",
        'process.stdout.write("GitHub issue: example/project#900")',
      ],
    });
    const service = await harness.start({
      workflows: [
        {
          ...harness.registration,
          workflowId: "develop-issue",
          admission: 1,
          submission: { maximumBytes: 4096, fields: { ticket: "string" } },
          resolver,
        },
      ],
    });
    const submit = (ticket: string) =>
      call(harness, {
        operation: "run",
        parameters: {
          workflowId: "develop-issue",
          commandId: ticket,
          submission: { ticket },
        },
      });
    assert.equal((await submit("original"))["kind"], "run-admitted");
    assert.equal((await submit("alias"))["code"], "ticket-active");
    await service.close();
  }));

async function sourceAt(directory: string) {
  await writeFile(join(directory, "ticket"), ticket);
  await writeFile(
    join(directory, "states"),
    JSON.stringify({ "12": "open", "13": "closed" }),
  );
  await writeFile(
    join(directory, "ticket.mjs"),
    'import { readFileSync } from "node:fs"; process.stdout.write(readFileSync(process.argv[2], "utf8"));',
  );
  await writeFile(
    join(directory, "gh.mjs"),
    `import { appendFileSync, readFileSync } from "node:fs";
const endpoint = process.argv.at(-1);
appendFileSync(${JSON.stringify(join(directory, "calls"))}, endpoint + "\\n");
const states = JSON.parse(readFileSync(${JSON.stringify(join(directory, "states"))}, "utf8"));
process.stdout.write(JSON.stringify({ state: states[endpoint.split("/").at(-1)] }));`,
  );
  return {
    repository: directory,
    command: [
      process.execPath,
      join(directory, "ticket.mjs"),
      join(directory, "ticket"),
    ],
    githubCommand: [process.execPath, join(directory, "gh.mjs")],
  };
}

await test("CLV-184 dependency waits use the ticket repository and refresh edited prerequisites", () =>
  withHarness(async (harness) => {
    const directory = harness.projectDirectory;
    const source = await sourceAt(directory);
    const waits = ticketDependencyWaits(source);
    assert.deepEqual(await waits.check({ ticketId: "900", ticket, signal }), [
      "12",
    ]);
    assert.deepEqual(waits.skipped(), [
      {
        ticketId: "900",
        reason: "ticket-dependency-open",
        dependencies: ["12"],
      },
    ]);
    assert.deepEqual(await waits.refresh(signal), ["900"]);
    assert.match(
      await readFile(join(directory, "calls"), "utf8"),
      /repos\/example\/project\/issues\/12/,
    );
    await writeFile(
      join(directory, "ticket"),
      "# Edited task\n## Dependencies\nNone.",
    );
    assert.deepEqual(await waits.refresh(signal), []);
    assert.deepEqual(waits.skipped(), []);
  }));

await test("CLV-184 dependency checks refuse unknown state and unavailable ticket refresh", () =>
  withHarness(async (harness) => {
    const directory = harness.projectDirectory;
    const source = await sourceAt(directory);
    const plain = "## Dependencies\nNeeds #12.";
    const waits = ticketDependencyWaits({ ...source, command: ["false"] });
    assert.deepEqual(
      await waits.check({ ticketId: "900", ticket: plain, signal }),
      ["12"],
    );
    assert.match(
      await readFile(join(directory, "calls"), "utf8"),
      /repos\/\{owner\}\/\{repo\}\/issues\/12/,
    );
    await assert.rejects(waits.refresh(signal), /ticket-not-available/);
    const absent = ticketDependencyWaits({ ...source, command: undefined });
    assert.deepEqual(
      await absent.check({ ticketId: "900", ticket: plain, signal }),
      ["12"],
    );
    await assert.rejects(
      absent.refresh(signal),
      /ticket-source-not-configured/,
    );
    await writeFile(
      join(directory, "states"),
      JSON.stringify({ "12": "unknown" }),
    );
    await assert.rejects(
      waits.check({ ticketId: "900", ticket: plain, signal }),
      /invalid-dependency-state/,
    );
    await assert.rejects(
      ticketDependencyWaits({ ...source, githubCommand: ["false"] }).check({
        ticketId: "900",
        ticket,
        signal,
      }),
      /github-call-failed/,
    );
  }));

await test("CLV-184 an alias of an active GitHub issue is refused even when the next command ignores skips", () =>
  withHarness(async (harness) => {
    const source = await sourceAt(harness.projectDirectory);
    const resolver = issueResolver({
      ...source,
      nextCommand: [process.execPath, "-e", 'process.stdout.write("900")'],
    });
    const resolved = await resolver.resolve({
      workflowId: "develop-issue",
      commandId: "alias",
      signal,
      submission: { ticket: "next" },
      activeTickets: [
        { ticketId: "ALIAS", ticket: "GitHub issue: Example/Project#900" },
      ],
    });
    assert.deepEqual(resolved, {
      kind: "rejected",
      code: "ticket-active",
      detail: "An active run already works on this ticket.",
    });
  }));

await test("CLV-184 a failed dependency lookup refuses admission and the same command can retry", () =>
  withHarness(async (harness) => {
    const source = await sourceAt(harness.projectDirectory);
    const command = join(harness.projectDirectory, "lookup.mjs");
    await writeFile(command, "process.exit(1);");
    const resolver = issueResolver({
      ...source,
      githubCommand: [process.execPath, command],
    });
    const request = {
      workflowId: "develop-issue",
      commandId: "lookup-retry",
      signal,
      submission: { ticket: "900" },
    };
    const resolution = await resolver.resolve(request);
    assert.equal(resolution.kind, "rejected");
    assert.equal(resolution.code, "ticket-not-available");
    await writeFile(
      command,
      'process.stdout.write(JSON.stringify({ state: "closed" }));',
    );
    assert.equal((await resolver.resolve(request)).kind, "resolved");
  }));

await test("CLV-184 selection refreshes one waiting ticket and rotates past removed entries", () =>
  withHarness(async (harness) => {
    const directory = harness.projectDirectory;
    const source = await sourceAt(directory);
    await writeFile(
      join(directory, "ticket.mjs"),
      `import { appendFileSync, readFileSync } from "node:fs";
const id = process.argv.at(-1);
appendFileSync(${JSON.stringify(join(directory, "reads"))}, id + "\\n");
process.stdout.write(id === "999" ? "# Ready task" : readFileSync(process.argv[2], "utf8"));`,
    );
    const skips = join(directory, "skips");
    const resolver = issueResolver({
      ...source,
      nextCommand: [
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(skips)}, process.env.CLOVING_SKIP_TICKETS); process.stdout.write("999");`,
      ],
    });
    const resolve = (ticketId: string) =>
      resolver.resolve({
        workflowId: "develop-issue",
        commandId: ticketId,
        signal,
        submission: { ticket: ticketId },
      });
    for (const ticketId of ["900", "901", "902"])
      assert.equal((await resolve(ticketId)).kind, "rejected");
    await writeFile(join(directory, "reads"), "");
    assert.equal((await resolve("next")).kind, "resolved");
    assert.equal(
      await readFile(join(directory, "reads"), "utf8"),
      "900\n999\n",
    );
    assert.equal(await readFile(skips, "utf8"), "900 901 902");
    await writeFile(
      join(directory, "states"),
      JSON.stringify({ "12": "closed", "13": "closed" }),
    );
    for (const remaining of ["900 902", "900", ""]) {
      assert.equal((await resolve("next")).kind, "resolved");
      assert.equal(await readFile(skips, "utf8"), remaining);
    }
    assert.equal(
      await readFile(join(directory, "reads"), "utf8"),
      "900\n999\n901\n999\n902\n999\n900\n999\n",
    );
    assert.deepEqual(resolver.skippedTickets?.(), []);
  }));

await test("CLV-184 a failed refresh retains its skip and lets later tickets be refreshed", () =>
  withHarness(async (harness) => {
    const directory = harness.projectDirectory;
    const source = await sourceAt(directory);
    const waits = ticketDependencyWaits(source);
    for (const ticketId of ["900", "901", "902"])
      await waits.check({ ticketId, ticket, signal });
    await writeFile(
      join(directory, "ticket.mjs"),
      'if (process.argv.at(-1) === "900") process.exit(1); process.stdout.write("# Ready task");',
    );
    await assert.rejects(waits.refresh(signal), /ticket-not-available/);
    assert.deepEqual(await waits.refresh(signal), ["900", "902"]);
    assert.deepEqual(await waits.refresh(signal), ["900"]);
    assert.deepEqual(waits.skipped(), [
      {
        ticketId: "900",
        reason: "ticket-dependency-open",
        dependencies: ["12"],
      },
    ]);
    await writeFile(
      join(directory, "ticket.mjs"),
      'process.stdout.write("# Ready task");',
    );
    assert.deepEqual(await waits.refresh(signal), []);
  }));
