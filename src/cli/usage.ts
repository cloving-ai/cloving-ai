const binding =
  "--expected-revision <n> --generation <n> --subject-digest <digest>";

export const commandUsage: Readonly<Record<string, string>> = {
  run: `Usage: cloving run <workflow-id> (--prompt <text> | --ticket <id> | --next | --input <json-file>) [--command-id <id>] [--json]

Submits one run of an admitted workflow. Use exactly one input source.
With --ticket, the workflow gets the ticket ID and reads the ticket itself.
With --next (the same as --ticket next), develop-issue and develop-ticket select a ready ticket through CLOVING_NEXT_COMMAND.
Success means a committed receipt. It does not mean completed work.
`,
  status: `Usage: cloving status [<run-id>] [--limit <n>] [--after <cursor>] [--json]

Lists the runs, or shows one run with its reason, evidence and next action.
`,
  questions: `Usage: cloving questions [<run-id>] [--json]

Lists the pending decisions with the values that a decision command needs.
`,
  answer: `Usage: cloving answer <decision-ref> --text <answer> ${binding} [--command-id <id>] [--json]

Records an answer to one design question.
`,
  approve: `Usage: cloving approve <decision-ref> ${binding} [--command-id <id>] [--json]

Approves one pending approval.
`,
  deny: `Usage: cloving deny <decision-ref> [--text <feedback>] ${binding} [--command-id <id>] [--json]

Denies one pending approval. The workflow continues with the denial.
A feedback text has at most 8000 bytes. The ticket workflow sends it to the next round.
`,
  pause: `Usage: cloving pause <run-id> --expected-revision <n> [--command-id <id>] [--json]

Stops new dispatch for the run. Work in progress is not stopped at once.
`,
  resume: `Usage: cloving resume <run-id> --expected-revision <n> [--command-id <id>] [--json]

Returns a paused run to the state that it paused from.
`,
  drop: `Usage: cloving drop <run-id> --expected-revision <n> [--command-id <id>] [--json]

Cancels the run and its pending dispatch. It keeps the workspace and the evidence.
`,
  events: `Usage: cloving events [<run-id>] [--after <sequence>] [--limit <n>] [--follow] [--json]

Prints the committed events after a sequence. With --json, each line is one event.
`,
  watch: `Usage: cloving watch [--port <n>]

Serves a page on http://127.0.0.1:<port>/ that shows the runs live: the state,
the events, the work of the Claude worker and each pending decision.
The default port is 3663. The page is read only. Stop it with Control-C.
`,
  start: `Usage: cloving start [--repository <directory>]

Starts the Cloving service for one git repository, with the workflow host,
the Claude worker and the watch page. The default repository is the current
directory. This command works in a development checkout of Cloving.
Stop it with Control-C.

The command reads these settings from the environment:
  CLOVING_RUNTIME_DIR              The path of the runtime directory. The default is ~/.local/state/cloving/run, if XDG_RUNTIME_DIR and XDG_STATE_HOME are not set.
  CLOVING_TICKET_COMMAND           A JSON list of a command and its arguments. The command gets a ticket ID as its last argument and prints the ticket. The setting has no default, and a run with --ticket needs it.
  CLOVING_NOTIFY_COMMAND           A JSON list of a command and its arguments. Every 15 seconds, new decisions, blocked runs and failed runs send JSON on standard input with no added argument. The setting has no default.
  CLOVING_NEXT_COMMAND             A JSON list of a command and its arguments. The command runs with no added argument and prints one ready ticket ID for --next. The setting has no default.
  CLOVING_QUEUE_SECONDS            A whole number from 10 to 3600 seconds between develop-issue queue checks; requires CLOVING_NEXT_COMMAND and CLOVING_TICKET_COMMAND. Unset means no queue. The queue stops after a failed, cancelled or unsuccessful run until restart; manual develop-issue submissions are refused with workflow-active while an issue run is active.
  CLOVING_SELF_UPDATE_SECONDS      A whole number from 30 to 3600 seconds between checks of the own checkout; unset means no update. An update stops the daemon and restarts with new code. A change of package-lock.json needs the operator to update and install by hand.
  CLOVING_CLAUDE_COMMAND           A JSON list of a command and its arguments for the Claude worker. The default is the claude command with a limit of 5 USD for each turn.
  CLOVING_PROFILES                 The path of a JSON file of operator-defined Claude turn profiles, read once at start. The setting has no default.
  CLOVING_TOKEN_PRICES             A JSON object from model names to input, cachedInput and output USD prices per million tokens for estimates; no default means no estimate.
  CLOVING_WORKER                   The worker for each turn: claude or codex. The default is claude. Other values stop the start with invalid-worker.
  CLOVING_CODEX_COMMAND            A JSON list of a command and its arguments, used only when CLOVING_WORKER is codex; CLOVING_CLAUDE_COMMAND is then ignored. The default is codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -, with no sandbox and no approval prompts.
  CLOVING_WATCH_REPOSITORY         The service repository context for the watch board, set by start from --repository. Its local origin supplies the GitHub identity. There is no current-directory default.
  CLOVING_WATCH_PORT               The port number of the watch page. The value off starts no watch page. The default is 3663.
  CLOVING_OWNERSHIP_LEASE_SECONDS  The time in seconds of the ownership lease of a started workflow step. The default is 15.
  CLOVING_HOST_BOUND               The largest number of queue messages that the workflow host handles at one time, from 1 to 64. The default is 8.
  CLOVING_GH_COMMAND               A JSON list of a command and its arguments for the GitHub CLI, which the workflow develop-issue uses for pull requests and develop-prd uses for issues. The watch board also uses it to read pull request status. The default is gh.
  CLOVING_CHECK_COMMAND            A JSON list of a command and its arguments that the workflow develop-issue runs in the work tree before a merge. A merge does not occur if the command fails. The setting has no default, and with no setting the merge occurs with no check.
  CLOVING_PRIVATE_TEXTS            A JSON list of texts that the workflow develop-issue does not push in a file or in a commit message. The workflow develop-prd requires the list before posting an issue. The list adds to the path of the home folder, and the case of the letters does not matter. The setting has no default.
`,
};

export const usage = `Usage: cloving [--help] [--version]
       cloving workflows validate <manifest-path> [--input <json-file>] [--json]
       cloving <command> [--help]

Commands:
  workflows validate  Check a compiled workflow manifest, its artifacts and optional runtime input.
  chats redact  Redact one imported chat corpus into private runtime files.
  chats import  Import explicitly selected Claude Code transcripts into private runtime files.
  run        Submit one run of an admitted workflow.
  status     List the runs or show one run.
  questions  List the pending decisions.
  answer     Answer one design question.
  approve    Approve one pending approval.
  deny       Deny one pending approval.
  pause      Stop new dispatch for a run.
  resume     Resume a paused run.
  drop       Cancel a run and keep its files.
  events     Print the committed events.
  watch      Serve a page that shows the runs live.
  start      Start the service for a repository.

The runtime commands need a Cloving service. CLOVING_RUNTIME_DIR names its runtime directory.
Use npm exec -- cloving ... for a project-local installation.
`;

export const chatsImportUsage = `Usage: cloving chats import [--] <path> [<path> ...]

Imports only the selected Claude Code JSONL files. Relative paths use the current directory.
This local command needs no service. It does not expand globs or scan directories.
The file limit is 10 MiB (10,485,760 bytes). Links and nonregular files are refused.
The total normalized corpus limit is 50 MiB (52,428,800 UTF-8 bytes), including newlines and repeated selections.
Exceeding that total returns output-failed with exit code 1 and no completed coverage manifest; partial files may remain.
Private corpus.jsonl, structure.json and coverage.json files go into a new import directory under the runtime directory's chats directory.
The runtime selection is CLOVING_RUNTIME_DIR, XDG_RUNTIME_DIR, XDG_STATE_HOME, then HOME.
Output contains only counts, fixed codes and an opaque import ID. Source paths stay in the private manifest.
Structure preserves branches and marks known copies without removing records. History completeness remains unknown.
Exit codes: 0 for all selected sources included, 1 for refused sources or output failure, 2 for invalid usage.
`;

export const validateUsage = `Usage: cloving workflows validate <manifest-path> [--input <json-file>] [--json]

Checks a Cloving workflow manifest, its compiled SDK artifacts, declared resources and toolchain, and an optional runtime input file. Relative paths resolve against the current directory.

Options:
  --input <json-file>  Validate this runtime input file.
  --json               Print one versioned JSON result on stdout.

Validation does not admit a run, dispatch effects, import workflow code or call a model.

Example:
  cloving workflows validate cloving.workflow.json --input input.json
`;

export const chatsRedactUsage = `Usage: cloving chats redact <IMPORT_ID>

Redact one existing import selected by its UUID v4 import ID. No service is required.
Write redacted.jsonl and redaction.json beside the original corpus with mode 0600.
HOME supplies the home folder. CLOVING_PRIVATE_TEXTS is an optional JSON list of nonblank strings.
Originals and metadata remain private. Redaction does not authorize model use or guarantee removal of every private value.
Exit codes: 0 complete, 1 processing failure, 2 invalid usage.
`;
