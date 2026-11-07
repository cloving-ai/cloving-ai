import { issueIdentity } from "../issue-identity.ts";
import { record, type Fields, type Reply } from "../protocol.ts";
import { reportFields } from "../worker-usage.ts";
import { failed, type GithubReader, type ServiceContext } from "./replies.ts";

function ticketText(input: Fields): unknown {
  const declared = record(record(input["input"])?.["ticket"]);
  return declared === undefined ? input["ticket"] : declared["text"];
}

async function issuePath(
  context: ServiceContext,
  runId: string,
): Promise<string | null> {
  const digest = (await context.authority.state()).details[runId]?.input;
  const input = reportFields(
    await context.authority.queries.document(String(digest)),
  );
  const issue = issueIdentity(ticketText(input));
  return issue === null
    ? null
    : `repos/${issue.owner}/${issue.repository}/issues/${String(issue.number)}`;
}

async function pullPath(
  context: ServiceContext,
  runId: string,
): Promise<string | null> {
  const opened = (await context.authority.effects.operations(runId)).findLast(
    (operation) => operation.method === "open-pr" && operation.result !== null,
  );
  const url = reportFields(
    await context.authority.queries.document(String(opened?.result)),
  )["url"];
  const [, owner, repository, number] =
    /^https:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/([1-9][0-9]*)$/.exec(
      typeof url === "string" ? url : "",
    ) ?? [];
  if (owner === undefined || repository === undefined || number === undefined)
    return null;
  return `repos/${owner}/${repository}/pulls/${number}`;
}

async function readField(
  github: GithubReader,
  request: { readonly path: string | null; readonly name: string },
): Promise<unknown> {
  if (request.path === null) return undefined;
  const value = await github.read(request.path).catch(() => undefined);
  return record(value)?.[request.name];
}

export async function finishedRefusal(
  context: ServiceContext,
  request: { readonly runId: string; readonly identity: Fields },
): Promise<Reply | undefined> {
  const github = context.githubRead;
  if (github === undefined) return undefined;
  const issue = await issuePath(context, request.runId);
  if ((await readField(github, { path: issue, name: "state" })) === "closed")
    return failed("continuation-ticket-closed", {
      ...request.identity,
      detail: "The ticket of the run is closed. Its work is finished.",
    });
  const pull = await pullPath(context, request.runId);
  if ((await readField(github, { path: pull, name: "merged" })) !== true)
    return undefined;
  return failed("continuation-pull-request-merged", {
    ...request.identity,
    detail: "The pull request of the run is merged. Its work is finished.",
  });
}
