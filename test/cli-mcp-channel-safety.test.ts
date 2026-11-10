import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { privateSettingsPath } from "../src/cli/project-settings.ts";
import { request, startMcp } from "./mcp-fixture.ts";
import { channelServer, channelService } from "./mcp-channel-fixture.ts";
import { withHarness } from "./service-fixture.ts";

const token = "ghp_0123456789abcdefABCDEF0123456789abcd";

await test("CLV-338 the channel masks the private texts of the private settings of the repository", () =>
  withHarness(async (harness) => {
    execFileSync("git", ["init", "-q", harness.projectDirectory]);
    const configuration = join(harness.stateDirectory, "configuration");
    const environment = { XDG_CONFIG_HOME: configuration };
    const settings = privateSettingsPath(environment, harness.projectDirectory);
    await mkdir(dirname(settings), { recursive: true });
    await writeFile(
      settings,
      JSON.stringify({ version: 1, privateTexts: ["Acme Secret"] }),
    );
    const service = await channelService(harness.runtimeDirectory);
    harness.cleanup(() => service.close());
    const server = await channelServer({
      runtime: harness.runtimeDirectory,
      directory: harness.projectDirectory,
      environment,
    });
    harness.cleanup(() => {
      server.child.kill();
    });
    service.run(
      {
        runId: "run-secret0000",
        workflowId: "develop",
        state: "failed",
        title: `Acme Secret login with ${token}`,
        reason: { code: "turn-failed", detail: "The ACME SECRET push failed." },
      },
      "run.failed",
    );
    const [message] = await server.sent(1);
    assert.equal((await server.end()).status, 0);
    assert.equal(
      message?.["content"],
      "Run run-secr… ([hidden] login with [hidden]) failed: The [hidden] push failed. Continue it with cloving_continue, or dismiss it with cloving_dismiss.",
    );
  }));

await test("CLV-338 the channel refuses private texts that are not a list of texts", async () => {
  const server = startMcp({
    argumentsList: ["--channel"],
    environment: { CLOVING_PRIVATE_TEXTS: '{"text": 1}' },
  });
  server.send(request({ id: 1, method: "ping" }));
  const output = await server.end();
  assert.equal(output.status, 2);
  assert.match(output.stderr, /^invalid-private-texts: /);
  assert.deepEqual(server.messages, []);
});
