import { auditCandidates, type AuditCandidate } from "./audit-report.mts";

export interface CommandCall {
  readonly file: "git" | "npm" | "gh";
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface CommandEnd {
  readonly error: { readonly code?: unknown } | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface AuditSystem {
  readonly repository: string;
  readonly folder: string;
  readonly commandArguments: readonly string[];
  readonly run: (call: CommandCall) => Promise<CommandEnd>;
}

interface AuditAccess {
  readonly system: AuditSystem;
  readonly login: Readonly<Record<string, string>>;
}

export interface AuditOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const usage =
  "Give the absolute path of a GitHub CLI configuration folder as the only argument.";

export const securityIssues =
  "repos/{owner}/{repo}/issues?state=open&labels=cloving%3A%20security&per_page=100";

export function commandFailure(error: unknown): CommandEnd {
  const fields: Readonly<Record<string, unknown>> =
    typeof error === "object" && error !== null
      ? Object.fromEntries(Object.entries(error))
      : {};
  const text = (value: unknown): string =>
    typeof value === "string" ? value : "";
  return {
    error: { code: fields["code"] },
    stdout: text(fields["stdout"]),
    stderr: text(fields["stderr"]) || String(error).replace(/^Error: /, ""),
  };
}

async function output(
  system: AuditSystem,
  call: CommandCall & { readonly codes?: readonly number[] },
): Promise<string> {
  const end = await system.run(call);
  const code = end.error === null ? 0 : end.error.code;
  if ((call.codes ?? [0]).some((accepted) => accepted === code))
    return end.stdout;
  const reason = end.stderr.trim().split("\n").slice(-1).join("");
  throw new Error(
    `${call.file} ${call.args.join(" ")} failed: ${reason || `exit code ${String(code)}`}`,
  );
}

function json(text: string, source: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${source} printed an unexpected report.`);
  }
}

async function treeCandidates(
  access: AuditAccess,
  tree: string,
): Promise<readonly AuditCandidate[]> {
  const npm = (args: readonly string[]) =>
    output(access.system, {
      file: "npm",
      args,
      cwd: tree,
      environment: {},
      codes: [0, 1],
    });
  await output(access.system, {
    file: "npm",
    args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
    cwd: tree,
    environment: {},
  });
  const audit = json(await npm(["audit", "--json"]), "npm audit");
  const installed = json(await npm(["ls", "--all", "--json"]), "npm ls");
  const issues = json(
    await output(access.system, {
      file: "gh",
      args: ["api", "--paginate", "--slurp", securityIssues],
      cwd: access.system.repository,
      environment: access.login,
    }),
    "gh",
  );
  return auditCandidates({ audit, tree: installed, issues });
}

function loginFolder(commandArguments: readonly string[]): string {
  const [folder, ...others] = commandArguments;
  if (folder === undefined || !folder.startsWith("/") || others.length > 0)
    throw new Error(usage);
  return folder;
}

async function auditedTree(
  system: AuditSystem,
): Promise<readonly AuditCandidate[]> {
  const access = {
    system,
    login: { GH_CONFIG_DIR: loginFolder(system.commandArguments) },
  };
  const git = (args: readonly string[]) =>
    output(system, {
      file: "git",
      args,
      cwd: system.repository,
      environment: access.login,
    });
  const head = await git([
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  const branch = head.trim().replace(/^origin\//, "");
  await git(["fetch", "--quiet", "origin", branch]);
  const tree = `${system.folder}/tree`;
  await git([
    "worktree",
    "add",
    "--quiet",
    "--detach",
    tree,
    `origin/${branch}`,
  ]);
  try {
    return await treeCandidates(access, tree);
  } finally {
    await git(["worktree", "remove", "--force", tree]);
  }
}

export async function auditOutput(system: AuditSystem): Promise<AuditOutput> {
  try {
    const candidates = await auditedTree(system);
    return {
      stdout: `${JSON.stringify(candidates, null, 2)}\n`,
      stderr: "",
      exitCode: 0,
    };
  } catch (error) {
    return {
      stdout: "",
      stderr: `${String(error).replace(/^Error: /, "")}\n`,
      exitCode: 1,
    };
  }
}
