import { test } from "node:test";
import { assertEmulatedChatTests } from "./chats-darwin-emulation.ts";

await test("CLV-136 Darwin chat adapter control flow uses isolated filesystem substitutes on Linux", () => {
  assertEmulatedChatTests([
    "test/chats-cli-flow.test.ts",
    "test/chats-destination.test.ts",
    "test/chats-destination-race.test.ts",
    "test/chats-isolation.test.ts",
    "test/chats-output-failures.test.ts",
    "test/chats-storage.test.ts",
    "test/chats-corpus-limit.test.ts",
    "test/chats-source.test.ts",
    "test/chats-selection.test.ts",
    "test/chats-selection-races.test.ts",
    "test/chats-reader-failures.test.ts",
    "test/chats-revision-import.test.ts",
    "test/chats-revision-storage.test.ts",
    "test/chats-redact-failures.test.ts",
    "test/chats-redact-isolation.test.ts",
    "test/chats-redact-storage.test.ts",
    "test/chats-redact-coverage.test.ts",
    "test/chats-redact-streaming.test.ts",
    "test/chats-reader.test.ts",
  ]);
});
