const binding =
  "--expected-revision <n> --generation <n> --subject-digest <digest>";

export const configUsage = `Usage: cloving config list [--json]
       cloving config get <field> [--json]
       cloving config set <field> <value> [--private] [--json]
       cloving config unset <field> [--private] [--json]

Reads and changes settings for the current repository; --repository selects another repository.
Values use JSON when valid, otherwise text. Every change is checked before writing.
Fields use their default project or private file; --private selects the private file.
list and get show the effective source and hidden file values. Unconfigured values use defaults; null means no value.
Changes keep the previous file as .bak and replace the file atomically under a lock.
A live lock waits at most ten seconds, then exits with settings-locked.
Private files, backups and temporary files have mode 0600. Changes require a service restart.
`;

export const commandUsage: Readonly<Record<string, string>> = {
  report: `Usage: cloving report [--since <hours>] [--json]

Reads loop facts without writing state. Hours are a whole number from 1 to 168; default 24.
Reports run outcomes, throughput and ended-run costs with seven-day medians and MAD bands.
Unsupported facts and unreadable sources are unavailable.
`,
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
  start: `Usage: cloving start [--repository <directory>] [--reset-queue]

Starts the Cloving service for one git repository, with the workflow host,
the Claude worker and the watch page. The default repository is the current
directory.
Stop it with Control-C.

The queue continues after unsuccessful runs and stops after three runs in a row
without a successful handoff. A successful handoff resets the count; ordinary restarts preserve the count.
Stop the service, inspect the failures and reconcile affected issues, then start with --reset-queue and the same queue settings to clear the failure streak once. Tracked commands are preserved.

The command reads these settings from the environment:
Settings files: .cloving/config.json in the repository and <config>/cloving/projects/<name>-<id>.json for private settings. Both require version 1. Precedence: environment, private, project, defaults. <config> is an absolute XDG_CONFIG_HOME or ~/.config. The start guide shows each configured field's source. See the packaged project-config.schema.json and private-config.schema.json in dist/src.

  CLOVING_RUNTIME_DIR              The path of the runtime directory. The default is ~/.local/state/cloving/<name>-<id>/run, if XDG_RUNTIME_DIR and XDG_STATE_HOME are not set. A recorded legacy adoption takes priority.
  CLOVING_TICKET_COMMAND           A JSON list of a command and its arguments. The command gets a ticket ID as its last argument and prints the ticket. The setting has no default, and a run with --ticket needs it.
  CLOVING_NOTIFY_COMMAND           A JSON list of a command and its arguments. Every 15 seconds, new decisions, blocked runs and failed runs send JSON on standard input with no added argument. The setting has no default.
  CLOVING_NEXT_COMMAND             A JSON list of a command and its arguments. The command runs with no added argument and prints one ready ticket ID for --next. It must exclude the space-separated ticket IDs in CLOVING_SKIP_TICKETS. The setting has no default.
  CLOVING_QUEUE_SECONDS            A whole number from 10 to 3600 seconds between develop-issue queue checks; requires CLOVING_NEXT_COMMAND and CLOVING_TICKET_COMMAND. Unset means no queue. The queue stops after three runs in a row without a successful handoff; manual develop-issue submissions are refused with workflow-active when all lanes are busy.
  CLOVING_QUEUE_LANES              A whole number from 1 to 4; the default is 1. Requires CLOVING_QUEUE_SECONDS. Active tickets are refused with ticket-active. Needs #N sentences in the ticket's ## Dependencies section refuse admission with ticket-dependency-open while issue #N is open.
  CLOVING_SELF_UPDATE_SECONDS      A whole number from 30 to 3600 seconds between checks of the own checkout; unset means no update. An update stops the daemon and restarts with new code. A change of package-lock.json needs the operator to update and install by hand.
  CLOVING_CLAUDE_COMMAND           A JSON list of a command and its arguments for the Claude worker. The default is the claude command with a limit of 5 USD for each turn.
  CLOVING_PROFILES                 The path of a JSON file of operator-defined Claude turn profiles, read once at start. The setting has no default.
  CLOVING_COMMANDS                A JSON object mapping names to argument arrays with an absolute executable path. Invalid values refuse startup with invalid-commands. Unset means no commands. Command execution is not available yet.
  CLOVING_COMMAND_SECONDS         A whole number from 1 to 3600 seconds; the default is 60. Invalid values refuse startup with invalid-command-seconds. Reserved for command execution.
  CLOVING_TOKEN_PRICES             A JSON object from model names to input, cachedInput and output USD prices per million tokens for estimates; entries override matching built-in prices.
  CLOVING_FALLBACK_MODELS          A JSON array of at most three nonempty model names; the default is no fallback. After capacity refusals the first retry keeps the main model and the third attempt uses the first fallback, with the same waits and attempt limit. Requires an explicit -m, --model or --model= argument. A fallback can have a higher price.
  CLOVING_WORKER                   The worker for each turn: claude, codex or cursor-agent. The default is claude. Unsupported harnesses stop the start with harness-no-worker.
  CLOVING_CODEX_COMMAND            A JSON list of a command and its arguments, used only when CLOVING_WORKER is codex; CLOVING_CLAUDE_COMMAND is then ignored. The default is codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -, with no sandbox and no approval prompts.
  CLOVING_WATCH_REPOSITORY         The service repository context for the watch board, set by start from --repository. Its local origin supplies the GitHub identity. There is no current-directory default.
  CLOVING_WATCH_ACTIONS            The value off removes the board run form and its write endpoint. The default is on.
  CLOVING_WATCH_PORT               The port number of the watch page. The value off starts no watch page. The default is 3663.
  CLOVING_PHONE_RELAY              The phone relay child, which connects phones through cloving.ai. The value off starts no phone relay. The default is on.
  CLOVING_RELAY_ORIGIN             The origin of the phone relay server. Only https origins are accepted. The default is https://cloving.ai.
  CLOVING_OWNERSHIP_LEASE_SECONDS  The time in seconds of the ownership lease of a started workflow step. The default is 15.
  CLOVING_HOST_BOUND               The largest number of queue messages that the workflow host handles at one time, from 1 to 64. The default is 8.
  CLOVING_GH_COMMAND               A JSON list of a command and its arguments for the GitHub CLI, which the workflow develop-issue uses for pull requests and develop-prd uses for issues. The watch board also uses it to read pull request status. The default is gh.
  CLOVING_CHECK_COMMAND            A JSON list of a command and its arguments that the workflow develop-issue runs in the work tree before a merge. A merge does not occur if the command fails. The setting has no default, and with no setting the merge occurs with no check.
  CLOVING_REQUIRED_CHECKS          A JSON list of required check run names before a develop-issue merge. Unset requires all GitHub Actions checks; a repository with no CI can merge after 60 seconds. The latest run of each name decides. The CI wait limit is 90 minutes.
  CLOVING_PRIVATE_TEXTS            A JSON list of texts that the workflow develop-issue does not push in a file or in a commit message. The workflow develop-prd requires the list before posting an issue. The list adds to the path of the home folder, and the case of the letters does not matter. The setting has no default.
`,
};

export const usage = `Usage: cloving [--help] [--version]
       cloving workflows list [--json] [--repository <directory>]
       cloving workflows test [<id>] [--repository <directory>]
       cloving workflows validate <manifest-path> [--input <json-file>] [--json]
       cloving <command> [--help]

Commands:
  workflows list      List bundled, project and user workflows and refusal codes.
  workflows test      Run project and user workflow tests without a service.
  workflows validate  Check a compiled workflow manifest, its artifacts and optional runtime input.
  run        Submit one run of an admitted workflow.
  status     List the runs or show one run.
  report     Report loop facts and seven-day baselines.
  questions  List the pending decisions.
  answer     Answer one design question.
  approve    Approve one pending approval.
  deny       Deny one pending approval.
  pause      Stop new dispatch for a run.
  resume     Resume a paused run.
  drop       Cancel a run and keep its files.
  events     Print the committed events.
  watch      Serve a page that shows the runs live.
  phone      Show, list, remove and reset the connected phones.
  config     Read and change repository settings.
  start      Start the service for a repository.

The runtime commands need a Cloving service. They use the current git repository; --repository <directory> selects another repository. CLOVING_RUNTIME_DIR overrides its runtime directory.
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

export const phoneUsage = `Usage: cloving phone status [--json]
       cloving phone list [--json]
       cloving phone remove <device-id> [--json]
       cloving phone reset [--json]

Shows and changes the phones that answer the questions of this computer.
status shows the registration with cloving.ai and the number of phones.
list shows each phone with its device ID, name, platform, state and pairing time.
remove marks one phone removed on this computer, then asks cloving.ai to remove it. A failure at cloving.ai keeps the phone removed and shows a warning.
reset removes the registration with cloving.ai, marks all phones removed and deletes phone/link.json and phone/daemon-keys.json.
Connect a phone with the Connect a phone button of the watch page.
cloving start runs the phone relay as a child process. With CLOVING_PHONE_RELAY=off, the relay does not start, and status says that the relay is off or not started.
`;
