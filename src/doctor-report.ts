import { hasTicketField, type SubmissionContract } from "./submission.ts";

export const doctorCodes = [
  "git-repository",
  "node-version",
  "harnesses",
  "default-harness",
  "gh-login",
  "github-origin",
  "greptile-review",
  "settings-files",
  "runtime-directory",
  "service",
  "ticket-command",
  "next-command",
  "check-command",
  "queue-interval",
  "private-texts",
] as const;

export type DoctorCode = (typeof doctorCodes)[number];
export interface DoctorObservation {
  readonly result: "ok" | "fail" | "skip";
  readonly detail: string;
}
export interface DoctorCheck extends DoctorObservation {
  readonly code: DoctorCode;
  readonly required: boolean;
  readonly fix: string;
}

export const doctorFixes: Readonly<Record<DoctorCode, string>> = {
  "git-repository": "Change to the repository, or run: git init",
  "node-version":
    "Install the qualified Node version: nvm install 26.9.0 && nvm use 26.9.0",
  harnesses: "Install a harness: npm install -g @anthropic-ai/claude-code",
  "default-harness":
    "Install a harness: npm install -g @anthropic-ai/claude-code; select it: CLOVING_WORKER=claude cloving doctor; clear command overrides: unset CLOVING_CLAUDE_COMMAND CLOVING_CODEX_COMMAND; edit private harness.command if configured",
  "gh-login": "Log in with the configured GitHub command: gh auth login",
  "github-origin":
    "Set a GitHub origin: git remote add origin git@github.com:OWNER/REPO.git || git remote set-url origin git@github.com:OWNER/REPO.git",
  "greptile-review":
    "Install the Greptile app at https://github.com/apps/greptile, then open a first pull request: gh pr create",
  "settings-files":
    "Fix the project JSON: ${EDITOR:-vi} .cloving/config.json; for private JSON, edit <config>/cloving/projects/<repository-id>.json",
  "runtime-directory":
    'Select a private writable runtime: CLOVING_RUNTIME_DIR="$HOME/.local/state/cloving/doctor/run" cloving doctor',
  service: "Start the service: cloving start",
  "ticket-command":
    "Set tickets.command to an executable list: ${EDITOR:-vi} .cloving/config.json",
  "next-command":
    "Set tickets.nextCommand to an executable list: ${EDITOR:-vi} .cloving/config.json",
  "check-command":
    "Set checks.beforeMerge to an executable list: ${EDITOR:-vi} .cloving/config.json",
  "queue-interval":
    "Set an interval from 10 to 3600: CLOVING_QUEUE_SECONDS=30 cloving doctor",
  "private-texts": `Set a nonblank private text: CLOVING_PRIVATE_TEXTS='["TEXT TO KEEP PRIVATE"]' cloving doctor`,
};

export function doctorExitCode(checks: readonly DoctorCheck[]): number {
  return checks.some((check) => check.required && check.result !== "ok")
    ? 1
    : 0;
}

export interface DoctorWorkflow {
  readonly scope: "bundled" | "project" | "user";
  readonly workflowId: string;
  readonly capabilities: readonly string[];
  readonly input?: SubmissionContract;
}

export function requiredDoctorCodes(
  workflows: readonly DoctorWorkflow[],
  options: { readonly queueSeconds: string | undefined },
): readonly DoctorCode[] {
  const codes = new Set<DoctorCode>([
    "git-repository",
    "node-version",
    "default-harness",
    "settings-files",
    "runtime-directory",
  ]);
  if (workflows.some((workflow) => workflow.capabilities.includes("github"))) {
    codes.add("gh-login");
    codes.add("github-origin");
  }
  const bundled = workflows
    .filter((workflow) => workflow.scope === "bundled")
    .map((workflow) => workflow.workflowId);
  const issue = bundled.includes("develop-issue");
  if (issue) codes.add("check-command");
  if (issue && options.queueSeconds !== undefined) {
    codes.add("next-command");
    codes.add("queue-interval");
  }
  if (
    workflows.some((workflow) => hasTicketField(workflow.input)) ||
    bundled.some((name) => ["develop-ticket", "develop-issue"].includes(name))
  )
    codes.add("ticket-command");
  if (bundled.includes("develop-prd")) codes.add("private-texts");
  return [...codes];
}
