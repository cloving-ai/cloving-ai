import { parse } from "yaml";
import { field, type Operation } from "./github-operation.ts";

function pullRequestTrigger(source: string): boolean {
  try {
    const document: unknown = parse(source, { merge: true });
    const events = field(document, "on");
    if (typeof events === "string") return events === "pull_request";
    if (Array.isArray(events)) return events.includes("pull_request");
    if (typeof events === "object" && events !== null)
      return Object.hasOwn(events, "pull_request");
    return true;
  } catch {
    return true;
  }
}

export async function hasPullRequestWorkflow(
  operation: Operation,
  commit: string,
): Promise<boolean> {
  const read = (parts: readonly string[]): Promise<string> =>
    operation.calls.git(operation.settings.repository, parts);
  const paths = await read([
    "ls-tree",
    "-r",
    "--name-only",
    "-z",
    commit,
    "--",
    ".github/workflows",
  ]);
  for (const path of paths.split("\0")) {
    if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) continue;
    const source = await read(["show", `${commit}:${path}`]);
    if (pullRequestTrigger(source)) return true;
  }
  return false;
}
