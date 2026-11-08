export interface RecordSystem {
  readonly commandArguments: readonly string[];
  readonly input: string;
  readonly decidedAt: string;
  readonly runId: string | null;
  readonly append: (path: string, text: string) => Promise<void>;
}

export interface RecordOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

interface Decision {
  readonly name: string;
  readonly kind: string;
  readonly rule: string;
  readonly shape: string;
  readonly decision: string;
  readonly links: readonly string[];
}

const invalid = "The input has no valid decisions.";

function refused(message: string): RecordOutput {
  return { stdout: "", stderr: `${message}\n`, exitCode: 1 };
}

function words(value: unknown): string {
  if (typeof value === "string" && value.length <= 600) return value;
  throw new Error(invalid);
}

function decisionOf(value: unknown): Decision {
  if (typeof value !== "object" || value === null) throw new Error(invalid);
  const item: Readonly<Record<string, unknown>> = Object.fromEntries(
    Object.entries(value),
  );
  const name = words(item["name"]);
  const decision = words(item["decision"]);
  const links = item["links"];
  if (
    !/^[a-z][a-z0-9-]{0,63}$/.test(name) ||
    !["accept", "reject", "defer"].includes(decision) ||
    !Array.isArray(links)
  )
    throw new Error(invalid);
  return {
    name,
    kind: words(item["kind"]),
    rule: words(item["rule"]),
    shape: words(item["shape"]),
    decision,
    links: links.map((link: unknown) => words(link)),
  };
}

function decisionsOf(input: string): readonly Decision[] {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error(invalid);
  }
  const listed: unknown =
    typeof value === "object" && value !== null && "decisions" in value
      ? value.decisions
      : null;
  if (!Array.isArray(listed) || listed.length === 0) throw new Error(invalid);
  return listed.map((item: unknown) => decisionOf(item));
}

export async function recordOutput(
  system: RecordSystem,
): Promise<RecordOutput> {
  const [file = ""] = system.commandArguments;
  if (system.commandArguments.length !== 1 || !file.startsWith("/"))
    return refused("Give the absolute decisions file as the only argument.");
  let decisions: readonly Decision[];
  try {
    decisions = decisionsOf(system.input);
  } catch {
    return refused(invalid);
  }
  const lines = decisions.map((decision) =>
    JSON.stringify(
      Object.assign({}, decision, {
        decidedAt: system.decidedAt,
        runId: system.runId,
      }),
    ),
  );
  await system.append(file, `${lines.join("\n")}\n`);
  return {
    stdout: `${JSON.stringify({ recorded: decisions.length })}\n`,
    stderr: "",
    exitCode: 0,
  };
}
