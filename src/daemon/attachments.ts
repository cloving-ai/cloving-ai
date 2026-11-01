import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { treeName } from "./work-tree.ts";

export function attachmentFolder(place: {
  readonly worktrees: string;
  readonly target: string;
}): string {
  return join(dirname(place.worktrees), "attachments", treeName(place.target));
}

export async function attachmentEnvironment(
  settings: { readonly worktrees: string },
  start: {
    readonly intent: { readonly target: string };
    readonly profile: { readonly env?: Readonly<Record<string, string>> };
  },
): Promise<Readonly<Record<string, string>>> {
  const attachments = attachmentFolder({
    worktrees: settings.worktrees,
    target: start.intent.target,
  });
  await mkdir(attachments, { recursive: true });
  return {
    ...(start.profile.env ?? {}),
    CLOVING_ATTACHMENTS_DIRECTORY: attachments,
  };
}
