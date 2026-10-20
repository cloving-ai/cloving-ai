import { record, type Fields } from "../protocol.ts";

export interface PrIdentity {
  readonly host: string;
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
}

export type PrFailure =
  | "configuration"
  | "identity"
  | "command"
  | "access"
  | "rate-limit"
  | "response"
  | "timeout";
export type PrReadResult =
  | { readonly status: "merged" | "unmerged" }
  | {
      readonly status: "unavailable";
      readonly failure: PrFailure;
      readonly retryAt?: number;
    };

export type PrObservation = (PrReadResult | { readonly status: "pending" }) & {
  readonly retryAt?: number;
  readonly lastSuccess?: {
    readonly status: "merged" | "unmerged";
    readonly readAt: number;
  };
};

function responseNames(fields: Fields): readonly unknown[] {
  const repository = record(record(fields["base"])?.["repo"]) ?? {};
  return [
    fields["html_url"],
    repository["html_url"],
    repository["full_name"],
    repository["name"],
    record(repository["owner"])?.["login"],
  ];
}

export function prResponse(identity: PrIdentity, value: unknown): PrReadResult {
  const fields = record(value) ?? {};
  const expected = `https://${identity.host}/${identity.owner}/${identity.repository}`;
  const strings = responseNames(fields);
  if (
    typeof fields["number"] !== "number" ||
    strings.some((part) => typeof part !== "string")
  )
    return { status: "unavailable", failure: "response" };
  const wanted = [
    `${expected}/pull/${String(identity.number)}`,
    expected,
    `${identity.owner}/${identity.repository}`,
    identity.repository,
    identity.owner,
  ];
  if (
    fields["number"] !== identity.number ||
    strings.some(
      (part, index) =>
        String(part).toLowerCase() !== String(wanted[index]).toLowerCase(),
    )
  )
    return { status: "unavailable", failure: "identity" };
  const merged = fields["merged"];
  if (typeof merged !== "boolean")
    return { status: "unavailable", failure: "response" };
  return { status: merged ? "merged" : "unmerged" };
}

export type PrRepository = Omit<PrIdentity, "number">;

export function establishedIssue(
  repository: PrRepository | null,
  value: unknown,
): PrIdentity | null {
  const fields = record(value) ?? {};
  const number = fields["number"];
  if (
    repository === null ||
    typeof number !== "number" ||
    !Number.isSafeInteger(number) ||
    number <= 0
  )
    return null;
  const owner = fields["owner"];
  const name = fields["repository"];
  if (
    typeof owner !== "string" ||
    typeof name !== "string" ||
    owner.toLowerCase() !== repository.owner ||
    name.toLowerCase() !== repository.repository
  )
    return null;
  return { ...repository, number };
}

export function sameIssue(
  first: PrIdentity | null | undefined,
  second: PrIdentity | null | undefined,
): boolean {
  return (
    first != null &&
    second != null &&
    first.host === second.host &&
    first.owner === second.owner &&
    first.repository === second.repository &&
    first.number === second.number
  );
}

export function prRepository(origin: string): PrRepository | null {
  const address = origin
    .replace(/^git@([^:/]+):/, "ssh://git@$1/")
    .replace(/\r?\n$/, "");
  const matched =
    /^(?:https:\/\/|ssh:\/\/git@)([a-zA-Z0-9.-]+)\/([a-zA-Z0-9-]+)\/([a-zA-Z0-9_.-]+)$/.exec(
      address,
    );
  const [, host, owner, name] = matched ?? [];
  if (host === undefined || owner === undefined || name === undefined)
    return null;
  if (
    host
      .split(".")
      .some(
        (label) => !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label),
      )
  )
    return null;
  const repository = name.replace(/\.git$/, "");
  if (
    ![host, owner].every((part) => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(part)) ||
    ["", ".", ".."].includes(repository)
  )
    return null;
  return {
    host: host.toLowerCase(),
    owner: owner.toLowerCase(),
    repository: repository.toLowerCase(),
  };
}

export function prIdentity(
  repository: PrRepository,
  pullRequest: { readonly number: number; readonly url: string },
): PrIdentity | null {
  const { number, url } = pullRequest;
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  const expected = `https://${repository.host}/${repository.owner}/${repository.repository}/pull/${String(number)}`;
  return url.toLowerCase() === expected ? { ...repository, number } : null;
}
