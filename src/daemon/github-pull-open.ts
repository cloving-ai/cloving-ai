import {
  changeChecked,
  defaultBranch,
  existingTree,
  field,
  text,
  type Operation,
  type Place,
  type Pull,
} from "./github-operation.ts";

interface TitledPull extends Pull {
  readonly title: string;
}

async function pullOf(
  operation: Operation,
  branch: string,
): Promise<TitledPull | undefined> {
  const listed: unknown = JSON.parse(
    await operation.calls.gh([
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "number,url,title",
    ]),
  );
  const first: unknown = Array.isArray(listed) ? listed[0] : undefined;
  if (first === undefined) return undefined;
  return {
    number: Number(field(first, "number")),
    url: String(field(first, "url")),
    title: String(field(first, "title")),
  };
}

async function created(
  operation: Operation,
  place: { readonly tree: Place; readonly base: string },
): Promise<TitledPull> {
  const printed = await operation.calls.gh([
    "pr",
    "create",
    "--head",
    place.tree.branch,
    "--base",
    place.base,
    "--title",
    text(operation, "title"),
    "--body",
    text(operation, "body"),
  ]);
  const url = printed.trim().split("\n").at(-1) ?? "";
  const number = Number(/\/pull\/(\d+)$/.exec(url)?.[1]);
  if (!Number.isInteger(number)) throw new Error("github-call-failed");
  return { number, url, title: text(operation, "title") };
}

function bodyReplaced(operation: Operation): boolean {
  if (!Object.hasOwn(operation.payload, "replaceBody")) return false;
  if (operation.payload["replaceBody"] === true) return true;
  throw new Error("invalid-payload");
}

export async function openPull(operation: Operation): Promise<unknown> {
  const replace = bodyReplaced(operation);
  const tree = existingTree(operation);
  const base = await defaultBranch(operation);
  await changeChecked(operation, { tree, base });
  await operation.calls.git(tree.path, [
    "push",
    "--quiet",
    "origin",
    `HEAD:refs/heads/${tree.branch}`,
  ]);
  const commit = (
    await operation.calls.git(tree.path, ["rev-parse", "HEAD"])
  ).trim();
  const existing = await pullOf(operation, tree.branch);
  if (existing === undefined) {
    const pull = await created(operation, { tree, base });
    return { number: pull.number, url: pull.url, commit, title: pull.title };
  }
  if (replace)
    await operation.calls.gh([
      "pr",
      "edit",
      String(existing.number),
      "--body",
      text(operation, "body"),
    ]);
  return {
    number: existing.number,
    url: existing.url,
    commit,
    title: existing.title,
  };
}
