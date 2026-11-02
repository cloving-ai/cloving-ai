import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  adoptionRecordPath,
  runtimeDirectory,
} from "../src/cli/runtime-directory.ts";
import { parseInvocation } from "../src/cli/arguments.ts";
import { startMcp, request } from "./mcp-fixture.ts";
import {
  eventually,
  fields,
  parsed,
  runCli,
  withHarness,
  type Harness,
} from "./service-fixture.ts";

await test("CLV-250 mcp parses repository selection, rejects options and documents help", () =>
  withHarness(async (harness) => {
    assert.deepEqual(parseInvocation(["mcp", "--repository", "project"]), {
      kind: "mcp",
      repository: "project",
    });
    assert.deepEqual(parseInvocation(["mcp", "extra"]), {
      kind: "usage-error",
      code: "unexpected-argument",
      json: false,
    });
    assert.deepEqual(parseInvocation(["mcp", "--json"]), {
      kind: "usage-error",
      code: "unexpected-option",
      json: false,
    });
    const help = await harness.cli(["mcp", "--help"]);
    assert.equal(help.status, 0, help.stderr);
    assert.match(
      help.stdout,
      /Usage: cloving mcp \[--repository <directory>\]/,
    );
    assert.match(
      help.stdout,
      /cloving_status.*cloving_questions.*cloving_events/s,
    );
    const top = await harness.cli(["--help"]);
    assert.match(top.stdout, /mcp.*read.*stdio/);
  }));

await test("CLV-250 mcp exits with repository-unknown when no runtime resolves", () =>
  withHarness(async (harness) => {
    const server = startMcp({
      directory: harness.projectDirectory,
      environment: { CLOVING_RUNTIME_DIR: "" },
    });
    server.send(
      request({
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
    );
    const output = await server.end();
    assert.equal(output.status, 2);
    assert.equal(output.stdout, "");
    assert.match(output.stderr, /repository-unknown/);
  }));

async function repositoryService(harness: Harness, name: string) {
  execFileSync("git", ["init", "-q", harness.projectDirectory]);
  const environment = {
    CLOVING_RUNTIME_DIR: "",
    XDG_RUNTIME_DIR: "",
    XDG_STATE_HOME: harness.stateDirectory,
  };
  const runtime = runtimeDirectory(environment, harness.projectDirectory);
  assert.ok(runtime);
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await harness.start({
    runtimeDirectory: runtime,
    workflows: [{ ...harness.registration, workflowId: name }],
  });
  const server = startMcp({
    directory: harness.runtimeDirectory,
    argumentsList: ["--repository", harness.projectDirectory],
    environment,
  });
  harness.cleanup(() => {
    server.child.kill();
  });
  server.send(request({ id: 0, method: "ping" }));
  await eventually(() => (server.messages.length > 0 ? true : undefined));
  return { server, runtime, environment };
}

await test("CLV-250 two mcp servers stay bound to their startup repositories", () =>
  withHarness(async (firstHarness) =>
    withHarness(async (secondHarness) => {
      const first = await repositoryService(firstHarness, "first");
      const second = await repositoryService(secondHarness, "second");
      const adoption = adoptionRecordPath(
        first.environment,
        firstHarness.projectDirectory,
      );
      assert.ok(adoption);
      await mkdir(dirname(adoption), { recursive: true });
      await writeFile(
        adoption,
        JSON.stringify({
          schemaVersion: 1,
          repository: firstHarness.projectDirectory,
          runtimeDirectory: second.runtime,
        }),
      );
      for (const [bound, harness, name] of [
        [first, firstHarness, "first"],
        [second, secondHarness, "second"],
      ] as const) {
        bound.server.send(
          request({
            id: 1,
            method: "tools/call",
            params: { name: "cloving_status" },
          }),
        );
        const output = await bound.server.end();
        assert.equal(output.status, 0, output.stderr);
        const cli = await runCli(["status", "--json"], {
          directory: harness.projectDirectory,
          runtime: bound.runtime,
        });
        const content = fields(bound.server.messages[1]?.["result"])[
          "structuredContent"
        ];
        assert.deepEqual(content, parsed(cli));
        assert.ok(JSON.stringify(content).includes(name));
        assert.ok(
          !JSON.stringify(content).includes(
            name === "first" ? "second" : "first",
          ),
        );
      }
    }),
  ));
