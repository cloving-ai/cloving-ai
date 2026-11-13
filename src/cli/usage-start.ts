import { harnessEnvironmentUsage } from "./usage-harnesses.ts";

export const startUsage = `Usage: cloving start [--repository <directory> | --workspace] [--reset-queue]

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
  CLOVING_READY_COMMAND            A JSON list of a command and its arguments. Requires CLOVING_QUEUE_SECONDS or a declared queue workflow. When the queue starts, and one queue interval after each run ends, the command runs with no added argument and prints a JSON list of the ready tickets. Queue checks do not wait for it. Each item is an object with an id and a readyAt UTC time, such as 2026-11-03T07:30:00Z. The watch page shows the count of ready tickets that are not in work and do not wait for a dependency, and the oldest wait. The setting has no default.
  CLOVING_QUEUE_SECONDS            A whole number from 10 to 3600 seconds between checks for a declared workflow with queue: true or a queue object. It overrides the everySeconds of the declaration, and queues.<workflow>.everySeconds overrides it. Unset means the declared value or 120. A declared queue starts when CLOVING_NEXT_COMMAND and CLOVING_TICKET_COMMAND are set; with this setting, the start requires both. With no queue workflow, there is no queue. The queue stops after three runs in a row without a successful handoff; manual submissions to that workflow are refused with workflow-active when all lanes are busy.
  CLOVING_QUEUES                   A JSON object mapping a workflow ID to {state, everySeconds, lanes, workingLanes}. The state is on or off; off stops the start of that queue. everySeconds (10 to 3600), lanes (1 to 16) and workingLanes override CLOVING_QUEUE_SECONDS, CLOVING_QUEUE_LANES, CLOVING_QUEUE_WORKING_LANES and the declaration. cloving reload applies lanes and workingLanes. Unset keeps the other values.
  CLOVING_QUEUE_LANES              A whole number from 1 to 16; the default is 1, or the lanes of the declaration. queues.<workflow>.lanes overrides it. Requires CLOVING_QUEUE_SECONDS or a declared queue workflow. Active tickets are refused with ticket-active. Needs #N sentences in the ticket's ## Dependencies section refuse admission with ticket-dependency-open while issue #N is open. cloving reload applies a change; fewer lanes stop new starts and do not stop active runs.
  CLOVING_QUEUE_WORKING_LANES      A whole number from 1 to 16 and not more than CLOVING_QUEUE_LANES. It limits the queue runs in which a turn or a command runs; a run that waits for CI, a review or a person holds a lane but not a working lane. The default is CLOVING_QUEUE_LANES. Requires CLOVING_QUEUE_SECONDS or a declared queue workflow. cloving reload applies a change.
  CLOVING_EFFECT_RESERVED          A whole number from 0 to 8; the default is 2. The broker keeps this count of effect leases for runs that are not queue runs. The effect capacity is CLOVING_QUEUE_LANES plus this reserve, and queue runs together hold at most CLOVING_QUEUE_LANES leases. Other values stop the start with invalid-effect-settings. cloving reload applies a change.
  CLOVING_QUEUE_MAX_LOAD_PER_CORE  A number from 0.1 to 4; the default is 0.7. The queue starts a run only when the 1-minute load average divided by the available cores is below this limit. Requires CLOVING_QUEUE_SECONDS or a declared queue workflow. cloving reload applies a change.
  CLOVING_QUEUE_MAX_MEMORY_PRESSURE normal or warn; the default is normal. The queue starts a run only when the memory pressure is at or below this level: on macOS from sysctl kern.memorystatus_vm_pressure_level, on Linux from MemAvailable of /proc/meminfo (warn below 20 percent, critical below 10 percent). Requires CLOVING_QUEUE_SECONDS or a declared queue workflow. cloving reload applies a change.
  CLOVING_QUEUE_DAILY_SPEND_USD    A positive finite USD number. Requires CLOVING_QUEUE_SECONDS or a declared queue workflow, unless CLOVING_SPEND_SCOPE is all. Holds new queue runs at 85 percent of the limit in the last 24 hours; active runs continue. Unset adds no spend limit.
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
  CLOVING_TURN_COMMIT_SIGNATURES   keep or off. The default is keep. With off, Cloving adds commit.gpgsign=false and tag.gpgsign=false to the git configuration of each turn, so a turn commits and tags with no signature. The private setting turns.commitSignatures sets it.
  CLOVING_PROFILES                 The path of a JSON file of operator-defined Claude turn profiles, read at start and at each cloving reload. A relative path starts at the folder of cloving start. The setting has no default.
  CLOVING_COMMANDS                A JSON object mapping names to argument arrays with an absolute executable path. Invalid values refuse startup with invalid-commands. Unset means no commands. Command execution is not available yet.
  CLOVING_COMMAND_SECONDS         A whole number from 1 to 3600 seconds; the default is 60. Invalid values refuse startup with invalid-command-seconds. Reserved for command execution.
  CLOVING_TOKEN_PRICES             A JSON object from model names to input, cachedInput and output USD prices per million tokens for estimates; entries override matching built-in prices.
  CLOVING_FALLBACK_MODELS          A JSON array of at most three nonempty model names; the default is no fallback. After capacity refusals the first retry keeps the main model and the third attempt uses the first fallback, with the same waits and attempt limit. Requires an explicit -m, --model or --model= argument. A fallback can have a higher price.
${harnessEnvironmentUsage}
  CLOVING_WATCH_REPOSITORY         The service repository context for the watch board, set by start from --repository. Its local origin supplies the GitHub identity. There is no current-directory default.
  CLOVING_WATCH_ACTIONS            The value off removes the board run form, the queue control, the loop controls, the run controls and their write endpoints. The default is on.
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
`;
