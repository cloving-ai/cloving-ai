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
  CLOVING_NEXT_COMMAND             A JSON list of a command and its arguments. The command runs with no added argument and prints one ready ticket ID for --next. The setting has no default.
  CLOVING_QUEUE_SECONDS            A whole number from 10 to 3600 seconds between develop-issue queue checks; requires CLOVING_NEXT_COMMAND and CLOVING_TICKET_COMMAND. Unset means no queue. The queue stops after a failed, cancelled or unsuccessful run until restart; manual develop-issue submissions are refused with workflow-active while an issue run is active.
  CLOVING_SELF_UPDATE_SECONDS      A whole number from 30 to 3600 seconds between checks of the own checkout. Unset means no update. An update stops the daemon and watch page; a change of package-lock.json needs the operator to update and install by hand.
  CLOVING_CLAUDE_COMMAND           A JSON list of a command and its arguments for the Claude worker. The default is the claude command with a limit of 5 USD for each turn.
  CLOVING_WORKER                   The worker for each turn: claude or codex. The default is claude. Other values stop the start with invalid-worker.
  CLOVING_CODEX_COMMAND            A JSON list of a command and its arguments, used only when CLOVING_WORKER is codex; CLOVING_CLAUDE_COMMAND is then ignored. The default is codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -, with no sandbox and no approval prompts.
  CLOVING_WATCH_PORT               The port number of the watch page. The value off starts no watch page. The default is 3663.
  CLOVING_OWNERSHIP_LEASE_SECONDS  The time in seconds of the ownership lease of a started workflow step. The default is 15.
  CLOVING_HOST_BOUND               The largest number of queue messages that the workflow host handles at one time, from 1 to 64. The default is 8.
  CLOVING_GH_COMMAND               A JSON list of a command and its arguments for the GitHub CLI, which the workflow develop-issue uses for pull requests and develop-prd uses for issues. The default is gh.
  CLOVING_CHECK_COMMAND            A JSON list of a command and its arguments that the workflow develop-issue runs in the work tree before a merge. A merge does not occur if the command fails. The setting has no default, and with no setting the merge occurs with no check.
  CLOVING_PRIVATE_TEXTS            A JSON list of texts that the workflow develop-issue does not push in a file or in a commit message. The workflow develop-prd requires the list before posting an issue. The list adds to the path of the home folder, and the case of the letters does not matter. The setting has no default.
`,
};

export const usage = `Usage: cloving [--help] [--version]
       cloving workflows validate <manifest-path> [--input <json-file>] [--json]
       cloving <command> [--help]

Commands:
  workflows validate  Check a compiled workflow manifest, its artifacts and optional runtime input.
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

export const validateUsage = `Usage: cloving workflows validate <manifest-path> [--input <json-file>] [--json]

Checks a Cloving workflow manifest, its compiled SDK artifacts, declared resources and toolchain, and an optional runtime input file. Relative paths resolve against the current directory.

Options:
  --input <json-file>  Validate this runtime input file.
  --json               Print one versioned JSON result on stdout.

Validation does not admit a run, dispatch effects, import workflow code or call a model.

Example:
  cloving workflows validate cloving.workflow.json --input input.json
`;
