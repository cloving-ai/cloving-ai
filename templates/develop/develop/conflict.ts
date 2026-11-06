import type { PullRequest } from "cloving/workflows";

export function conflictText(request: {
  readonly output: string;
  readonly pull: PullRequest;
}): string {
  const { output, pull } = request;
  const lines = output.split("\n").map((line) => line.trim());
  const reported = lines
    .filter((line) => line.startsWith("CONFLICT ("))
    .map((line) => {
      const close = line.indexOf("): ");
      return { kind: line.slice(10, close), text: line.slice(close + 3) };
    });
  const listed = reported
    .map((entry) =>
      entry.text
        .replace(/^Merge conflict in /, "")
        .split(" ", 1)
        .join(""),
    )
    .concat(lines.filter((line) => /^[^\s:]+$/.test(line)))
    .filter((file) => file !== "");
  const files = Array.from(new Set(listed));
  const number = String(pull.number);
  return [
    `The merge of the base branch into pull request #${number} conflicts again.`,
    "Conflicting files:",
  ]
    .concat(
      files.map((file) => `- ${file}`),
      [
        "",
        "Both sides:",
        `- This branch: the commits of pull request #${number} up to ${pull.commit}.`,
        "- The base branch: the commits that reached it after this branch last merged it.",
      ],
      reported.map((entry) => `- Git: ${entry.kind}: ${entry.text}`),
      [
        "",
        "Merge the base branch into this branch. Keep the intent of both sides in each file, then commit the merge.",
        "",
        "Merge output:",
        output,
      ],
    )
    .join("\n");
}
