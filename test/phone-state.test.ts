import assert from "node:assert/strict";
import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { mock, test } from "node:test";
import { pairingSessions } from "../src/relay/pairing-session.ts";
import { phoneState } from "../src/relay/relay-service.ts";
import { openRelayStore } from "../src/relay/relay-store.ts";
import {
  fakeRelayServer,
  registeredLink,
} from "./phone-relay-server-fixture.ts";
import { withFiles } from "./quality/files-fixture.ts";

await test("CLV-190 registration loss wins over a link read started before cleanup", async () => {
  await withFiles({}, async (phoneDirectory) => {
    const server = await fakeRelayServer();
    await registeredLink(server, phoneDirectory);
    const store = await openRelayStore(phoneDirectory);
    const registration = { lost: false };
    const original = filesystem.readFile;
    mock.method(
      filesystem,
      "readFile",
      async (...arguments_: Parameters<typeof original>) => {
        const value = await original(...arguments_);
        if (arguments_[0] === join(phoneDirectory, "link.json")) {
          await filesystem.rm(join(phoneDirectory, "link.json"));
          registration.lost = true;
        }
        return value;
      },
    );
    syncBuiltinESMExports();
    try {
      const reply = await phoneState({
        context: {
          phoneDirectory,
          origin: server.origin,
          computerName: "Studio",
        },
        store,
        registration,
        sessions: pairingSessions({
          secret: () => Buffer.alloc(16),
          follow: () => Promise.resolve(),
        }),
      });
      assert.equal(reply.kind, "result");
      assert.equal(reply.result["registered"], false);
      assert.equal(reply.result["daemonId"], null);
      assert.equal(reply.result["origin"], null);
      assert.equal(reply.result["reason"], "registration-lost");
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
      await store.close();
      await server.close();
    }
  });
});
