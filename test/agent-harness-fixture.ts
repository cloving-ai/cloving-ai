import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessOptions } from "../src/agent-harnesses.ts";

export interface HarnessScene {
  readonly directory: string;
  readonly options: HarnessOptions;
  readonly file: (name: string, body: string) => Promise<string>;
  readonly startup: (body: string) => Promise<void>;
}

export async function withHarnesses(
  use: (scene: HarnessScene) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "cloving-harness-"));
  try {
    await use({
      directory,
      options: {
        env: {
          PATH: directory,
          HOME: directory,
          ZDOTDIR: directory,
          SHELL: "/bin/zsh",
        },
      },
      file: async (name, body) => {
        const path = join(directory, name);
        await writeFile(path, `#!/bin/sh\n${body}\n`);
        await chmod(path, 0o755);
        return path;
      },
      startup: async (body) => {
        await writeFile(join(directory, ".zshrc"), body);
        await writeFile(join(directory, ".bash_profile"), body);
      },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function harnessPid(text: string): number {
  const identifier = Number(text);
  assert.ok(/^[1-9]\d*\n$/.test(text));
  assert.ok(Number.isSafeInteger(identifier) && identifier > 0);
  return identifier;
}
