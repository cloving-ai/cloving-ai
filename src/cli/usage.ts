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
Private files, backups and temporary files have mode 0600.
cloving reload applies changes of profiles, fallbackModels, tokenPrices, workflows.folder, queue.lanes, queue.workingLanes, queue.maxLoadPerCore, queue.maxMemoryPressure and effects.reserved. Other changes require a service restart.
`;

export const commandUsage: Readonly<Record<string, string>> = {
  mcp: `Usage: cloving mcp [--repository <directory>]
       cloving mcp --workspace
       cloving mcp --connection <name> [--state-dir <directory>]

Serves cloving_status, cloving_questions and cloving_events as read tools over stdio.
Serves cloving_run, cloving_answer, cloving_approve, cloving_deny, cloving_pause,
cloving_resume, cloving_drop, cloving_continue and cloving_dismiss to submit runs and decisions. Each of these tools
needs a commandId. After a lost reply, send the same commandId again.
The server binds to one repository at startup. It needs an existing Cloving service.
With --workspace, one server serves each repository of the running workspace.
It adds the read tool cloving_repositories, which lists the repositories, and
a repository argument with the workspace names to each tool. A tool that
changes state needs the repository argument when the workspace lists more than
one repository. A read tool with no repository argument reads each repository.
Standard output contains only JSON-RPC messages. Diagnostics use standard error.
--connection launches the encrypted remote bridge from the cloving-zapier integration package.
Pair the harness first with cloving integrations pair mcp --name <name>.
On the workflow computer, use cloving integrations connect mcp, approve mcp and serve mcp.
The remote bridge exposes only locally permitted workflows and tools. It does not need a local project.
`,
  "red-green": `Usage: cloving red-green

Reads {"head":"<full commit ID>"} on standard input. Uses CLOVING_RED_GREEN to run
the changed tests on the merge base with origin/HEAD and then on the head.
Prints one JSON verdict. Verdicts exit with 0; invalid input and git errors exit with 1.
Uses temporary detached worktrees. CLOVING_COMMAND_SECONDS bounds each prepare or test command.
`,
  init: `Usage: cloving init [--harness <name or path>] [--repository <directory>]

Starts the setup agent in the repository with the message "run \`cloving init-prompt\`".
Choose an installed harness at the terminal, or pass --harness to skip the question.
A name must have exactly one usable entry; shell:<name> selects a shell function or alias.
The selection is saved in private settings. The command returns the agent's exit status.
`,
  "init-prompt": `Usage: cloving init-prompt [--repository <directory>]

Prints facts, rules and setup steps for an agent. Does not change settings, call a model or control the service.
`,
  themes: `Usage: cloving themes list [--json] [--repository <directory>]

Lists the themes of the watch page. Cloving finds themes in three places:
the built-in themes of the package, <config>/cloving/themes/<name> and .cloving/themes/<name> in the repository.
A project theme replaces a user theme of the same name. A user theme replaces a built-in theme.
Each line shows the name, the place, usable or the refusal codes, the replaced places and the name in theme.json.
A theme with a refusal code is not usable. --json prints the same data as one JSON list.
The private setting watch.theme selects a theme by its name, or auto. The default is auto.
cloving doctor reports a selected theme that is missing or refused.
`,
  doctor: `Usage: cloving doctor [--json] [--repository <directory>]

Checks repository requirements without repairs, model turns or GitHub writes.
Required failures or skipped prerequisites exit with status 1.
`,
  queue: `Usage: cloving queue [--json]
       cloving queue resume [--command-id <id>] [--json]
       cloving queue drain [--command-id <id>] [--json]

Shows the state of the queue: running, stopped, draining or drained, with the busy lanes.
A stopped queue shows the reason and the failed runs in a row.
resume sets the failure count to 0 and ends a stop or a drain. The next queue check can start a run.
drain starts no new queue run. The runs in work continue to their end.
When no lane is busy, the queue records the drain time, writes "Queue drained" one time and shows drained.
A drained queue is a safe point for a restart. A drain stays in place after a restart.
The queue keeps the newest 32 command IDs. A repeated kept ID does not apply the command again.
The reply shows the current state. A different command with a kept ID is refused.
`,
  report: `Usage: cloving report [--since <hours>] [--json]

Reads loop facts without writing state. Hours are a whole number from 1 to 168; default 24.
Reports run outcomes, throughput and ended-run costs with seven-day medians and MAD bands.
Unsupported facts and unreadable sources are unavailable.
`,
  run: `Usage: cloving run <workflow-id> (--prompt <text> | --ticket <id> | --next | --input <json-file>) [--command-id <id>] [--json]
       cloving run continue <run-id> [--from <phase>/<operation>[/<round>]] [--bundle current] [--note <text>] [--command-id <id>] [--json]

Submits one run of an admitted workflow. Use exactly one input source.
With --ticket, the daemon reads the ticket at admission. A declared ticket field receives { id, text } inside input.
With --next (the same as --ticket next), ticket workflows select a ready ticket through CLOVING_NEXT_COMMAND.
Success means a committed receipt. It does not mean completed work.
Continue admits a new run for a failed run, or for a run that completed blocked.
The new run keeps the cycle, the branch, the work tree and the pull request of the old run.
It reuses the completed effects before the failed step, or before the first visit of the --from step.
It uses the kept workflow bundle of the old run, or the current workflow with --bundle current.
With --note, the first agent turn that the new run starts gets the note under "Notes from the operator:".
A note has 1 to 4000 characters after the spaces at its start and end are removed.
`,
  status: `Usage: cloving status [<run-id>] [--active] [--limit <n>] [--after <cursor>] [--json]

Lists the runs, or shows one run with its reason, evidence and next action.
With --active, lists only the runs that are not completed, failed or cancelled.
While a workspace runs, cloving status with no run ID shows one summary line for
each repository: the service state, the active runs and the pending decisions.
Use --repository <name> to show the runs of one repository.
`,
  schedule: `Usage: cloving schedule [--json]
       cloving schedule pause <workflowId> [--json]
       cloving schedule resume <workflowId> [--json]

Lists interval schedules and their state. Pause stops new runs; an active run continues.
Three consecutive failed or blocked scheduled runs stop a schedule.
Resume clears failures and starts the next run one interval later.
Paused and stopped schedules survive a service restart.
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
  dismiss: `Usage: cloving dismiss <run-id> [--command-id <id>] [--json]

Records a dismissal of a run that ended failed or blocked. Needs you on the watch page does not list the run.
The dismissal is an event of the run and stays after a restart. It does not change the run or its files.
`,
  events: `Usage: cloving events [<run-id>] [--after <sequence>] [--limit <n>] [--follow] [--json]

Prints the committed events after a sequence. With --json, each line is one event.
`,
  reload: `Usage: cloving reload [--json]

Checks and compiles the workflow files again while the service runs.
New runs use the new bundle. A run that started before the reload stays on the bundle of its pin.
A new refusal of a workflow file keeps the current workflows and shows the reason.
A change of the queue workflow or of a schedule needs a restart.
It also reads the settings files and the profiles file again, and applies changes of profiles, fallbackModels, tokenPrices, workflows.folder, queue.lanes, queue.workingLanes, queue.maxLoadPerCore, queue.maxMemoryPressure and effects.reserved.
New turns use the new values. A turn in work keeps the values of its start.
The reply lists each other changed field as a field that needs a restart. The service keeps its old value.
An invalid settings file, an invalid profiles file or a profile harness with no worker at the start refuses the reload. Then nothing changes.
`,
  restart: `Usage: cloving restart [--at gap|now] [--within <duration>] [--resume-queue] [--settings environment|files] [--update] [--command-id <id>] [--json]
       cloving restart --cancel [--command-id <id>] [--json]

Restarts the service that cloving start runs, with the settings files and the product files of the new start.
--at gap waits for the next gap: no run that has not ended, no open turn and no queue submission. It is the default.
--within limits the wait for a gap, for example 30m or 6h. The default is 12h. At the deadline, the restart is cancelled.
While the restart waits, the queue admits no new run. cloving status shows the pending restart.
--at now stops at once. Claude and Codex turns resume after the start.
A stale or missing dist builds first. A failed build starts nothing.
The restart stops the watch server and the relay first. A child that still runs after 60 seconds refuses the restart.
The start program replaces itself in the same terminal and starts the service again.
The command waits up to 180 seconds for the new service. It prints the commits, the lanes and each workflow.
A refused queue workflow or scheduled workflow gives exit status 1.
Control-C stops the wait and keeps the restart pending. --cancel cancels a pending restart.
The restart keeps a drain of the queue and its failure count.
--resume-queue clears the drain at the new start and keeps the failure count. cloving start --reset-queue clears both.
--settings files starts without the CLOVING_* variables that the settings files can set. The files and the defaults decide.
--update updates the product checkout after the stop. Local changes skip the update.
The update fetches the default branch and needs a fast-forward.
It runs npm ci --ignore-scripts when package-lock.json changed, and then npm run build.
When a step fails, the checkout goes back to the old commit and the service starts on it. The command exits with status 1.
While a workspace runs, cloving restart with no --repository restarts all repositories at a common gap.
The workspace supervisor holds the queue runs of all repositories, waits until no repository has work,
and then restarts each repository at once. --at now does not wait for the gap.
A workspace restart has no --update, --cancel or --within; use --repository <name> to restart one repository.
`,
  watch: `Usage: cloving watch [--port <n>] [--workspace]

Serves a page on http://127.0.0.1:<port>/ that shows the runs live: the state,
the events, the work of the worker and each pending decision.
The default port is 3663. The page is read only. Stop it with Control-C.
With --workspace, the page reads each repository of the running workspace and
shows one group of lines for each repository. A workspace start serves this
page itself.
`,
  start: `Usage: cloving start [--repository <directory> | --workspace] [--reset-queue]

Starts the Cloving service for one git repository, with the workflow host,
the worker and the watch page. The default repository is the current
directory.
Stop it with Control-C.

With --workspace, one start serves each repository of the workspace file
<config>/cloving/workspace.json, for example
{"version": 1, "repositories": [{"path": "/work/app", "name": "app"}]}.
Each repository needs an absolute path. The optional name has 1 to 64
letters, digits, dots, dashes or underscores; the default is the last part of
the path. Each repository gets its own daemon, runtime directory and settings,
as with one start, and no watch page of its own. The start serves one watch
page for all repositories on the watch port. While the workspace runs,
cloving status lists each repository, and --repository <name> selects one.
Control-C stops all repositories. When one repository stops with an error,
Cloving stops the other repositories. The optional workspace fields lanes
(1 to 64) and dailySpendLimitUsd (above 0) limit the queue runs of all
repositories: a queue asks the supervisor before it starts a run, and the
supervisor holds the run when the active queue runs fill the lanes or the
spend of the last 24 hours is at 85 percent of the limit.

The queue continues after unsuccessful runs and stops after three runs in a row
without a successful handoff. A successful handoff resets the count; ordinary restarts preserve the count.
Inspect the failures and reconcile affected issues. To clear the failure streak with no restart, run cloving queue resume.
Stop the service and start with --reset-queue and the same queue settings to clear the failure streak once at a restart; --reset-queue also ends a drain. Tracked commands are preserved.

The command reads these settings from the environment:
Settings files: .cloving/config.json in the repository and <config>/cloving/projects/<name>-<id>.json for private settings. Both require version 1. Precedence: environment, private, project, defaults. <config> is an absolute XDG_CONFIG_HOME or ~/.config. The start guide shows each configured field's source. See the packaged project-config.schema.json and private-config.schema.json in dist/src.

  CLOVING_RUNTIME_DIR              The path of the runtime directory. The default is ~/.local/state/cloving/<name>-<id>/run, if XDG_RUNTIME_DIR and XDG_STATE_HOME are not set. A recorded legacy adoption takes priority.
  CLOVING_TICKET_COMMAND           A JSON list of a command and its arguments. The command gets a ticket ID as its last argument and prints the ticket. The setting has no default, and a run with --ticket needs it.
  CLOVING_NOTIFY_COMMAND           A JSON list of a command and its arguments. Every 15 seconds, new decisions, blocked runs, failed runs and stopped schedules send JSON on standard input with no added argument. The setting has no default.
  CLOVING_NEXT_COMMAND             A JSON list of a command and its arguments. The command runs with no added argument and prints one ready ticket ID for --next. It must exclude the space-separated ticket IDs in CLOVING_SKIP_TICKETS. The setting has no default.
  CLOVING_READY_COMMAND            A JSON list of a command and its arguments. Requires CLOVING_QUEUE_SECONDS. When the queue starts, and one queue interval after each run ends, the command runs with no added argument and prints a JSON list of the ready tickets. Queue checks do not wait for it. Each item is an object with an id and a readyAt UTC time, such as 2026-11-03T07:30:00Z. The watch page shows the count of ready tickets that are not in work and do not wait for a dependency, and the oldest wait. The setting has no default.
  CLOVING_QUEUE_SECONDS            A whole number from 10 to 3600 seconds between checks for a declared workflow with queue: true; requires CLOVING_NEXT_COMMAND and CLOVING_TICKET_COMMAND when that workflow exists. Unset or no queue workflow means no queue. The queue stops after three runs in a row without a successful handoff; manual submissions to that workflow are refused with workflow-active when all lanes are busy.
  CLOVING_QUEUE_LANES              A whole number from 1 to 16; the default is 1. Requires CLOVING_QUEUE_SECONDS. Active tickets are refused with ticket-active. Needs #N sentences in the ticket's ## Dependencies section refuse admission with ticket-dependency-open while issue #N is open. cloving reload applies a change; fewer lanes stop new starts and do not stop active runs.
  CLOVING_QUEUE_WORKING_LANES      A whole number from 1 to 16 and not more than CLOVING_QUEUE_LANES. It limits the queue runs in which a turn or a command runs; a run that waits for CI, a review or a person holds a lane but not a working lane. The default is CLOVING_QUEUE_LANES. Requires CLOVING_QUEUE_SECONDS. cloving reload applies a change.
  CLOVING_EFFECT_RESERVED          A whole number from 0 to 8; the default is 2. The broker keeps this count of effect leases for runs that are not queue runs. The effect capacity is CLOVING_QUEUE_LANES plus this reserve, and queue runs together hold at most CLOVING_QUEUE_LANES leases. Other values stop the start with invalid-effect-settings. cloving reload applies a change.
  CLOVING_QUEUE_MAX_LOAD_PER_CORE  A number from 0.1 to 4; the default is 0.7. The queue starts a run only when the 1-minute load average divided by the available cores is below this limit. Requires CLOVING_QUEUE_SECONDS. cloving reload applies a change.
  CLOVING_QUEUE_MAX_MEMORY_PRESSURE normal or warn; the default is normal. The queue starts a run only when the memory pressure is at or below this level: on macOS from sysctl kern.memorystatus_vm_pressure_level, on Linux from MemAvailable of /proc/meminfo (warn below 20 percent, critical below 10 percent). Requires CLOVING_QUEUE_SECONDS. cloving reload applies a change.
  CLOVING_QUEUE_DAILY_SPEND_USD    A positive finite USD number. Requires CLOVING_QUEUE_SECONDS, unless CLOVING_SPEND_SCOPE is all. Holds new queue runs at 85 percent of the limit in the last 24 hours; active runs continue. Unset adds no spend limit.
  CLOVING_SPEND_SCOPE              queue or all; the default is queue. The private or project setting spend.scope sets it. With all, the daily spend limit counts the turns of every workflow and holds the admission of every workflow, and the limit does not need CLOVING_QUEUE_SECONDS.
  CLOVING_LIMIT_EFFECTS            A whole number from 1 to 1000; the default is 100. The private or project setting limits.effects sets it. A declared workflow with an effectLimit above it is refused with effect-limit-above-maximum.
  CLOVING_LIMIT_CHAIN              A whole number from 2 to 50; the default is 5. The private or project setting limits.chain sets it. A declared chainLimit above it is refused with chain-limit-above-maximum.
  CLOVING_WORKFLOW_FOLDER          An absolute folder path; when set, it replaces the user workflow folder. The private setting workflows.folder sets it. The folder itself must not be a symbolic link.
  CLOVING_SCHEDULES                A JSON object mapping declared workflow IDs to {everySeconds, input} or {at, timeZone, weekdays, input}; replaces declaration schedules. Intervals are whole seconds from 60 to 2592000. A time is HH:MM in an IANA time zone, and weekdays is an optional list of day names. Unset keeps declaration schedules. Scheduled runs skip overlapping slots and retain their progress across restart.
  CLOVING_SELF_UPDATE_SECONDS      A whole number from 30 to 3600 seconds between checks of the own checkout; unset means no update. An update stops the daemon and restarts with new code. A change of package-lock.json needs the operator to update and install by hand.
  CLOVING_RETENTION_DAYS           A whole number of at least 1, or null. The default is 30. The daemon archives or deletes a journal or GitHub record folder of a completed, failed or cancelled run when the end of the run and the newest file of the folder are older than this count of days. It never touches the records of a run that is not finished. It also removes the work tree, the branch and the attachments folder of a run that ended failed or cancelled more than this count of days ago, when the branch has no open pull request. It also removes a workflow bundle when no unfinished run is pinned to it, it is not the current generation, and it was not current during this count of days. The value null keeps all records and workflow bundles. The daemon sweeps once at start, before the watch page starts, and then each hour, with at most 200 folders in each pass.
  CLOVING_RETENTION_ACTION         archive or delete. The default is archive. An archive keeps the relative path of the folder in the archive folder.
  CLOVING_RETENTION_ARCHIVE_FOLDER An absolute folder path, or null for <state>/archive. The folder can be on another volume. When the folder is not available, the sweep moves nothing, logs the reason and tries again in the next hour.
  CLOVING_DEMO_TOOL                The absolute path of the instruction file or folder of a demo tool. The private setting demo.tool sets it. The service does not read the tool; each turn gets it as CLOVING_DEMO_TOOL, and the demo option of the develop template reads it there.
  CLOVING_TURN_ENVIRONMENT         inherit, or a JSON list of variable names. The default is an empty list. A turn gets only the base variables (PATH, HOME, USER, LOGNAME, SHELL, TERM, TMPDIR, TZ, LANG, LC_ALL, LC_CTYPE and XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_CACHE_HOME, XDG_STATE_HOME), the login variables of its harness, the profile env and the listed variables. The value inherit gives a turn the whole environment except the GitHub tokens, as before; it stays for one release. The private setting turns.environment sets it.
  CLOVING_GROK_COMMAND             A JSON list of a command and its arguments for Grok. The default uses streaming-messages-json, --always-approve and -p; the turn text follows -p or --single as one argument, or is appended if neither flag is present.
  CLOVING_CLAUDE_COMMAND           A JSON list of a command and its arguments for the Claude worker. The default is the claude command with a limit of 5 USD for each turn.
  CLOVING_PROFILES                 The path of a JSON file of operator-defined Claude turn profiles, read at start and at each cloving reload. A relative path starts at the folder of cloving start. The setting has no default.
  CLOVING_COMMANDS                A JSON object mapping names to argument arrays with an absolute executable path. Invalid values refuse startup with invalid-commands. Unset means no commands. Command execution is not available yet.
  CLOVING_COMMAND_SECONDS         A whole number from 1 to 3600 seconds; the default is 60. Invalid values refuse startup with invalid-command-seconds. Reserved for command execution.
  CLOVING_TOKEN_PRICES             A JSON object from model names to input, cachedInput and output USD prices per million tokens for estimates; entries override matching built-in prices.
  CLOVING_FALLBACK_MODELS          A JSON array of at most three nonempty model names; the default is no fallback. After capacity refusals the first retry keeps the main model and the third attempt uses the first fallback, with the same waits and attempt limit. Requires an explicit -m, --model or --model= argument. A fallback can have a higher price.
  CLOVING_WORKER                   The worker for each turn: claude, codex, gemini, grok, cursor-agent or opencode. The default is claude. Other values stop the start with harness-no-worker.
  CLOVING_CODEX_COMMAND            A JSON list of a command and its arguments, used only when CLOVING_WORKER is codex; CLOVING_CLAUDE_COMMAND is then ignored. The default is codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -, with no sandbox and no approval prompts.
  CLOVING_GEMINI_COMMAND           A JSON list of a command and its arguments for the gemini worker. The default is gemini --output-format stream-json --approval-mode yolo; Cloving appends -p and the turn text; turn text of 64 KiB or more in UTF-8 goes through standard input instead. No approval prompts or capacity retries.
  CLOVING_OPENCODE_COMMAND         A JSON list of a command and its arguments for opencode. The default is opencode run --format json; the turn text is appended as one argument. OPENCODE_PERMISSION permits unattended tools.
  CLOVING_WATCH_REPOSITORY         The service repository context for the watch board, set by start from --repository. Its local origin supplies the GitHub identity. There is no current-directory default.
  CLOVING_WATCH_ACTIONS            The value off removes the board run form, the queue control and their write endpoints. The default is on.
  CLOVING_WATCH_PORT               The port number of the watch page. The value off starts no watch page. The default is 3663.
  CLOVING_PHONE_RELAY              The phone relay child, which connects phones through cloving.ai. The value off starts no phone relay. The default is on.
  CLOVING_RELAY_ORIGIN             The origin of the phone relay server. Only https origins are accepted. The default is https://cloving.ai.
  CLOVING_OWNERSHIP_LEASE_SECONDS  The time in seconds of the ownership lease of a started workflow step. The default is 15.
  CLOVING_WORKSPACE_PERMITS        The path of the permit socket of the workspace supervisor. A workspace start sets it for each repository; do not set it by hand. The queue asks the supervisor for a permit before each queue run.
  CLOVING_HOST_BOUND               The largest number of queue messages that the workflow host handles at one time, from 1 to 64. The default is 8.
  CLOVING_GH_COMMAND               A JSON list of a command and its arguments for the GitHub CLI, used by workflows for pull requests and issues. The watch board also uses it to read pull request status. The default is gh.
  CLOVING_CHECK_COMMAND            A JSON list of a command and its arguments that a workflow runs in the work tree before a merge. A merge does not occur if the command fails. The setting has no default, and with no setting the merge occurs with no check.
  CLOVING_RED_GREEN                A JSON object with test and testFiles, optional prepare, assertionPattern and skipPattern for cloving red-green. The project setting is checks.redGreen.
  CLOVING_REQUIRED_CHECKS          A JSON list of required check run names before a workflow merge. Unset requires all GitHub Actions checks; a repository with no CI can merge after 60 seconds. The latest run of each name decides. The CI wait limit is 90 minutes.
  CLOVING_MERGE_MODE               direct or queue. The default is direct. queue adds a reviewed pull request to the GitHub merge queue and waits for GitHub to merge it; the ruleset of the default branch needs the merge queue rule. The project setting is merge.mode.
  CLOVING_PRIVATE_TEXTS            A JSON list of texts that workflows do not push in a file or in a commit message. An issue-posting workflow can require the list. The list adds to the path of the home folder, and the case of the letters does not matter. The setting has no default.
`,
};

export const usage = `Usage: cloving [--help] [--version]
       cloving workflows list [--json] [--repository <directory>]
       cloving workflows test [<id>] [--repository <directory>]
       cloving workflows validate <manifest-path> [--input <json-file>] [--json]
       cloving init [--harness <name or path>] [--repository <directory>]
       cloving init-prompt [--repository <directory>]
       cloving templates list [--json]
       cloving templates show <name> [--json]
       cloving templates copy <name> [--id <workflow-id>] [--json] [--repository <directory>]
       cloving themes list [--json] [--repository <directory>]
       cloving integrations <command> <zapier|mcp> [options]
       cloving red-green
       cloving <command> [--help]

Commands:
  workflows list      List project and user workflows and refusal codes.
  workflows test      Run project and user workflow tests without a service.
  workflows validate  Check a compiled workflow manifest, its artifacts and optional runtime input.
  templates list      List the workflow templates of the package.
  templates show      Show the decision points and the files of one template.
  templates copy      Copy one template into .cloving/workflows of the repository.
  themes list         List the themes of the watch page and their refusal codes.
  integrations        Connect and manage encrypted Zapier and MCP access.
  red-green  Check assertion failure on the base and success on the head.
  init             Start the setup agent
  init-prompt Print setup instructions for an agent.
  doctor     Check repository requirements before starting or submitting work.
  run        Submit one run of an admitted workflow.
  status     List the runs or show one run.
  mcp        Serve the Cloving tools over stdio.
  schedule   List, pause and resume workflow schedules.
  queue      Show, resume and drain the queue.
  report     Report loop facts and seven-day baselines.
  questions  List the pending decisions.
  answer     Answer one design question.
  approve    Approve one pending approval.
  deny       Deny one pending approval.
  pause      Stop new dispatch for a run.
  resume     Resume a paused run.
  drop       Cancel a run and keep its files.
  dismiss    Remove a stopped run from Needs you.
  events     Print the committed events.
  watch      Serve a page that shows the runs live.
  reload     Check and compile the workflow files again.
  restart    Restart the service at the next gap or at once.
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
