import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { check, githubReads, withDoctor } from "./doctor-fixture.ts";

await test("CLV-207 fake GitHub and harness probes make no other network call", () =>
  withDoctor(async (scene) => {
    const hook = join(scene.root, "network-guard.mjs");
    const marker = join(scene.root, "forbidden-network-attempts");
    await writeFile(
      hook,
      `
import { appendFileSync } from "node:fs";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
const forbidden = () => { appendFileSync(${JSON.stringify(marker)}, "attempt\\n"); throw new Error("doctor-network-call-forbidden"); };
net.Socket.prototype.connect = forbidden;
tls.connect = forbidden;
dgram.createSocket = forbidden;
dns.lookup = forbidden;
dns.resolve = forbidden;
globalThis.fetch = forbidden;
syncBuiltinESMExports();
`,
    );
    const output = await scene.report({
      NODE_OPTIONS: `--import=${pathToFileURL(hook).href}`,
    });
    assert.equal(check(output, "harnesses")["result"], "ok");
    assert.equal(check(output, "gh-login")["result"], "ok");
    assert.equal(check(output, "greptile-review")["result"], "ok");
    await assert.rejects(access(marker), { code: "ENOENT" });
    const calls = await githubReads(scene);
    assert.doesNotMatch(calls, /POST|PATCH|create|edit|merge/);
  }));

await test("CLV-207 bundled queue requires and fails an absent next command", () =>
  withDoctor(async (scene) => {
    const output = await scene.report({ CLOVING_NEXT_COMMAND: undefined });
    assert.equal(check(output, "next-command")["required"], true);
    assert.equal(check(output, "next-command")["result"], "fail");
    assert.equal(check(output, "queue-interval")["required"], true);
    assert.equal(output.status, 1);
  }));

await test("CLV-207 the effective harness command uses the service search path", () =>
  withDoctor(async (scene) => {
    const marker = join(scene.root, "service-node-probed");
    await scene.program("node", "process.exit(91)");
    await writeFile(
      join(scene.repository, "worker.mjs"),
      `import assert from "node:assert/strict"; import { writeFileSync } from "node:fs"; assert.deepEqual(process.argv.slice(2), ["--version"]); writeFileSync(${JSON.stringify(marker)}, "probed"); console.log("2.1.1 (Claude Code)");`,
    );
    const output = await scene.report({
      CLOVING_CLAUDE_COMMAND: '["node","worker.mjs"]',
    });
    assert.equal(check(output, "default-harness")["result"], "ok");
    await assert.doesNotReject(access(marker));
  }));
