import { rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { copiedAttachment, openedAttachment } from "./attachment-file.ts";
import { attachmentFolder } from "./attachments.ts";
import { repositoryName } from "./github-issue-methods.ts";
import { issuePrivacy, operatorPrivateTexts } from "./github-issue-privacy.ts";
import {
  field,
  repositoryPath,
  text,
  type Operation,
} from "./github-operation.ts";
import { githubRead } from "./github-retry.ts";

interface Attachment {
  readonly number: number;
  readonly name: string;
  readonly release: string;
  readonly comment: string;
}

function isList(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function validName(name: string): boolean {
  return /^[\w-][\w.-]*\.(?:mp4|webm|png)$/.test(name) && !name.includes("..");
}

function validRelease(release: string): boolean {
  return /^[a-z][a-z0-9-]{0,63}$/.test(release) && !/^v\d/.test(release);
}

function attachmentOf(operation: Operation): Attachment {
  const number = operation.payload["number"];
  const name = text(operation, "name");
  const release = text(operation, "release");
  const comment = text(operation, "comment");
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1)
    throw new Error("invalid-payload");
  if (!validName(name) || !validRelease(release) || comment.length > 4000)
    throw new Error("invalid-payload");
  return { number, name, release, comment };
}

function attachedFile(operation: Operation, name: string): Promise<FileHandle> {
  return openedAttachment({
    folder: attachmentFolder({
      worktrees: operation.settings.worktrees,
      target: operation.target,
    }),
    name,
  });
}

async function pages(
  operation: Operation,
  path: string,
): Promise<readonly unknown[]> {
  const reply: unknown = JSON.parse(
    await githubRead(operation, ["api", "--paginate", "--slurp", path]),
  );
  if (!isList(reply)) throw new Error("github-call-failed");
  return reply.flatMap((page) => {
    if (!isList(page)) throw new Error("github-call-failed");
    return page;
  });
}

async function releaseOf(operation: Operation, tag: string): Promise<unknown> {
  const releases = await pages(
    operation,
    `${repositoryPath}/releases?per_page=100`,
  );
  return releases.find((item) => field(item, "tag_name") === tag);
}

async function ensuredRelease(
  operation: Operation,
  release: string,
): Promise<void> {
  if ((await releaseOf(operation, release)) !== undefined) return;
  try {
    await operation.calls.gh([
      "release",
      "create",
      release,
      "--prerelease",
      "--latest=false",
      "--title",
      "Pull request demos",
      "--notes",
      "Demo videos of pull requests. Cloving uploads them.",
    ]);
  } catch (error) {
    if ((await releaseOf(operation, release)) === undefined) throw error;
  }
}

async function uploaded(
  operation: Operation,
  attachment: Attachment & { readonly file: FileHandle },
): Promise<string> {
  const { release } = attachment;
  await ensuredRelease(operation, release);
  const asset = `pr-${String(attachment.number)}-${attachment.name}`;
  const copy = join(operation.folder, asset);
  try {
    await copiedAttachment(attachment.file, copy);
    await operation.calls.gh(["release", "upload", release, copy, "--clobber"]);
  } finally {
    await rm(copy, { force: true });
  }
  const assets = field(await releaseOf(operation, release), "assets");
  const found = isList(assets)
    ? assets.find((item) => field(item, "name") === asset)
    : undefined;
  const url = field(found, "browser_download_url");
  if (typeof url !== "string" || !url.startsWith("https://"))
    throw new Error("github-call-failed");
  return url;
}

async function ownLogin(operation: Operation): Promise<string> {
  const user: unknown = JSON.parse(
    await githubRead(operation, ["api", "user"]),
  );
  const login = field(user, "login");
  if (typeof login !== "string" || login === "")
    throw new Error("github-call-failed");
  return login;
}

async function commented(
  operation: Operation,
  attachment: Attachment & { readonly url: string },
): Promise<void> {
  const { number, name, url } = attachment;
  const marker = `<!-- cloving-attachment:${String(number)}:${name} -->`;
  const body = `${attachment.comment}\n\n[${name}](${url})\n\n${marker}`;
  const comments = await pages(
    operation,
    `${repositoryPath}/issues/${String(number)}/comments?per_page=100`,
  );
  const login = await ownLogin(operation);
  const known = comments.find((item) => {
    const existing = field(item, "body");
    return (
      typeof existing === "string" &&
      existing.includes(marker) &&
      field(field(item, "user"), "login") === login
    );
  });
  const id = field(known, "id");
  if (typeof id === "number") {
    await operation.calls.gh([
      "api",
      "-X",
      "PATCH",
      `${repositoryPath}/issues/comments/${String(id)}`,
      "-f",
      `body=${body}`,
    ]);
    return;
  }
  await operation.calls.gh([
    "api",
    `${repositoryPath}/issues/${String(number)}/comments`,
    "-f",
    `body=${body}`,
  ]);
}

export async function attachAsset(operation: Operation): Promise<unknown> {
  const attachment = attachmentOf(operation);
  operatorPrivateTexts(operation.settings);
  const repository = repositoryName(
    await operation.calls.gh(["repo", "view", "--json", "nameWithOwner"]),
  );
  issuePrivacy(attachment.comment, {
    settings: operation.settings,
    repository,
  });
  const file = await attachedFile(operation, attachment.name);
  try {
    const url = await uploaded(operation, { ...attachment, file });
    await commented(operation, { ...attachment, url });
    return { number: attachment.number, url };
  } finally {
    await file.close();
  }
}
