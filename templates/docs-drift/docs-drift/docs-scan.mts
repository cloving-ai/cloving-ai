import {
  changedWords,
  docPatterns,
  mentionedCode,
  namedDocs,
  type ChangedWords,
} from "./doc-mentions.mts";
import {
  message,
  recordOf,
  type DocsRecord,
  type ScriptOutput,
} from "./docs-record.mts";

export interface CommandCall {
  readonly file: "git" | "gh";
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface CommandEnd {
  readonly error: { readonly code?: unknown } | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ScanSystem {
  readonly repository: string;
  readonly commandArguments: readonly string[];
  readonly run: (call: CommandCall) => Promise<CommandEnd>;
  readonly read: (file: string) => Promise<string | null>;
}

interface Candidate {
  readonly doc: string;
  readonly since: string | null;
  readonly code: readonly string[];
  readonly codeCount: number;
}

type Git = (args: readonly string[]) => Promise<string>;

const usage =
  "Give the absolute path of a GitHub CLI configuration folder, the absolute path of the record file and one or more doc patterns, for example README.md or templates/*/README.md.";

export const docsIssues =
  "repos/{owner}/{repo}/issues?state=open&labels=cloving%3A%20docs&per_page=100";

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
    stderr: text(fields["stderr"]) || message(error),
  };
}

async function output(system: ScanSystem, call: CommandCall): Promise<string> {
  const end = await system.run(call);
  if (end.error === null) return end.stdout;
  const reason = end.stderr.trim().split("\n").slice(-1).join("");
  throw new Error(
    `${call.file} ${call.args.join(" ")} failed: ${reason || `exit code ${String(end.error.code)}`}`,
  );
}

function absolute(path: string | undefined): path is string {
  return path?.startsWith("/") === true;
}

function settingsOf(commandArguments: readonly string[]) {
  const [login, record, ...patterns] = commandArguments;
  const relative = (pattern: string) =>
    !pattern.startsWith("/") && !pattern.split("/").includes("..");
  if (
    !absolute(login) ||
    !absolute(record) ||
    patterns.length === 0 ||
    !patterns.every(relative)
  )
    throw new Error(usage);
  return { login, record, patterns };
}

function list(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function report(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}

function openTitles(text: string): readonly string[] {
  const pages = report(text);
  if (!list(pages)) throw new Error("gh printed an unexpected report.");
  return pages
    .flatMap((page) => page)
    .flatMap((issue) => {
      const item: unknown = issue;
      if (typeof item !== "object" || item === null || "pull_request" in item)
        return [];
      return "title" in item && typeof item.title === "string"
        ? [item.title]
        : [];
    });
}

async function defaultBranch(git: Git): Promise<string> {
  const remote = await git(["ls-remote", "--symref", "origin", "HEAD"]);
  const branch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(remote)?.[1];
  if (branch === undefined)
    throw new Error("The remote origin names no default branch.");
  return branch;
}

async function knownCommit(
  system: ScanSystem,
  commit: string | undefined,
): Promise<string | null> {
  if (commit === undefined) return null;
  const end = await system.run({
    file: "git",
    args: ["cat-file", "-e", `${commit}^{commit}`],
    cwd: system.repository,
    environment: {},
  });
  return end.error === null ? commit : null;
}

interface Tree {
  readonly system: ScanSystem;
  readonly git: Git;
  readonly commit: string;
  readonly empty: string;
  readonly recorded: DocsRecord;
  readonly diffs: Map<string, ChangedWords>;
}

async function changedSince(tree: Tree, base: string): Promise<ChangedWords> {
  const known = tree.diffs.get(base);
  if (known !== undefined) return known;
  const changed = changedWords(
    await tree.git([
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-renames",
      "--unified=0",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      base,
      tree.commit,
      "--",
      ".",
      ":(exclude)*.md",
    ]),
  );
  tree.diffs.set(base, changed);
  return changed;
}

async function candidateOf(
  tree: Tree,
  doc: string,
): Promise<readonly Candidate[]> {
  const since = await knownCommit(tree.system, tree.recorded[doc]);
  const changed = await changedSince(tree, since ?? tree.empty);
  const text = await tree.git(["show", `${tree.commit}:${doc}`]);
  const code = mentionedCode({ path: doc, text }, changed);
  if (code.length === 0) return [];
  return [{ doc, since, code: code.slice(0, 50), codeCount: code.length }];
}

async function scanned(system: ScanSystem): Promise<string> {
  const settings = settingsOf(system.commandArguments);
  const login = { GH_CONFIG_DIR: settings.login };
  const git: Git = (args) =>
    output(system, {
      file: "git",
      args,
      cwd: system.repository,
      environment: login,
    });
  const branch = await defaultBranch(git);
  const remote = `refs/remotes/origin/${branch}`;
  await git(["fetch", "--quiet", "origin", `+refs/heads/${branch}:${remote}`]);
  const commit = (
    await git(["rev-parse", "--verify", `${remote}^{commit}`])
  ).trim();
  const files = (
    await git(["ls-tree", "-r", "-z", "--name-only", commit])
  ).split("\0");
  const recorded = recordOf(
    await system.read(settings.record),
    settings.record,
  );
  const named = namedDocs(
    openTitles(
      await output(system, {
        file: "gh",
        args: ["api", "--paginate", "--slurp", docsIssues],
        cwd: system.repository,
        environment: login,
      }),
    ),
  );
  const tree: Tree = {
    system,
    git,
    commit,
    empty: (await git(["hash-object", "-t", "tree", "/dev/null"])).trim(),
    recorded,
    diffs: new Map(),
  };
  const found: Candidate[] = [];
  for (const doc of docPatterns(files, settings.patterns))
    if (!named.has(doc)) found.push(...(await candidateOf(tree, doc)));
  found.sort(
    (left, right) =>
      right.codeCount - left.codeCount || (left.doc < right.doc ? -1 : 1),
  );
  const candidates = found.slice(0, 15);
  const more = found.length - candidates.length;
  return `${JSON.stringify({ commit, branch, candidates, more }, null, 2)}\n`;
}

export async function scanOutput(system: ScanSystem): Promise<ScriptOutput> {
  try {
    return { stdout: await scanned(system), stderr: "", exitCode: 0 };
  } catch (error) {
    return { stdout: "", stderr: `${message(error)}\n`, exitCode: 1 };
  }
}
