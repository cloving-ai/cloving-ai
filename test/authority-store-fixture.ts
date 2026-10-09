import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  openAuthorityStore,
  type AuthorityStore,
  type StoreReceipt,
} from "../src/broker/authority-store.ts";
import { pinnedIdentity } from "../src/execution-pin.ts";
import { answeredGate, recorded } from "./authority-fixture.ts";

export const manifest = {
  name: "develop",
  workflowId: "workflow//./workflows/develop//develop",
  steps: ["step//cloving/workflows/steps/load-cycle@0.4.0//loadCycle"],
  capabilities: ["fake-harness"],
  artifacts: { "flow.mjs": "a".repeat(64), "steps.mjs": "b".repeat(64) },
  resources: { "prompts/implement.md": "e".repeat(64) },
  toolchain: {
    sdk: "workflow@5.1.0",
    world: "@workflow/world-local@5.0.2",
    builder: "@workflow/builders@5.0.2",
    node: "v26.9.0",
    dependencies: "c".repeat(64),
  },
};

export const pin = `sha256:${createHash("sha256").update(pinnedIdentity(manifest)).digest("hex")}`;

export const storedGate: readonly Readonly<Record<string, unknown>>[] =
  answeredGate.map((command) =>
    command.kind === "admit-run" ? { ...command, workflow: pin } : command,
  );

export function executeStored(
  store: AuthorityStore,
  command: Readonly<Record<string, unknown>>,
): StoreReceipt {
  const pinned = ["admit-run", "decide-gate", "resume-run"].includes(
    String(command["kind"]),
  );
  return store.execute(command, pinned ? { ...recorded, manifest } : recorded);
}

const temporaryDirectories: string[] = [];

export async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "cloving-authority-"));
  temporaryDirectories.push(directory);
  return directory;
}

export async function removeTemporaryDirectories(): Promise<void> {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
}

export function alterDatabase(directory: string, sql: string): void {
  const database = new DatabaseSync(join(directory, "authority.sqlite"));
  database.exec(sql);
  database.close();
}

export function queryDatabase(
  directory: string,
  sql: string,
): readonly unknown[] {
  const database = new DatabaseSync(join(directory, "authority.sqlite"));
  const rows = database.prepare(sql).all();
  database.close();
  return rows.map((row) => ({ ...row }));
}

export function opened(
  directory: string,
): Extract<ReturnType<typeof openAuthorityStore>, { kind: "opened" }> {
  const opening = openAuthorityStore(directory);
  assert.equal(opening.kind, "opened", JSON.stringify(opening));
  return opening;
}

export interface ChildProcess {
  readonly lines: readonly string[];
  readonly waitFor: (line: string) => Promise<void>;
  readonly waitForLines: (count: number) => Promise<readonly string[]>;
  readonly send: (text: string) => void;
  readonly kill: () => Promise<{
    readonly code: number | null;
    readonly signal: string | null;
  }>;
}

export async function withChild(
  script: string,
  parameters: readonly string[],
  body: (child: ChildProcess) => Promise<void>,
): Promise<void> {
  await withChildren(script, parameters, 1, async ([child]) => {
    assert.ok(child);
    await body(child);
  });
}

export async function withChildren(
  script: string,
  parameters: readonly string[],
  count: number,
  body: (children: readonly ChildProcess[]) => Promise<void>,
): Promise<void> {
  const children = Array.from({ length: count }, () =>
    startChild(script, parameters),
  );
  try {
    await body(children);
  } finally {
    await Promise.all(children.map((child) => child.kill()));
  }
}

interface Output {
  readonly lines: string[];
  readonly waiters: Set<() => void>;
  readonly errors: () => string;
}

function collect(child: ReturnType<typeof spawn>): Output {
  const lines: string[] = [];
  const waiters = new Set<() => void>();
  let buffered = "";
  let errors = "";
  child.stderr?.on("data", (data: Buffer) => {
    errors += data.toString();
  });
  child.stdout?.on("data", (data: Buffer) => {
    buffered += data.toString();
    const parts = buffered.split("\n");
    buffered = parts.pop() ?? "";
    lines.push(...parts);
    for (const wake of waiters) wake();
  });
  return { lines, waiters, errors: () => errors };
}

function startChild(
  script: string,
  parameters: readonly string[],
): ChildProcess {
  const child = spawn(
    process.execPath,
    [join(import.meta.dirname, script), ...parameters],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const { lines, waiters, errors } = collect(child);
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolveExit) => {
      child.on("exit", (code, signal) => {
        for (const wake of waiters) wake();
        resolveExit({ code, signal });
      });
    },
  );
  function waitUntil(reached: () => boolean, label: string): Promise<void> {
    return new Promise((resolveLine, reject) => {
      function check(): void {
        if (reached()) {
          waiters.delete(check);
          resolveLine();
          return;
        }
        if (child.exitCode === null && child.signalCode === null) return;
        waiters.delete(check);
        reject(new Error(`child-exited-before: ${label}; stderr=${errors()}`));
      }
      waiters.add(check);
      check();
    });
  }
  return {
    lines,
    waitFor: (line) => waitUntil(() => lines.includes(line), line),
    waitForLines: async (count) => {
      await waitUntil(() => lines.length >= count, `${String(count)} lines`);
      return lines.slice(0, count);
    },
    send: (text) => {
      child.stdin.write(text);
    },
    kill: () => {
      child.kill("SIGKILL");
      return exited;
    },
  };
}
