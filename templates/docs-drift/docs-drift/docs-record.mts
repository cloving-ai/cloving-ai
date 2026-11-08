export type DocsRecord = Readonly<Record<string, string>>;

export interface ScriptOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface RecordSystem {
  readonly commandArguments: readonly string[];
  readonly input: string;
  readonly read: (file: string) => Promise<string | null>;
  readonly write: (file: string, text: string) => Promise<void>;
}

const commitId = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const docPath = /^(?!.*\.\.)(?!\/)[\w./-]+\.md$/;
const usage = "Give the absolute path of the record file as the only argument.";
const inputRule =
  'The input must be {"commit": "<commit ID>", "docs": ["<doc path>"]} with at most 15 docs.';

export function message(error: unknown): string {
  return String(error).replace(/^Error: /, "");
}

export function absentFile(error: unknown): null {
  if (error instanceof Error && "code" in error && error.code === "ENOENT")
    return null;
  throw error;
}

function json(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}

function fields(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;
}

function commitOf(value: unknown): value is string {
  return typeof value === "string" && commitId.test(value);
}

export function recordOf(text: string | null, file: string): DocsRecord {
  if (text === null) return {};
  const document = fields(json(text));
  const docs = fields(document?.["docs"]);
  if (
    document?.["version"] !== 1 ||
    docs === undefined ||
    !Object.entries(docs).every(
      ([doc, commit]) => docPath.test(doc) && commitOf(commit),
    )
  )
    throw new Error(`The file ${file} is not a docs-drift record.`);
  return Object.fromEntries(
    Object.entries(docs).map(([doc, commit]) => [doc, String(commit)]),
  );
}

function updateOf(input: string): {
  readonly commit: string;
  readonly docs: readonly string[];
} {
  const update = fields(json(input));
  const commit = update?.["commit"];
  const docs: unknown = update?.["docs"];
  if (
    !commitOf(commit) ||
    !Array.isArray(docs) ||
    docs.length > 15 ||
    !docs.every((doc) => typeof doc === "string" && docPath.test(doc))
  )
    throw new Error(inputRule);
  return { commit, docs: docs.map((doc) => String(doc)) };
}

function recordFile(commandArguments: readonly string[]): string {
  const [file, ...others] = commandArguments;
  if (file === undefined || !file.startsWith("/") || others.length > 0)
    throw new Error(usage);
  return file;
}

export async function recordOutput(
  system: RecordSystem,
): Promise<ScriptOutput> {
  try {
    const file = recordFile(system.commandArguments);
    const update = updateOf(system.input);
    const previous = recordOf(await system.read(file), file);
    const docs = Object.entries(previous)
      .filter(([doc]) => !update.docs.includes(doc))
      .concat(update.docs.map((doc) => [doc, update.commit]))
      .sort(([left], [right]) => (left < right ? -1 : 1));
    await system.write(
      file,
      `${JSON.stringify({ version: 1, docs: Object.fromEntries(docs) }, null, 2)}\n`,
    );
    return {
      stdout: `${JSON.stringify({ recorded: update.docs.length })}\n`,
      stderr: "",
      exitCode: 0,
    };
  } catch (error) {
    return { stdout: "", stderr: `${message(error)}\n`, exitCode: 1 };
  }
}
