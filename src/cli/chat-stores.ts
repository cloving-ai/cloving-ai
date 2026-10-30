import { lstat, opendir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type { ChatStore } from "./init-prompt.ts";

const knownStores = [
  {
    name: "Claude Code",
    folder: ".claude/projects",
    format: "JSONL",
    documentation: "https://code.claude.com/docs/en/claude-directory",
  },
  {
    name: "Codex",
    folder: ".codex/sessions",
    format: "JSONL, including zstd-compressed .jsonl.zst (read with zstd -dc)",
    documentation: "https://learn.chatgpt.com/docs/security/sdk",
  },
  {
    name: "Gemini CLI",
    folder: ".gemini",
    format: "JSON conversation history and checkpoints under tmp/<project>/",
    documentation: "https://geminicli.com/docs/cli/checkpointing/",
  },
  {
    name: "opencode",
    folder: ".local/share/opencode",
    format:
      "SQLite (opencode.db); older versions use JSON files under storage/",
    documentation: "https://docs.opencode.ai/docs/troubleshooting/",
  },
  {
    name: "grok",
    folder: ".grok",
    format:
      "JSONL ACP events in sessions/<encoded-cwd>/<session-id>/updates.jsonl; raw messages in chat_history.jsonl; JSON metadata",
    documentation:
      "https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/17-sessions.md",
  },
  {
    name: "Cursor Agent",
    folder: ".cursor",
    format:
      "JSONL under projects/<project>/agent-transcripts/ (older transcripts may be text)",
    documentation:
      "https://forum.cursor.com/t/accessing-the-full-agent-transcript-in-cursor/157311/5",
  },
];

async function metadata(path: string) {
  return lstat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  });
}

async function* storeFiles(path: string) {
  const pending = [path];
  for (
    let folder = pending.pop();
    folder !== undefined;
    folder = pending.pop()
  ) {
    const directory = await opendir(folder);
    for await (const entry of directory) {
      const file = join(folder, entry.name);
      if (entry.isDirectory()) pending.push(file);
      if (!entry.isFile()) continue;
      const info = await metadata(file);
      if (info?.isFile()) yield info;
    }
  }
}

async function measure(path: string) {
  let fileCount = 0;
  let totalBytes = 0;
  let oldest: number | null = null;
  let newest: number | null = null;
  for await (const info of storeFiles(path)) {
    fileCount += 1;
    totalBytes += info.size;
    oldest = Math.min(oldest ?? info.mtimeMs, info.mtimeMs);
    newest = Math.max(newest ?? info.mtimeMs, info.mtimeMs);
  }
  return {
    fileCount,
    totalBytes,
    oldestFileDate: oldest === null ? null : new Date(oldest).toISOString(),
    newestFileDate: newest === null ? null : new Date(newest).toISOString(),
  };
}

async function inspectStore(path: string) {
  try {
    if (!(await metadata(path))?.isDirectory()) return null;
    return await measure(path);
  } catch (error) {
    return {
      unavailable:
        error instanceof Error &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : "scan-failed",
      fileCount: null,
      totalBytes: null,
      oldestFileDate: null,
      newestFileDate: null,
    };
  }
}

export async function chatStores(
  home: string | undefined,
): Promise<readonly ChatStore[]> {
  if (!home || !isAbsolute(home)) return [];
  const stores: ChatStore[] = [];
  for (const { folder, ...store } of knownStores) {
    const path = join(home, folder);
    const facts = await inspectStore(path);
    if (facts) stores.push({ ...store, path, ...facts });
  }
  return stores;
}
