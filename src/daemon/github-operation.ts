import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CallSettings, Calls } from "./github-calls.ts";
import { treePlace } from "./work-tree.ts";

export interface GithubTiming {
  readonly pollMilliseconds: number;
  readonly triggerMilliseconds: number;
  readonly limitMilliseconds: number;
}

export const githubTiming: GithubTiming = {
  pollMilliseconds: 30_000,
  triggerMilliseconds: 300_000,
  limitMilliseconds: 3_600_000,
};

export interface MethodSettings extends CallSettings {
  readonly worktrees: string;
  readonly timing?: GithubTiming;
  readonly check?: readonly string[];
  readonly privateTexts?: readonly string[];
}

export interface Operation {
  readonly settings: MethodSettings;
  readonly calls: Calls;
  readonly target: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
  readonly folder: string;
}

export interface Place {
  readonly path: string;
  readonly branch: string;
}

export interface Pull {
  readonly number: number;
  readonly url: string;
}

export const repositoryPath = "repos/{owner}/{repo}";
export function text(operation: Operation, name: string): string {
  const value = operation.payload[name];
  if (typeof value !== "string" || value === "")
    throw new Error("invalid-payload");
  return value;
}

export function field(value: unknown, name: string): unknown {
  return Reflect.get(Object(value), name);
}

export function existingTree(operation: Operation): Place {
  const place = treePlace({
    worktrees: operation.settings.worktrees,
    target: operation.target,
  });
  if (!existsSync(join(place.path, ".git")))
    throw new Error("work-tree-not-available");
  return place;
}

export async function removeWorktree(
  operation: Operation,
  place: Place,
): Promise<void> {
  const repository = (parts: readonly string[]): Promise<string> =>
    operation.calls.git(operation.settings.repository, parts);
  if (existsSync(join(place.path, ".git")))
    await repository(["worktree", "remove", "--force", place.path]);
  if ((await repository(["branch", "--list", place.branch])).trim() !== "")
    await repository(["branch", "-D", place.branch]);
}

export async function defaultBranch(operation: Operation): Promise<string> {
  const reference = await operation.calls.git(operation.settings.repository, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  return reference.trim().replace(/^origin[/]/, "");
}

export async function changeChecked(
  operation: Operation,
  place: { readonly tree: Place; readonly base: string },
): Promise<void> {
  const call = (parts: readonly string[]): Promise<string> =>
    operation.calls.git(place.tree.path, parts);
  const range = `origin/${place.base}..HEAD`;
  if (Number((await call(["rev-list", "--count", range])).trim()) === 0)
    throw new Error("no-change");
  const change = [
    await call(["diff", `origin/${place.base}...HEAD`]),
    await call(["log", "--format=%B", range]),
  ].join("\n");
  const privateTexts = [homedir(), ...(operation.settings.privateTexts ?? [])];
  const lowered = change.toLowerCase();
  if (
    privateTexts.some(
      (item) => item !== "" && lowered.includes(item.toLowerCase()),
    )
  )
    throw new Error("private-path-in-change");
}
