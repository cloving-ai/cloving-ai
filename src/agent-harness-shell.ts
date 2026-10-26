export const shellDiscoveryScript = `
set +m
if [ -z "\${ZSH_VERSION-}" ] && [ -z "\${BASH_VERSION-}" ]; then exit 64; fi
printf '__CLOVING_HARNESS_START_-1__\\n%s\\n\\n__CLOVING_HARNESS_END_-1__\\n' "\${BASH_VERSION:+bash}"
index=0
for name in "$@"; do
  printf '__CLOVING_HARNESS_START_%s__\\n' "$index"
  if [ -n "\${ZSH_VERSION-}" ]; then
    kind=$(whence -w -- "$name" 2>/dev/null)
    printf '%s\\n' "\${kind##*: }"
    file=$(whence -p -- "$name" 2>/dev/null)
  else
    kind=$(builtin type -t -- "$name" 2>/dev/null)
    printf '%s\\n' "$kind"
    file=$(builtin type -P -- "$name" 2>/dev/null)
  fi
  case "$file" in /*|"") ;; *) file="$PWD/$file" ;; esac
  printf '%s\\n%s\\n' "$file" "$PATH"
  printf '\\n__CLOVING_HARNESS_END_%s__\\n' "$index"
  index=$((index + 1))
done
exit 0
`;

export const shellProbeScript = `
set +m
printf '__CLOVING_HARNESS_START_0__\\n'
if [ -n "\${ZSH_VERSION-}" ]; then
  if (( \${+aliases[$1]} )); then
    alias_command="\${aliases[$1]}"
    builtin unalias -- "$1"
    eval -- "$alias_command"' --version'
  else
    "$1" --version
  fi
elif [ -n "\${BASH_VERSION-}" ]; then
  alias_value=$(builtin alias -- "$1" 2>/dev/null)
  if [ $? -eq 0 ]; then
    eval -- "alias_command=\${alias_value#*=}"
    builtin unalias -- "$1"
    eval -- "$alias_command"' --version'
  else
    "$1" --version
  fi
else
  exit 64
fi
probe_status=$?
printf '\\n__CLOVING_HARNESS_END_0__\\n'
exit "$probe_status"
`;

export function shellBlock(output: string, index: number): string | null {
  const start = `__CLOVING_HARNESS_START_${String(index)}__\n`;
  const end = `\n__CLOVING_HARNESS_END_${String(index)}__\n`;
  const began = output.indexOf(start);
  if (began < 0) return null;
  const finished = output.indexOf(end, began + start.length);
  return finished < 0 ? null : output.slice(began + start.length, finished);
}

export interface ShellEntry {
  readonly name: string;
  readonly kind: "file" | "shell";
  readonly path: string;
  readonly searchPath: string;
}

export function shellEntries(
  output: string,
  names: readonly string[],
): ShellEntry[] | null {
  const blocks = names.map((_, index) => shellBlock(output, index));
  if (blocks.some((block) => block === null)) return null;
  return names.flatMap((name, index) => {
    const [kind, path, searchPath = ""] = (blocks[index] ?? "").split("\n");
    const entries: ShellEntry[] = [];
    if (path) entries.push({ name, kind: "file", path, searchPath });
    if (kind === "function" || kind === "alias")
      entries.push({ name, kind: "shell", path: name, searchPath });
    return entries;
  });
}

export type ShellMode = "login" | "interactive";

export function shellArguments(mode: ShellMode): string[] {
  return [...(mode === "login" ? ["-l"] : []), "-i", "+m", "-c"];
}
