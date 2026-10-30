import { shellRunScript } from "./agent-harness-shell.ts";
import type { HarnessSelection } from "./configuration-change.ts";

export interface HarnessStartRequest {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly directory: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

const startForms: Readonly<Record<string, readonly string[]>> = {
  claude: [],
  codex: [],
  gemini: [],
  grok: [],
  "cursor-agent": [],
  opencode: ["--prompt"],
};

const shellStartScript = `
set +m
kind=
if [ -n "\${ZSH_VERSION-}" ]; then
  kind=$(builtin whence -w -- "$1" 2>/dev/null) || kind=
  kind="\${kind##*: }"
elif [ -n "\${BASH_VERSION-}" ]; then
  kind=$(builtin type -t -- "$1" 2>/dev/null) || kind=
fi
case "$kind" in
  function|alias) ;;
  *) printf '%s\\n' 'Open your agent in this repository and tell it: run \`cloving init-prompt\`.' >&2; exit 1 ;;
esac
${shellRunScript}
`;

export function harnessStartRequest(
  entry: HarnessSelection,
  context: {
    readonly repository: string;
    readonly environment: Readonly<NodeJS.ProcessEnv>;
    readonly message: string;
  },
): HarnessStartRequest {
  const argumentsList = [
    ...(Object.hasOwn(startForms, entry.name)
      ? (startForms[entry.name] ?? [])
      : []),
    context.message,
  ];
  const executable =
    entry.kind === "shell" ? (context.environment["SHELL"] ?? "") : entry.path;
  const args =
    entry.kind === "shell"
      ? [
          "-l",
          "-i",
          "-c",
          shellStartScript,
          "cloving-init",
          entry.path,
          ...argumentsList,
        ]
      : argumentsList;
  return {
    executable,
    arguments: args,
    directory: context.repository,
    environment: context.environment,
  };
}
