import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { repositoryPath, text, type Operation } from "./github-operation.ts";
import { writeRecord } from "./operation-journal.ts";
import { issuePrivacy, operatorPrivateTexts } from "./github-issue-privacy.ts";
import { repositoryName } from "./github-issue-methods.ts";

interface PostedComment {
  readonly number: number;
  readonly url: string;
}

function issueNumber(operation: Operation): number {
  const value = operation.payload["number"];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("invalid-payload");
  return value;
}

function postedComment(url: string, number: number): PostedComment {
  const match =
    /^https?:\/\/[^/\s]+\/[\w.-]+\/[\w.-]+\/issues\/([1-9]\d*)#issuecomment-[1-9]\d*$/.exec(
      url,
    );
  if (match === null || Number(match[1]) !== number)
    throw new Error("github-call-failed");
  return { number, url };
}

function urlPage(line: string): readonly unknown[] {
  const page: unknown = JSON.parse(line);
  if (!Array.isArray(page)) throw new Error("github-call-failed");
  return page;
}

async function knownComment(
  operation: Operation,
  comment: { readonly number: number; readonly marker: string },
): Promise<PostedComment | undefined> {
  const output = await operation.calls.gh([
    "api",
    "--paginate",
    `${repositoryPath}/issues/${String(comment.number)}/comments?per_page=100`,
    "--jq",
    `[.[] | select((.body // "") | contains(${JSON.stringify(comment.marker)})) | .html_url] | @json`,
  ]);
  const url = output.trim().split("\n").flatMap(urlPage)[0];
  if (url === undefined) return undefined;
  if (typeof url !== "string") throw new Error("github-call-failed");
  return postedComment(url, comment.number);
}

export async function commentIssue(operation: Operation): Promise<unknown> {
  operatorPrivateTexts(operation.settings);
  const number = issueNumber(operation);
  const body = text(operation, "body");
  if (body.trim() === "") throw new Error("invalid-payload");
  issuePrivacy(body, {
    settings: operation.settings,
    repository: repositoryName(
      await operation.calls.gh(["repo", "view", "--json", "nameWithOwner"]),
    ),
  });
  const marker = `<!-- cloving-comment:${basename(operation.folder)} -->`;
  const known = await knownComment(operation, { number, marker });
  if (known !== undefined) return known;
  if (existsSync(join(operation.folder, "post.json")))
    throw new Error("post-uncertain");
  await writeRecord(operation.folder, { name: "post.json", value: { marker } });
  const printed = await operation.calls.gh([
    "issue",
    "comment",
    String(number),
    "--body",
    `${body}\n${marker}`,
  ]);
  return postedComment(printed.trim().split("\n").at(-1) ?? "", number);
}
