import { existsSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  existingTree,
  removeWorktree,
  field,
  repositoryPath,
  text,
  type Operation,
  type Pull,
} from "./github-operation.ts";

import { writeRecord } from "./operation-journal.ts";
import { treePlace } from "./work-tree.ts";
import { issuePrivacy, operatorPrivateTexts } from "./github-issue-privacy.ts";

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

async function knownIssue(
  operation: Operation,
  marker: string,
): Promise<Pull | undefined> {
  const pages: unknown = JSON.parse(
    await operation.calls.gh([
      "api",
      "--paginate",
      "--slurp",
      `${repositoryPath}/issues?state=all&per_page=100`,
    ]),
  );
  if (!Array.isArray(pages)) throw new Error("github-call-failed");
  const issue: unknown = pages
    .flat()
    .find((entry: unknown) => String(field(entry, "body")).includes(marker));
  if (issue === undefined) return undefined;
  return {
    number: Number(field(issue, "number")),
    url: String(field(issue, "html_url")),
  };
}

export async function createIssue(operation: Operation): Promise<unknown> {
  operatorPrivateTexts(operation.settings);
  const draft = await draftOf(operation);
  const [heading = "", ...lines] = draft.split("\n");
  if (!heading.startsWith("# ") || heading.slice(2).trim() === "")
    throw new Error("invalid-draft");
  const repository: unknown = JSON.parse(
    await operation.calls.gh(["repo", "view", "--json", "nameWithOwner"]),
  );
  issuePrivacy(draft, {
    settings: operation.settings,
    repository: String(field(repository, "nameWithOwner")),
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
  const number = Number(/\/issues\/(\d+)$/.exec(url)?.[1]);
  if (!Number.isInteger(number)) throw new Error("github-call-failed");
  return { number, url };
}

export async function discard(operation: Operation): Promise<unknown> {
  const place = treePlace({
    worktrees: operation.settings.worktrees,
    target: operation.target,
  });
  await removeWorktree(operation, place);
  return { discarded: place.branch };
}
