type Fields = Readonly<Record<string, unknown>>;

function record(value: unknown): Fields {
  return typeof value === "object" && value !== null ? { ...value } : {};
}

function parsed(line: string): Fields {
  try {
    return record(JSON.parse(line));
  } catch {
    return {};
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function message(content: Fields): string {
  return JSON.stringify({ type: "assistant", message: { content: [content] } });
}

function commandError(item: Fields): string[] {
  const code = item["exit_code"];
  if (item["status"] !== "failed" && !(typeof code === "number" && code !== 0))
    return [];
  const fallback =
    typeof code === "number" ? `exit code ${String(code)}` : "command failed";
  const content = text(item["aggregated_output"]).slice(-2000) || fallback;
  return [
    JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", is_error: true, content }] },
    }),
  ];
}

function completed(item: Fields): string[] {
  if (item["type"] === "agent_message")
    return [message({ type: "text", text: text(item["text"]) })];
  if (item["type"] === "command_execution") return commandError(item);
  if (item["type"] !== "file_change" || !Array.isArray(item["changes"]))
    return [];
  return item["changes"].map((change: unknown) =>
    message({
      type: "tool_use",
      name: "Edit",
      input: { file_path: text(record(change)["path"]) },
    }),
  );
}

interface State {
  sessionId: string | null;
  turns: number;
  failed: boolean;
  error: string;
  message: string;
}

function updated(event: Fields, state: State): void {
  const type = event["type"];
  if (type === "thread.started")
    state.sessionId = text(event["thread_id"]) || null;
  if (type === "turn.completed") state.turns += 1;
  if (type === "turn.failed" || type === "error") {
    state.failed = true;
    state.error =
      text(
        type === "turn.failed"
          ? record(event["error"])["message"]
          : event["message"],
      ) || state.error;
  }
}

function translated(event: Fields, state: State): string[] {
  updated(event, state);
  const type = event["type"];
  if (type === "thread.started")
    return [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: state.sessionId,
      }),
    ];
  const item = record(event["item"]);
  if (type === "item.started" && item["type"] === "command_execution")
    return [
      message({
        type: "tool_use",
        name: "Bash",
        input: { command: text(item["command"]) },
      }),
    ];
  if (type !== "item.completed") return [];
  if (item["type"] === "agent_message") state.message = text(item["text"]);
  return completed(item);
}

export function codexStream(): {
  readonly line: (line: string) => readonly string[];
  readonly result: (exitCode: number | null) => string;
} {
  const state: State = {
    sessionId: null,
    turns: 0,
    failed: false,
    error: "",
    message: "",
  };
  return {
    line: (line) => translated(parsed(line), state),
    result: (exitCode) => {
      const success = exitCode === 0 && state.turns > 0 && !state.failed;
      return JSON.stringify({
        type: "result",
        subtype: success ? "success" : "error_during_execution",
        is_error: !success,
        result: success
          ? state.message
          : state.error || `codex ended with the code ${String(exitCode)}`,
        total_cost_usd: null,
        session_id: state.sessionId,
        num_turns: state.turns,
      });
    },
  };
}
