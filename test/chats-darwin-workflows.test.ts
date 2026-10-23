import { test } from "node:test";
import { assertEmulatedChatTests } from "./chats-darwin-emulation.ts";

await test("CLV-136 compiled Darwin chat workflows use isolated filesystem substitutes on Linux", () => {
  assertEmulatedChatTests([
    "test/analyze-chats-follow-up.test.ts",
    "test/analyze-chats-batch-question.test.ts",
    "test/analyze-chats-batch-question-stops.test.ts",
    "test/analyze-chats-batch-question-restart.test.ts",
    "test/analyze-chats-batch-question-privacy.test.ts",
  ]);
});
