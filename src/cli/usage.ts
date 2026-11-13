import { startUsage } from "./usage-start.ts";

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
cloving reload applies changes of profiles, fallbackModels, tokenPrices, workflows.folder, queue.lanes, queue.workingLanes, queue.maxLoadPerCore, queue.maxMemoryPressure and effects.reserved. It also applies the lanes and workingLanes of each workflow in queues. Other changes require a service restart.
`;

export const commandUsage: Readonly<Record<string, string>> = {
  mcp: `Usage: cloving mcp [--repository <directory>] [--channel]
       cloving mcp --workspace [--channel]
       cloving mcp --connection <name> [--state-dir <directory>]

Serves cloving_status, cloving_questions and cloving_events as read tools over stdio.
Serves cloving_run, cloving_answer, cloving_approve, cloving_deny, cloving_pause,
cloving_resume, cloving_drop, cloving_continue, cloving_dismiss, cloving_steer and cloving_rename to submit runs, decisions,
notes and names. Each of these tools
needs a commandId. After a lost reply, send the same commandId again.
The server binds to one repository at startup. It needs an existing Cloving service.
With --workspace, one server serves each repository of the running workspace.
It adds the read tool cloving_repositories, which lists the repositories, and
a repository argument with the workspace names to each tool. A tool that
changes state needs the repository argument when the workspace lists more than
one repository. A read tool with no repository argument reads each repository.
Standard output contains only JSON-RPC messages. Diagnostics use standard error.
--channel tells a connected Claude Code session when a run needs you: a pending
decision, a paused run, a failed or blocked run, or a stopped schedule.
With --workspace, each channel message names its repository.
--connection launches the encrypted remote bridge from the Cloving relay integration package.
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
  init: `Usage: cloving init [--harness <name or path>] [--local | --factory] [--repository <directory>]

On a terminal, asks you to try one task locally or to build your factory. With no terminal, the command builds the factory.
--local copies develop with the first-run choices and does not start an agent. --factory starts the setup agent with the message "run \`cloving init-prompt\`".
Choose an installed harness at the terminal, or pass --harness to skip the question.
A name must have exactly one usable entry; shell:<name> selects a shell function or alias.
The selection is saved in private settings. A factory returns the agent's exit status.
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
  queue: `Usage: cloving queue [--workflow <id>] [--json]
       cloving queue resume [--workflow <id>] [--command-id <id>] [--json]
       cloving queue drain [--workflow <id>] [--command-id <id>] [--json]
       cloving queue lanes <n> --workflow <id> [--command-id <id>] [--json]

Shows the state of the queue: running, stopped, draining or drained, with the busy lanes. With several queues, --workflow <id> is required. With one queue, it is optional.
lanes writes 1 to 16 lanes to the private queues setting and applies it now. Fewer lanes keep runs in work.
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
       cloving schedule run <workflowId> [--command-id <id>] [--json]

Lists interval schedules and their state. Pause stops new runs; an active run continues.
Three consecutive failed or blocked scheduled runs stop a schedule.
Resume clears failures and starts the next run one interval later.
Paused and stopped schedules survive a service restart.
Run admits one manual run with the input of the schedule, marked manual from loop.
It does not change the next run. While a run of the workflow is active, the service
refuses it with run-active.
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
  steer: `Usage: cloving steer <run-id> --text <note> [--now] [--command-id <id>] [--json]

Records a note of 1 to 4000 characters for an active run. The next agent turn of the run gets the note.
With --now, a Claude Code or Codex turn in work that recorded a session stops and resumes the same session
with the note as the next message. A turn takes at most three such notes. In other cases the reply says
queued with the reason, and the note waits for the next turn.
`,
  rename: `Usage: cloving rename <run-id> (--title <text> [--label <text>] | --clear) [--command-id <id>] [--json]

Gives an active or ended run a manual title of 1 to 200 characters on one line, and with --label a label of
1 to 32 letters, digits or the characters # ! . _ / -. The watch page, cloving status and the read API show it.
--clear removes the manual name, and the run gets its automatic name again. The rename is an event of the run,
so it stays after a restart. The newest rename wins. It does not change the pull request or the ticket.
`,
  events: `Usage: cloving events [<run-id>] [--after <sequence>] [--limit <n>] [--follow] [--json]

Prints the committed events after a sequence. With --json, each line is one event.
`,
  reload: `Usage: cloving reload [--json]

Checks and compiles the workflow files again while the service runs.
New runs use the new bundle. A run that started before the reload stays on the bundle of its pin.
A new refusal of a workflow file keeps the current workflows and shows the reason.
A change of the queue workflow, of its declared interval or of a schedule needs a restart.
It also reads the settings files and the profiles file again, and applies changes of profiles, fallbackModels, tokenPrices, workflows.folder, queue.lanes, queue.workingLanes, queue.maxLoadPerCore, queue.maxMemoryPressure and effects.reserved.
It applies the lanes and workingLanes of each workflow in queues. A change of state or everySeconds in queues needs a restart.
New turns use the new values. A turn in work keeps the values of its start.
The reply lists each other changed field as a field that needs a restart. The service keeps its old value.
An invalid settings file, an invalid profiles file or a profile harness with no worker at the start refuses the reload. Then nothing changes.
`,
  restart: `Usage: cloving restart [--at keep|gap|now] [--within <duration>] [--resume-queue] [--settings environment|files] [--set <key>=<value>]... [--update] [--command-id <id>] [--json]
       cloving restart --cancel [--command-id <id>] [--json]

Restarts the service that cloving start runs, with the settings files and the product files of the new start.
--at keep is the default. It restarts at once when each open turn can keep running through the restart.
It waits for each turn that cannot keep running, each open command and each queue submission.
--at gap waits for the next gap: no run that has not ended, no open turn and no queue submission.
--within limits the wait, for example 30m or 6h. The default is 12h. At the deadline, the restart is cancelled.
While the restart waits, the queue admits no new run. cloving status shows the pending restart.
--at now stops at once. A Claude turn keeps running, and a Codex turn resumes after the start.
A stale or missing dist builds first. A failed build starts nothing.
The restart stops the watch server and the relay first. A child that still runs after 60 seconds refuses the restart.
The start program replaces itself in the same terminal and starts the service again.
The command waits up to 180 seconds for the new service. It prints the commits, the lanes and each workflow.
A refused queue workflow or scheduled workflow gives exit status 1.
Control-C stops the wait and keeps the restart pending. --cancel cancels a pending restart.
The restart keeps a drain of the queue and its failure count.
--resume-queue clears the drain at the new start and keeps the failure count. cloving start --reset-queue clears both.
--settings files starts without the CLOVING_* variables that the settings files can set. The files and the defaults decide.
--set <key>=<value> sets the CLOVING_* variable of a settings file key in the new start. Give it one time for each key.
For harness.command, it sets the command variable of the worker of the service, or of the --set harness.name worker.
The command checks each value as cloving config set does. An unknown key or an invalid value refuses the restart. The value applies after --settings files, and later restarts of this cloving start keep it.
--update updates the product checkout after the stop. Local changes skip the update.
The update fetches the default branch and needs a fast-forward.
It runs npm ci --ignore-scripts when package-lock.json changed, and then npm run build.
When a step fails, the checkout goes back to the old commit and the service starts on it. The command exits with status 1.
While a workspace runs, cloving restart with no --repository restarts all repositories at once,
and each one keeps its turns running. With --at gap, it restarts them at a common gap.
The workspace supervisor then holds the queue runs of all repositories, waits until no repository has work,
and then restarts each repository at once. --at now does not wait for the gap.
A workspace restart has no --update, --cancel, --within or --set; use --repository <name> to restart one repository.
`,
  watch: `Usage: cloving watch [--port <n>] [--workspace]

Serves a page on http://127.0.0.1:<port>/ that shows the runs live: the state,
the events, the work of the worker and each pending decision.
The default port is 3663. The page is read only. Stop it with Control-C.
With --workspace, the page reads each repository of the running workspace and
shows one group of lines for each repository. A workspace start serves this
page itself.
`,
  start: startUsage,
};

export const usage = `Usage: cloving [--help] [--version]
       cloving workflows list [--json] [--repository <directory>]
       cloving workflows test [<id>] [--repository <directory>]
       cloving workflows validate <manifest-path> [--input <json-file>] [--json]
       cloving init [--harness <name or path>] [--local | --factory] [--repository <directory>]
       cloving init-prompt [--repository <directory>]
       cloving templates list [--json]
       cloving templates show <name> [--json]
       cloving templates copy <name> [--id <workflow-id>] [--json] [--repository <directory>]
       cloving templates apply-local [--repository <directory>]
       cloving themes list [--json] [--repository <directory>]
       cloving integrations <command> mcp [options]
       cloving red-green
       cloving <command> [--help]

Commands:
  workflows list      List project and user workflows and refusal codes.
  workflows test      Run project and user workflow tests without a service.
  workflows validate  Check a compiled workflow manifest, its artifacts and optional runtime input.
  templates list      List the workflow templates of the package.
  templates show      Show the decision points and the files of one template.
  templates copy      Copy one template into .cloving/workflows of the repository.
  templates apply-local  Copy develop with the first-run choices.
  themes list         List the themes of the watch page and their refusal codes.
  integrations        Connect and manage encrypted MCP access.
  red-green  Check assertion failure on the base and success on the head.
  init             Try one local task or start the setup agent
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
  steer      Send a note to a run in work.
  rename     Give a run a new title and label.
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
