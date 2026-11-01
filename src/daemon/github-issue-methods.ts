import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  existingTree,
  removeWorktree,
  repositoryPath,
  text,
  type Operation,
  type Pull,
} from "./github-operation.ts";

import { writeRecord } from "./operation-journal.ts";
import { treePlace } from "./work-tree.ts";
import { issuePrivacy, operatorPrivateTexts } from "./github-issue-privacy.ts";

function issueFromUrl(url: string): Pull {
  const number = Number(
    /^https?:\/\/[^/\s]+\/[\w.-]+\/[\w.-]+\/issues\/([1-9]\d*)$/.exec(url)?.[1],
  );
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error("github-call-failed");
  return { number, url };
}

function issueOf(issue: unknown): Pull {
  if (
    typeof issue !== "object" ||
    issue === null ||
    !("number" in issue) ||
    typeof issue.number !== "number" ||
    !("html_url" in issue) ||
    typeof issue.html_url !== "string"
  )
    throw new Error("github-call-failed");
  const parsed = issueFromUrl(issue.html_url);
  if (issue.number !== parsed.number) throw new Error("github-call-failed");
  return parsed;
}

function issuePage(line: string): readonly Pull[] {
  const page: unknown = JSON.parse(line);
  if (!Array.isArray(page)) throw new Error("github-call-failed");
  return page.map((issue: unknown) => issueOf(issue));
}

export function repositoryName(reply: string): string {
  const repository: unknown = JSON.parse(reply);
  if (
    typeof repository !== "object" ||
    repository === null ||
    !("nameWithOwner" in repository) ||
    typeof repository.nameWithOwner !== "string" ||
    !/^[\w.-]+\/[\w.-]+$/.test(repository.nameWithOwner)
  )
    throw new Error("github-call-failed");
  return repository.nameWithOwner;
}

async function draftOf(operation: Operation): Promise<string> {
  const name = text(operation, "draft");
  if (basename(name) !== name || name.includes("\\"))
    throw new Error("invalid-draft");
  const path = join(existingTree(operation).path, name);
  const stat = await lstat(path).catch(() => undefined);
  if (stat === undefined || !stat.isFile())
    throw new Error("draft-not-available");
  return readFile(path, "utf8");
}

function draftDigest(text: string): string {
  return "sha256:" + createHash("sha256").update(text).digest("hex");
}

export async function captureDraft(operation: Operation): Promise<unknown> {
  const text = await draftOf(operation);
  const capture = { text, digest: draftDigest(text) };
  if (Buffer.byteLength(JSON.stringify(capture)) > 65_536)
    throw new Error("draft-too-large");
  return capture;
}

function checkDraftDigest(operation: Operation, draft: string): void {
  if (!Object.hasOwn(operation.payload, "expectedDigests")) return;
  const digests = operation.payload["expectedDigests"];
  if (
    !Array.isArray(digests) ||
    digests.length === 0 ||
    !digests.every(
      (digest: unknown) =>
        typeof digest === "string" && /^sha256:[0-9a-f]{64}$/.test(digest),
    )
  )
    throw new Error("invalid-payload");
  const current = draftDigest(draft);
  if (!digests.every((digest: unknown) => digest === current))
    throw new Error("draft-changed");
}

async function knownIssue(
  operation: Operation,
  marker: string,
): Promise<Pull | undefined> {
  const output = await operation.calls.gh([
    "api",
    "--paginate",
    `${repositoryPath}/issues?state=all&per_page=100`,
    "--jq",
    `[.[] | select((.body // "") | contains(${JSON.stringify(marker)})) | {number, html_url}] | @json`,
  ]);
  return output.trim().split("\n").flatMap(issuePage)[0];
}

export async function createIssue(operation: Operation): Promise<unknown> {
  operatorPrivateTexts(operation.settings);
  const draft = await draftOf(operation);
  checkDraftDigest(operation, draft);
  const [heading = "", ...lines] = draft.split("\n");
  if (!heading.startsWith("# ") || heading.slice(2).trim() === "")
    throw new Error("invalid-draft");
  const repository = repositoryName(
    await operation.calls.gh(["repo", "view", "--json", "nameWithOwner"]),
  );
  issuePrivacy(draft, {
    settings: operation.settings,
    repository,
  });
  const marker = `<!-- cloving-prd:${operation.target} -->`;
  const known = await knownIssue(operation, marker);
  if (known !== undefined) return known;
  if (existsSync(join(operation.folder, "post.json")))
    throw new Error("post-uncertain");
  await writeRecord(operation.folder, { name: "post.json", value: { marker } });
  const printed = await operation.calls.gh([
    "issue",
    "create",
    "--title",
    heading.slice(2).trim(),
    "--body",
    `${lines.join("\n")}\n${marker}`,
  ]);
  const url = printed.trim().split("\n").at(-1) ?? "";
  return issueFromUrl(url);
}

export async function discard(operation: Operation): Promise<unknown> {
  const place = treePlace({
    worktrees: operation.settings.worktrees,
    target: operation.target,
  });
  await removeWorktree(operation, place);
  return { discarded: place.branch };
}
