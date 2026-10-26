export const defaultCommand = [
  "claude",
  "-p",
  "--output-format",
  "stream-json",
  "--verbose",
  "--permission-mode",
  "acceptEdits",
  "--allowedTools",
  "Bash,Read,Edit,Write,Glob,Grep,WebSearch,WebFetch",
  "--max-budget-usd",
  "5",
];
export const defaultCodexCommand = [
  "codex",
  "exec",
  "--json",
  "--dangerously-bypass-approvals-and-sandbox",
  "--skip-git-repo-check",
  "-",
];
