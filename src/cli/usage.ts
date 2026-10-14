const binding =
  "--expected-revision <n> --generation <n> --subject-digest <digest>";

export const commandUsage: Readonly<Record<string, string>> = {
  run: `Usage: cloving run <workflow-id> (--prompt <text> | --ticket <id> | --input <json-file>) [--command-id <id>] [--json]

Submits one run of an admitted workflow. Use exactly one input source.
With --ticket, the workflow gets the ticket ID and reads the ticket itself.
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
  deny: `Usage: cloving deny <decision-ref> ${binding} [--command-id <id>] [--json]

Denies one pending approval. The workflow continues with the denial.
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
  CLOVING_CLAUDE_COMMAND           A JSON list of a command and its arguments for the Claude worker. The default is the claude command with a limit of 5 USD for each turn.
  CLOVING_WATCH_PORT               The port number of the watch page. The value off starts no watch page. The default is 3663.
  CLOVING_OWNERSHIP_LEASE_SECONDS  The time in seconds of the ownership lease of a started workflow step. The default is 15.
  CLOVING_HOST_BOUND               The largest number of queue messages that the workflow host handles at one time, from 1 to 64. The default is 8.
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
