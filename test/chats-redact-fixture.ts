import { darwinChatFileArguments } from "./chats-platform-fixture.ts";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

export const importId = "01234567-89ab-4cde-8fab-0123456789ab";
export const base = `runtime/chats/${importId}`;
export const text =
  "/synthetic/home/operator/secret person@example.test ghp_SyntheticSecret Private Phrase";
export const record = {
  schemaVersion: 1,
  sourceId: "sha256:synthetic:0",
  role: "user",
  timestamp: null,
  sessionId: "session",
  text,
  blocks: [
    { position: 0, type: "text", text },
    {
      position: 2,
      type: "tool_use",
      id: "call",
      name: "tool",
      input: { text },
    },
  ],
};
export const corpus =
  JSON.stringify(record) +
  "\n" +
  JSON.stringify({
    ...record,
    sourceId: "sha256:synthetic:100",
    text: "benign",
    blocks: [],
  }) +
  "\n";
export const coverage = JSON.stringify({
  schemaVersion: 1,
  importId,
  files: [
    {
      path: "/nonexistent/synthetic/transcript",
      status: "included",
      reason: "supported",
      digest: "sha256:synthetic",
      recordCount: 2,
      omissions: { metadataRecords: 0, thinkingBlocks: 0 },
    },
  ],
});
export const files = {
  [`${base}/corpus.jsonl`]: corpus,
  [`${base}/coverage.json`]: coverage,
};
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export function configuredCli(
  directory: string,
  request: {
    readonly argumentsList: readonly string[];
    readonly environment?: NodeJS.ProcessEnv;
  },
) {
  return spawnSync(
    process.execPath,
    [
      ...darwinChatFileArguments(),
      resolve("src/cli.ts"),
      ...request.argumentsList,
    ],
    {
      cwd: directory,
      encoding: "utf8",
      timeout: 15000,
      env: {
        CLOVING_RUNTIME_DIR: join(directory, "runtime"),
        HOME: "/synthetic/home/operator",
        CLOVING_PRIVATE_TEXTS: '["Private Phrase"]',
        ...request.environment,
      },
    },
  );
}

export function cli(directory: string, argumentsList: readonly string[]) {
  return configuredCli(directory, { argumentsList });
}

export const expectedRedacted = (() => {
  const text = "[HOME_PATH] [EMAIL] [TOKEN] [PRIVATE_TEXT]";
  const first = {
    ...record,
    text,
    blocks: [
      { position: 0, type: "text", text },
      {
        position: 2,
        type: "tool_use",
        id: "call",
        name: "tool",
        input: { text },
      },
    ],
  };
  const second = {
    ...record,
    sourceId: "sha256:synthetic:100",
    text: "benign",
    blocks: [],
  };
  return `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`;
})();
