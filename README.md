# Cloving

The world's easiest software factory.

Build a software factory with simple TypeScript for your project, and your project can build itself.

The end of vibe coding. This is agentic engineering.

A workflow file in TypeScript is the factory. It sets the steps: a worker turn in a work tree, a pull request, a review and a merge. Cloving keeps the state of each run and a record of each step. A GitHub step continues after a restart of the service. A worker turn in work stops at a restart. Cloving builds itself through `develop-issue` in this repository.

## Cloving

Cloving is a local durable development workflow service in TypeScript. You give it a ticket or the text of a task. A Claude Code worker does the work on a new git branch in its own work tree. Then you, or a review on GitHub, decide about the work. The service records each run, each event and each decision on your computer.

This pre-release has one supervised slice: a service for one git repository, a workflow host, a Claude Code worker, a GitHub worker and review rounds. `cloving --help` lists the commands.

What works now:

- `cloving start` starts the service for one git repository, with the workflow host, the Claude worker and a watch page.
- Three workflows from one workflow file: `develop-prompt`, `develop-ticket` and `develop-issue`.
- `cloving start` loads the bundled `workflows/`, repository `.cloving/workflows/` and user `cloving/workflows/` folders (see "Develop a workflow").
- In a run of `develop-ticket` or `develop-prompt`, the operator approves or denies the work of each round. A run has a maximum of three rounds.
- In a run of `develop-issue`, Greptile reviews the pull request. The GitHub worker merges the pull request at the confidence score 5/5, with no human approval.
- Cloving develops itself through `develop-issue`, with a Greptile review and an automatic merge.
- The watch page shows the runs, the events and the work of the Claude worker as it occurs.

What does not work yet:

- The Claude worker is not confined. It runs as the current user.
- An approval does not merge the branch. You merge the branch yourself.
- Cloving cannot make a workflow from your earlier chats yet. The issues [#42](https://github.com/cloving-ai/cloving-ai/issues/42), [#43](https://github.com/cloving-ai/cloving-ai/issues/43) and [#44](https://github.com/cloving-ai/cloving-ai/issues/44) are open for this work. Until then, the prompt "Find workflows in your chats" is a guide for a coding agent.

## Install

Cloving supports macOS and Linux on arm64 and x64, with the Node and npm ranges in `package.json`. Workflow admission still requires exactly Node 26.9.0. CI runs the developer gate and packed-install checks on macOS 15 arm64 and Ubuntu 24.04 x64 with Node 26.9.0 and npm 11.19.1. Windows is unsupported.

A run needs these tools:

- `git`.
- The `claude` command of Claude Code on the search path. The Claude worker runs it as the current user.
- For `develop-issue` only: the `gh` command with a login, and a GitHub repository that Greptile reviews. The worker uses the `gh` login and the git credentials of the current user.

Install the executable from npm:

```sh
npm install --global cloving --ignore-scripts
cloving --version
```

This package replaces the older Cloving CLI under the same npm name. The installed package includes startup, the watch command, bundled workflows and the SDK compiler integration. It starts without a source checkout or development dependencies, using the installed runtime dependencies. Installation runs no scripts and starts no service.

For checkout development, get the code and install the dependencies:

```sh
git clone https://github.com/cloving-ai/cloving-ai.git ~/cloving
cd ~/cloving
npm ci --ignore-scripts
```

The runtime dependencies include the Workflow SDK (`workflow`), its directive compiler (`@workflow/builders`), Solid Objects (`solid-objects`), Entities (`entities`) and Preact (`preact`), which the watch page loads. Startup runs the SDK compiler to transform workflow and step directives. Development dependencies are needed to build the package, but an installed tarball runs without them.

### The `cloving` command

For checkout development, put a launcher for `src/cli.ts` in a directory of the search path. The launcher must use exactly Node 26.9.0. This example is for a checkout in `~/cloving` and a launcher in `~/.local/bin`:

```sh
mkdir -p ~/.local/bin
cat > ~/.local/bin/cloving <<'EOF'
#!/bin/sh
exec node "$HOME/cloving/src/cli.ts" "$@"
EOF
chmod +x ~/.local/bin/cloving
cloving --version
```

If the `node` program of the search path has a different version, write the full path of the correct `node` program in the launcher.

To install a built tarball, build and pack it in the checkout:

```sh
npm run build
npm pack --ignore-scripts
```

Then install the resulting tarball in your project using its absolute location:

```sh
npm install --ignore-scripts --omit=dev /path/to/TARBALL
./node_modules/.bin/cloving --help
./node_modules/.bin/cloving start
```

The installed executable includes JavaScript for startup, the watch command and bundled workflows. It uses the installed runtime dependencies, including the SDK compiler, without a source checkout. Runtime state and generated workflow artifacts use the configured runtime location outside the installation. Installation scripts are unnecessary. The checkout launcher above remains supported, including its existing checkout self-update behavior; installing a tarball does not add package self-updates.

For a project-local tarball installation, use `./node_modules/.bin/cloving` wherever the examples below say `cloving`, or add your project's `node_modules/.bin` to the search path. After a build, `npm link` also supplies the executable.

### Repository settings

`cloving start` reads `.cloving/config.json` in the selected repository and a private file at `<config>/cloving/projects/<name>-<id>.json`. The name and ID match the repository's runtime directory. `<config>` is an absolute `XDG_CONFIG_HOME`, or `~/.config` otherwise. Missing files keep the existing defaults. Restart after changing a file.

Each file requires `"version": 1`. Environment settings override private settings, which override project settings, which override built-in defaults. The start guide names each configured field's source: `environment`, `private` or `project`.

The project file supports `checks.beforeMerge`, `checks.required`, `tickets.command`, `tickets.nextCommand`, `queue.everySeconds` and `queue.lanes`. The private file supports these same fields plus `harness.name`, `harness.kind`, `harness.path`, `harness.command`, `profiles`, `fallbackModels`, `tokenPrices`, `privateTexts`, `notify.command`, `watch.port`, `watch.actions`, `selfUpdate.everySeconds` and `github.command`. Commands are arrays of arguments; seconds, lanes and ports are numbers. A watch port can also be `"off"`; watch actions are `"on"` or `"off"`.

For example, a shared `.cloving/config.json` can contain:

```json
{
  "version": 1,
  "checks": { "beforeMerge": ["npm", "test"] }
}
```

The private file can contain `{"version": 1, "privateTexts": ["acme"]}`. With `CLOVING_CHECK_COMMAND='["make", "check"]'`, the environment command takes priority. `harness.command` belongs to `harness.name`: `CLOVING_CLAUDE_COMMAND` overrides it for Claude, `CLOVING_CODEX_COMMAND` for Codex and `CLOVING_OPENCODE_COMMAND` for opencode. Without a saved command, `harness.path` replaces the program in that worker's default command. `harness.kind` accepts `file` or `shell`; shell harnesses run through `SHELL -l -i -c`, with command parts passed as separate arguments. `profiles` contains the profile map directly; `CLOVING_PROFILES` still selects a separate profiles file and overrides that map.

Read and change settings with the configuration commands:

```sh
cloving config list
cloving config get checks.beforeMerge --json
cloving config set checks.beforeMerge '["npm","test"]'
cloving config set privateTexts '["acme"]'
cloving config set queue.lanes 2 --private
cloving config unset queue.lanes --private
```

All four commands accept `--json` and `--repository <directory>`. Use the setting names listed above; `profiles` and `tokenPrices` are whole JSON maps, and dictionary subpaths are unknown settings. Values are parsed as JSON, falling back to text. Changes are validated before writing and go to the field's default file; `--private` writes an override in the private file. `list` and `get` show each value's source, including `default`, and all hidden file values. JSON results have `schemaVersion: 1`; list returns a `settings` array, get returns `field`, `value`, `source` and `hidden`. A default `null` means no configured value. Mutation results include `field`, `scope`, `action` and `notice`; notice is null when no service is running.

Each change holds a file lock from read through atomic replacement, keeping the previous bytes as `<file>.bak`. A first write needs no backup. Private files, backups and temporary files have mode 0600. Locks from stopped processes are reclaimed; a live lock waits at most ten seconds, then exits with `settings-locked`. Invalid settings and unknown fields exit with status 2 without changing a file. For a running service, the result explains whether to restart to use the new value or whether an environment or private source will keep hiding it after a restart. Settings do not reload automatically.

Changing or unsetting `harness.name` clears kind, path and command. Changing or unsetting kind clears path and command; changing or unsetting path clears command. This keeps the previous harness's configuration from carrying into a new selection.

The package includes [the project schema](src/project-config.schema.json) and [the private schema](src/private-config.schema.json), also installed under `dist/src/`. Unknown fields fail with `unknown-setting: <field>`, invalid values with `invalid-setting: <field>`, and unsupported or missing versions with `unsupported-config-version: version`. Private fields in the project file fail with `private-setting-in-project-file: <field>`. Files cannot set runtime directories, ownership leases, host bounds or the watch repository; those remain environment settings.

Run `cloving doctor` from the repository before starting the service. It lists each requirement with a fixed code, `ok`, `fail` or `skip`, and a fixing command. Required failures and skipped prerequisites exit with status 1. `cloving doctor --json` prints the same checks as `{ "version": 1, "checks": [...] }` for setup agents.

Doctor probes harness versions and effective executable paths without running a turn. Shell scripts and simple `node script` wrappers receive `--version` from the repository folder; unsupported launcher arguments fail the probe. GitHub login and reads use the origin's host, including GitHub Enterprise. GitHub calls are reads limited to ten seconds each; a service probe waits at most five seconds. Recent Greptile activity does not establish that a usable review is available, and missing activity does not prove the app is absent.

## First run

This first run uses `develop-prompt` on a test repository. It needs no ticket command and no GitHub repository.

1. Make a test repository with one commit:

   ```sh
   mkdir ~/cloving-trial
   cd ~/cloving-trial
   git init
   echo "A test project." > README.md
   git add README.md
   git commit -m "Start the test project"
   ```

2. In terminal 1, in the test repository, start the service. Keep this terminal open:

   ```sh
   cloving start
   ```

   `cloving start` copies the workflow file into a host project, compiles it there, and starts the service. Then it prints the commands for a second terminal.

3. Open the watch page on `http://127.0.0.1:3663/`.

4. In terminal 2, submit a run:

   ```sh
   cloving run develop-prompt --prompt "Add a file HELLO.md with one line of text."
   ```

   The command prints a committed receipt with the run ID. A receipt does not mean completed work.

5. The Claude worker does one Claude Code turn. Then the run opens one approval. Show the pending decisions:

   ```sh
   cloving questions
   ```

   The output has the approval text and the values that a decision command needs. The approval text has the round, the ticket ID, the branch, the commits, the changed files and the report of the worker.

6. Read the diff before you decide. In the test repository, `git diff HEAD...BRANCH` shows the work of the branch.

7. Approve or deny the work:

   ```sh
   cloving approve DECISION_REF --expected-revision N --generation N --subject-digest DIGEST
   cloving deny DECISION_REF --text "FEEDBACK" --expected-revision N --generation N --subject-digest DIGEST
   ```

   An approval completes the run. It does not merge the branch, so merge the branch yourself, for example with `git merge BRANCH`. A denial with a feedback text starts one more round.

8. `cloving status` lists the runs. `cloving status RUN_ID` shows one run with its reason, evidence and next action.

### The service and its settings

`cloving start` starts one Cloving service for the git repository of the current directory, with the workflow host, the Claude worker and the watch page. `--repository` selects a different repository. Stop the service with Control-C. A stop of the service stops a turn in work; submit that ticket again.

Each repository has its own default runtime directory: `<root>/cloving/<name>-<id>/run`. The root is `XDG_RUNTIME_DIR`, then `XDG_STATE_HOME`, then `~/.local/state`. The name keeps only letters, digits, `-` and `_` from the git top-level folder name, up to 24 characters. The ID is the first eight hexadecimal characters of the SHA-256 digest of that folder's real path. Commands in the repository find its service automatically; outside it, use `--repository <directory>` or `CLOVING_RUNTIME_DIR`. The start guide prints commands with the service repository already selected. `CLOVING_RUNTIME_DIR` overrides both the recorded adoption and the default for clients and start.

On start, Cloving keeps the old default runtime path only when all retained workflow bundles beside it validate for this repository. It records that choice under `<state>/cloving/adopted-runtime/<name>-<id>.json`, where state is `XDG_STATE_HOME` or `~/.local/state`. Clients reuse the record. With no bundles, foreign or mixed repositories, or damaged bundles, start uses the new default and prints a note with the old path. No state moves. The directory above the runtime directory still holds the authority state, Local World data, turn records and git work trees. Set a different `CLOVING_WATCH_PORT` for a second service.

`cloving watch` serves a local page on `http://127.0.0.1:3663/` (`--port` selects a different port). The page shows the runs, the events, the work of the Claude worker as it occurs, and each pending decision with its approve and deny commands. `cloving start` starts the page too; `CLOVING_WATCH_PORT` selects its port, and the value `off` starts none.

Each workflow board with supported inputs has **+ Add a card** at the bottom of its first column, including an empty board. It opens an inline form: **Issue number** for `develop-issue`, **Ticket ID** for `develop-ticket`, **Idea** for `develop-prd` and **Task** for `develop-prompt`. Declared workflows use the string fields in their bundled declaration. Unsupported inputs have no control. Select **Add card**, press Enter in a one-line field, or Command/Control+Enter in a text area to send. **Cancel** and Esc close the form. The service reply shows the admitted run ID or a refusal code; admitted cards arrive through the existing live stream. For `workflow-active`, add `cloving: ready` to the issue to queue it.

The form sends the same run request as the CLI and retains its random command ID for retries, including a lost reply. Retry the same form to avoid duplicate runs. The write endpoint accepts at most 16 KiB of JSON, requires the page's random token, matching Origin and a loopback/localhost Host with the bound port, and allows no cross-origin preflight. `CLOVING_WATCH_ACTIONS=off` removes both the form control and the endpoint; actions are enabled by default. The **Start a run** section remains available with prompts to copy into agents. Decisions and other run actions still use their displayed CLI commands.

`cloving start` reads its settings from the environment. `cloving start --help` gives the form and the default of each setting:

- `CLOVING_RUNTIME_DIR`: the runtime directory.
- `CLOVING_TICKET_COMMAND`: the ticket command (see "Daily development").
- `CLOVING_NOTIFY_COMMAND`: a JSON list naming a command to notify the operator about pending decisions, blocked runs and failed runs. It has no default.
- `CLOVING_NEXT_COMMAND`: a JSON list of a command and its arguments that prints the next ready ticket ID for `--next`. It has no default.
- `CLOVING_CLAUDE_COMMAND`: a replacement of the `claude` command of the worker.
- `CLOVING_PROFILES`: a JSON file of named turn profiles, read once when the service starts.
- `CLOVING_COMMANDS`: a JSON object mapping command names to argument arrays, such as `{"review-requests":["/opt/cloving/scan-reviews.mjs"]}`. Names contain 1–64 ASCII letters, digits or hyphens; the first argument must be an absolute executable path. Unset means no commands. Invalid values stop startup with `invalid-commands`.
- `CLOVING_COMMAND_SECONDS`: a whole number from 1 to 3600, default 60. Invalid values stop startup with `invalid-command-seconds`. A command exceeding the deadline fails with `command-timeout`.
- `CLOVING_WATCH_ACTIONS`: `off` disables starting runs from the board; default `on`.
- `CLOVING_WATCH_PORT`: the port of the watch page, or `off`.
- `CLOVING_WATCH_REPOSITORY`: repository context for a separate watch process. `start` sets this from its service repository. The watch process uses its local origin and has no current-directory default.
- `CLOVING_OWNERSHIP_LEASE_SECONDS` and `CLOVING_HOST_BOUND`: limits of the workflow host.
- `CLOVING_GH_COMMAND`, `CLOVING_CHECK_COMMAND` and `CLOVING_PRIVATE_TEXTS`: settings of `develop-issue`; the GitHub command and private-text list also apply to `develop-prd`.

A command setting is a JSON list of texts, for example `CLOVING_CHECK_COMMAND='["npm", "test"]'`.

The notify command receives no added argument. Its standard input receives one JSON object with `event`, `runId`, `workflowId`, `subject` and `body`. The body contains the decision or outcome text already shown by `cloving questions` or `cloving status`, with complete response commands, up to 4000 characters. The daemon checks every 15 seconds. The first check with no notification record only records existing events.

The private `notify-events.json` journal records a notification as `pending` before calling the command and as `sent` after exit code 0. A failed command retries the same message after 1, 5, 15 and 60 minutes, with five attempts in total and a 30-second limit per attempt. The journal records attempt times and fixed failure reasons without command arguments or output. Pending and retryable failed entries resume after restart. Exhausted delivery logs one line naming its key. Old key-only records migrate as sent without sending them again.

Journal updates use a temporary file and rename. Sent and exhausted failed delivery details expire after seven days; their keys remain to prevent later duplicate delivery. Unfinished deliveries remain until resolved. A crash after command success but before recording that success can repeat delivery. Decisions opened and closed between checks can be missed.

### Answer decisions from a phone

Cloving can send its pending decisions to the Cloving app on your phone, and the phone can answer them. `cloving start` runs the phone relay as a child process. `CLOVING_PHONE_RELAY` with the value `off` starts no relay. `CLOVING_RELAY_ORIGIN` selects the relay server; the default is `https://cloving.ai`.

To connect a phone:

1. On the watch page, click **Connect a phone**. The page shows a QR code for 10 minutes.
2. Scan the code with the camera of the phone, or with **Pair a computer** in the app. Sign in to cloving.ai in the app when it asks.
3. In the app, click Connect. The watch page and the app show the name of the phone and the same 6-digit code.
4. Click **Accept** on the watch page only when the two codes are the same. The app checks the signed receipt of the computer, and the page shows **Connected**.

After that, each new decision goes to the connected phones. Answer a question with text. Approve or deny an approval with Face ID, a fingerprint or the screen lock of the phone; the phone signs approvals with a key for approvals only. Before the relay sends a decision, it checks the signature, the device, the age of the answer (10 minutes at most) and the prompt that the phone saw. The decision records the actor `device:<device ID>`, and `cloving status <run-id>` shows it. When a decision closes on the computer or expires, the phone removes it.

`cloving phone list` lists the phones. `cloving phone remove <device-id>` removes one phone. `cloving phone reset` removes the registration with cloving.ai and all phones. A removed phone gets no more decisions, and the relay refuses its answers.

What cloving.ai sees: the names of the computer and of each phone, the public keys, the times of the messages, the sizes of the sealed messages (padded to 1, 4, 16 or 64 KiB) and opaque IDs. The decisions, the prompts and the answers are end-to-end encrypted between this computer and your phones (HPKE with P-256 keys that stay on the devices), and each message is signed. cloving.ai cannot read or change them.

The questions of `analyze-chats` are private. Their full text goes only to your own paired phones, end-to-end encrypted, and the app shows it only after it opens the message. The preview for the lock screen keeps a fixed text.

### Daily loop facts

Run `cloving report --since 24 --json` for a versioned JSON report, or omit `--json` for text. `--since` accepts whole hours from 1 to 168 and defaults to 24. The window includes its start and excludes its end; the command captures the end time once. It reads the daemon's committed events and individual run status through the control socket. Set `CLOVING_WATCH_REPOSITORY` to the service repository to enable GitHub reads; its local origin supplies the host, owner and repository. There is no current-directory fallback. `CLOVING_GH_COMMAND` selects the GitHub command as a JSON argument array, defaulting to `gh`.

This is the first part of the daily report. The implemented values are:

| JSON value                    | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `metrics.tickets.completed`   | Currently closed GitHub issues whose state reason is completed and whose latest closure falls in the window. Pull requests and issues closed for another reason are excluded. This is a current snapshot: reopening an issue removes that closure from these figures.                                                                                                                                                                                                                                       |
| `metrics.pullRequests.merged` | Pull requests with a GitHub merge timestamp in the window. Closed, unmerged pull requests are excluded.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `metrics.runs.completed`      | Terminal `run.completed` events with no outcome or with `handoff_requested`, excluding partial ticket handoffs.                                                                                                                                                                                                                                                                                                                                                                                             |
| `metrics.runs.partial`        | Handoffs explicitly marked with partial ticket status.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `metrics.runs.blocked`        | Terminal `run.completed` events with the blocked outcome.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `metrics.runs.failed`         | Terminal `run.failed` events.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `metrics.runs.cancelled`      | Terminal `run.cancelled` events.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `metrics.cost.medianRunUsd`   | Median lifetime actual turn cost among runs ending in the window. Any unknown run cost makes this value unavailable.                                                                                                                                                                                                                                                                                                                                                                                        |
| `runCosts`                    | Each ended run's outcome, end time, actual total USD cost, individual turn operation IDs and actual prices, plus the historical daily median run-cost baseline. All of a run's turn cost is attributed to its end time, including turns before the window. Estimates never replace unknown actual prices. An observed run with no worker turns and settled effects has cost zero. A cancelled run that is still draining, or any unresolved effect, leaves its total unavailable. Active runs are excluded. |

Every metric has `value`, `comparisonValue`, `baseline` and `evidence`. Counts retain their requested-window totals in `value`; `comparisonValue` is their equivalent per 24 hours. Costs are not scaled. The baseline uses the seven consecutive 24-hour periods immediately before the window, anchored at the same time of day in UTC. It contains the median and the band from median minus three times the median absolute deviation to median plus three times that deviation. Only values strictly outside the band receive `mark: "outside"`. Individual run costs use the band of daily median run costs. With fewer than five complete observed days, `history` is `short`, the median and band are null, and there is no mark. Empty observed days count as zero for counts; days with no cost sample or with an unknown cost do not establish a daily cost median. An unrepresentable numeric band has unavailable history and no mark. Daemon history starts at its earliest retained event; GitHub history starts at repository creation.

Evidence includes the contributing run IDs and event sequences, issue numbers or pull request numbers. Baseline evidence is separate from current-window evidence. Run cost details also expose each turn's operation ID. The daemon event read is pinned to the first page's latest sequence; later appended events are excluded. Run status and GitHub sources are separate reads, so the report is not an atomic cross-source snapshot.

Each GitHub read uses the existing retry rules: transient network errors and HTTP 500, 502, 503 and 504 receive up to three attempts, with growing waits of 30 and 60 seconds. Read failure, invalid data, an unknown actual price or missing repository context is represented as `unavailable` with a null metric value, rather than zero. A failed source does not hide readable sources. `sources` shows which reads succeeded; the command exits zero when it produces a report, including one with unavailable sources. Invalid command arguments exit two.

The `coverage` object explicitly marks the remaining facts unavailable: immutable ticket closure and reopening history, fix rounds per merged pull request, ready-to-merge lead time, phase durations, lane utilization and ready-ticket idle time, peak active runs, skips and unsuccessful streaks, first-attempt main CI passes, flaky failures and test names, reverted work, review scores, CI runner/OS utilization and limits, time-outs, reruns and runner waits, completed-ticket costs across attempts, and operator merges, reruns, labels and restarts. These facts are not inferred from the implemented counts. The report performs no model call, writes no state and changes no queue.

## Daily development

`cloving start` copies the TypeScript files in `workflows/` into a host project and compiles them there. The bundled workflows are:

- `develop-prompt` takes the text of a task. Use it for a small task with no ticket, or for a first try in a new repository.
- `develop-ticket` takes a ticket ID and reads the ticket itself. Use it for the normal work on a ticket, when you want to read each diff and merge the branch yourself.
- `develop-issue` takes a ticket ID too, and sends the work through a GitHub pull request. Use it for a small ticket with clear criteria, in a GitHub repository that Greptile reviews and that has a check command. It is the workflow of the continuous process.
- `develop-prd` takes an idea, researches the code and web, reviews a draft PRD, and posts it as a GitHub issue. It then hands the issue number to `develop-issue` to build automatically. Set `CLOVING_PRIVATE_TEXTS` to a nonempty JSON list before starting the daemon. A refused post preserves the worktree and draft. If the handoff is refused, it adds `cloving: ready` so the issue queue can build it later. The PRD run retains `issue-N` as its promotion, shows the refusal code in its outcome reason, and removes its worktree after posting. If the fallback label fails, status also shows `issueUpdate: failed`; inspect the GitHub operation and queue the issue after resolving the failure.

```sh
cloving start                                  # terminal 1, in the repository
cloving run develop-ticket --ticket TICKET_ID  # terminal 2
cloving run develop-issue --ticket TICKET_ID   # the work goes through a pull request
cloving run develop-issue --next               # select the next ready ticket
cloving run develop-prompt --prompt "the text of the task"
cloving run develop-prd --prompt "Show the cost of each run on the watch page"
cloving watch                                  # the live page, also started by cloving start
cloving questions
cloving approve DECISION_REF --expected-revision N --generation N --subject-digest DIGEST
cloving deny DECISION_REF --text "FEEDBACK" --expected-revision N --generation N --subject-digest DIGEST
```

The rule: read the diff before you approve.

Claude turns have web research tools by default, an empty GitHub CLI configuration folder, and no GitHub token environment variables. This is not a sandbox: a turn can still find other credentials. The PRD refusal rules catch the listed private text and common sensitive forms; unlisted private names can pass. A `post-uncertain` result requires checking GitHub before trying another run.

`cloving status RUN_ID --json` includes `run.input`, and `cloving status --json` includes `input` on each listed run. It is the normalized submission admitted with the run, such as `{"ticket":"297"}` for `develop-issue` or the submitted fields of a declared workflow. It survives service restarts and excludes resolver-added ticket text and repository paths. Older runs without a stored submission show `null`. The text status of one run shows `Input:` as compact JSON, limited to the first 200 characters with `…` appended when longer. Terminal control and hidden format characters are escaped.

### The ticket command

`CLOVING_TICKET_COMMAND` (a JSON list of texts) names the ticket command. The contract of a ticket command:

- It gets a ticket ID as its last argument and prints the text of the ticket.
- For `develop-issue`, a first line that starts with `# ` gives the title of the pull request. With no such line, the title is `Cloving task <cycle ID>`.
- For `develop-issue`, a line `GitHub issue: <owner>/<repository>#<number>` makes the pull request reference that issue. Cloving closes it after a merge only when the worker reports complete work.

The daemon runs the ticket command when it admits a run. The printed text becomes the stored input of the run, so a later change of the ticket does not change the run. A ticket that the command does not give is refused with `ticket-not-available`. With no ticket command, `develop-ticket` is refused with `ticket-source-not-configured`. A ticket ID has letters, digits and the characters `. _ : -` only.

This example ticket command reads a GitHub issue. Save it as `~/.local/bin/github-ticket`, and make it executable:

```sh
#!/bin/sh
set -eu
repository=OWNER/REPOSITORY
title=$(gh issue view "$1" --repo "$repository" --json title --jq .title)
body=$(gh issue view "$1" --repo "$repository" --json body --jq .body)
printf '# %s\n\nGitHub issue: %s#%s\n\n%s\n' "$title" "$repository" "$1" "$body"
```

Then start the service with the setting:

```sh
CLOVING_TICKET_COMMAND='["github-ticket"]' cloving start
```

`cloving run develop-issue --next` and `cloving run develop-ticket --next` use the reserved ticket ID `next`, just like `--ticket next`. Set `CLOVING_NEXT_COMMAND` to a JSON list naming your selection command and its arguments. The daemon adds no argument. The command chooses a ready ticket in your tracker and prints its ID; the daemon trims it and reads the ticket with `CLOVING_TICKET_COMMAND`. Both commands share the resolver's 30-second deadline. Selection logic stays in your command, and each invocation submits only one run.

Set `CLOVING_QUEUE_SECONDS` to a whole number from 10 to 3600 to poll for ready issues. It requires both ticket commands. `CLOVING_QUEUE_LANES` sets the number of simultaneous `develop-issue` runs, from 1 to 4, and requires `CLOVING_QUEUE_SECONDS`; its default is 1. For example, `CLOVING_QUEUE_LANES=4` admits at most one new ticket each cycle until four lanes are busy. Each run has its own branch and work tree. Manual issue submissions share this limit and receive `workflow-active` when all lanes are busy. A ticket already being developed receives `ticket-active`.

Before enabling more than one lane, update the next-ticket command to honor `CLOVING_SKIP_TICKETS`. Cloving sets this environment variable to space-separated IDs of active tickets and tickets waiting for dependencies. The command must never print an ID from that list. It should print nothing when no eligible ticket remains. The service also checks selected tickets before admission.

In the ticket text returned by `CLOVING_TICKET_COMMAND`, each `#N` in a sentence starting with **Needs** inside `## Dependencies` is a hard dependency. For example, `Needs #123 and #124.` waits until both GitHub issues close. Other references and sections do not create dependencies. Cloving reads dependency state with `CLOVING_GH_COMMAND` (default `gh`); an unavailable or invalid response prevents admission. An open dependency returns `ticket-dependency-open` and puts the ticket in the skip list. Waiting tickets are checked again each cycle with a free lane, so a closed dependency makes its ticket eligible again.

`cloving status` and watch display busy lanes and skipped tickets with their reasons. A pending self-update holds new admissions while active lanes drain. Three unsuccessful runs in a row, counted in the order they finish, stop the queue; a successful handoff clears the streak. Ordinary restarts preserve it. After inspecting and reconciling the failures, start with `--reset-queue` to clear the streak. A conflict caused by an earlier lane's merge returns its diagnostics to a fix round. Lanes do not add CI runners or parallelize turns within one run.

An empty selection gives `no-ready-ticket`; a failed command gives `next-ticket-not-available`. Missing configuration gives `next-source-not-configured`. Multiple IDs, an invalid ID, or `next` as the selected ID give `invalid-ticket-id`. Use only one of `--next`, `--ticket`, `--prompt` and `--input`.

A saved harness named `grok` runs `grok --output-format streaming-messages-json --always-approve -p <turn text>` in the work tree. `CLOVING_GROK_COMMAND` replaces its command; the turn text follows `-p` or `--single` as one argument, or is appended if neither flag is present. Grok runs without approval prompts and has the same GitHub credential isolation as the other workers. Completion requires exit status 0 and a terminal result with `subtype: "success"` and `is_error: false`. The terminal result supplies the report and ticket status. Grok capacity errors are not retried.

Grok token counts come only from the terminal result, including its subagents. Input includes uncached input and cache creation; cache reads and output remain separate. Missing, all-zero or stderr-warned incomplete usage shows `Token usage not known`. An estimate requires complete usage attributed to exactly one model with a configured price. Mixed models and missing prices show `Price not known`. Grok uses token-based estimates and ignores its projected cost field. No Grok model prices are built in.

### Review rounds of `develop-ticket` and `develop-prompt`

Worker turns retry an exact Codex capacity refusal or a Claude overload after 60 seconds, then 180 seconds, for at most three attempts. Each retry keeps the work tree, profile, budget and limits, and asks the worker to continue from the current work. The step keeps one operation identity and sums usage across attempts. Private turn journals and turn usage retain each attempt's model, token counts and cost estimate. Stopping during a wait returns `stopped`; a daemon restart fails the recorded operation for existing recovery. Other failures are not retried.

`CLOVING_FALLBACK_MODELS` accepts a JSON array of at most three nonempty model names, for example `'["gpt-6-astra"]'`. Without the setting or with `[]`, every attempt keeps the main model. The first attempt and first retry use the main model; each later attempt uses the next configured fallback within the existing attempt limit. With three attempts, only the first fallback can be used. The worker command must explicitly name a model with `-m NAME`, `--model NAME` or `--model=NAME`; otherwise it stays unchanged and the private journal records `fallback-model-unavailable`. Fallbacks apply only after capacity refusals. A fallback model can have a higher price. Each attempt's estimate uses its own model's price; an unknown price or missing token count leaves the total estimate unknown. Malformed settings refuse daemon start with `invalid-fallback-models`.

A run of `develop-ticket` or `develop-prompt` has one to three review rounds. Each round does one Claude Code turn in the work tree of the run, on the branch `cloving/<ticket id>-…`, and then opens one approval. The first round makes the work tree. The approval text has the round, the ticket ID, the branch, the commits, the changed files and the report of the worker. Read the diff before you decide. The decision has these results:

- An approval completes the run. It does not merge the branch. Merge the branch yourself.
- A denial with a feedback text (`--text`) in round 1 or 2 starts the next round. The Claude worker gets the feedback text and adds commits to the same branch.
- A denial with no text, or a denial in round 3, ends the run.

The worker is not confined. It runs the `claude` command of the search path as the current user, with file edits and shell commands permitted in the work tree and a spend limit of 5 USD for each turn. `CLOVING_CLAUDE_COMMAND` (a JSON list of texts) replaces the command.

Single-run status (`cloving status RUN_ID`, also with `--json`) and watch show each worker command call and its run totals. Token counts retain the reported input, cache read and output categories separately. Codex input includes cached tokens; cache read tokens are not added to input tokens. These selected counts are not complete billing usage or a record of all subagent work. Missing or invalid fields show `Token usage not known`. Costs show the worker-reported USD price when available, otherwise `≈ 7.82 USD (estimate)` when an estimate is available, otherwise `Price not known`; a reported zero shows `0.00 USD`. Totals for an unfinished run are labeled `so far`. JSON uses `null` for unknown numeric values, retains the total reported price field `claudeCostUsd`, and adds `costDisplay` to the run and each worker turn.

The built-in table uses standard short-context prices read on **2026-10-18** from the [OpenAI pricing page](https://openai.com/api/pricing/), in USD per million tokens:

| Model         | Input | Cached input | Output |
| ------------- | ----: | -----------: | -----: |
| `gpt-6.1-sol` |  2.00 |         0.10 |  10.00 |
| `gpt-6-astra` | 10.00 |         1.00 |  50.00 |

`CLOVING_TOKEN_PRICES` accepts a JSON object mapping model names to non-negative finite `input`, `cachedInput` and `output` prices per million tokens. Its entries override matching built-in entries and retain the others. Estimates use the reported model or the worker command's model argument, with `estimatedCostUsd` totals only when every ended turn has an estimate. There is no live price lookup; estimates do not change budgets or limits.

Each turn selects its harness in this order: profile `harness`, `CLOVING_WORKER`, private `harness.name`, then `claude`. `CLOVING_WORKER` changes the default for one start; a profile can still override it. Supported workers are `claude`, `codex`, `cursor-agent` and `opencode`; a configured harness without a worker stops startup with `harness-no-worker` and its name. Private command, path and kind settings apply only to the matching harness. Status, its JSON and watch show each turn's harness.

Cursor Agent runs `cursor-agent -p --output-format stream-json --force` in the run's work tree. Turn text below 64 KiB in UTF-8 is its final argument; larger text goes through standard input to stay below operating-system argument limits. It uses the last assistant text as the report and requires exit status 0 and a terminal result with `subtype: "success"` and `is_error: false`. File and command tools appear in watch activity. Error events and incomplete streams fail the turn. Capacity errors do not retry. GitHub token variables are removed and each turn gets an empty temporary GitHub configuration directory.

The [Cursor output reference](https://cursor.com/docs/cli/reference/output-format) defines the older stream used by version 2026.01.28 without counts. These runs show `Token usage not known`. For newer terminal `usage` objects, Cloving accepts only four nonnegative safe integer fields: `inputTokens`, `outputTokens`, `cacheReadTokens` and `cacheWriteTokens`. Cursor's [published cache explanation](https://forum.cursor.com/t/discrepancies-between-cursor-cli-usage-and-billing/164471/7) defines uncached input separately from reads and writes, with counts covering the whole turn; Cloving retains each category separately, including optional `cache_creation_input_tokens` in JSON. Other shapes remain unknown. No Cursor prices are built in. A configured price produces an estimate when cache writes are zero; positive writes leave the estimate unknown because the price table has no cache-write rate. Cursor's [headless cost explanation](https://forum.cursor.com/t/cost-information-in-cursor-cli-headless-mode/164583/7) distinguishes CLI counts from billed charges.

With `codex`, `CLOVING_CODEX_COMMAND` replaces the native Codex command and must still emit native Codex events. A shared-format wrapper uses `CLOVING_CLAUDE_COMMAND` with the `claude` worker selection. Its last JSONL result supplies `total_cost_usd` and `usage.input_tokens`, `usage.cache_read_input_tokens` and `usage.output_tokens`, including on errors. Report only the usage and price of that command call; the wrapper must normalize resumed sessions or multi-input accounting. Cloving does not infer the output format from the executable or model name or reconstruct missing usage from old logs.

With `opencode`, the default is `opencode run --format json "<turn text>"` in the work tree. `CLOVING_OPENCODE_COMMAND` replaces the command prefix; Cloving appends the turn text as one argument. Model options use `provider/model`. Cloving sets `OPENCODE_PERMISSION='{"*":"allow"}'` for unattended edits and shell commands under default OpenCode permissions. Explicit project or agent permission rules may still take precedence; `opencode run` auto-rejects any remaining approval requests. Cloving uses the same empty GitHub configuration folder and stripped GitHub token variables as the other workers. See [CLI configuration](https://opencode.ai/docs/cli/#environment-variables) and [permissions](https://opencode.ai/docs/permissions/).

The opencode worker requires exit status 0, no `error` event and a last `step_finish` with `part.reason: "stop"`. Its last assistant `text` is the report, including the ticket status line. Counts on `step_finish` describe individual steps, so Cloving sums them; output includes both output and reasoning tokens. Input and cache read counts remain separate. The two-step fixture in `test/opencode-fixture.ts` follows the [v1.3.17 JSON event emitter](https://github.com/anomalyco/opencode/blob/v1.3.17/packages/opencode/src/cli/cmd/run.ts), [step processing](https://github.com/anomalyco/opencode/blob/v1.3.17/packages/opencode/src/session/processor.ts) and [usage normalization](https://github.com/anomalyco/opencode/blob/v1.3.17/packages/opencode/src/session/index.ts). This version's normal events omit the model; the command's model option supplies the fallback. A reported model takes priority when present. Missing counts show `Token usage not known`; without a matching price entry the cost is `Price not known`. No opencode prices are added, and opencode capacity errors are not retried.

Set `CLOVING_PROFILES` to a file such as:

```json
{
  "profiles": {
    "checker": {
      "harness": "claude",
      "env": { "REVIEW_ONLY": "1", "TURN_NAME": "{turn}" },
      "allowedTools": ["Read", "Grep", "Skill", "Agent"],
      "maxBudgetUsd": 15,
      "workflows": ["review-loop"]
    },
    "fixer": { "env": { "TURN_NAME": "{turn}" } }
  }
}
```

A workflow selects a profile with a `protectedEffect` request for capability `claude` and method `run-turn:checker` or `run-turn:fixer`. Profile names contain 1–119 ASCII letters, digits, hyphens or underscores. All fields are optional. `harness`, `env`, `workflows` and `model` work with each harness. `model` replaces existing `-m`, `--model` or `--model=` options, or adds one model option. Only `allowedTools`, `permissionMode` and `maxBudgetUsd` require Claude; using them with another harness gives `profile-needs-claude`. Unspecified fields keep the selected worker's defaults. Flags after `--` remain unchanged.

`workflows` restricts a profile to the service's registered workflow IDs; omitting it allows every workflow. Each turn receives its run ID and journal operation key joined with a hyphen in `CLOVING_TURN_ID`. That value replaces each `{turn}` in profile environment values. Variables added by one profile do not carry into the next turn. The four GitHub token variables and `GH_CONFIG_DIR` are forbidden in profiles; turns retain an empty GitHub configuration directory. Invalid files stop startup with `invalid-profiles`. Turns refuse unknown profiles with `unknown-profile` and disallowed workflows with `profile-not-allowed`.

To run a Claude, Codex or opencode turn on an existing branch, a custom workflow sets
the effect target to `branch:feature-search`. The service finds that branch's
linked work tree in its own repository. The main checkout is excluded. Before
each turn, the work tree must be clean, including untracked files, submodule
changes and executable bits. Index entries marked assume-unchanged or
skip-worktree are refused even when unchanged. Missing or mismatched work trees
fail with `branch-worktree-not-found`; dirty work trees fail with
`branch-worktree-not-clean`. Branches beginning with `cloving/` and work trees
inside the managed work-tree directory fail with `branch-reserved`.

Cloving only inspects an existing branch work tree; the turn itself can edit
and commit there. Cloving does not create, stash, reset, clean, remove or delete
it or its branch. Results count commits and changed files from the first turn
of that run and target, including after a worker restart. Sequential runs have
separate starting commits; concurrent runs on one branch do not isolate their
commits. Index flags inside submodules and other settings that hide changes
are outside these checks. Every GitHub worker method refuses `branch:` targets
with `branch-target-not-supported`, so this target adds no Cloving push or merge
step. The bundled development workflows keep their existing targets.

### Pull requests of `develop-issue`

A run of `develop-issue` opens no approval. The GitHub worker makes the work tree from the newest commit of the default branch of `origin`. After the Claude turn, the worker pushes the branch and opens a pull request. The title and the referenced issue come from the ticket text (see "The ticket command"). The pull request body uses `Refs owner/repository#N`, so the merge itself does not close the issue. Then the worker waits for the Greptile review of the pushed commit, and asks for a review with a comment after 5 minutes.

When the ticket names a GitHub issue, the workflow adds `cloving: in progress` after preparing the work tree and removes `cloving: ready` and `cloving: blocked`. A blocked run adds `cloving: blocked` and removes `cloving: in progress`. Start and blocked label failures leave the run's outcome unchanged. Cloving creates the labels it adds or removes with the fixed color `ededed`; existing labels have their color and description reset by `gh label create --force`.

The last worker report must end with exactly one line: `Ticket status: complete` or `Ticket status: partial`. A partial report must put `Remaining:` immediately before a list with one `- ` item per line, followed by the status line. The worker records the parsed status and remaining items before shortening the summary, so summary limits cannot remove those fields. If the preserved fields exceed the result byte limit, the turn fails with `claude-result-too-large` and retains bounded cost metadata; the full report stays in the private turn log. Older recorded turns still use summary parsing. Missing, repeated, unknown or malformed status reports count as partial with the remaining item "The worker report has no ticket status line."

After a merge, a protected GitHub operation updates the issue body and labels. Complete work closes the issue with reason `completed` and adds "Completed in pull request #M." to `## Cloving status`. Partial work keeps the issue open and appends `- Pull request #M: partial. Remaining: ...` to that section at the end of the body, preserving earlier partial lines and other body text. Items are separated by semicolons. The issue privacy check runs before new remaining text is written; a refusal uses "Remaining work is in the private run report." instead. No issue comment is posted. Status writes add and remove only workflow labels, preserving unrelated label edits. Before a body write, Cloving rereads the issue and refuses a changed body with `github-issue-conflict`; the merged outcome records `issueUpdate: failed`. GitHub does not support conditional PATCH requests for this endpoint, so this check cannot make the read and write atomic.

Partial work removes `cloving: in progress` and adds `cloving: ready`, so the next queue cycle can select the same issue and read its remaining work from the issue body. The third partial run adds `cloving: blocked` instead of `cloving: ready`. Completion removes these workflow labels. Status operations reconcile the pull request number in the stored history after a restart to avoid duplicate writes. The effect limit stays at 20 units: the post-merge status operation replaces the final label operation.

Partial history comes only from a hidden HTML comment at the end of the issue body, beginning with `cloving-status`. Its JSON object has `version: 1`, a `partialRuns` array of pull request numbers and remaining-item lists, and an optional `completedPullRequest`. Double hyphens and greater-than signs in JSON strings are escaped so they cannot end the comment. Each write regenerates the readable section from this data and replaces the exact previously generated section. Other Markdown stays unchanged, including status examples, lists, tables, HTML and unclosed fences. Missing, broken or unknown metadata counts as zero earlier partial runs and is replaced on the next write; readable text is never used to reconstruct history. A block followed by other issue text is left unchanged and counts as missing terminal metadata.

Partial history, including its JSON block, is bounded by the 48,000-byte ticket-read limit, reserving 2,048 bytes for the title, issue reference and worker notes. If the new remaining items do not fit, Cloving uses the private-report notice above. If even the notice cannot fit alongside the existing body and history, the issue update fails without requeueing it. Retries check the same size limit before restoring queue labels. Review and merge-fix turns receive the previous report's remaining items, including preserved items from shortened summaries, and must reassess each item before reporting completion.

Merged runs retain `handoff_requested` with `ticketStatus: complete` or `partial`, visible in `cloving status` and watch. If the issue update fails, `issueUpdate: failed` is also shown. The queue reports each terminal run without a successful handoff and continues, stopping after three such runs in a row. A successful handoff resets the count; the queue journal preserves the count and run IDs across daemon restarts. Inspect failed GitHub operations and reconcile their issues before requeueing them. A later partial run does not mark an earlier blocked ticket as done.

To resume a queue stopped at this limit, stop the service with Control-C, inspect the failures and reconcile the affected issues, then run `cloving start --reset-queue` with the same repository, runtime and queue settings. This clears the failure streak once and preserves tracked commands. Ordinary restarts, including automatic self-updates, preserve the count. Resetting the queue does not change issue labels or retry blocked issues.

At the confidence score 5/5, the worker runs the local merge check and waits for CI of the exact head it will merge, including an updated head pushed after merging the default branch. When CI passes, it merges the pull request with a merge commit, with no human approval. Then it removes the remote branch, the work tree and the local branch. With a lower score, the Claude worker gets the summary and the findings of the review for one more round. After three such rounds, or after 60 minutes with no review, the run stops and the pull request stays open.

Set `CLOVING_REQUIRED_CHECKS` to a JSON list of check run names, such as `["quality", "quality_linux"]`, to require those checks. Without the setting, all GitHub Actions checks on the head commit are required. The newest run of each name decides; `success`, `neutral` and `skipped` pass. With no setting and no Actions checks after a 60-second grace period, a repository without CI can merge. A configured missing check keeps waiting. CI is polled every 30 seconds with a separate 90-minute limit. A timeout returns `ci-pending` and blocks without a fix round.

When a GitHub Actions check fails in its first workflow attempt, Cloving requests one rerun of the failed jobs and keeps waiting within the same 90-minute CI limit. The operation journal retains the request before sending it, the first failure output and the original deadline, so a daemon restart cannot request another rerun. Status and watch show “CI rerun after a failed check”. A failed rerun request reports a transient GitHub error.

A second failure returns `ci-failed` with the outputs of both attempts, including failed check names, failed steps and failed log tails, with private texts hidden and at most 6,000 characters in total. Checks outside GitHub Actions or without an Actions run link retain the immediate failure behavior. The failure starts a worker fix round that must repair CI, including failures the pull request did not cause, and commit the fix. The new commit receives a new Greptile review and CI gate. Review, local check, conflict and CI repairs share the existing limit of three fix rounds.

The watch board keeps blocked `develop-issue` runs in `Stopped`. A validated local merge report shows `PR merged · #N`. A later completed run for the same established GitHub issue must have its own validated merge report to show `Ticket completed by later run`. The original and later run have separate links. Either local proof prevents a GitHub read. These marks preserve the recorded run outcome.

Otherwise, the board reads the recorded pull request with `CLOVING_GH_COMMAND` (default `gh`). It validates the PR and issue identities against the configured repository's local origin. The first queued or active read shows `Checking PR`. A confirmed merge shows `PR merged · #N`; a failed read shows `PR status unavailable`. An unmerged PR shows `Needs attention`. A separate `Stale` mark appears when the last successful unmerged observation is older than 120 seconds, including after a failed refresh. A successful refresh resets its age. Confirmed merges never become stale.

Reads run in the background, one at a time, with a five-second limit. Board loads can refresh unresolved PRs at least 60 seconds after the previous attempt started. Confirmed merges remain cached until the watch process stops. A later normal page load shows each result.

The GitHub worker does not push a change that has the path of the home folder in a file or in a commit message. `CLOVING_PRIVATE_TEXTS` (a JSON list of texts) adds more texts to refuse, with no difference between capital and small letters. `CLOVING_CHECK_COMMAND` (a JSON list of texts) names a check that must pass in the work tree before a merge. `CLOVING_GH_COMMAND` replaces the `gh` command. The worker uses the `gh` login and the git credentials of the current user.

## Continuous process

In a continuous process, Cloving develops one ticket after the next with `develop-issue`. Use one terminal session for the service that stays open, for example a `tmux` session. Do these steps for each issue:

1. Write a small issue: one behavior, clear criteria that a test can check, and the first tests. The prompt "Write a ticket for Cloving" helps.
2. Run it: `cloving run develop-issue --ticket ISSUE_NUMBER`.
3. Follow the run on the watch page, or with `cloving status RUN_ID` and `cloving events RUN_ID --follow`.
4. Check the merge. The run completes when the GitHub worker merges the pull request. The watch page shows the number of the pull request of the run (`PR_NUMBER`). It is also `pullRequest.number` of the run in `http://127.0.0.1:3663/data.json`. The pull request number and the issue number are different.
   - Make sure that the pull request is merged: `gh pr view PR_NUMBER --json state,mergedAt`.
   - Check the ticket status and issue: `gh issue view ISSUE_NUMBER --json state,body,labels`. Complete work closes the issue; partial work stays open and requeues until the third partial run blocks it.
5. Update the local `main`: `git switch main`, then `git pull --ff-only`.
6. When the repository is the Cloving checkout itself, also restart the service, so that it runs the new code. Stop it with Control-C, then start it again with the same settings.
7. Go to the next issue.

When a run stops and the pull request stays open, read the review. Fix the work yourself, or write a smaller issue.

Know these limits before you start:

- The cost limit of each Claude turn is 5 USD. A run of `develop-issue` can have up to four Claude turns. `CLOVING_CLAUDE_COMMAND` changes the command and its limit.
- The text of a pull request is public in a public repository. The worker gets an instruction to write no local file path in a file or in a commit message.
- `CLOVING_PRIVATE_TEXTS` adds texts that the GitHub worker refuses to push, for example the names of private projects. The path of the home folder is always refused.
- `CLOVING_CHECK_COMMAND` names the checks of the repository. Set it, because a merge at 5/5 has no human approval. With no setting, the merge occurs with no check.

## Prompts for a coding agent

Copy a prompt, replace the words in capital letters, and give it to a coding agent.

### Set up Cloving for a repository

```text
Set up Cloving for my repository REPOSITORY_PATH. Ask me for each value that you do not know. Do not push, publish or merge anything in this setup.

1. Check the platform: macOS or Linux on arm64 or x64, with the Node and npm versions of "engines" in package.json of Cloving. Check that git and the claude command work. If I want develop-issue, check that gh has a login and that Greptile reviews the GitHub repository.
2. If I have no Cloving checkout, clone https://github.com/cloving-ai/cloving-ai.git to ~/cloving. In the checkout, run: npm ci --ignore-scripts
3. Write a launcher ~/.local/bin/cloving that runs src/cli.ts of the checkout with the correct node program, and make it executable. Do not use npm link. Make sure that ~/.local/bin is on the search path and that "cloving --version" works.
4. Ask me which tracker has my tickets. Write a ticket command for that tracker in ~/.local/bin. The command gets a ticket ID as its last argument and prints the text of the ticket. For develop-issue, the first line is "# " and the title, and one line is "GitHub issue: OWNER/REPOSITORY#NUMBER". Test the command with one ticket ID, and show me the output.
5. Start the service in a terminal session that stays open, for example a tmux session. In that session, in my repository, run: CLOVING_TICKET_COMMAND='["TICKET_COMMAND"]' cloving start
   For develop-issue, also set CLOVING_CHECK_COMMAND to the checks of my repository. Give me the address of the watch page.
6. Make a first run with develop-prompt and a small task that I agree to. Show me the output of "cloving questions" and the diff of the branch. Do not approve or deny. I decide.
7. Then run my first ticket: cloving run develop-ticket --ticket TICKET_ID
   Show me the diff again before I decide.
```

### Run a continuous process

```text
Run a continuous process with Cloving and develop-issue in my repository REPOSITORY_PATH. The Cloving service runs in the terminal session SESSION_NAME. Do the issues ISSUE_LIST one at a time, in this order.

For each issue:
1. Read the issue. Do not change it.
2. Run: cloving run develop-issue --ticket ISSUE_NUMBER
   ISSUE_NUMBER is the number of the issue. Record the run ID.
3. Follow the run with "cloving status RUN_ID" and "cloving events RUN_ID --follow".
4. When the run completes, get the number of its pull request (PR_NUMBER). It is pullRequest.number of the run in http://127.0.0.1:3663/data.json, and the watch page shows it too. Then:
   - Make sure that the pull request is merged: gh pr view PR_NUMBER --json state,mergedAt
   - Check the issue state, remaining work and queue labels: gh issue view ISSUE_NUMBER --json state,body,labels
5. Update the local main branch: git switch main, then git pull --ff-only
6. If the repository is the Cloving checkout itself, restart the service in its terminal session, so that it runs the new code. Stop it with Control-C, then start it again with the same settings.
7. Run the checks of the repository on the new main branch.
8. Add a record of the run to RECORD_FILE, outside the repository: the issue, the run ID, the pull request, the merge commit, the number of rounds and the result of the checks.
9. Go to the next issue.

Stop and ask me when:
- an issue is not small, or has no criteria that a test can check;
- a run stops, or its pull request stays open;
- the checks fail on the main branch after a merge;
- a step needs a change of the settings or of the credentials, or work in a different repository;
- a step needs a force push, a change of the history, or a publication.

Do not merge a pull request yourself. Do not approve or deny for me.
```

### Write a ticket for Cloving

```text
Help me write a ticket for Cloving. A Claude Code worker gets the full text of the ticket and no other context. Ask me questions until each part is clear. Then write the ticket in Markdown with these parts:

# TITLE
  One line. For develop-issue, it becomes the title of the pull request.
GitHub issue: OWNER/REPOSITORY#NUMBER
  Only for develop-issue. The pull request references this issue; complete work closes it after the merge.
## Problem
  What is wrong now, with facts.
## Desired outcome
  What is true when the work is done.
## Concrete scenario
  One example from the start to the end, with real values.
## Scope
  The changes, with the names of the files, commands and functions that you know.
## Non-goals
  What the work must not change.
## Acceptance criteria
  A numbered list. A test can check each criterion.
## First tests
  The first tests to write. Each test fails before the change.

Rules:
- One ticket has one behavior. If the work needs more than one pull request, split the ticket.
- Write no secret, no private data and no local file path. For develop-issue, the ticket text and the branch become public.
- Use one term for one thing.
```

### Find workflows in your chats

```text
Find workflows in my chats with coding agents, and write a draft Cloving workflow for one of them.

Rules:
- Read only the chats that I select. Ask me for the list first. Do not read other chats.
- Keep the chat text and private data out of the repository. Do not copy chat text, names of persons, secrets or local paths into a file of the repository. Keep your notes outside the repository.

Steps:
1. In the selected chats, find sequences of steps that repeat. For each sequence, list the steps, the tool of each step (for example git, a test command, gh or a model), and each decision of a person (for example "approve the diff").
2. Show me the list, and ask me which sequence to use.
3. Map each step that changes something outside the workflow to protectedEffect, with a capability and a method. Map each decision of a person to decisionGate.
4. Use only the capabilities that have a worker: claude (method run-turn) and github. Put each step that needs a different capability in a list of open points, not in the draft.
5. Write the draft in the form of workflows/develop-ticket.ts of the Cloving checkout: an exported async function with the directive "use workflow", and the step helpers from the subpaths of cloving/workflows.
6. Write a list of the human decisions in the draft: for each decisionGate, the question, the person who decides, and the result of each answer.
7. Write workflow tests with a fake step bridge, in the form of test/develop-workflow-fixture.ts.
8. Tell me which changes of the Cloving code the draft needs before the service can run it. The section "Develop a workflow" of the Cloving README lists them.
```

## Develop a workflow

`cloving start` loads workflows from three folders:

- The bundled `workflows/` folder in the Cloving package. Startup compiles each TypeScript file in this folder.
- The repository `.cloving/workflows/` folder.
- The user `cloving/workflows/` folder under an absolute `XDG_CONFIG_HOME`, otherwise under `~/.config`. An unset or relative `XDG_CONFIG_HOME` uses that default.

A workflow is a TypeScript file in the form of `workflows/develop-ticket.ts`:

- An exported async function with the directive `"use workflow"` as its first statement. The directive needs the compiler of the Workflow SDK, not only TypeScript.
- The first argument is the input of the run. A resolver of the daemon makes it, for example `cycleId`, `ticketId`, `ticket` and `repository`. With `decisionGate`, the host calls the function again with the decision (`gateId`, `decision` and `answer`) as the second argument. The function must examine that argument before it asks for an effect, as `decided()` in `workflows/develop-ticket.ts` does. With `waitForDecision`, the decision returns to the same call.
- The step helpers come from the subpaths of `cloving/workflows`: `protectedEffect` from `cloving/workflows/steps/protected-effect`, `decisionGate` from `cloving/workflows/steps/decision-gate`, `waitForDecision` from `cloving/workflows/steps/wait-for-decision`, `loadCycle` from `cloving/workflows/steps/load-cycle`, `handoff` from `cloving/workflows/steps/handoff`, `waitForRun` from `cloving/workflows/steps/wait-for-run` and `runCommand` from `cloving/workflows/steps/run-command`. The type `CycleOutcome` comes from `cloving/workflows`. An import of `cloving/workflows` starts no service.
- `protectedEffect` asks the daemon for one effect of a capability, for example a Claude turn. `decisionGate` opens a decision for a person.
- The function returns a `CycleOutcome`: `waiting_for_decision`, `handoff_requested` or `blocked`.

For `handoff_requested`, the daemon retains the workflow's `promotionId` in the completion event. An optional bounded `reason` records a handoff refusal while preserving the promotion. `cloving status <runId>` shows the promotion as `Promotion:` and the reason beside the outcome; JSON status includes `run.outcome.promotionId` and `run.outcome.reason`. Watch retains the promotion in the run model and completed-run details. This identifier is an opaque reference and grants no authority.

```ts
import type { CycleOutcome } from "cloving/workflows";
import { decisionGate } from "cloving/workflows/steps/decision-gate";
import { protectedEffect } from "cloving/workflows/steps/protected-effect";

export async function developTicket(
  input: { readonly cycleId: string; readonly ticket: string },
  decision?: {
    readonly gateId: string;
    readonly decision: string;
    readonly answer: string | null;
  },
): Promise<CycleOutcome> {
  "use workflow";
  if (decision?.decision === "approved")
    return {
      kind: "handoff_requested",
      cycleId: input.cycleId,
      promotionId: `cloving-${input.cycleId}`,
    };
  if (decision !== undefined)
    return {
      kind: "blocked",
      cycleId: input.cycleId,
      reason: "The operator denied the work.",
      evidenceId: decision.gateId,
    };
  const turn = await protectedEffect({
    scope: { phase: "implement", operation: "claude-turn", round: 1 },
    capability: "claude",
    method: "run-turn",
    target: input.cycleId,
    payload: input.ticket,
    units: 1,
  });
  if (turn.kind !== "completed")
    return {
      kind: "blocked",
      cycleId: input.cycleId,
      reason: "The Claude turn did not complete.",
      evidenceId: "claude-turn",
    };
  const gate = await decisionGate({
    gateId: "review-1",
    kind: "approval",
    prompt: "Review the work of the Claude worker.",
  });
  if (gate.kind !== "opened")
    return {
      kind: "blocked",
      cycleId: input.cycleId,
      reason: "The review gate did not open.",
      evidenceId: "review-1",
    };
  return {
    kind: "waiting_for_decision",
    cycleId: input.cycleId,
    decisionId: gate.decisionId,
  };
}
```

In this example, an approval completes the run and a denial ends it. `workflows/develop-ticket.ts` also starts one more round after a denial with a feedback text.

New workflows can await a decision in the same call:

```ts
import { waitForDecision } from "cloving/workflows/steps/wait-for-decision";

export async function review(input: { cycleId: string }) {
  "use workflow";
  const decision = await waitForDecision({
    gateId: "review-1",
    kind: "approval",
    prompt: "Approve this change?",
  });
  return {
    kind: "handoff_requested",
    cycleId: input.cycleId,
    promotionId: decision.decision,
  };
}
```

`waitForDecision` accepts the same request as `decisionGate` and returns `{ decision, answer }`. The decision is `approved`, `denied`, `answered` or `expired`. An optional `expiresAt` resumes the wait with `expired` and `answer: null`. The SDK hook survives daemon restarts and replay. Gate IDs belong to a run, so different runs can use the same gate ID. The existing questions, decision commands and binding values apply; dropping the run cancels the wait. `waitForDecision` is also exported by `cloving/workflows`.

The workflow tests run the workflow function with a fake step bridge (`test/develop-workflow-fixture.ts`). The fixture resolves `cloving/workflows` to the files of `src`, records each effect request and gate request, and gives the results of a scenario. `test/develop-ticket-workflow.test.ts` and `test/develop-issue-workflow.test.ts` use it.

Use `cloving workflows list` to inspect bundled, project and user workflows without a service. `--json` prints an array with `scope`, `workflowId`, `file`, `admitted`, `codes` and each valid parsed declaration. Invalid declarations have a null ID. Inspection uses the same folder admission and compiler as startup in a disposable project directory.

Put tests beside each folder workflow as `<name>.test.ts`, then run `cloving workflows test <workflow-id>`. Omit the ID to run all available project and user workflow tests. Both commands accept `--repository <directory>`. The Node test runner prints its results and supplies the exit status. Unknown IDs report `unknown-workflow`; known workflows without tests report `workflow-test-missing`. Neither needs a running service.

Tests can import `runScenario` from `cloving/workflows/testing`:

```typescript
import assert from "node:assert/strict";
import { test } from "node:test";
import { runScenario } from "cloving/workflows/testing";

await test("develop uses the fake worker result", async () => {
  const turn = {
    kind: "completed" as const,
    operationId: "turn-1",
    receipt: null,
    result: "fake result",
  };
  const result = await runScenario({
    workflow: new URL("./develop.ts", import.meta.url).href,
    exportName: "develop",
    input: {},
    turn,
  });
  assert.deepEqual(result.outcome, turn);
  assert.equal(result.requests.length, 1);
});
```

Each scenario runs in an isolated Node process. `effects` maps `"<capability> <method>"` to result queues; `gate` supplies a decision-gate result, `effects.handoff` supplies handoff results, `waits` supplies run-wait outcomes, `decisions` supplies `{ decision, answer }` results for `waitForDecision` in call order, and `decision` supplies the workflow's second argument. A missing `waitForDecision` result throws `no-scenario-result`. An optional `effectLimit` simulates a budget and adds `spent` to the result. Missing effect or gate results return `unavailable`. For tests that import the workflow directly, `using bridge = fakeStepBridge(scenario)` installs the same fake bridge until disposal and exposes `requests` and `spent`. It refuses to replace an active host bridge. The test command resolves public Cloving imports from its own package, including a global installation, without adding a package to the consumer repository.

The four built-in registrations (`develop-ticket`, `develop-issue`, `develop-prd` and `develop-prompt`) keep their existing input contracts and resolvers.

For a repository or user folder workflow, use one `<name>.ts` file with one exported workflow function. Put one `<name>.declaration.json` file beside it. Function names and workflow IDs must be unique across the folders and bundled workflows.

Discovery considers files in the folder root and ignores `.d.ts` and `.test.ts` files. Put local TypeScript helpers in subfolders: for example, `develop.ts` can import `./develop/prompts.ts`. Helpers can import further `.ts` files through `./` paths within those subfolders and need no workflow function or declaration. Imports with parent traversal, absolute paths or a `node_modules` component are refused, as are package imports outside the public `cloving/workflows` modules.

Every imported helper must be a regular file, with no links in its path. Its imports and effects receive the same checks as the workflow, and their combined effects count against the workflow's declared limit. Startup captures and retains all imported helper bytes in the workflow generation. Editing a helper changes the digest for new runs; existing runs keep their earlier helpers after restart.

The declaration has two fields: `workflow` contains the workflow declaration, and `methods` maps each declared capability to its permitted methods. Each list must contain at least one nonblank method name and no duplicates. Do not add method keys for undeclared capabilities. The `isCandidateDeclaration` check in `src/workflow-candidate.ts` validates this form:

```json
{
  "workflow": {
    "workflowId": "review-run",
    "effectLimit": 14,
    "capabilities": ["claude"],
    "input": {
      "maximumBytes": 65536,
      "fields": {
        "prompt": { "type": "string" },
        "rounds": {
          "type": "integer",
          "minimum": 1,
          "maximum": 10,
          "optional": true
        }
      }
    }
  },
  "methods": {
    "claude": ["run-turn"]
  }
}
```

The ID accepts 1–64 letters, digits or hyphens. The effect limit is 1–100; capabilities contain one or more of `claude`, `github` and `command`. The input byte limit is 1–1048576, subject to the service's own limit. Fields accept nonempty strings, integers with optional inclusive bounds, booleans, or tickets. Fields are required unless `optional` is `true`; unknown fields are rejected. Bounds apply only to integers.

A declaration can have one `"ticket": { "type": "ticket" }` field, named `ticket`. Submit its ID as a string. When it is the only required field, use `cloving run <workflow-id> --ticket 312` or `--next`. You can also use `--input ticket.json` with `{"ticket":"312"}`; include every other required field in that file. At admission, the daemon reads the configured ticket command and replaces the ID with `{ "id": "312", "text": "# ..." }` inside the workflow's `input`. `--next` selects the ID through the configured next command. Missing sources keep the `ticket-source-not-configured` and `next-source-not-configured` refusals. The `Needs #N` dependency rule and `ticket-active` refusal apply as for `develop-issue`. Active tickets are checked within each workflow, so different workflows can work on the same ticket. Doctor requires `ticket-command` for these declarations, and the watch form labels the field **Ticket ID**.

Optional `commands` lists distinct names from `CLOVING_COMMANDS`; executable paths and arguments belong only in the operator setting. The `command` capability requires at least one name. Registration refuses an unknown name with `command-unknown`. The execution pin retains these names with each run, and authority refuses `command` effects whose `run:<name>` method is absent from that run's pinned list with `command-not-declared`. Reordering names preserves the pin; changing names changes it. Omitted and empty lists preserve legacy pins.

Use `runCommand` inside a workflow to request a named command:

```typescript
import { runCommand } from "cloving/workflows/steps/run-command";

const result = await runCommand({
  scope: { phase: "scan", operation: "reviews", round: 1 },
  name: "review-requests",
  input: {},
});
```

The helper is also exported from `cloving/workflows`. It accepts serializable JSON input, sends its JSON text through `protectedEffect`'s host bridge with capability `command`, method `run:<name>`, target `<name>` and one effect unit, and returns the same `ProtectedResult` union. A completed result's `result` field contains the stored output text. Refusals retain their fixed reason, including `command-not-declared`; without a host it returns `unavailable` with `cloving-host-unavailable`. The scope identifies the logical operation using the same rules as `protectedEffect`; it grants no authority. Candidate admission requires a literal command name and counts each call against the effect limit.

The daemon starts the operator command without a shell in the repository folder and writes the JSON input to stdin. It uses the Claude turn environment, including its GitHub credential isolation, plus `CLOVING_RUN_ID` and `CLOVING_OPERATION_ID`. Stdout is limited to 1 MiB of bytes and decoded as UTF-8 text; invalid byte sequences become replacement characters. Stderr is limited to 64 KiB and retained only in the effect journal as `command.stderr.log`. Exceeding either output limit fails with `command-output-limit`; a nonzero exit fails with `command-exit`, with its exit status retained in the journal and status display. An unavailable command name fails with `command-unknown`.

The journal records a claim before starting the process. Completed effects replay their stored result after restart. A claimed effect without a result fails with `command-interrupted` after restart and never starts again, including when the earlier process may have written data. Each logical operation starts at most one command; use a new operation scope for a new invocation. The watch run page and `cloving status <run>` show each command name, state, exit status and duration.

Optional `handoffs` lists distinct registered workflow IDs. Registration refuses unknown targets. The execution pin retains these permissions with each run: target order does not affect the pin, while adding or removing a target changes it. Omitted and empty lists keep existing pins. Stored permissions survive restart and retained workflow versions. The built-in `develop-prd` declares `develop-issue` as its only handoff target and calls it after creating an issue; the other built-in workflows declare none. A refused PRD handoff adds `cloving: ready` for the queue and records the refusal in the PRD run's outcome.

Use `handoff` inside a workflow to submit input to a declared target:

```typescript
import { handoff } from "cloving/workflows/steps/handoff";

const runId = await handoff({
  workflowId: "develop-issue",
  input: { ticket: "CLV-123" },
});
```

The step returns the target run ID after admission through the operator submission path. It spends one protected-effect unit. The caller’s pinned `handoffs` list must include the target; otherwise the step fails with `handoff-not-declared`. The target validates and resolves the input through its normal submission contract. Refusal fails with `handoff-input-refused` and admits no target run. If the target returns `workflow-active`, the worker makes at most ten attempts, one second apart, then fails with `handoff-start-timeout`. The worker retains the active-target refusal count across restarts. Replays reuse command ID `handoff:<operation ID>` and return the same run ID; separate step calls have distinct operation IDs. After a lost submission reply, recovery replays that same command ID only while the source run, lease, budget and workflow pin still permit dispatch. Status checks and stop never start a target run.

Hand-offs record `parentRunId` and `chainId` (the first run's ID) in the new run's admission. A chain permits at most five runs, including the first; attempting a sixth fails with `chain-limit` and starts no run. This fixed limit follows ancestry, so separate children of the same parent do not consume each other's chain length. The records and limit survive service restarts. `cloving status` shows the parent, chain and child run IDs in text and JSON; watch cards link to parent and child runs across workflows.

Use `waitForRun` to await the outcome of a run that the current run started with `handoff`:

```typescript
import { handoff, waitForRun } from "cloving/workflows";

const runId = await handoff({ workflowId: "size-ticket", input: {} });
const outcome = await waitForRun({ runId, maximumWaitSeconds: 60 });
if (
  outcome.kind === "handoff_requested" &&
  outcome.promotionId === "size-small"
)
  await handoff({ workflowId: "take-ticket", input: {} });
```

`maximumWaitSeconds` must be an integer from 1 to 86400. The result contains `kind`, `reason` and `promotionId`; absent reason or promotion values are `null`. A wait for an unknown run, a run started by another run, or an invalid bound fails with `run-wait-refused`. Expiry fails with `run-wait-timeout`. Waiting spends no effect units. Several handoffs to a workflow without `when-idle` admission create distinct child runs that can each be awaited.

The compiled SDK step uses durable retries and its original start time, so restarting the daemon preserves the deadline, includes downtime in the wait and replays the same terminal outcome. `cloving status` shows condition `waiting-run` and the awaited run ID (`awaitedRunId` in JSON); watch cards show a link labeled “Waiting for run”.

Optional `stages` contains 1–12 entries in board order. Each entry has a unique `name` (1–64 ASCII letters, digits or hyphens), a unique `label` (1–40 printable characters on one line, without outer spaces), and `operations`, `gateKinds`, or both. At least one selector array must be nonempty. Operations match the `scope.operation` passed to `protectedEffect`, using 1–128 ASCII letters, digits or `._:/-`; gate kinds are `approval` and `question`. Selectors cannot repeat within an array or belong to two stages of the same selector type. Unknown fields and labels `Other`, `Done` and `Stopped` are rejected.

For declared stages, the board uses the latest committed `effect.requested` or `gate.opened` sequence, preserving that event's start time. Unmatched events and runs without a relevant event use Other. Decisions and worker output do not advance a card; later requests can move it back. Declared labels are followed by Other, Done and Stopped. Existing terminal retention rules take precedence. Unstaged workflows and `develop-issue` keep their existing columns and placement. Declarations load at service startup; stages provide display metadata and grant no capabilities.

After startup, `cloving status` lists the declared ID. Submit JSON with `cloving run review-run --input input.json`. The function receives `{ cycleId, repository, input }`, where `cycleId` is `task-` followed by 12 characters derived from the command ID, `repository` is the service repository, and `input` retains the checked JSON values. Invalid input is rejected before a run starts. Invalid declarations or duplicate workflow IDs or function names stop startup.

Startup retains each complete compiled project under `workflow-bundles` in private daemon state, beside the generated `project` directory. Each content-addressed snapshot includes workflow sources, declarations, registration manifests, all compiler artifacts, and the installed dependency graph and Node identity. Snapshots bind to the canonical repository and survive later source edits or removal. Storage lookup validates every captured file and returns `pinned-workflow-unavailable` for missing or changed bytes; startup refuses reuse of a matching damaged snapshot without repairing it. No retained generation is deleted automatically. Routing pinned runs through these stored generations remains pending.

Candidate policy checking is available internally through `checkWorkflowCandidate` in `src/workflow-candidate.ts`. It takes serializable analysis facts, an export snapshot and a candidate declaration containing `workflow` and `methods`. Each declared capability requires a nonempty list of distinct method names. The existing workflow sidecar format is unchanged. Results are sorted, unique refusal codes; an empty list grants no admission or execution authority.

The caller supplies imported symbol names, literal effect pairs (`null` represents a dynamic value), direct-effect and unsupported-form findings, and known call and unit totals. Unknown portions of a total still require runtime budget enforcement. This pure checker does not analyze source or verify these facts. Source-to-facts analysis, SDK candidate compilation and the installed candidate admission adapter remain unimplemented.

## Development of Cloving

The shell tests require both zsh at `/bin/zsh` and Bash at `/bin/bash`. macOS includes them. Linux contributors and CI runners must install both before setup; on Ubuntu, install the `zsh` and `bash` system packages. The fixtures exercise zsh 5.9 and Bash 3.2 or 5.2, including their real startup files; neither shell's tests are optional. `npm run check:setup` checks that both executables run and reports a missing prerequisite before compilation.

```sh
npm ci --ignore-scripts
npm run check:setup
npm run build
node dist/src/cli.js --help
npm pack --ignore-scripts
```

After a merge or branch update changes `package.json` or `package-lock.json`, rerun `npm ci --ignore-scripts` in the worktree before running checks. Copied `node_modules` can still contain the previous versions; the developer gate rejects a mismatch with the lockfile.

`npm pack` prints the file name of the tarball. Install it into a separate project with `npm install --ignore-scripts --omit=dev /absolute/path/to/TARBALL`, then run `./node_modules/.bin/cloving --version` or `./node_modules/.bin/cloving start`. The package includes the emitted CLI, start program, compiler and bundled workflows; startup uses the installed runtime dependencies. The package has no installation hooks. An import of `cloving/workflows` gives the step helpers `loadCycle`, `protectedEffect`, `decisionGate`, `waitForDecision`, `handoff`, `waitForRun` and `runCommand`, and starts no service.

`npm run check` and `npm run test:concurrency` currently reject admission because the complete quality policy is not implemented. Setup checks are not product acceptance. State and retained releases will live outside the package installation; installing or updating the package does not activate a daemon or migrate state.

Run `npm run test:scale` on an otherwise idle machine to measure authority opening at 1,000, 10,000 and 50,000 events. This command runs the benchmark alone, without coverage; the regular test suite excludes it. The fixture uses completed runs with budgets, gates and released continuations. It requires each opening to take less than two seconds and the largest opening to take less than eight times the 10,000-event opening. Replay uses the pure reducer with run-scoped projections and preserves shared effect and lease state. Large effect histories, growing gate or pending-intent state within one run, and cancelled-run recovery still require separate scaling work; this benchmark does not establish their bounds. The generated-history parity and tamper tests compare replay with the full reducer and cover every event type.

`npm run check:quality` checks the npm manifest, lock and installed versions, regenerates TypeScript output in memory, inventories first-party files, and runs strict compilation, the proposed module catalog, workflow/effect boundaries, suppression and test-integrity checks, formatting, typed lint, structural checks, clone detection and the regular local test suite. Production modules require at least 90% line, statement and function coverage and 85% branch coverage per file. Coverage uses native V8 ranges mapped to the syntax tree of the exact Node-stripped source; unimported production files fail. Class and named object types allow at most 24 callable members; interfaces allow 10. Clone checks support ordinary TypeScript and JavaScript; JSX is rejected until separately qualified. `npm run check:lint`, `npm run check:format` and `npm run test:quality` run individual development checks.

The gate uses the committed `quality/test-durations.json` record to start files with unknown durations first in path order, then recorded files from longest to shortest, breaking ties by path. Stale entries have no effect. The launcher passes the ordered list directly to Node’s programmatic test runner because CLI discovery sorts positional paths. The test inventory and sorted report stay the same. Run `npm run record:test-durations` to refresh the record after adding or changing tests, then commit the JSON. This runs the regular suite with the gate's worker count, timeout settings, isolated environment and V8 coverage, sums each file's top-level test and suite durations in seconds, and writes entries in path order after a successful complete run. Nested tests are not counted twice. Temporary coverage stays outside the repository and is removed afterward. The command accepts the same concurrency and time-factor settings as the gate.

The quality report includes elapsed time and the effective limit in milliseconds for each bounded command: npm inventory, clone detection, tests and coverage conversion. Commands using more than 80 percent of their limit produce a warning in the JSON report and on stderr after the report. Failed checks print the collected timings and warnings with the original error and a failing exit status. Warnings preserve a passing result. If your change made the check slower, address the warning in the same ticket.

The watch scrolling tests launch an isolated headless Chrome process at desktop and phone widths. They require Chrome on the test machine. Run them with `node --test test/watch-scrolling.test.ts`. The fixture serves bundled Preact and board data over loopback and blocks external page resources.

To check the 390 px expansion race, run both phone scrolling scenarios twenty times with the CI timing factor:

```sh
for run in $(seq 1 20); do
  CLOVING_CHECK_TIME_FACTOR=3 node --test --test-name-pattern='CLV-(134|196).*390px$' test/watch-scrolling.test.ts || exit 1
done
```

The expansion helper waits for two animation frames before horizontal input. Resolving in the first callback can send the gesture before the widened Done column renders, leaving the board at its old horizontal scroll limit even after scrolling settles. The regression delays that rendering pass with `testMilliseconds(250)` and keeps the full card visibility assertion. A failure reports the card, column and board rectangles, both scroll positions and the viewport; compare the card's right edge with the board's right edge to distinguish horizontal clipping from an incomplete vertical scroll.

Before a ticket report, commit your work and run `npm run check:clean`. It refuses uncommitted changes, archives the committed tree of `HEAD` into a temporary directory, copies the worktree's `node_modules`, and runs `node tools/check-quality.ts` there with the same environment and exit code. Ignored build output such as `dist/` is absent, so tests that rely on stale local files fail. The temporary copy is removed after success, failure or SIGINT/SIGTERM interruption.

After merging dependency changes, run `npm ci --ignore-scripts` in the worktree before checking it. Copied dependencies can belong to an earlier lockfile; `check:clean` copies them unchanged. An `installed-lock-mismatch` requires refreshing that installation and rerunning the checks. If existing `dist/` output produces `generated-output-mismatch`, regenerate it with `npm run build` before rerunning `check:quality`.

Set `CLOVING_CHECK_TIME_FACTOR` to a whole number from 1 to 5 (default 1) to multiply the developer gate test and coverage command time limits, the inner hook check limit (5 seconds by default), and the installed hook limit (10 seconds by default). With factor 3, the hook limits are 15 and 30 seconds, respectively.

Set `CLOVING_TEST_CONCURRENCY` to a whole number from 1 to 8 to override the developer gate's test worker count. Without the setting, the gate uses one fewer worker than the available cores, with a minimum of 2 and a maximum of 4. macOS CI sets it to 3 and Ubuntu CI sets it to 4. Pull requests from branches of this repository run both jobs on local runners with the label `cloving-ci` (macOS arm64 and Linux arm64) with 8 workers; the local macOS runner accepts the macOS version of its machine. Invalid values fail with an error.

Tests that stop a child process should await `stopChild` from `test/stop-child.ts`. Use `stopChildGroup` for a detached process group, including descendants whose leader has exited. Both helpers send `SIGTERM`, wait up to five seconds times `CLOVING_CHECK_TIME_FACTOR` for exit, then escalate to `SIGKILL`. When a test requires a hard crash or an unresponsive child, start that child with `NODE_V8_COVERAGE` omitted so a kill cannot interrupt its coverage recording. Keep coverage enabled for ordinary child runs and recovery runs.

The catalog and checker configuration are local proposals. The bounded SDK artifact, dependency-surface, production-coverage and mandatory-test inventory components have local qualification fixtures. Protected activation of their records, verifier execution and hooks remain pending. Dependency snapshots and supplied review records cannot activate a candidate. The local quality command cannot accept a product candidate. Static workflow checks are not isolation or replay proof. Deterministic sequencing fixtures qualify the test mechanism; they do not prove ownership or storage concurrency in the service.

The coverage profile supports strip-only TypeScript and JavaScript (`ts`, `mts`, `cts`, `js`, `mjs`, `cjs`). It rejects source-map and coverage-ignore patterns interpreted by the provider, including patterns inside strings. Native V8 limitations around throwing calls and default arguments remain; coverage does not replace behavioral assertions. Production roles come from the complete module catalog, independently of which files tests import. Nested npm workspaces and unsupported dependency directory links fail explicitly until qualified.

For trusted development fixtures, `npm run build:workflows -- SOURCE_DIRECTORY OUTPUT_DIRECTORY` runs the selected directive compiler with deterministic manifest ordering. Run the compiler in an isolated fixture project; its output directory must resolve that project's installed `workflow` dependency. Compiler caches and generated handlers stay outside the application source tree. Generated handlers are development artifacts and do not grant authority to execute effects.

SDK qualification uses a fixed logical output path and an empty root TypeScript configuration. Its separate input preflight rejects ancestor/nested compiler configuration, outside first-party inputs, dynamic/CommonJS loading and ambiguous local declaration/runtime resolution. Record the full installed tool/helper closure and every generated handler, manifest and debug artifact, then regenerate at the same logical path and compare preserved bytes. The direct build command does not authenticate these records. Real packed-helper execution is qualified with a disposable prototype.
