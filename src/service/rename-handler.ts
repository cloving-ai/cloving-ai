import { isCommandId } from "../authority/commands.ts";
import type { Fields, Reply } from "../protocol.ts";
import { runLabel, runTitle } from "../run-name.ts";
import {
  committed,
  failed,
  invalidRequest,
  isIdentifier,
  publicReceipt,
  rejection,
  result,
  type ServiceContext,
} from "./replies.ts";
import { currentName } from "./run-metadata.ts";

interface Identity {
  readonly runId: string;
  readonly commandId: string;
}

type Name = Fields | Reply;

function givenName(parameters: Fields, identity: Identity): Name {
  const title = runTitle(parameters["title"]);
  if (title === undefined)
    return failed("invalid-title", {
      ...identity,
      detail:
        "A title has 1 to 200 characters after the spaces at its start and end are removed. It is on one line and has no control characters.",
    });
  if (parameters["label"] === undefined) return { title };
  const label = runLabel(parameters["label"]);
  if (label === undefined)
    return failed("invalid-label", {
      ...identity,
      detail:
        "A label has 1 to 32 characters. It has only letters, digits and the characters # ! . _ / -.",
    });
  return { title, label };
}

function nameOf(parameters: Fields, identity: Identity): Name {
  if (parameters["clear"] !== true) return givenName(parameters, identity);
  if (parameters["title"] !== undefined || parameters["label"] !== undefined)
    return invalidRequest(
      "A rename that clears the name has no title or label.",
    );
  return {};
}

function isReply(name: Name): name is Reply {
  return name["kind"] === "error";
}

export async function renameRun(
  context: ServiceContext,
  parameters: Fields,
): Promise<Reply> {
  const { runId, commandId } = parameters;
  const clear = parameters["clear"] ?? false;
  if (
    !isIdentifier(runId) ||
    !isCommandId(commandId) ||
    typeof clear !== "boolean"
  )
    return invalidRequest("The rename request is not valid.");
  const identity = { runId, commandId };
  const name = nameOf(parameters, identity);
  if (isReply(name)) return name;
  const receipt = await context.gateway.execute({
    principal: "operator",
    command: { kind: "rename-run", ...identity, ...name },
  });
  if (receipt.kind === "rejected" && receipt.reason === "unknown-run")
    return failed("unknown-run", {
      ...identity,
      detail: `No run has the ID ${runId}.`,
    });
  if (!committed(receipt)) return rejection(receipt, identity);
  const stored = await context.authority.queries.receipt(commandId);
  if (stored === undefined) return failed("authority-unavailable", identity);
  return result("run-renamed", {
    ...identity,
    ...(await currentName(context, runId)),
    replayed: receipt.kind === "duplicate",
    receipt: publicReceipt(stored),
  });
}
