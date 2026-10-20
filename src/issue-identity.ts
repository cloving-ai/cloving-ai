export interface IssueIdentity {
  readonly owner: string;
  readonly repository: string;
  readonly number: number;
}

export function issueIdentity(ticket: unknown): IssueIdentity | null {
  if (typeof ticket !== "string") return null;
  const markers = ticket
    .split(/\r?\n/)
    .filter((line) => line.startsWith("GitHub issue:"));
  if (markers.length !== 1) return null;
  const match =
    /^GitHub issue: ([a-zA-Z0-9][a-zA-Z0-9-]*)\/([a-zA-Z0-9_.-]+)#([1-9][0-9]*)(?: \((?:open|closed)\))?\s*$/.exec(
      markers[0] ?? "",
    );
  const [, owner, repository, digits] = match ?? [];
  const number = Number(digits);
  if (
    owner === undefined ||
    repository === undefined ||
    [".", ".."].includes(repository) ||
    !Number.isSafeInteger(number) ||
    number <= 0
  )
    return null;
  return {
    owner: owner.toLowerCase(),
    repository: repository.toLowerCase(),
    number,
  };
}
