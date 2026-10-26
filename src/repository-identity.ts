export function repositoryFileName(identity: {
  readonly name: string;
  readonly sha256: string;
}): string {
  const name = identity.name.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24);
  return `${name}-${identity.sha256.slice(0, 8)}`;
}
