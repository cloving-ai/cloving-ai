export interface KnownHarness {
  readonly name: string;
  readonly versionOption: string;
  readonly versionPattern: string;
}

const semanticVersion = String.raw`\d+\.\d+\.\d+(?:[-+][\w.+-]+)?`;
const fallbackVersion = String.raw`\d+\.\d+`;

export const knownHarnesses: readonly KnownHarness[] = [
  {
    name: "claude",
    versionOption: "--version",
    versionPattern: `^${semanticVersion} \\(Claude Code\\)$`,
  },
  {
    name: "codex",
    versionOption: "--version",
    versionPattern: `^codex-cli ${semanticVersion}$`,
  },
  {
    name: "gemini",
    versionOption: "--version",
    versionPattern: `^${semanticVersion}$`,
  },
  {
    name: "opencode",
    versionOption: "--version",
    versionPattern: `^(?:opencode v)?${semanticVersion}$`,
  },
  {
    name: "grok",
    versionOption: "--version",
    versionPattern: `^${semanticVersion}$`,
  },
  {
    name: "cursor-agent",
    versionOption: "--version",
    versionPattern: String.raw`^\d{4}\.\d{2}\.\d{2}-[\w.-]+$`,
  },
  { name: "pi", versionOption: "--version", versionPattern: fallbackVersion },
  { name: "amp", versionOption: "--version", versionPattern: fallbackVersion },
];

export function harnessDefinition(name: string): KnownHarness {
  return (
    knownHarnesses.find((entry) => entry.name === name) ?? {
      name,
      versionOption: "--version",
      versionPattern: fallbackVersion,
    }
  );
}

export function harnessVersion(output: string, pattern: string): string | null {
  const line = output.split(/\r?\n/, 1)[0] ?? "";
  if (/\b(?:error|unavailable|not found)\b/i.test(line)) return null;
  return new RegExp(pattern).test(line) ? line : null;
}
