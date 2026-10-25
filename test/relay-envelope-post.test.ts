import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { postEnvelopes } from "../src/relay/envelope-post.ts";
import { withFiles } from "./quality/files-fixture.ts";

const at = Date.parse("2026-10-26T12:00:00.000Z");

const request = {
  deviceId: "phone-1",
  envelopes: [
    {
      envelopeId: "env-1",
      kind: "full",
      ciphertext: "AAAA",
      expiresAt: "2026-11-01T11:00:00.000Z",
    },
  ],
};

await test("CLV-191 an unreachable server, a broken link file and a malformed request are failed posts", async () => {
  await withFiles({}, async (root) => {
    const reachable = join(root, "phone");
    await mkdir(reachable);
    await writeFile(
      join(reachable, "link.json"),
      JSON.stringify({
        daemonId: "dmn_1",
        origin: "http://127.0.0.1:9",
        token: "t",
        registeredAt: "2026-10-25T12:00:00Z",
      }),
    );
    const context = { phoneDirectory: reachable, now: () => at };
    assert.deepEqual(await postEnvelopes(context, request), {
      at,
      failure: "relay-unreachable",
    });
    assert.deepEqual(
      await postEnvelopes(context, { deviceId: "phone-1", envelopes: "x" }),
      { at, failure: "relay-request-invalid" },
    );
    assert.deepEqual(
      await postEnvelopes(context, { envelopes: request.envelopes }),
      { at, failure: "relay-request-invalid" },
    );
    const broken = join(root, "broken");
    await mkdir(join(broken, "link.json"), { recursive: true });
    assert.deepEqual(
      await postEnvelopes({ phoneDirectory: broken, now: () => at }, request),
      { at, failure: "relay-unregistered" },
    );
  });
});
