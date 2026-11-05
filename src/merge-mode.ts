export const mergeModes = ["direct", "queue"] as const;

export type MergeMode = (typeof mergeModes)[number];

export const mergeModeRefusal =
  "invalid-setting: CLOVING_MERGE_MODE must be direct or queue";

export function mergeMode(value: string | undefined): MergeMode {
  const mode = mergeModes.find((name) => name === (value ?? "direct"));
  if (mode === undefined) throw new Error(mergeModeRefusal);
  return mode;
}
