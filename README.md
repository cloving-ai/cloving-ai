# Cloving

The world's easiest software factory.

Build a software factory with simple TypeScript for your project, and your project can build itself.

The end of vibe coding. This is agentic engineering.

A workflow file in TypeScript is the factory. It sets the steps: a worker turn in a work tree, a pull request, a review and a merge. Cloving keeps the state of each run and a record of each step. A GitHub step continues after a restart of the service. A worker turn in work stops at a restart. Cloving builds itself through a private copy of the `develop` template for this repository.

## Cloving

Cloving is a local durable development workflow service in TypeScript. You give it a ticket or the text of a task. A Claude Code worker does the work on a new git branch in its own work tree. Then you, or a review on GitHub, decide about the work. The service records each run, each event and each decision on your computer.

This pre-release has one supervised slice: a service for one git repository, a workflow host, a Claude Code worker, a GitHub worker and review rounds. `cloving --help` lists the commands.

What works now:

- `cloving start` starts the service for one git repository, with the workflow host, the Claude worker and a watch page.
- `cloving start` registers workflows from repository `.cloving/workflows/` and user `cloving/workflows/` folders (see "Develop a workflow").
- The `develop` template supports ticket or task-text input and human or automatic review.
- The default `develop` template uses Greptile review and merges at the confidence score 5/5, with no human approval.
- Cloving develops itself through `develop`, a private copy of the develop template, with a Greptile review and an automatic merge.
- The watch page shows the runs, the events and the work of the worker as it occurs.

- `cloving init-prompt` lists local chat-store metadata without reading chat contents. Its setup instructions ask for consent before the agent counts repeated work and samples chats to suggest linked workflows.

What does not work yet:

- The Claude worker is not confined. It runs as the current user.
- An approval does not merge the branch. You merge the branch yourself.

## Install

Cloving supports macOS and Linux on arm64 and x64, with the Node and npm ranges in `package.json`. Workflow admission accepts the same Node range: Node 24.22.1 or a later Node 24 version, and Node 26.9.0 or a later Node 26 version. CI runs the developer gate and packed-install checks on macOS 15 arm64 and Ubuntu 24.04 x64 with Node 26.9.0 and npm 11.19.1. CI also runs the Ubuntu checks with Node 24.22.1. The `quality_linux` check passes only when the Ubuntu checks pass on both Node versions. Windows is unsupported.

A run needs these tools:

- `git`.
- The `claude` command of Claude Code on the search path. The Claude worker runs it as the current user.
- For workflows that use GitHub: the `gh` command with a login. Workflows that select Greptile review also need Greptile on the repository. The worker uses the `gh` login and the git credentials of the current user.

Install the executable from npm:

```sh
npm install --global cloving --ignore-scripts
cloving --version
```

This package replaces the older Cloving CLI under the same npm name. The installed package includes startup, the watch command, workflow templates and the SDK compiler integration. It starts without a source checkout or development dependencies, using the installed runtime dependencies. Installation runs no scripts and starts no service.

For checkout development, get the code and install the dependencies:

```sh
git clone https://github.com/cloving-ai/cloving-ai.git ~/cloving
cd ~/cloving
npm ci --ignore-scripts
```

The runtime dependencies include the Workflow SDK (`workflow`), its directive compiler (`@workflow/builders`), Solid Objects (`solid-objects`), Entities (`entities`) and Preact (`preact`), which the watch page loads. Startup runs the SDK compiler to transform workflow and step directives. Development dependencies are needed to build the package, but an installed tarball runs without them.

### The `cloving` command

For checkout development, put a launcher for `src/cli.ts` in a directory of the search path. The launcher must use a Node version in the supported range. This example is for a checkout in `~/cloving` and a launcher in `~/.local/bin`:

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

The installed executable includes JavaScript for startup, the watch command and workflow support. It uses the installed runtime dependencies, including the SDK compiler, without a source checkout. Runtime state and generated workflow artifacts use the configured runtime location outside the installation. Installation scripts are unnecessary. The checkout launcher above remains supported, including its existing checkout self-update behavior; installing a tarball does not add package self-updates.

For a project-local tarball installation, use `./node_modules/.bin/cloving` wherever the examples below say `cloving`, or add your project's `node_modules/.bin` to the search path. After a build, `npm link` also supplies the executable.

### Repository settings

`cloving start` reads `.cloving/config.json` in the selected repository and a private file at `<config>/cloving/projects/<name>-<id>.json`. The name and ID match the repository's runtime directory. `<config>` is an absolute `XDG_CONFIG_HOME`, or `~/.config` otherwise. Missing files keep the existing defaults. Restart after changing a file.

Each file requires `"version": 1`. Environment settings override private settings, which override project settings, which override built-in defaults. The start guide names each configured field's source: `environment`, `private` or `project`. For each environment value that hides a file value, the start guide prints a warning, for example `Warning: CLOVING_MERGE_MODE in the environment hides merge.mode in the private file.` At each start, the service records the source of each setting: `environment`, `private`, `project` or `default`. `cloving status --json` shows them in `settingSources`, and the `service` check of `cloving doctor` names the settings that come from the environment.

The project file supports `checks.beforeMerge`, `checks.required`, `checks.redGreen`, `merge.mode`, `tickets.command`, `tickets.nextCommand`, `tickets.readyCommand`, `queue.everySeconds`, `queue.lanes` and `queue.dailySpendLimitUsd`. The private file supports these same fields plus `harness.name`, `harness.kind`, `harness.path`, `harness.command`, `harness.turn`, `harness.output`, `profiles`, `fallbackModels`, `tokenPrices`, `privateTexts`, `notify.command`, `watch.port`, `watch.actions`, `watch.theme`, `selfUpdate.everySeconds`, `github.command`, `workflows.folder`, `retention.days`, `retention.action`, `retention.archiveFolder` and `turns.environment`. Commands are arrays of arguments; seconds, lanes, spend limits and ports are numbers. A watch port can also be `"off"`; watch actions are `"on"` or `"off"`. A watch theme is a theme name or `"auto"`; the default is `"auto"` (see "Themes of the watch page"). The retention days are a whole number of at least 1, or `null` to keep all records and workflow bundles; the default is 30. The retention action is `"archive"` or `"delete"`; the default is `"archive"`. The archive folder is an absolute path, or `null` for the `archive` folder in the state folder. The turn environment is a list of variable names, or `"inherit"`; the default is an empty list (see "What a turn can reach"). The merge mode is `"direct"` or `"queue"`; the default is `"direct"` (see "The GitHub merge queue").

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

Each change holds a file lock from read through atomic replacement, keeping the previous bytes as `<file>.bak`. A first write needs no backup. Private files, backups and temporary files have mode 0600. Locks from stopped processes are reclaimed; a live lock waits at most ten seconds, then exits with `settings-locked`. Invalid settings and unknown fields exit with status 2 without changing a file. For a running service, the result explains whether to run `cloving reload` or to restart to use the new value, or whether an environment or private source will keep hiding it after a restart. Settings do not reload automatically.

Changing or unsetting `harness.name` clears kind, path and command. Changing or unsetting kind clears path and command; changing or unsetting path clears command. This keeps the previous harness's configuration from carrying into a new selection.

The package includes [the project schema](src/project-config.schema.json) and [the private schema](src/private-config.schema.json), also installed under `dist/src/`. Unknown fields fail with `unknown-setting: <field>`, invalid values with `invalid-setting: <field>`, and unsupported or missing versions with `unsupported-config-version: version`. Private fields in the project file fail with `private-setting-in-project-file: <field>`. Files cannot set runtime directories, ownership leases, host bounds or the watch repository; those remain environment settings.

Run `cloving doctor` from the repository before starting the service. It lists each requirement with a fixed code, `ok`, `warn`, `fail` or `skip`, and a fixing command. Required failures and skipped prerequisites exit with status 1. A warning does not change the exit status. `cloving doctor --json` prints the same checks as `{ "version": 1, "checks": [...] }` for setup agents.

The required `no-workflow` check fails when neither the project nor the user folder has a workflow declaration. Its fix is `cloving init`. During `cloving init-prompt` setup, defer this check to the template step, copy or create the workflow, then run doctor again. `no-workflow` must report `ok` before setup is ready.

The optional `retention` check shows the size and the folder count of `journal/` and `github/` in the state folder, the size and the bundle count of `workflow-bundles/`, the age of the oldest kept record folder, and the values of `retention.days`, `retention.action` and `retention.archiveFolder`. The size includes all files in the three folders. The folder count and the age include only the record folders that the retention rule can archive or delete. The bundle count includes only the folders with a bundle digest as name. The age of a folder starts at the change time of its newest file. The check gives `warn` when `retention.days` is `null` and the three folders together are larger than 1 GB (1,000,000,000 bytes). An invalid retention setting fails the check and names the variable.

The optional `turn-environment` check names the variables of the environment of `cloving doctor` that a turn does not get. It shows the names only, never the values. It does not name the `CLOVING_*` settings, `GH_CONFIG_DIR` or the GitHub token variables, because a turn never got them from the service. When a project needs a variable from the list, add its name to `turns.environment`. The check gives `warn` when `turns.environment` is `"inherit"`. An invalid value fails the check and names the variable.

Doctor probes harness versions and effective executable paths without running a turn. Shell scripts and simple `node script` wrappers receive `--version` from the repository folder; unsupported launcher arguments fail the probe. GitHub login and reads use the origin's host, including GitHub Enterprise. GitHub calls are reads limited to ten seconds each; a service probe waits at most five seconds. Recent Greptile activity does not establish that a usable review is available, and missing activity does not prove the app is absent.

## First run

```sh
cloving init
```

Run this in your git repository. Choose the agent harness for setup; Cloving saves it in your private repository settings and opens the agent with ``run `cloving init-prompt` `` as its first message. The agent walks through setup, a first run and a first ticket with you.

Use `cloving init --harness <name or path>` to skip the question. A name with both a file and a shell entry needs an explicit path or `--harness shell:<name>`. A later `cloving init` lists your current default first. The harness stays attached to your terminal, uses its normal permissions and returns its exit status when the session ends.

### The service and its settings

`cloving start` starts one Cloving service for the git repository of the current directory, with the workflow host, the Claude worker and the watch page. `--repository` selects a different repository. Stop the service with Control-C. A stop of the service stops a turn in work; submit that ticket again.

Each repository has its own default runtime directory: `<root>/cloving/<name>-<id>/run`. The root is `XDG_RUNTIME_DIR`, then `XDG_STATE_HOME`, then `~/.local/state`. The name keeps only letters, digits, `-` and `_` from the git top-level folder name, up to 24 characters. The ID is the first eight hexadecimal characters of the SHA-256 digest of that folder's real path. Commands in the repository find its service automatically; outside it, use `--repository <directory>` or `CLOVING_RUNTIME_DIR`. The start guide prints commands with the service repository already selected. `CLOVING_RUNTIME_DIR` overrides both the recorded adoption and the default for clients and start.

On start, Cloving keeps the old default runtime path only when all retained workflow bundles beside it validate for this repository. It records that choice under `<state>/cloving/adopted-runtime/<name>-<id>.json`, where state is `XDG_STATE_HOME` or `~/.local/state`. Clients reuse the record. With no bundles, foreign or mixed repositories, or damaged bundles, start uses the new default and prints a note with the old path. No state moves. The directory above the runtime directory still holds the authority state, Local World data, turn records and git work trees. Set a different `CLOVING_WATCH_PORT` for a second service.

`cloving watch` serves a local page on `http://127.0.0.1:3663/` (`--port` selects a different port). The page shows the runs, the events, the work of the worker as it occurs, and each pending decision with its approve and deny commands. `cloving start` starts the page too; `CLOVING_WATCH_PORT` selects its port, and the value `off` starts none.

The page opens on the **Floor**. Each workflow is one line with its name, its count of active runs, its stations and the line end. The stations are the declared stages of the workflow in order. Each active run is a token under the station of its current step. A token shows the worker initial (`Y` when the run needs you), the ticket number (`Draft` for a run with no ticket) and the time at that step. Select a token to open the run.

The diamond lamp of a station shows the most urgent state of its runs: stopped (red), needs you (blue), waiting (yellow), then running (green). A station with no run has an empty lamp. The line end of a scheduled workflow shows its next run time. When the service has a ready-ticket command, the line end of the queue workflow shows the count of ready tickets and the oldest wait. The count does not include a ticket that is in work or that waits for a dependency. Select a workflow name to open its board with its columns and cards. The header shows the count of active runs and the count of runs that need you. When the service has a queue, **Drain queue** and **Resume queue** send the same commands as `cloving queue drain` and `cloving queue resume`.

The **Needs you** panel under the floor lists each pending decision, each paused run, and each failed or blocked run with no continuation, with the count of items. A decision has a blue mark. A paused, failed or blocked run has a red mark. Each item shows the run title, one sentence that tells you what to do, the workflow and the wait time. The item that waited longest is first. **Answer** opens the run with its decision form. **Open run** opens the run with its stop reason. With no item, the panel shows "Nothing needs you."

The **Today** panel at the side of the floor shows the numbers of the day: the runs completed, the cost, the cost per completed run and the stopped runs. A stopped run is a run that ended as failed, cancelled or blocked. Under the completed runs and the cost, the panel shows the values of yesterday. A bar chart shows the completed runs of each of the last 7 days, today last. A table shows the completed runs and the cost of today for each workflow. The last line shows the queue state, with one mark for each lane, busy or free.

A day starts at local midnight of the computer that runs the service. The panel counts a run on the day that the run ends. It uses the same events, outcomes and run costs as `cloving report`. A cost shows as unknown when the cost of one of its runs is not known.

Below the floor, the **Completed today** shelf shows the count of runs that completed today, and one tile for each run, the newest first. The shelf uses the same day as the Today panel. A blocked run has no tile. A tile shows the ticket number, the pull request number, the title in at most two lines, the workflow, the time from start to end and the cost. The left edge of a tile has the color of the line of its workflow. When the run attached a video (`.mp4` or `.webm`) with the GitHub method `attach-asset`, the tile also shows **Play demo** with a small frame of the video. Select it to play the video in a player on the page. Press Esc or click outside the player to close it. The shelf scrolls sideways when the tiles do not fit. With no completed run, the shelf shows "No run completed today."

Each workflow board with supported inputs has **+ Add a card** at the bottom of its first column, including an empty board. The form uses the string and ticket fields of the workflow's registered declaration. Ticket fields are labeled **Ticket ID**; other fields use their declared names, and optional fields can be left out. Unsupported inputs have no control. Select **Add card** or press Enter in a field to send. **Cancel** and Esc close the form. The service reply shows the admitted run ID or a refusal code; admitted cards arrive through the existing live stream.

The form sends the same run request as the CLI and retains its random command ID for retries, including a lost reply. Retry the same form to avoid duplicate runs. The write endpoint accepts at most 16 KiB of JSON, requires the page's random token, matching Origin and a loopback/localhost Host with the bound port, and allows no cross-origin preflight. `CLOVING_WATCH_ACTIONS=off` removes the form control, the queue control and their endpoints; actions are enabled by default. Decisions and other run actions still use their displayed CLI commands.

`cloving start` reads its settings from the environment. `cloving start --help` gives the form and the default of each setting:

- `CLOVING_RUNTIME_DIR`: the runtime directory.
- `CLOVING_TICKET_COMMAND`: the ticket command (see "Daily development").
- `CLOVING_NOTIFY_COMMAND`: a JSON list naming a command to notify the operator about pending decisions, blocked runs, failed runs and stopped schedules. It has no default.
- `CLOVING_NEXT_COMMAND`: a JSON list of a command and its arguments that prints the next ready ticket ID for `--next`. It has no default.
- `CLOVING_READY_COMMAND`: a JSON list of a command and its arguments that prints the list of ready tickets for the watch page (see "Daily development"). It has no default.
- `CLOVING_CLAUDE_COMMAND`: a replacement of the `claude` command of the worker.
- `CLOVING_PROFILES`: a JSON file of named turn profiles. The service reads it at the start and at each `cloving reload`.
- `CLOVING_COMMANDS`: a JSON object mapping command names to argument arrays, such as `{"review-requests":["/opt/cloving/scan-reviews.mjs"]}`. Names contain 1–64 ASCII letters, digits or hyphens; the first argument must be an absolute executable path. Unset means no commands. Invalid values stop startup with `invalid-commands`.
- `CLOVING_COMMAND_SECONDS`: a whole number from 1 to 3600, default 60. Invalid values stop startup with `invalid-command-seconds`. A command exceeding the deadline fails with `command-timeout`.
- `CLOVING_WATCH_ACTIONS`: `off` disables starting runs from the board and the queue control; default `on`.
- `CLOVING_WATCH_PORT`: the port of the watch page, or `off`.
- `CLOVING_WATCH_REPOSITORY`: repository context for a separate watch process. `start` sets this from its service repository. The watch process uses its local origin and has no current-directory default.
- `CLOVING_OWNERSHIP_LEASE_SECONDS` and `CLOVING_HOST_BOUND`: limits of the workflow host.
- `CLOVING_GH_COMMAND`, `CLOVING_CHECK_COMMAND` and `CLOVING_PRIVATE_TEXTS`: settings of `develop`; the GitHub command and private-text list also apply to `idea-to-issue`.

A command setting is a JSON list of texts, for example `CLOVING_CHECK_COMMAND='["npm", "test"]'`.

The notify command receives no added argument. Its standard input receives one JSON object with `event`, `runId`, `workflowId`, `subject` and `body`. The body contains the decision or outcome text already shown by `cloving questions` or `cloving status`, with complete response commands, up to 4000 characters. The daemon checks every 15 seconds. The first check with no notification record only records existing events.

The private `notify-events.json` journal records a notification as `pending` before calling the command and as `sent` after exit code 0. A failed command retries the same message after 1, 5, 15 and 60 minutes, with five attempts in total and a 30-second limit per attempt. The journal records attempt times and fixed failure reasons without command arguments or output. Pending and retryable failed entries resume after restart. Exhausted delivery logs one line naming its key. Old key-only records migrate as sent without sending them again.

Journal updates use a temporary file and rename. Sent and exhausted failed delivery details expire after seven days; their keys remain to prevent later duplicate delivery. Unfinished deliveries remain until resolved. A crash after command success but before recording that success can repeat delivery. Decisions opened and closed between checks can be missed.

#### Stalls of the thread pool

On macOS, a libuv defect can stop the thread pool of a long-running Node process (libuv issue 5280). Sockets and timers continue to work, but file reads never end. Cloving finds such a stall, logs it and recovers the watch page:

- Each reply of the watch page has a deadline of 10 seconds. A reply that does not end before the deadline gets status 503, and the watch page logs `watch-reply-timeout path=<route> ms=<elapsed>`. For the read API, the 503 reply is `application/problem+json` with the code `timeout`. The event streams `/events` and `/api/v1/stream` stay open.
- The watch page and the daemon check the thread pool at their start and then every 60 seconds. The check reads the status of `package.json` of the install with `fs.promises.stat`. When the check has no answer after 5 seconds, the process logs `threadpool-stalled ms=<elapsed> resources=<name>:<count>,...` with the counts of `process.getActiveResourcesInfo()`.
- After a stall, the watch page stops with exit code 70. A normal exit waits for the stalled threads, so the watch page replaces its process with a new Node process that exits with code 70.
- `cloving start` starts the watch page again when it stops while the daemon runs, and logs `watch-restart code=<exit code> delay=<wait>ms` for each restart. The first wait is 1 second. Each exit less than 60 seconds after the start doubles the wait. After 5 restarts in 10 minutes, the next exit stops the restarts with the line `watch-restart-stopped code=<exit code> reason=restart-limit restarts=5 window=600000ms`. A stop of the daemon also stops the watch page, and the watch page does not start again.
- The daemon does not stop after a stall. `cloving status` shows `Thread pool: stalled;` with the time of the check, and `cloving status --json` has the latest check in `threadPool`. To recover the daemon, stop the service with Control-C and start it again.
- `http://127.0.0.1:3663/health.json` gives `{ "threadPool": <latest check or null> }` from memory, with no file read.
- The `thread-pool` check of `cloving doctor` asks the running daemon and the running watch page for their latest check. It fails when a check is stalled, and it warns when the watch page does not send a full answer in 5 seconds. The check is not required.

#### Read API of the watch page

The watch page has a read API at `http://127.0.0.1:3663/api/v1`. Its OpenAPI 3.1 document is at `http://127.0.0.1:3663/api/v1/openapi.json`. OpenAPI client generators can read the document and make a typed client. The API accepts only `GET` and needs no authentication. An error reply is `application/problem+json` with a `code` member, for example `not-found` or `invalid-query`.

- `GET /api/v1/` gives the version of the API and its endpoints.
- `GET /api/v1/openapi.json` gives the OpenAPI document.
- `GET /api/v1/service` tells if the Cloving service answers.
- `GET /api/v1/workflows` gives the workflows with their counts and card fields.
- `GET /api/v1/runs` gives one page of runs, newest first. The query parameters `workflowId`, `state`, `limit` (1 to 200, default 50) and `cursor` select the runs. The `nextCursor` of a page gives the next page.
- `GET /api/v1/runs/{runId}` gives one run with its phases, open decisions, reviews and agent turns.
- `GET /api/v1/runs/{runId}/events` gives the events of one run, the lowest sequence first. The query parameter `after` (default 0) gives only the events with a higher sequence.
- `GET /api/v1/stream` sends Server-Sent Events. Each message has the event `change` and the data `{"updatedAt":"<time>"}`. Read the runs again when a message arrives.

Replace `<run-id>` with the ID of a run of `develop`, for example from the run list:

```sh
curl http://127.0.0.1:3663/api/v1/
curl http://127.0.0.1:3663/api/v1/openapi.json
curl http://127.0.0.1:3663/api/v1/service
curl http://127.0.0.1:3663/api/v1/workflows
curl 'http://127.0.0.1:3663/api/v1/runs?workflowId=develop&state=waiting_gate&limit=20'
curl 'http://127.0.0.1:3663/api/v1/runs/<run-id>'
curl 'http://127.0.0.1:3663/api/v1/runs/<run-id>/events?after=40'
curl -N http://127.0.0.1:3663/api/v1/stream
```

The run list has the active runs and the runs of the last 7 days. The run detail reads each run, also a run older than 7 days. The events endpoint gives no event payloads, and the API has no write endpoint.

#### Themes of the watch page

A theme gives the watch page other colors, sizes, fonts, art and words. A theme contains only data: it cannot add CSS text, selectors or JavaScript. Cloving checks each theme before use, and a theme with a refusal code is not usable. The Cloving logo and its colors do not change with a theme.

A theme is a folder with a `theme.json` file and an optional `assets` folder. Cloving finds themes in three places:

1. The built-in themes of the package: `floor`, `floor-at-night` and `workshop` (see "Built-in themes").
2. The user folder `<config>/cloving/themes/<name>`. `<config>` is an absolute `XDG_CONFIG_HOME`, or `~/.config` otherwise.
3. The project folder `.cloving/themes/<name>` in the repository. The watch process of `start` uses the service repository in `CLOVING_WATCH_REPOSITORY`.

A project theme replaces a user theme with the same name, and a user theme replaces a built-in theme. A refused theme also replaces the theme of the same name. The folder name is the name of the theme. It has 1 to 64 lowercase letters, digits and single hyphens, and starts with a letter. The name `auto` is reserved.

`cloving themes list` shows each theme with its name, its place, `usable` or its refusal codes, the places that it replaces and the `name` in `theme.json`. `cloving themes list --json` prints the same data as one JSON list of `{ name, place, title, colorScheme, usable, codes, replaces }`. The places are `project`, `user` and `built-in`. When Cloving cannot read a place folder, the command stops with `unreadable-theme-folder`. The private setting `watch.theme` selects a theme by its name, or `auto`. The default is `auto`. The `theme` check of `cloving doctor` reports a selected theme that is missing or refused.

```sh
cloving themes list
cloving config set watch.theme workshop
cloving doctor
```

The header of the watch page has a theme menu. The menu shows `Auto` and each usable theme. A choice in the menu applies at once, and the browser keeps it for the next visits. With no choice in the browser, the page uses `watch.theme`. `auto` uses the theme `floor` when the browser uses a light color scheme, and `floor-at-night` when it uses a dark color scheme. When the selected theme is refused or missing, the page uses the default theme and shows a short notice, for example "The page uses the default theme: the theme workshop is refused: invalid-color." When `auto` finds no `floor` or `floor-at-night` theme, the page uses the default theme with no notice.

##### Built-in themes

Cloving has three built-in themes. Each one is a theme folder in the `themes` folder of the package, in the same theme format as your own themes (see [The theme format](#the-theme-format)). Copy a built-in folder to the user folder or to the project folder to start a theme of your own.

- **Floor** (`floor`) is the default for a light browser. It has concrete and steel colors and the safety colors for the states: green for running, yellow for waiting, blue for needs you and red for stopped. Buttons and run tokens have angled corners (`shape.cut` of 7 px). It uses the fonts Barlow and Barlow Semi Condensed.
- **Floor at night** (`floor-at-night`) is the default for a dark browser. It has the same structure as Floor, with colors for a dark room.
- **Workshop** (`workshop`) shows how far a theme can go with only tokens, art and words. It has a tile floor, a brick header, pennant banners, benches as stations, worker sprites as run tokens and a shoe badge on the tiles of the Completed today shelf. Its words include "Workshop", "Bulletin board", "Inspector", "Help desk" and "shoes". It uses the pixel fonts Silkscreen and Pixelify Sans.

In each built-in theme, the text colors have a contrast of at least 4.5:1 on the page and panel colors. The package includes the font files with their licenses in `assets/watch-fonts`. All the fonts use the SIL Open Font License 1.1.

![Floor](https://github.com/user-attachments/assets/bd6afd21-8e26-4330-bb3f-bc0d520cc51c)

![Floor at night](https://github.com/user-attachments/assets/ef7b02fa-c51b-41d1-a491-4705429e8146)

![Workshop](https://github.com/user-attachments/assets/d16acc47-e27e-4f76-a09e-8b8ce11deffc)

##### How the page applies a theme

The watch server puts each usable theme on the page as CSS custom properties, one for each token. The name of a property is the token name with `-` in place of `.`, for example `--color-state-running` and `--shape-cut`. The page takes its colors, corner cuts, borders, text size, gaps and fonts from these properties. Only the logo, the colors of the workflow lines, the text on state colors and the error text in code windows keep fixed colors. Each art slot that a theme sets becomes the page class `art-<slot>`, for example `art-station`, and the custom properties `--art-<slot>`, `--art-<slot>-repeat` and `--art-<slot>-rendering`, for example `--art-station`, `--art-station-repeat` and `--art-station-rendering`. A slot in `mask` mode also gives the class `art-<slot>-mask`, for example `art-station-mask`. The server serves the art files at `/themes/<name>/assets/<path>`, only for a usable theme and only for the files of its art slots.

| Art slot | Place on the page |
| --- | --- |
| `floor` | The background of the floor. |
| `header` | The background of the header. |
| `line-banner` | The background of the name of each workflow line. |
| `station` | Each station, in place of the lamp. A small state mark at the corner keeps the state visible. |
| `run-token` | Each run token, in place of the worker initial. The token keeps its state color. |
| `completed-badge` | A badge on each tile of the Completed today shelf. |

An `image` slot shows the file as it is. A `mask` slot uses the file as a shape and fills it with a color of the theme: the state color for a station, the text color on a state for a run token, the completed color for a badge and the line color for a background. The state mark of a station stays outside the shape.

##### The theme format

`theme.json` uses the W3C Design Tokens Format Module 2025.10. The tokens are in groups. Each token has a `$value` and a `$type`, or it gets the `$type` of its group. A group `$type` is `color`, `dimension` or `fontFamily`. A token or a group can also have a `$description` text. Cloving refuses all other `$` properties and aliases. A token or group name cannot contain `.`, `{` or `}`. The theme data that is not a token is in `$extensions` under the key `ai.cloving.theme`:

- `name`: the name that people see, plain text of 1 to 60 characters.
- `colorScheme`: `light` or `dark`.
- `art`: optional art slots.
- `words`: optional words.

```json
{
  "color": {
    "page": { "$type": "color", "$value": { "colorSpace": "srgb", "components": [0.843, 0.855, 0.835], "hex": "#D7DAD5" } },
    "state": { "running": { "$type": "color", "$value": { "colorSpace": "srgb", "components": [0.122, 0.616, 0.333], "hex": "#1F9D55" } } }
  },
  "shape": { "cut": { "$type": "dimension", "$value": { "value": 7, "unit": "px" } } },
  "$extensions": {
    "ai.cloving.theme": {
      "name": "Workshop",
      "colorScheme": "light",
      "art": { "station": { "src": "assets/bench.svg", "mode": "image", "pixelated": true } },
      "words": { "completed.unit": { "one": "shoe", "other": "shoes" } }
    }
  }
}
```

A theme can set only these token names. All tokens are optional.

| Tokens | `$type` | Values |
| --- | --- | --- |
| `color.page`, `color.surface`, `color.panel`, `color.ink`, `color.muted`, `color.line` | `color` | A color |
| `color.accent`, `color.accent-strong`, `color.on-accent`, `color.warn`, `color.bad` | `color` | A color |
| `color.code.background`, `color.code.header`, `color.code.text`, `color.code.line`, `color.code.muted` | `color` | A color |
| `color.state.running`, `color.state.waiting`, `color.state.attention`, `color.state.completed`, `color.state.failed` | `color` | A color |
| `shape.cut`, `shape.radius` | `dimension` | 0 to 32 px |
| `shape.border` | `dimension` | 0 to 8 px |
| `size.text` | `dimension` | 10 to 24 px |
| `size.gap` | `dimension` | 0 to 48 px |
| `font.ui`, `font.heading`, `font.code` | `fontFamily` | A list of font names |

A color is a hex value `#RRGGBB` or `#RRGGBBAA`, or a color object. A color object has the `colorSpace` `srgb` and three `components` from 0 to 1. It can also have an `alpha` from 0 to 1 and a `hex` value `#RRGGBB`. A dimension is an object with a `value` in the range of its token and the `unit` `px`. A font family is a list of 1 to 8 font names. A font name has 1 to 64 letters, digits, spaces, `_` and `-`, and starts and ends with a letter or a digit. The watch page includes the fonts Barlow, Barlow Semi Condensed, Fira Code, Heebo, Pixelify Sans, Silkscreen and Space Grotesk. A theme can use other font names only for fonts that the computer of the browser has.

A theme can set art in these slots: `floor`, `header`, `line-banner`, `station`, `run-token` and `completed-badge`. Each slot is an object with these fields:

- `src`: the path of a file in the `assets` folder, for example `assets/bench.svg`, with at most 200 characters. Each part of the path has letters, digits, `.`, `_` and `-`, and starts with a letter, a digit, `_` or `-`. A path cannot contain spaces.
- `mode`: `image` or `mask`.
- `repeat`: optional, `none`, `x`, `y` or `both`.
- `pixelated`: optional, `true` or `false`.

An art file is SVG, PNG or WebP, with the extension `.svg`, `.png` or `.webp`. Its content must agree with its extension, and its size is at most 512 KB (524288 bytes). A symbolic link in `assets` must not point out of the `assets` folder.

An SVG file is UTF-8 text with the root element `svg`. Cloving checks it with these rules:

- Only these elements: `svg`, `g`, `defs`, `symbol`, `use`, `title`, `desc`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `text`, `tspan`, `linearGradient`, `radialGradient`, `stop`, `pattern`, `clipPath`, `mask`, `marker`, `filter`, and the filter elements `feBlend`, `feColorMatrix`, `feComponentTransfer`, `feComposite`, `feConvolveMatrix`, `feDiffuseLighting`, `feDisplacementMap`, `feDistantLight`, `feDropShadow`, `feFlood`, `feFuncA`, `feFuncB`, `feFuncG`, `feFuncR`, `feGaussianBlur`, `feMerge`, `feMergeNode`, `feMorphology`, `feOffset`, `fePointLight`, `feSpecularLighting`, `feSpotLight`, `feTile` and `feTurbulence`. Thus an SVG file has no `script`, `style`, `foreignObject`, `image`, `a` or animation element, and no element with a prefix.
- No event attribute such as `onload`. An attribute name has no prefix, but `xlink:href`, `xml:space`, `xml:lang` and `xmlns:xlink` are permitted. `xmlns` must be `http://www.w3.org/2000/svg`, and `xmlns:xlink` must be `http://www.w3.org/1999/xlink`.
- No external reference: an `href` or `xlink:href` is `#` and an element ID, and a `url(` refers only to an element in the same file, for example `url(#shade)`. An attribute value can use only the functions `rgb`, `rgba`, `hsl`, `hsla`, `translate`, `scale`, `rotate`, `matrix`, `skewX`, `skewY`, `var` and `calc`.
- No comment, no CDATA section, no character reference such as `&#117;`, no entity other than `&amp;`, `&lt;`, `&gt;`, `&quot;` and `&apos;`, no backslash, no `DOCTYPE` or `ENTITY`, and no processing instruction other than the XML declaration. Each attribute value is in quotation marks.
- One complete `svg` root element. Each element closes with a tag of the same name or with `/>`. Outside the root, the file has only spaces, tabs and line breaks. An attribute value has no `<`, and an element has each attribute name one time only.

A theme can set only these words:

| Word key | Form | Place on the page |
| --- | --- | --- |
| `workflows.title` | text | The heading of the floor, now "Floor" |
| `column.done` | text | The name of the board column "Done" |
| `column.stopped` | text | The name of the board column "Stopped" |
| `state.attention` | text | The mark of a board card that needs attention, now "Needs attention" |
| `state.decision` | text | The mark of a board card with a waiting decision, now "Decision waiting" |
| `station.agent` | text | The name of an agent step on the floor and on the board, now "Agent turn" |
| `station.review` | text | The name of a review step on the floor and on the board, now "Your review" |
| `totals.label` | text | The label of the totals of a board card, now "Totals" |
| `today.title` | text | The heading of the Today panel, now "Today" |
| `needs.title` | text | The heading of the Needs you panel, now "Needs you" |
| `ready.count` | plural | The count of ready tickets at the end of a workflow line, now "3 ready" |
| `completed.unit` | plural | The unit of the count on the Completed today shelf |
| `run.unit` | plural | The unit of the count on the Completed today shelf, when `completed.unit` is not set |
| `ticket.unit` | plural | The unit of the count of skipped tickets of the queue |

A text word is plain text of 1 to 60 characters, with no control characters and no `<`, `>`, `{` or `}`. A plural word is an object with the forms `one` and `other`. Each form is plain text of 1 to 60 characters and can contain `{count}`. The page uses `one` for a count of 1 and `other` for all other counts. A form with `{count}` gets the count in its place; a form with no `{count}` comes after the count, for example "3 shoes".

| Refusal code | Cause |
| --- | --- |
| `missing-theme-file` | The folder has no `theme.json` file, or `theme.json` is a symbolic link. |
| `theme-file-too-large` | `theme.json` is larger than 256 KB. |
| `invalid-theme-json` | `theme.json` is not valid JSON. |
| `invalid-folder-name` | The folder name is not a theme name. |
| `reserved-theme-name` | The folder name is `auto`. |
| `invalid-theme-folder` | The theme folder is a symbolic link. |
| `missing-theme-data` | `$extensions` has no `ai.cloving.theme` object. |
| `unknown-extension` | `$extensions` has a key that is not `ai.cloving.theme`. |
| `unknown-theme-field` | `ai.cloving.theme` has a field that is not `name`, `colorScheme`, `art` or `words`. |
| `invalid-name` | `name` is not plain text of 1 to 60 characters. |
| `invalid-color-scheme` | `colorScheme` is not `light` or `dark`. |
| `unknown-token` | A token or a group has a name that is not in the token table. |
| `invalid-token` | A token has no `$value` or no `$type`, or a token or a group has an unknown `$` property. |
| `token-type-mismatch` | The `$type` of a token is not the type of its name. |
| `invalid-color` | A color token has a value that is not a color. |
| `invalid-dimension` | A dimension token is not in `px` or is out of its range. |
| `invalid-font-family` | A font family token is not a list of font names. |
| `css-text` | A text contains `url(`, `expression(`, `@import`, `javascript:` or a tag. |
| `unknown-art-slot` | `art` has a slot that is not in the slot list. |
| `invalid-art` | An art slot has an unknown field, no `mode`, or a value that is not permitted. |
| `invalid-asset-path` | An art `src` is not a path in `assets`, or it points out of `assets`. |
| `invalid-asset-type` | An art file is not SVG, PNG or WebP, or its content does not agree with its extension. |
| `missing-asset` | An art file is not there, or it is not a file. |
| `unreadable-file` | Cloving cannot read `theme.json` or an art file. |
| `asset-too-large` | An art file is larger than 512 KB. |
| `svg-script` | An SVG file has a `script` element or a `javascript:` text. |
| `svg-event-attribute` | An SVG file has an event attribute. |
| `svg-foreign-object` | An SVG file has a `foreignObject` element. |
| `svg-element` | An SVG file has an element that is not in the element list. |
| `svg-attribute` | An SVG file has an attribute or a function that is not permitted. |
| `svg-external-reference` | An SVG file refers to another file or address. |
| `svg-doctype` | An SVG file has a `DOCTYPE` or an `ENTITY`. |
| `svg-markup` | An SVG file has a comment, CDATA, a character reference, a backslash, a processing instruction, a tag that is not complete, or tags that do not make one complete `svg` element. |
| `unknown-word` | `words` has a key that is not in the word table. |
| `invalid-word` | A word is not plain text of 1 to 60 characters, or it does not have its form. |

### Use Cloving from an MCP client

`cloving mcp --repository <directory>` serves Cloving tools to an MCP client over standard input and output. The server connects to the service of that repository. Start the service with `cloving start` before the client calls a tool.

Register the server in Claude Code:

```sh
claude mcp add cloving -- cloving mcp --repository <directory>
```

Register the server in Codex with this table in `~/.codex/config.toml`:

```toml
[mcp_servers.cloving]
command = "cloving"
args = ["mcp", "--repository", "<directory>"]
```

The server has eleven tools:

- `cloving_status`, `cloving_questions` and `cloving_events` read the runs, the pending decisions and the events, as `cloving status`, `cloving questions` and `cloving events` do.
- `cloving_run` submits a run, as `cloving run` does. Give exactly one source: `prompt`, `ticket` (a ticket ID or `next`) or `input` (a JSON object, not a file path).
- `cloving_answer`, `cloving_approve` and `cloving_deny` record a decision. Read `reference`, `expectedRevision`, `generation` and `subjectDigest` from `cloving_questions`.
- `cloving_pause`, `cloving_resume` and `cloving_drop` send a run command with the `expectedRevision` of the run.
- `cloving_continue` continues a failed or blocked run, as `cloving run continue` does. The arguments `from` and `bundle` are optional.

Each of the eight tools that change state requires a `commandId`. The server never makes a command ID. After a lost reply (`outcome-unknown`), send the same request with the same `commandId` again. The service then gives the stored receipt, also when the first request came from the CLI. A tool gives the same JSON object as the CLI command with `--json`. A refusal of the service gives `isError: true`, and an argument that is not valid gives the JSON-RPC error `-32602`. A cancel of a tool call stops the wait for the reply, but it does not cancel a command that the service admitted.

A tool call cannot start the service and cannot select a different repository. The server binds to one repository when it starts.

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

The implemented report values are:

| JSON value                                     | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `metrics.tickets.completed` | Issue close events with reason `completed` in the window. Reopened issues retain their completed closes. Each completed close counts, including repeated closes. Pull requests and other close reasons are excluded. `semantics.tickets` is `closed-completed-in-window`. |
| `metrics.pullRequests.merged`                  | Pull requests with a GitHub merge timestamp in the window. Closed, unmerged pull requests are excluded.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `metrics.runs.completed`                       | Terminal `run.completed` events with no outcome or with `handoff_requested`, excluding partial ticket handoffs.                                                                                                                                                                                                                                                                                                                                                                                             |
| `metrics.runs.partial`                         | Handoffs explicitly marked with partial ticket status.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `metrics.runs.blocked`                         | Terminal `run.completed` events with the blocked outcome.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `metrics.runs.failed`                          | Terminal `run.failed` events.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `metrics.runs.cancelled`                       | Terminal `run.cancelled` events.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `metrics.cost.medianRunUsd`                    | Median lifetime actual turn cost among runs ending in the window. Any unknown run cost makes this value unavailable.                                                                                                                                                                                                                                                                                                                                                                                        |
| `runCosts`                                     | Each ended run's outcome, end time, actual total USD cost, individual turn operation IDs and actual prices, plus the historical daily median run-cost baseline. All of a run's turn cost is attributed to its end time, including turns before the window. Estimates never replace unknown actual prices. An observed run with no worker turns and settled effects has cost zero. A cancelled run that is still draining, or any unresolved effect, leaves its total unavailable. Active runs are excluded. |
| `metrics.fixRounds.medianPerMergedPullRequest` | Median count of `run-turn` operations after the first `open-pr` request, for each successful merge in the window. Evidence includes the run ID, pull request number, merge operation ID and fix-round count. Unmerged runs do not contribute.                                                                                                                                                                                                                                                               |
| `metrics.leadTime.medianHours`                 | Median hours from the last `cloving: ready` label before each completed ticket's close to that close. The command reads all issue timeline pages, including labels before the window. Evidence includes issue numbers and label and close times. An unreadable timeline or missing ready label leaves the value unavailable.                                                                                                                                                                                |
| `metrics.phases.workerTurn.medianMinutes`      | Median minutes from request to report for `run-turn` operations that end in the window, including failed operations. Evidence includes run IDs and operation IDs.                                                                                                                                                                                                                                                                                                                                           |
| `metrics.phases.codeReview.medianMinutes`      | Median request-to-report minutes for `wait-review` operations that end in the window.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `metrics.phases.merge.medianMinutes`           | Median request-to-report minutes for `merge` operations that end in the window. This duration includes the merge check and CI wait; separate times are unavailable.                                                                                                                                                                                                                                                                                                                                         |
| `metrics.cost.medianCompletedTicketUsd`        | Median total actual run cost for tickets that close as completed in the window. Each ticket includes all of its ended attempts at report time, including older partial, blocked, failed and cancelled attempts.                                                                                                                                                                                                                                                                                                 |
| `completedTicketCosts`                         | Each completed ticket's issue number, close time, total USD cost, contributing runs and turn prices, evidence and historical daily median ticket-cost baseline. An unknown turn price, unreadable run identity or absent run history leaves the cost null. Estimates never replace actual prices.                                                                                                                                                                                                           |
| `metrics.flow.busyLaneShare` | Queue run active milliseconds divided by current lanes times window milliseconds. Runs start at `run.started` and end at their terminal event; crossing and ongoing runs are clipped to the window. Evidence names the workflow, current lanes and runs. |
| `metrics.flow.idleLaneHoursWithReadyTicket` | Elapsed hours with fewer active queue runs than lanes and at least one eligible ready ticket. An interval counts once even when several lanes are idle or several tickets are eligible. |
| `metrics.flow.readyWaitHours.dependency` | Sum of ticket-hours carrying `cloving: ready` while at least one issue in the ticket's current `Needs` lines is open. Tickets without `Needs` have no dependency wait. Evidence names tickets and dependencies. |
| `metrics.flow.readyWaitHours.noLane` | Sum of eligible ticket-hours while all current queue lanes are occupied. Eligibility requires the ready label and every needed issue closed. |
| `metrics.flow.peakActiveRuns` | Largest simultaneous active run count across all workflows in the window, with the run IDs at the first peak. |
| `metrics.flow.scheduleSkips` | Total `schedule.skipped` events in the window. `metrics.flow.scheduleSkips.<workflowId>` gives the count for each observed workflow, with workflow IDs and event sequences. |
| `metrics.flow.unsuccessfulStreak.current` | Number of consecutive last-ended runs whose outcome was not completed at the window end, including a streak starting before the window. Terminal time orders runs, with event sequence breaking ties. Evidence names the streak's runs. |
| `metrics.flow.unsuccessfulStreak.longest` | Longest unsuccessful streak among runs ending in the window. A completed outcome resets both streaks; partial, blocked, failed and cancelled outcomes extend them. |
| `ci.jobMinutes.localMacos` | Median job duration in minutes. The same key is available for `localLinux`, `hostedMacos` and `hostedLinux`. Evidence gives job IDs, run IDs, attempts, names, duration and limit. |
| `ci.jobLimitShare.localMacos` | Median of each job's duration divided by its own `timeout-minutes`. Also reported for `localLinux`, `hostedMacos` and `hostedLinux`. A job with no known limit contributes duration without a share. |
| `ci.runnerWaitMinutes.localMacos` | Median minutes from job creation to start, also reported for `localLinux`, `hostedMacos` and `hostedLinux`. |
| `ci.timeouts` | Jobs with conclusion `timed_out`, or duration at least their known limit. Each job counts once, with job and run IDs as evidence. |
| `ci.reruns` | Workflow runs whose latest attempt number exceeds one. Each run counts once at the latest attempt start (`run_started_at`, falling back to `updated_at`). Evidence includes run IDs and attempt numbers. |
| `operator.merges` | Merged pull requests with no completed daemon `merge` effect reporting `merged: true` or the daemon's merge commit SHA for that pull request number before report end. |
| `operator.labelChanges` | `labeled` and `unlabeled` events for `cloving:` labels with no daemon `label` effect ending within two minutes for the same issue. This is a time match, recorded in `semantics.operatorLabels`; it does not identify the actor. Evidence gives issue numbers, event IDs, label and change type. |
| `quality.mainFirstPassShare` | CI runs on `main` that passed on attempt 1, divided by all CI runs created in the window. Later successful attempts do not count as first passes. No runs gives unavailable. Evidence includes run IDs, commits and first-attempt conclusions. |
| `quality.flakyFailures` | Failed job names and commits with a later successful attempt. Each job-name and commit pair counts once. Evidence includes test names from the failed logs, the commit, run IDs and failed and successful job IDs. |
| `quality.realFailures` | Failed job names and commits without a later successful attempt. Repeated failed attempts count once per job-name and commit pair. Evidence includes the failed job IDs and test names. |
| `quality.revertedPullRequests` | Merged pull requests in the window whose title starts with `Revert "`. Evidence gives the pull request numbers. |
| `quality.reopenedTickets` | Reopened issue events in the window after an earlier completed close. Evidence gives issue numbers, event IDs and the earlier close time. |
| `quality.reviewScore.round1` | Median score reported by the first `wait-review` operation in each run. `round2` and later keys use the operation order in that run. The report time selects the window. Evidence includes run IDs, operation IDs, event sequences and scores. |

Quality values have the same metric fields and seven-day baseline as other metrics. First-pass shares compare directly with daily shares. Failure, revert and reopen counts compare their daily equivalents. Review scores compare daily medians. CI data comes from the workflow named `CI` on `main`, with each run attempt read separately. Closure reasons come from issue events, with a GraphQL close-event read when REST omits the reason. An unreadable close reason leaves closure and reopen values unavailable.

Failure metrics use job completion times. The report scans all run pages and selects recent run activity, including completions and reruns of older runs. First-pass shares use run creation times. Ticket costs count each ticket once at its latest completed close before the report end. Repeated completed closes still count separately toward ticket throughput.

The report reads at most 50 distinct failed job logs, with a 2 MB output limit for each log. `quality.jobLogs` gives `read`, `notRead`, `limit` and `maximumBytes`. Each failed job without readable names uses `unknown`. Unread and unreadable logs do not erase known job failures. Logs use the `Failed tests:` list from the quality gate.

Flow uses the current queue workflow and lane setting and the current ticket bodies, as recorded in `semantics`; earlier settings and bodies are not reconstructed. Ready-label intervals come from all issue timeline pages, including removed and reapplied labels. Dependency closure times come from the current issue records; an open dependency remains blocking. Issue discovery includes every issue so an old, still-ready ticket is retained. This definition uses the label and dependency conditions regardless of ticket closure or assignment. Ready wait sums ticket-hours, while idle time measures elapsed hours. Hours and skip counts compare their per-day equivalent with the baseline; busy share, peak and streak values compare directly. Ready-history baselines start at repository creation; idle and no-lane baselines require both GitHub and daemon history. Unreadable timelines, dependencies or queue identity leave affected values unavailable while independent daemon values remain readable.

Every metric has `value`, `comparisonValue`, `baseline` and `evidence`. Counts retain their requested-window totals in `value`; `comparisonValue` is their equivalent per 24 hours. Medians are not scaled. The baseline uses the seven consecutive 24-hour periods immediately before the window, anchored at the same time of day in UTC. It contains the median and the band from median minus three times the median absolute deviation to median plus three times that deviation. Only values strictly outside the band receive `mark: "outside"`. Individual run and ticket costs use their respective daily median cost bands. With fewer than five complete observed days, `history` is `short`, the median and band are null, and there is no mark. Empty observed days count as zero for counts; days without samples, or with an unknown sample, do not establish a daily median. An unrepresentable numeric band has unavailable history and no mark. Daemon history starts at its earliest retained event; GitHub history starts at repository creation. Ticket-cost history starts at the later of those two dates.

Evidence includes the contributing run IDs and event sequences, issue numbers or pull request numbers. Baseline evidence is separate from current-window evidence. Run cost details also expose each turn's operation ID. The daemon event read is pinned to the first page's latest sequence; later appended events are excluded. Run status and GitHub sources are separate reads, so the report is not an atomic cross-source snapshot.

Each GitHub read uses the existing retry rules: transient network errors and HTTP 500, 502, 503 and 504 receive up to three attempts, with growing waits of 30 and 60 seconds. Read failure, invalid data, an unknown actual price or missing repository context is represented as `unavailable` with a null metric value, rather than zero. A failed source does not hide readable sources. `sources` shows which reads succeeded; the command exits zero when it produces a report, including one with unavailable sources. Invalid command arguments exit two.

CI usage reads the workflow named `CI` on every branch, including every attempt of runs with recent activity. Job completion time selects job samples. Labels containing `self-hosted` identify local runners; other runners are hosted. macOS and Linux come from explicit system labels, falling back for hosted runners to the workflow's image (`runs-on`). Unrecognized runner data leaves job metrics unavailable. Limits come from the workflow file at the run's commit through the GitHub contents API. Only JSON documents are parsed; non-JSON workflows and jobs without numeric limits have duration and wait samples without shares. An unreadable workflow leaves shares and timeouts unavailable while duration, wait and rerun values remain independent. An unreadable job source preserves rerun counts. Unreadable run activity makes CI usage unavailable. `sources.github.ciUsage` reports the all-branch run read. `sources.github.ciUsageJobs` and `sources.github.ciUsageWorkflows` report its job and workflow reads, with failure reasons. These statuses are separate from `ci` and `jobs`, which report quality reads on `main`.

Operator values combine GitHub merges and repository issue-label events with daemon `effect.reported` events joined to their requests. Missing daemon history makes operator values unavailable. Their baselines start at the later of daemon history and repository creation. CI and operator values use the same seven-day median, band, evidence and short-history rules as other report values. CI durations, limit shares and waits compare daily medians; timeout, rerun and operator counts compare daily equivalents. The `coverage` object has no remaining unimplemented report sections. The report performs no model call, writes no state and changes no queue.

## Daily development

`cloving start` compiles and registers only project and user workflows. The start guide lists each registered workflow with a run command that matches its input contract. With no workflow, the service still starts and prints "No workflow. Run: cloving init". Status continues to show stored runs after their workflows have been removed.

To add, change or remove a workflow file while the service runs, run `cloving reload`. The service checks and compiles the workflow files again in a child process. New runs use the new bundle. A run that started before the reload stays on the bundle of its pin, and its agent turn continues. When a workflow file gets a new refusal, for example a compile error, the reload keeps the current workflows and shows the reason. A change of the queue workflow or of a schedule needs a restart. After you remove all workflow files, a reload removes all workflows. `cloving status --json` shows the current `bundleDigest`.

The reload also reads the settings files and the profiles file again. It applies changes of `profiles`, `fallbackModels`, `tokenPrices` and `workflows.folder`. New turns use the new values, and a turn in work keeps the values of its start. A changed `workflows.folder` applies to the workflow part of the same reload. The reply lists these fields in `reloadedFields`. It lists each other changed field in `restartFields`, and the service keeps the old value of that field until a restart. The environment variables of the start keep their precedence over the files. An invalid settings file, an invalid profiles file or a profile that names a harness with no worker at the start of the service refuses the reload with its code, for example `invalid-config-json`, `invalid-profiles` or `harness-no-worker`. Then nothing changes.

Use `cloving init` to choose and configure a template. The `develop` template supports ticket input, queue selection, review and merge choices. The `idea-to-issue` template researches an idea and hands the resulting issue to a declared development workflow. The commands below assume those templates have been copied and configured:

```sh
cloving start                                  # terminal 1, in the repository
cloving run develop --ticket TICKET_ID         # terminal 2
cloving run develop --next                     # select the next ready ticket
printf '%s\n' '{"idea":"Show the cost of each run on the watch page"}' > idea.json
cloving run idea-to-issue --input idea.json
cloving watch                                  # the live page, also started by cloving start
cloving questions
cloving approve DECISION_REF --expected-revision N --generation N --subject-digest DIGEST
cloving deny DECISION_REF --text "FEEDBACK" --expected-revision N --generation N --subject-digest DIGEST
```

The rule: read the diff before you approve.

Claude turns have web research tools by default, an empty GitHub CLI configuration folder, and no GitHub token environment variables. The PRD refusal rules catch the listed private text and common sensitive forms; unlisted private names can pass. A `post-uncertain` result requires checking GitHub before trying another run.

### What a turn can reach

A turn runs on the host as the operator user. It is not a sandbox and not a container. A later ticket adds sandboxed runners.

A turn gets only these variables of the service environment:

- The base list: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `TMPDIR`, `TZ`, `LANG`, `LC_ALL`, `LC_CTYPE`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME` and `XDG_STATE_HOME`.
- The login variables of its own harness. Claude gets `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_CONFIG_DIR`. Codex gets `CODEX_HOME`, `OPENAI_API_KEY` and `OPENAI_BASE_URL`. Gemini gets `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_LOCATION`, `GOOGLE_CLOUD_PROJECT` and `GOOGLE_GENAI_USE_VERTEXAI`. Grok gets `GROK_API_KEY` and `XAI_API_KEY`. OpenCode gets `OPENCODE_CONFIG` and `OPENCODE_CONFIG_DIR`. Cursor Agent gets `CURSOR_API_KEY`. A shell or file harness gets no login variables.
- The `env` values of its profile.
- The variables that the private setting `turns.environment` names.

Cloving also sets `CLOVING_TURN_ID`, `CLOVING_ATTACHMENTS_DIRECTORY` and an empty `GH_CONFIG_DIR`. A turn never gets `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` or `GITHUB_ENTERPRISE_TOKEN`. A turn does not get the other variables, for example `SSH_AUTH_SOCK`, cloud keys or other secrets of the shell that started the service. A shell harness starts a login shell, and the startup files of that shell can set more variables. A harness that signs commits with an SSH agent needs `SSH_AUTH_SOCK` in `turns.environment`. Run `cloving doctor` to see the names that a turn does not get.

For one release, `turns.environment` can have the value `"inherit"`. Then a turn gets the whole service environment except the GitHub tokens, as in earlier versions. A later release removes this value. Commands of `CLOVING_COMMANDS` keep the whole service environment.

A turn can still reach these things:

- All files that the operator user can read or write, which includes the main checkout, the home folder and the credential files in it. The instruction to not change the main checkout is only text in the turn prompt.
- The network, which includes the local network.
- The keychain and the other services of the operator session.
- The credentials of a login that the harness itself stores, for example in its configuration folder.

When a turn ends, Cloving stops each process whose current folder is in the work tree of the run and that started after the start of the turn. Thus a shell that the operator opened in the work tree before the turn stays. Cloving signals a process group only when all processes of the group are new processes in the work tree. Cloving sends SIGTERM, and after 15 seconds SIGKILL to each process that did not stop. It writes one log line for each process, with its process ID and command name. A process that changes its current folder to a place outside the work tree stays.

`cloving status --active` lists only the runs that are not `completed`, `failed` or `cancelled`. It uses the same order and format as `cloving status`. The service selects the active runs before it builds a run view. Thus it makes no view query for a finished run. The number of queries does not change with the number of finished runs, but the service still reads the stored state of each run. `--active` works with `--json`, `--limit` and `--after`. With `--json`, one request returns one page of active runs and its `next` cursor.

`cloving status RUN_ID --json` includes `run.input`, and `cloving status --json` includes `input` on each listed run. It is the normalized submission admitted with the run, such as `{"ticket":"297"}` for a ticket workflow or the submitted fields of another declared workflow. It survives service restarts and excludes resolver-added ticket text and repository paths. Older runs without a stored submission show `null`. The text status of one run shows `Input:` as compact JSON, limited to the first 200 characters with `…` appended when longer. Terminal control and hidden format characters are escaped.

### The ticket command

`CLOVING_TICKET_COMMAND` (a JSON list of texts) names the ticket command. The contract of a ticket command:

- It gets a ticket ID as its last argument and prints the text of the ticket.
- The `develop` template uses the first ticket line as the pull request title, removes leading Markdown heading markers and limits it to 200 characters.
- For `develop`, a line `GitHub issue: <owner>/<repository>#<number>` makes the pull request reference that issue. Cloving closes it after a merge only when the worker reports complete work.

The daemon runs the ticket command when it admits a run. The printed text becomes the stored input of the run, so a later change of the ticket does not change the run. A ticket that the command does not give is refused with `ticket-not-available`. With no ticket command, `develop` is refused with `ticket-source-not-configured`. A ticket ID has letters, digits and the characters `. _ : -` only.

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

`cloving run develop --next` uses the reserved ticket ID `next`, just like `--ticket next`. Set `CLOVING_NEXT_COMMAND` to a JSON list naming your selection command and its arguments. The daemon adds no argument. The command chooses a ready ticket in your tracker and prints its ID; the daemon trims it and reads the ticket with `CLOVING_TICKET_COMMAND`. Both commands share the resolver's 30-second deadline. Selection logic stays in your command, and each invocation submits only one run.

Set `CLOVING_QUEUE_SECONDS` to a whole number from 10 to 3600 to poll for ready tickets. The queue starts the declared workflow with `"queue": true` and requires both ticket commands when that workflow exists. If no workflow declares it, no queue starts, even when the interval is set. `CLOVING_QUEUE_LANES` sets the number of simultaneous runs, from 1 to 4, and requires `CLOVING_QUEUE_SECONDS`; its default is 1. For example, `CLOVING_QUEUE_LANES=4` admits at most one new ticket each cycle until four lanes are busy. Each run has its own branch and work tree. Manual submissions to the queue workflow share this limit and receive `workflow-active` when all lanes are busy. A ticket already being developed receives `ticket-active`. After a restart that moves the queue to another workflow, active runs of earlier queue workflows still occupy lanes and exclude their tickets.

Set `queue.dailySpendLimitUsd` in project or private configuration, or `CLOVING_QUEUE_DAILY_SPEND_USD`, to a positive finite USD limit. It requires `CLOVING_QUEUE_SECONDS`. At 85 percent of this limit, the queue holds new runs until spend falls below the threshold. Spend covers worker turns of queue workflows settled in the last 24 hours, using each reported price or its token-price estimate. Runs in work continue, so spend can exceed the limit. Status and watch show spend, the limit, unknown costs and turns in work. Unknown costs are never counted as zero; when every settled turn has unknown cost, they show `Price not known`. The window and hold are reconstructed from stored settlements after restart. Runs of other workflows do not count.

The optional declaration field `queue` is a boolean. `"queue": true` requires a field named `ticket` with `"type": "ticket"` (`queue-needs-ticket-field`), and every other input field must be optional (`queue-input-incomplete`). Two queue declarations stop startup with `queue-workflow-conflict`. `cloving doctor` requires `next-command` and `queue-interval` whenever a declared workflow takes the queue.

Set `tickets.readyCommand`, or `CLOVING_READY_COMMAND`, to a JSON list naming a command that lists the ready tickets. The setting requires `CLOVING_QUEUE_SECONDS`; without it, startup stops with `ready-command-needs-queue`. The daemon runs the command with no added argument when the queue starts. After each run ends, the daemon waits one queue interval and runs the command again. The command prints a JSON list of objects. Each object has the ticket `id` and the `readyAt` UTC time when the ticket became ready, such as `2026-11-03T07:30:00Z`. Only one run of the command occurs at a time. The command has a 30-second deadline, and the queue checks do not wait for it. `cloving status --json` and the watch page then show the count of ready tickets and the oldest wait. The count does not include the tickets in the skipped list of the queue, and it counts each ticket ID one time. Output that is not a valid list shows `Ready list failed` on the watch page. For GitHub issues with a `ready` label, the command can be as follows. This example uses the time when the issue was opened as the ready time:

```sh
gh issue list --label ready --limit 1000 --json number,createdAt --jq 'map({id: (.number | tostring), readyAt: .createdAt})'
```

Before enabling more than one lane, update the next-ticket command to honor `CLOVING_SKIP_TICKETS`. Cloving sets this environment variable to space-separated IDs of active tickets and tickets waiting for dependencies. The command must never print an ID from that list. It should print nothing when no eligible ticket remains. The service also checks selected tickets before admission.

In the ticket text returned by `CLOVING_TICKET_COMMAND`, each `#N` in a sentence starting with **Needs** inside `## Dependencies` is a hard dependency. For example, `Needs #123 and #124.` waits until both GitHub issues close. Other references and sections do not create dependencies. Cloving reads dependency state with `CLOVING_GH_COMMAND` (default `gh`); an unavailable or invalid response prevents admission. An open dependency returns `ticket-dependency-open` and puts the ticket in the skip list. Waiting tickets are checked again each cycle with a free lane, so a closed dependency makes its ticket eligible again.

`cloving status` and watch display the queue state, busy lanes and skipped tickets with their reasons. A pending self-update holds new admissions while active lanes drain. Three unsuccessful runs in a row, counted in the order they finish, stop the queue; a successful handoff clears the streak. Ordinary restarts preserve it. After inspecting and reconciling the failures, run `cloving queue resume`, or start with `--reset-queue`, to clear the streak. A conflict caused by an earlier lane's merge returns its diagnostics to a fix round. The merge steps of one repository take turns: a step waits until the earlier step ends, and then it merges `main`, runs the merge check, pushes and waits for CI. Lanes do not add CI runners or parallelize turns within one run.

An empty selection gives `no-ready-ticket`; a failed command gives `next-ticket-not-available`. Missing configuration gives `next-source-not-configured`. Multiple IDs, an invalid ID, or `next` as the selected ID give `invalid-ticket-id`. Use only one of `--next`, `--ticket`, `--prompt` and `--input`.

A saved harness named `grok` runs `grok --output-format streaming-messages-json --always-approve -p <turn text>` in the work tree. `CLOVING_GROK_COMMAND` replaces its command; the turn text follows `-p` or `--single` as one argument, or is appended if neither flag is present. Grok runs without approval prompts and has the same GitHub credential isolation as the other workers. Completion requires exit status 0 and a terminal result with `subtype: "success"` and `is_error: false`. The terminal result supplies the report and ticket status. Grok capacity errors are not retried.

Grok token counts come only from the terminal result, including its subagents. Input includes uncached input and cache creation; cache reads and output remain separate. Missing, all-zero or stderr-warned incomplete usage shows `Token usage not known`. An estimate requires complete usage attributed to exactly one model with a configured price. Mixed models and missing prices show `Price not known`. Grok uses token-based estimates and ignores its projected cost field. No Grok model prices are built in.

### Human review with a local branch

Worker turns retry an exact Codex capacity refusal or a Claude overload after 60 seconds, then 180 seconds. Claude worker turns also retry a failed result whose text starts with `API Error: Can't reach the API server`: the first retry waits 10 minutes and the second waits 40 minutes. The retry number selects the wait for its kind, with at most three attempts across both kinds. Other failures are not retried. Each wait starts after the failed attempt ends. Stopping during a wait returns `stopped`; a daemon restart fails the recorded operation for existing recovery.

Each retry keeps the work tree, profile, budget and limits, and starts a new session with a continuation line before the full prompt. After any network failure, every later attempt gets the network continuation, which asks it to check earlier commits, pushes, review comments and messages, avoid repeating completed writes, and stop to report a write whose result is unknown. It also gets fresh git evidence for commits since this turn's first attempt. Cloving fetches the branch from `origin` and marks each commit `pushed`, `not pushed` or `unknown`; an absent origin branch means `not pushed`. Each git command has a 30-second limit and is cancelled by drop. Failed reads give explicit unknown evidence.

Before a retry, Cloving checks the work tree's git index lock, including linked work trees. Capacity and network retries never remove a lock: `worktree-index-locked` records its path and tells the operator to remove it when no git process uses the work tree. Before a Claude resume after a daemon restart or a dead turn process, Cloving stops same-user processes whose working directories are in the turn work tree, waits up to 15 seconds after SIGTERM, then sends SIGKILL. Cloving does the same cleanup before it reports `claude-turn-interrupted` for a turn that it cannot resume, so a later turn does not share the work tree with an earlier process. A cleanup failure gives its own reason instead of `claude-turn-interrupted`. The daemon itself and processes outside that tree are excluded. Cloving removes a work tree index lock only when it identified the lock owners before cleanup, those owners have exited, and the lock has not changed. A lock with an unknown owner, including one whose owner closed its descriptor, stays in place and reports `worktree-index-locked`; inspect its owner before removing it manually. Stopped process IDs are recorded in `resume-processes.json` in the turn folder. An unreadable index path gives `worktree-index-unknown`. Neither failure starts another attempt. The step keeps one operation identity and sums usage across attempts. Private turn journals, status text and JSON, and watch retain each attempt's model, token counts, cost estimate and `retryKind` (`capacity`, `network`, or `null` for other results). Older attempts without the field show no kind. Attempt kinds appear after the turn ends. Resumed attempts also show `resumedAfter: daemon-restart` in status text, JSON and watch.

`CLOVING_FALLBACK_MODELS` accepts a JSON array of at most three nonempty model names, for example `'["gpt-6-astra"]'`. Without the setting or with `[]`, every attempt keeps the main model. The first attempt and first retry use the main model; each later attempt uses the next configured fallback within the existing attempt limit. With three attempts, only the first fallback can be used. The worker command must explicitly name a model with `-m NAME`, `--model NAME` or `--model=NAME`; otherwise it stays unchanged and the private journal records `fallback-model-unavailable`. Fallbacks apply only when the preceding attempt ended with a capacity refusal. A network retry keeps the model of the configured command. A fallback model can have a higher price. Each attempt's estimate uses its own model's price; an unknown price or missing token count leaves the total estimate unknown. Malformed settings refuse daemon start with `invalid-fallback-models`.

A develop template copy configured for human review and the local-branch merge option has up to four review rounds. Each round does one Claude Code turn in the work tree of the run, on its generated task branch, and then opens one approval. The first round makes the work tree. The approval identifies the immutable review subject, including its target and commit. Read that commit’s diff before you decide. The decision has these results:

- An approval completes the run. It does not merge the branch. Merge the branch yourself.
- A denial with a feedback text (`--text`) in rounds 1 to 3 starts the next round. The Claude worker gets the feedback text and adds commits to the same branch.
- A denial with no text, or a denial in round 4, ends the run.

The worker is not confined. It runs the `claude` command of the search path as the current user, with file edits and shell commands permitted in the work tree and a spend limit of 5 USD for each turn. `CLOVING_CLAUDE_COMMAND` (a JSON list of texts) replaces the command.

Single-run status (`cloving status RUN_ID`, also with `--json`) and watch show each worker command call and its run totals. Token counts retain the reported input, cache read and output categories separately. Codex input includes cached tokens; cache read tokens are not added to input tokens. These selected counts are not complete billing usage or a record of all subagent work. Missing or invalid fields show `Token usage not known`. Costs show the worker-reported USD price when available, otherwise `≈ 7.82 USD (estimate)` when an estimate is available, otherwise `Price not known`; a reported zero shows `0.00 USD`. Totals for an unfinished run are labeled `so far`. JSON uses `null` for unknown numeric values, retains the total reported price field `claudeCostUsd`, and adds `costDisplay` to the run and each worker turn.

The totals of a run stay in the service state after the retention rule moves its operation records. When a turn folder of the run is in the `journal` folder of the archive, single-run status shows `Turn details are archived in the journal folder of the archive: <folder>`, and JSON adds `run.turnDetails` as `{ "state": "archived", "folder": "<archive>/journal" }`. With the `delete` action, status shows `Turn details were deleted by the retention rule`, and JSON adds `{ "state": "deleted" }`. The daemon shows a deletion only for a finished run that ended before the retention period and has no turn folder in the state folder. Runs with kept records have no `turnDetails` field.

The built-in table uses standard short-context prices read on **2026-10-18** from the [OpenAI pricing page](https://openai.com/api/pricing/), in USD per million tokens:

| Model         | Input | Cached input | Output |
| ------------- | ----: | -----------: | -----: |
| `gpt-6.1-sol` |  2.00 |         0.10 |  10.00 |
| `gpt-6-astra` | 10.00 |         1.00 |  50.00 |

`CLOVING_TOKEN_PRICES` accepts a JSON object mapping model names to non-negative finite `input`, `cachedInput` and `output` prices per million tokens. Its entries override matching built-in entries and retain the others. Estimates use the reported model or the worker command's model argument, with `estimatedCostUsd` totals only when every ended turn has an estimate. There is no live price lookup; estimates do not change budgets or limits.

Each turn selects its harness in this order: profile `harness`, `CLOVING_WORKER`, private `harness.name`, then `claude`. `CLOVING_WORKER` changes the default for one start; a profile can still override it. Native workers are `claude`, `codex`, `cursor-agent`, `gemini`, `grok` and `opencode`. Other harnesses need a private `harness.turn` command form; without one, startup stops with `harness-no-worker` and its name. Private command, path and kind settings apply only to the matching harness. Status, its JSON and watch show each turn's harness.

For another harness, set its name and one-shot command in the private file:

```json
{
  "version": 1,
  "harness": {
    "name": "mytool",
    "kind": "file",
    "turn": ["mytool", "--print", "{prompt}"],
    "output": "text"
  }
}
```

`turn` must be a nonempty list of strings. Its program must be nonempty and cannot be `{prompt}`. One later argument can be exactly `{prompt}`; it receives the turn text as a literal argument. Without that argument, the text goes to standard input. `harness.command` takes precedence over `turn`; otherwise `harness.path`, when set, replaces the program in `turn`. These private values apply only to the selected private harness. The command runs in the worktree, using the login shell only for kind `shell`.

`output` accepts only `text` and defaults to it. The generic worker retains the end of standard output as the report within the normal turn result limits, preserving the ticket status parsed from the full output separately. A nonzero exit fails the turn and reports the end of standard error. Cost and token counts remain null; status shows “Price not known” and “Token usage not known”. `cloving doctor` probes the program without running a turn and recommends `cloving config set harness.turn '[...]'` when its command form is missing.

Cursor Agent runs `cursor-agent -p --output-format stream-json --force` in the run's work tree. Turn text below 64 KiB in UTF-8 is its final argument; larger text goes through standard input to stay below operating-system argument limits. It uses the last assistant text as the report and requires exit status 0 and a terminal result with `subtype: "success"` and `is_error: false`. File and command tools appear in watch activity. Error events and incomplete streams fail the turn. Capacity errors do not retry. GitHub token variables are removed and each turn gets an empty temporary GitHub configuration directory.

The [Cursor output reference](https://cursor.com/docs/cli/reference/output-format) defines the older stream used by version 2026.01.28 without counts. These runs show `Token usage not known`. For newer terminal `usage` objects, Cloving accepts only four nonnegative safe integer fields: `inputTokens`, `outputTokens`, `cacheReadTokens` and `cacheWriteTokens`. Cursor's [published cache explanation](https://forum.cursor.com/t/discrepancies-between-cursor-cli-usage-and-billing/164471/7) defines uncached input separately from reads and writes, with counts covering the whole turn; Cloving retains each category separately, including optional `cache_creation_input_tokens` in JSON. Other shapes remain unknown. No Cursor prices are built in. A configured price produces an estimate when cache writes are zero; positive writes leave the estimate unknown because the price table has no cache-write rate. Cursor's [headless cost explanation](https://forum.cursor.com/t/cost-information-in-cursor-cli-headless-mode/164583/7) distinguishes CLI counts from billed charges.

With `codex`, `CLOVING_CODEX_COMMAND` replaces the native Codex command and must still emit native Codex events. A shared-format wrapper uses `CLOVING_CLAUDE_COMMAND` with the `claude` worker selection. Its last JSONL result supplies `total_cost_usd` and `usage.input_tokens`, `usage.cache_read_input_tokens` and `usage.output_tokens`, including on errors. Report only the usage and price of that command call; the wrapper must normalize resumed sessions or multi-input accounting. Cloving does not infer the output format from the executable or model name or reconstruct missing usage from old logs.

With `gemini`, the default command is `gemini --output-format stream-json --approval-mode yolo -p <turn text>`, with no approval prompts. `CLOVING_GEMINI_COMMAND` replaces the command and fixed arguments; Cloving appends `-p` and the turn text. Turn text of 64 KiB or more in UTF-8 goes through standard input without `-p`, to stay below operating-system argument limits; Gemini runs headless because its input is not a terminal. The [Gemini headless stream](https://geminicli.com/docs/cli/headless/) supplies the last assistant message as the report. Completion requires exit status 0, a successful result event and no event with error severity. Gemini capacity errors are not retried. Status retains each model's token counts. Input includes cached tokens; estimates price uncached input and cache reads separately at each model's configured price, then sum them. Missing counts show `Token usage not known`; a missing price for any model makes the estimate unknown. There are no built-in Gemini prices; add them through `tokenPrices` or `CLOVING_TOKEN_PRICES`. Gemini turns use an empty GitHub configuration directory and receive no GitHub token variables.

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

A workflow selects a profile with a `protectedEffect` request for capability `claude` and method `run-turn:checker` or `run-turn:fixer`. Profile names contain 1–119 ASCII letters, digits, hyphens or underscores. All fields are optional. `harness`, `env` and `workflows` work with each harness. Native workers also accept `model`; a generic worker refuses it with `profile-model-not-supported`. `model` replaces existing `-m`, `--model` or `--model=` options, or adds one model option. Only `allowedTools`, `permissionMode` and `maxBudgetUsd` require Claude; using them with another harness gives `profile-needs-claude`. Unspecified fields keep the selected worker's defaults. Flags after `--` remain unchanged.

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
step. Each project or user workflow declares its own targets.

### Pull requests of `develop`

The default `develop` template uses automatic review without an approval. The GitHub worker makes the work tree from the newest commit of the default branch of `origin`. After the Claude turn, the worker pushes the branch and opens a pull request. The title and the referenced issue come from the ticket text (see "The ticket command"). The pull request body uses `Refs owner/repository#N`, so the merge itself does not close the issue. Then the worker waits for the Greptile review of the pushed commit, and asks for a review with a comment after 5 minutes.

When the ticket names a GitHub issue, the workflow adds `cloving: in progress` after preparing the work tree and removes `cloving: ready` and `cloving: blocked`. A blocked run adds `cloving: blocked` and removes `cloving: in progress`. A failed label operation throws and can fail the template run. Cloving creates the labels it adds or removes with the fixed color `ededed`; existing labels have their color and description reset by `gh label create --force`.

The last worker report must end with exactly one line: `Ticket status: complete` or `Ticket status: partial`. A partial report must put `Remaining:` immediately before a list with one `- ` item per line, followed by the status line. The worker records the parsed status and remaining items before shortening the summary, so summary limits cannot remove those fields. If the preserved fields exceed the result byte limit, the turn fails with `claude-result-too-large` and retains bounded cost metadata; the full report stays in the private turn log. Older recorded turns still use summary parsing. Missing, repeated, unknown or malformed status reports count as partial with the remaining item "The worker report has no ticket status line."

After a merge, a protected GitHub operation updates the issue body and labels. Complete work closes the issue with reason `completed` and adds "Completed in pull request #M." to `## Cloving status`. Partial work keeps the issue open and appends `- Pull request #M: partial. Remaining: ...` to that section at the end of the body, preserving earlier partial lines and other body text. Items are separated by semicolons. The issue privacy check runs before new remaining text is written; a refusal uses "Remaining work is in the private run report." instead. No issue comment is posted. Status writes add and remove only workflow labels, preserving unrelated label edits. Before a body write, Cloving rereads the issue and refuses a changed body with `github-issue-conflict`; the merged outcome records `issueUpdate: failed`. GitHub does not support conditional PATCH requests for this endpoint, so this check cannot make the read and write atomic.

Partial work removes `cloving: in progress` and adds `cloving: ready`, so the next queue cycle can select the same issue and read its remaining work from the issue body. The third partial run adds `cloving: blocked` instead of `cloving: ready`. Completion removes these workflow labels. Status operations reconcile the pull request number in the stored history after a restart to avoid duplicate writes. The unmodified develop template declares an effect limit of 31 units.

When a worker turn ends with `claude-turn-interrupted`, the develop template runs the turn again once in the same work tree. This occurs when the daemon cannot resume an open turn after a restart, for example when the turn has no recorded session. The prompt of the new turn tells the worker that the earlier turn stopped before its report, and that the work tree holds its work. A second interruption of the same turn ends the run as blocked with the reason `turn-interrupted` and adds `cloving: blocked`. Other turn failures fail the run.

Partial history comes only from a hidden HTML comment at the end of the issue body, beginning with `cloving-status`. Its JSON object has `version: 1`, a `partialRuns` array of pull request numbers and remaining-item lists, and an optional `completedPullRequest`. Double hyphens and greater-than signs in JSON strings are escaped so they cannot end the comment. Each write regenerates the readable section from this data and replaces the exact previously generated section. Other Markdown stays unchanged, including status examples, lists, tables, HTML and unclosed fences. Missing, broken or unknown metadata counts as zero earlier partial runs and is replaced on the next write; readable text is never used to reconstruct history. A block followed by other issue text is left unchanged and counts as missing terminal metadata.

Partial history, including its JSON block, is bounded by the 48,000-byte ticket-read limit, reserving 2,048 bytes for the title, issue reference and worker notes. If the new remaining items do not fit, Cloving uses the private-report notice above. If even the notice cannot fit alongside the existing body and history, the issue update fails without requeueing it. Retries check the same size limit before restoring queue labels. Review and merge-fix turns receive the previous report's remaining items, including preserved items from shortened summaries, and must reassess each item before reporting completion.

Merged runs retain `handoff_requested` with `ticketStatus: complete` or `partial`, visible in `cloving status` and watch. If the issue update fails, `issueUpdate: failed` is also shown. The queue reports each terminal run without a successful handoff and continues, stopping after three such runs in a row. A successful handoff resets the count; the queue journal preserves the count and run IDs across daemon restarts. Inspect failed GitHub operations and reconcile their issues before requeueing them. A later partial run does not mark an earlier blocked ticket as done.

To resume a queue stopped at this limit, stop the service with Control-C, inspect the failures and reconcile the affected issues, then run `cloving start --reset-queue` with the same repository, runtime and queue settings. This clears the failure streak once and preserves tracked commands. Ordinary restarts, including automatic self-updates, preserve the count. Resetting the queue does not change issue labels or retry blocked issues.

### Continue a stopped run

A run can stop on a problem that a person can fix, for example a rejected push. After the fix, continue the run:

```sh
cloving run continue <run-id>
cloving run continue <run-id> --from pull-request/github-open-pr
cloving run continue <run-id> --from implement/claude-turn/2 --bundle current
```

The command admits a new run of the same workflow with the same input. The new run keeps the cycle of the old run, so it uses the same branch, work tree and pull request. An effect of the new run whose scope (phase, operation, round and key) is the same as a completed effect of the old run gets the old result with the disposition `existing`. The worker does not do that effect again. The failed effect and all effects after it run again. GitHub label effects always run again, so the ticket labels follow the new run. With `--from <phase>/<operation>[/<round>]`, the first visit of that step and all steps after it run again.

The new run uses the kept workflow bundle of the old run. If that bundle is not kept, the command refuses with `pinned-workflow-unavailable`. With `--bundle current`, the new run uses the current workflow, and a step whose scope changed runs again. The reused effects count against the effect limit of the new run.

The old run keeps its state. `cloving status` and the watch page show `Continued by: <new run>` on the old run and `Continues: <old run>` on the new run. Only a run that is `failed`, or `completed` with the outcome `blocked`, can continue. The service refuses an active run with `run-active`, a dropped run with `run-cancelled`, a completed run that is not blocked with `run-not-blocked`, and a run that already has a continuation with `run-already-continued`. A blocked run has no failed step, so it needs `--from`; without it, the service refuses with `continuation-step-required`.

The service also refuses these continuations:

- A run that ended more than `retention.days` days ago gets `run-retention-expired`. With `retention.days` set to `null`, no run is too old.
- A run of a queue workflow gets `queue-spend-limit` while the queue holds for its daily spend limit. The spend of the old run counts in that daily total.
- A request with a known command ID and a different run, `--from` or `--bundle` gets `conflicting-command`. The same request gets the stored receipt again.

A workflow can continue a run of its own handoff chain with the step `continueRun`. The authority admits only one continuation of a run, also when two requests come at the same time. When a continuation of a run in the queue failure streak completes with `handoff_requested`, the queue clears the failure streak, as it does for each queue run that hands off.

On the watch page, **Needs you** also lists each failed or blocked run that no run continues yet. With watch actions on, the item has a **Continue** button. The button continues the run from the failed step with the kept bundle, and the reply of the service shows under the run. A blocked run needs `cloving run continue <run-id> --from <step>`.

### Queue control

The operator controls the queue of a running service with three commands. Each command uses the service protocol, and `--json` prints one JSON object.

- `cloving queue [--json]` shows the state of the queue: `running`, `stopped`, `draining` or `drained`. It also shows the busy lanes, the failed runs in a row and, for a stopped queue, the reason. `cloving status` and the watch page show the same state.
- `cloving queue resume [--command-id <id>] [--json]` sets the failure count to 0 and ends a stop or a drain. The next queue check can start a ready ticket. No restart is necessary.
- `cloving queue drain [--command-id <id>] [--json]` makes the queue start no new run. The runs in work continue to their end. At the next gap, the queue journal records the drain time, the service log shows `Queue drained` one time, and the state changes to `drained`. Until the queue records that time, the state stays `draining`.

A drained queue is a safe point for a restart. The queue records the drain time only at a gap, so a run of another workflow keeps the state `draining`. The drain stays in place after a restart. `cloving queue resume`, `cloving restart --resume-queue` or `cloving start --reset-queue` ends it. A drain does not stop manual runs. A manual run that starts after the drain time shows `draining` until the run ends.

With no `--command-id`, the command makes an ID. The text output prints it on standard error, and the JSON result includes it as `commandId`. The queue journal keeps the newest 32 command IDs across restarts. A repeated command with a kept ID does not apply the command again, and the reply shows the current queue state with `replayed: true`. A different command with a kept ID gets `conflicting-command`. The queue applies a command with an older ID as a new command.

A queue that stopped on an error shows the error as the reason and refuses commands until a restart. An invalid queue journal and a queue command that the journal cannot save are two examples of these errors.

At the confidence score 5/5, the worker runs the local merge check and waits for CI of the exact head it will merge, including an updated head pushed after merging the default branch. When CI passes, it merges the pull request with a merge commit, with no human approval. Then it removes the remote branch, the work tree and the local branch. With a lower score, the Claude worker gets the summary and the findings of the review for one more round. After three such rounds, or after 60 minutes with no review, the run stops and the pull request stays open.

Set `CLOVING_REQUIRED_CHECKS` to a JSON list of check run names, such as `["quality", "quality_linux"]`, to require those checks. Without the setting, all GitHub Actions checks on the head commit are required. The newest run of each name decides; `success`, `neutral` and `skipped` pass. With no setting and no Actions checks after a 60-second grace period, a repository without CI can merge. A configured missing check keeps waiting. CI is polled every 30 seconds with a separate 90-minute limit. A timeout returns `ci-pending` and blocks without a fix round.

When a GitHub Actions check fails in its first workflow attempt, Cloving requests one rerun of the failed jobs and keeps waiting within the same 90-minute CI limit. The operation journal retains the request before sending it, the first failure output and the original deadline, so a daemon restart cannot request another rerun. Status and watch show “CI rerun after a failed check”. A failed rerun request reports a transient GitHub error.

A second failure returns `ci-failed` with the outputs of both attempts, including failed check names, failed steps and failed log tails, with private texts hidden and at most 6,000 characters in total. Checks outside GitHub Actions or without an Actions run link retain the immediate failure behavior. The failure starts a worker fix round that must repair CI, including failures the pull request did not cause, and commit the fix. The new commit receives a new Greptile review and CI gate. Review, local check, conflict and CI repairs share the existing limit of three fix rounds.

#### The GitHub merge queue

Set `merge.mode` to `"queue"`, or `CLOVING_MERGE_MODE=queue`, to merge through the GitHub merge queue. The default `"direct"` keeps the flow above. In queue mode, the merge step does these steps in the merge turn of the repository:

1. It merges the newest default branch into a local copy of the head and runs `checks.beforeMerge` on that copy. It does not push the merged head, because a push starts a new CI run of the pull request.
2. It waits for the required checks of the pull request head. After a conflict repair, this is the new head.
3. It adds the pull request to the queue with the GraphQL mutation `enqueuePullRequest`, with `expectedHeadOid` set to the reviewed head.

Then the step leaves the merge turn, so the next merge step of the repository can start. The step reads the pull request every 30 seconds. `cloving status` shows the reason `github-merge-queued` with a text such as `In the merge queue, position 2. Queue state: AWAITING_CHECKS.` The step gives one of these results:

- GitHub merges the pull request. The result is a merge with the merge commit of GitHub.
- The pull request leaves the queue with no merge, and it now conflicts with the newest default branch. The result is `merge-conflict` with the conflict output, for the usual conflict repair.
- The pull request leaves the queue with no merge and no conflict. The result is `ci-failed` with the failed checks of its latest merge group run. Cloving uses only the merge group runs that GitHub started after it added the pull request to the queue. GitHub gives that time in the `enqueuedAt` field of the queue entry. If Cloving finds no failed check of such a run, the result is `merge-queue-removed`.
- The pull request stays in the queue for 3 hours. The step removes it with `dequeuePullRequest`, and the result is `merge-queue-timeout`. The 3 hours start at the `enqueuedAt` time of the queue entry. Thus a restart of the daemon does not start the 3 hours again. A step that finds the pull request already in the queue uses the same time.

The develop workflow blocks on `merge-queue-removed` and on `merge-queue-timeout` without a fix round.

Queue mode needs the merge queue rule in the ruleset of the default branch. Use the merge method `merge`. The CI workflow must also run for the `merge_group` event and report the required checks there, because GitHub merges a pull request only after its required checks pass on its merge group. The CI of this repository runs the jobs of `quality` and `quality_linux` for merge groups. The coverage job runs only for pull requests. The planned rule of this repository has a build concurrency of 3, a group size of 1, all checks green and a check timeout of 60 minutes.

The watch board preserves the displays of historical pull-request runs, including blocked runs in `Stopped`. A validated local merge report shows `PR merged · #N`. A later completed run for the same established GitHub issue must have its own validated merge report to show `Ticket completed by later run`. The original and later run have separate links. Either local proof prevents a GitHub read. These marks preserve the recorded run outcome.

Otherwise, the board reads the recorded pull request with `CLOVING_GH_COMMAND` (default `gh`). It validates the PR and issue identities against the configured repository's local origin. The first queued or active read shows `Checking PR`. A confirmed merge shows `PR merged · #N`; a failed read shows `PR status unavailable`. An unmerged PR shows `Needs attention`. A separate `Stale` mark appears when the last successful unmerged observation is older than 120 seconds, including after a failed refresh. A successful refresh resets its age. Confirmed merges never become stale.

Reads run in the background, one at a time, with a five-second limit. Board loads can refresh unresolved PRs at least 60 seconds after the previous attempt started. Confirmed merges remain cached until the watch process stops. A later normal page load shows each result.

The GitHub worker does not push a change that has the path of the home folder in a file or in a commit message. `CLOVING_PRIVATE_TEXTS` (a JSON list of texts) adds more texts to refuse, with no difference between capital and small letters. `CLOVING_CHECK_COMMAND` (a JSON list of texts) names a check that must pass in the work tree before a merge. `CLOVING_GH_COMMAND` replaces the `gh` command. The worker uses the `gh` login and the git credentials of the current user.

The GitHub worker tries a git call to the remote (`fetch`, `push` or `ls-remote`) again after a short failure. A short failure has one of these texts in the git output: `Could not read from remote repository`, `Permission denied (publickey)`, `Connection reset`, `Connection timed out`, `Could not resolve host`, `The remote end hung up unexpectedly`, `early EOF`, or an HTTP 5xx status. Output with `does not appear to be a git repository` fails at once. The waits before the three retries are 5, 15 and 45 seconds.

During a wait, `cloving status` shows the reason `git-network-retry` with a text such as `git fetch failed, retry 2 of 3.` and the time of the next attempt. If the fourth attempt also fails, the operation fails with `git-network-failed`, and its private journal keeps the last git output. Local git calls, for example `merge`, `status` and `rev-parse`, do not try again.

### Restart the service

`cloving restart` restarts the service that `cloving start` runs. The new start reads the settings files and the product files again.

- `--at gap` is the default. The restart waits for the next gap. A gap has no run of any workflow that has not ended, no open turn and no pending queue submission. The queue drain and the self-update use the same rule.
- `--at now` stops the service at once. Claude and Codex turns resume after the start, as after Control-C. The reply lists the runs with a turn that cannot resume: a turn of another harness, a turn that waits for a retry, or a turn with no recorded session. `--json` shows them in `restart.unresumableRuns`.
- `--cancel` cancels a pending restart. When the restart already started, the cancel prints `Restart: started, cannot cancel`, and the restart continues.
- `--update` updates the product checkout before the stop, at the gap or at once. The update fetches the default branch. It needs a fast-forward and a clean tree. Then it merges, runs `npm ci --ignore-scripts` when `package-lock.json` changed, and runs `npm run build`. While the update runs, the queue admits no new run. When a step fails, the command prints `restart-update-failed` with the step and its output, and exits with status 1. The service keeps running on the old commit. When the install or the build fails, the update puts the checkout back on the old commit and installs and builds it again. `--json` shows the step and the output in `step` and `output`. `cloving status --json` shows the newest failure in `restartFailure` until the next start. The service refuses `--update` with `update-unavailable` when the product is not the top folder of a git checkout.

The update and the self-update do not run at the same time. When `cloving start` stops during the update, the update stops its command and puts the checkout back on the old commit. It does not install or build again. The output of `cloving start` shows the failed step and the commands to run before the next start. When `cloving start` stops while the restart stops the service, the service stays stopped and does not start again.

While a restart waits, the queue admits no new run. `cloving status` and the watch page show `Restart pending: 2 runs active`. The reply to the request holds the commit and the start time of the service that accepted it. The command waits for a service with a different start time. Then it prints the old commit, the new commit and the start time that the new service reports. Control-C stops the wait, and the restart stays pending. When another command cancels the restart, the wait ends with `restart-cancelled` and exit status 1. When the connection ends before the reply, the command prints `outcome-unknown`. Then check `cloving status` before you send the request again. `cloving status --json` shows `serviceCommit`, `serviceStartedAt` and `restart`. The commit is `null` when the product is not the top folder of a git checkout.

The restart keeps a drain of the queue and the failure count. `cloving restart --resume-queue` clears the drain at the new start and keeps the failure count. `cloving start --reset-queue` clears the drain and the failure count. By default, the new start keeps the environment of `cloving start`, so an environment value still hides a file value. `cloving restart --settings files` starts the new service without each `CLOVING_*` variable that a settings file can set, so the files and the defaults decide. Later restarts of the same `cloving start`, for example a self-update, keep this smaller environment. Variables that only the environment can set, such as `CLOVING_RUNTIME_DIR` and `CLOVING_SCHEDULES`, stay.

## Continuous process

In a continuous process, Cloving develops one ticket after the next with `develop`. Keep the workflow outside this public repository. In a private repository, run `cloving templates copy develop`. From the Cloving repository, set `cloving config set workflows.folder "$WORKFLOW_FOLDER"`, where `WORKFLOW_FOLDER` is the absolute folder containing that copy, and restart the service. The setting stays in the operator’s private settings file. Do not commit a workflow copy here.

The unmodified template takes a ticket, selects from the queue (`"queue": true`), accepts Greptile at 5/5, lets Cloving merge after the checks, and returns partial tickets to the queue. Configure the ticket command, next-ticket command and queue interval in the operator’s settings. The queue starts only the declared queue workflow, `develop`.

Use one terminal session for the service that stays open, for example a `tmux` session. Do these steps for each issue:

1. Write a small issue: one behavior, clear criteria that a test can check, and the first tests. The prompt "Write a ticket for Cloving" helps.
2. Run it: `cloving run develop --ticket ISSUE_NUMBER`.
3. Follow the run on the watch page, or with `cloving status RUN_ID` and `cloving events RUN_ID --follow`.
4. Check the merge. The run completes when the GitHub worker merges the pull request. The watch page shows the number of the pull request of the run (`PR_NUMBER`). It is also `pullRequest.number` of the run in `http://127.0.0.1:3663/data.json`. The pull request number and the issue number are different.
   - Make sure that the pull request is merged: `gh pr view PR_NUMBER --json state,mergedAt`.
   - Check the ticket status and issue: `gh issue view ISSUE_NUMBER --json state,body,labels`. Complete work closes the issue; partial work stays open and requeues until the third partial run blocks it.
5. Update the local `main`: `git switch main`, then `git pull --ff-only`.
6. When the repository is the Cloving checkout itself, also restart the service, so that it runs the new code. Run `cloving restart --update`. The restart waits for the next gap, updates and builds the checkout, and then restarts.
7. Go to the next issue.

When a run stops and the pull request stays open, read the review. Fix the work yourself, or write a smaller issue.

Know these limits before you start:

- The cost limit of each Claude turn is 5 USD. A run of `develop` can have up to four Claude turns. `CLOVING_CLAUDE_COMMAND` changes the command and its limit.
- The text of a pull request is public in a public repository. The worker gets an instruction to write no local file path in a file or in a commit message.
- `CLOVING_PRIVATE_TEXTS` adds texts that the GitHub worker refuses to push, for example the names of private projects. The path of the home folder is always refused.
- The default develop workflow runs `checks.beforeMerge` before merging. With no configured command, it stops with `check-not-configured` and leaves the pull request open. This repository commits `["npm", "run", "check:quality"]` as that command and requires the CI checks `quality` and `quality_linux` in `.cloving/config.json`. An environment or private-file override takes precedence.

## Prompts for a coding agent

Copy a prompt, replace the words in capital letters, and give it to a coding agent.

### Set up a repository

Run `cloving init` in the repository and select your agent harness. The agent runs `cloving init-prompt` to get repository facts and the setup instructions, then guides you through the remaining steps.

### Run a continuous process

```text
Run a continuous process with Cloving and develop in my repository REPOSITORY_PATH. The Cloving service runs in the terminal session SESSION_NAME. Do the issues ISSUE_LIST one at a time, in this order.

For each issue:
1. Read the issue. Do not change it.
2. Run: cloving run develop --ticket ISSUE_NUMBER
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
  One line. For develop, it becomes the title of the pull request.
GitHub issue: OWNER/REPOSITORY#NUMBER
  Only for develop. The pull request references this issue; complete work closes it after the merge.
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
- Write no secret, no private data and no local file path. For develop, the ticket text and the branch become public.
- Use one term for one thing.
```

## Develop a workflow

`cloving start` loads workflows from two folders:

- The repository `.cloving/workflows/` folder.
- The user `cloving/workflows/` folder under an absolute `XDG_CONFIG_HOME`, otherwise under `~/.config`. An unset or relative `XDG_CONFIG_HOME` uses that default.

The private setting `workflows.folder` replaces the user folder with an absolute folder path, for example a private git repository of your own workflows. Set it with `cloving config set workflows.folder <path>`. Cloving reads the folder where it is. The folder itself must not be a symbolic link; a link in the path above it is allowed. `cloving workflows list` shows its workflows with the scope `user`.

A workflow is a TypeScript file in the form of `templates/develop/develop.ts`:

- An exported async function with the directive `"use workflow"` as its first statement. The directive needs the compiler of the Workflow SDK, not only TypeScript.
- The only argument is the input of the run. The declared resolver provides `cycleId`, `repository` and the submitted fields under `input`; a ticket field becomes `{ id, text }`. With `waitForDecision`, the decision returns to the same call.
- The step helpers come from the subpaths of `cloving/workflows`: `protectedEffect` from `cloving/workflows/steps/protected-effect`, `waitForDecision` from `cloving/workflows/steps/wait-for-decision`, `loadCycle` from `cloving/workflows/steps/load-cycle`, `handoff` from `cloving/workflows/steps/handoff`, `continueRun` from `cloving/workflows/steps/continue-run`, `waitForRun` from `cloving/workflows/steps/wait-for-run` and `runCommand` from `cloving/workflows/steps/run-command`. The type `CycleOutcome` comes from `cloving/workflows`. An import of `cloving/workflows` starts no service.
- `protectedEffect` asks the daemon for one effect of a capability, for example a Claude turn. `waitForDecision` opens a decision for a person and waits for the result.
- The function returns a `CycleOutcome`: `waiting_for_decision`, `handoff_requested` or `blocked`.

For `handoff_requested`, the daemon retains the workflow's `promotionId` in the completion event. An optional bounded `reason` records a handoff refusal while preserving the promotion. `cloving status <runId>` shows the promotion as `Promotion:` and the reason beside the outcome; JSON status includes `run.outcome.promotionId` and `run.outcome.reason`. Watch retains the promotion in the run model and completed-run details. This identifier is an opaque reference and grants no authority.

```ts
import type { CycleOutcome } from "cloving/workflows";
import { waitForDecision } from "cloving/workflows/steps/wait-for-decision";
import { protectedEffect } from "cloving/workflows/steps/protected-effect";

export async function developTicket(input: {
  readonly cycleId: string;
  readonly input: {
    readonly ticket: { readonly id: string; readonly text: string };
  };
}): Promise<CycleOutcome> {
  "use workflow";
  const turn = await protectedEffect({
    scope: { phase: "implement", operation: "claude-turn", round: 1 },
    capability: "claude",
    method: "run-turn",
    target: input.cycleId,
    payload: input.input.ticket.text,
    units: 1,
  });
  if (turn.kind !== "completed")
    return {
      kind: "blocked",
      cycleId: input.cycleId,
      reason: "The Claude turn did not complete.",
      evidenceId: "claude-turn",
    };
  const decision = await waitForDecision({
    gateId: "review-1",
    kind: "approval",
    prompt: "Review the work of the Claude worker.",
  });
  if (decision.decision !== "approved")
    return {
      kind: "blocked",
      cycleId: input.cycleId,
      reason: "The operator did not approve the work.",
      evidenceId: "review-1",
    };
  return {
    kind: "handoff_requested",
    cycleId: input.cycleId,
    promotionId: `cloving-${input.cycleId}`,
  };
}
```

In this example, an approval completes the run and a denial ends it. A copy of `templates/develop/develop.ts` configured for person review and local-branch delivery also supports repair rounds after a denial with feedback.

A workflow can also wait for a decision without requesting an effect:

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

`waitForDecision` accepts `{ gateId, kind, prompt, expiresAt? }` and returns `{ decision, answer }`. The decision is `approved`, `denied`, `answered` or `expired`. An optional `expiresAt` resumes the wait with `expired` and `answer: null`. The SDK hook survives daemon restarts and replay. Gate IDs belong to a run, so different runs can use the same gate ID. The existing questions, decision commands and binding values apply; dropping the run cancels the wait. `waitForDecision` is also exported by `cloving/workflows`.

Use `sleep({ seconds })` inside a workflow to pause between short outside-state checks. Whole seconds from 1 through 86400 are accepted; other requests reject with `invalid-sleep-seconds` before any wait. Import it from `cloving/workflows` or `cloving/workflows/steps/sleep`. It uses the SDK workflow timer and consumes no protected effect units or slots.

For example, configure an operator-supplied `approval-status` command to make one read, print `{"ready":false}` or `{"ready":true}`, and exit. Cloving does not ship this command. Set `CLOVING_COMMAND_SECONDS=10` to bound each command; this setting applies to all configured commands. The following candidate declaration permits at most 30 command units:

```json
{
  "workflow": {
    "workflowId": "approval",
    "effectLimit": 30,
    "capabilities": [
      "command"
    ],
    "commands": [
      "approval-status"
    ],
    "input": {
      "maximumBytes": 1024,
      "fields": {
        "request": {
          "type": "string"
        }
      }
    }
  },
  "methods": {
    "command": [
      "run:approval-status"
    ]
  }
}
```

The workflow checks immediately, then sleeps 60 seconds only between pending checks, with at most 30 checks and 29 sleeps:

```ts
import { runCommand, sleep } from "cloving/workflows";

export async function approval(input: {
  cycleId: string;
  input: { request: string };
}) {
  "use workflow";
  for (let round = 1; round <= 30; round += 1) {
    const result = await runCommand({
      scope: { phase: "approval", operation: "check", round },
      name: "approval-status",
      input: { request: input.input.request },
    });
    if (result.kind !== "completed")
      return blocked(input.cycleId, result.reason ?? result.kind);
    let response: unknown = null;
    try {
      if (result.result !== null) response = JSON.parse(result.result);
    } catch {
      response = null;
    }
    if (response === null || typeof response !== "object" || Array.isArray(response)
      || !("ready" in response) || typeof response.ready !== "boolean")
      return blocked(input.cycleId, "external-condition-invalid-result");
    if (response.ready)
      return { kind: "handoff_requested", cycleId: input.cycleId, promotionId: "external-condition-ready" };
    if (round < 30) await sleep({ seconds: 60 });
  }
  return blocked(input.cycleId, "external-condition-timeout");
}

function blocked(cycleId: string, reason: string) {
  return { kind: "blocked", cycleId, reason, evidenceId: "approval-status" };
}
```

Each completed command releases its effect slot before sleeping. Only boolean `false` means pending; every non-completed command stops with its reason or kind, and missing, malformed or wrongly shaped output stops with `external-condition-invalid-result`. Thirty pending checks return `external-condition-timeout`. The bound limits attempts; command durations and capacity waits add elapsed time. An overdue SDK timer resumes the next check without scheduling catch-up checks.

A recorded SDK timer retains its wake time through replay. Combined command recovery, four-waiter capacity release, cancellation and installed polling restart qualification remain acceptance prerequisites. The source analyzer estimates one command call for this early-exit loop; the runtime enforces the full budget. Observed approval is data: subsequent effects still need their own authorization and enough budget. Adding a sleep cannot shorten a command that already polls internally.

Use `reviewByPerson` to request approval of an immutable commit or draft:

```ts
import { reviewByPerson } from "cloving/workflows/steps/review-by-person";

const review = await reviewByPerson({
  subject: { draft: "The proposed issue text." },
});
```

Call it inside a workflow. The result is `{ accepted, feedback, findings, commit, subjectDigest }`; only an approval sets `accepted` to `true`. Feedback contains the decision's answer, or an empty string. `findings` is 1 when the decision does not approve and its answer is not empty. Otherwise it is 0. A commit subject is `{ commit, target }`, where `commit` is the full 40 or 64 character lowercase commit ID and `target` identifies the run's work tree. To review an existing pull, supply its `commit` together with the run target. A draft subject is `{ draft, commit? }`, where the optional commit identifies its base; the result's `commit` is always `null` for a draft. Drafts must contain text, and commit subjects need a nonempty target.

The SHA-256 `subjectDigest` identifies the exact subject, including a draft's text and optional base commit. A changed subject opens a different approval. Repeating the same subject within a run reuses its recorded decision. The helper returns that decision in the original call through `waitForDecision`, and is also exported by `cloving/workflows`. Workflow tests supply its decisions through the fake bridge's `decisions` queue; person reviews consume no protected effect budget.

For a Greptile review of a pull request, use the same result contract:

```ts
import { reviewByAgent } from "cloving/workflows/steps/review-by-agent";

const subject = { number: pull.number, commit: pull.commit, target: runTarget };
const review = await reviewByAgent({ subject: subject, reviewer: { kind: "greptile" } });
```

Replacing that call with `reviewByPerson({ subject })` preserves the result type and subject digest. Greptile needs the pull number and immutable commit; drafts can use person or turn review. Only a score of 5/5 sets `accepted: true`. Feedback includes the summary and findings with their file locations. `findings` is the number of Greptile findings, and does not count the summary. Responses must name the requested pull and commit; malformed or unrelated results reject with `invalid-review-result`. Failed effects reject with the effect's reason.

`reviewByAgent` uses the existing GitHub `wait-review` worker method and one protected effect unit per distinct subject. Its candidate declaration must include the `github` capability and `methods: { "github": ["wait-review"] }` with a sufficient effect limit. The broker still controls authority and budgets. Both the subpath above and `cloving/workflows` export the helper. Fake scenarios provide worker results in `effects["github wait-review"]`. A turn reviewer uses the same subject and result:

```ts
const review = await reviewByAgent({
  subject: subject,
  reviewer: { kind: "turn", profile: "checker" },
});
```

The named profile runs through the existing `claude` capability and `run-turn:checker` method, using that profile's configured harness and restrictions. The declaration must name that exact method and capability; the helper consumes one protected effect unit. The workflow call must contain a literal profile name. Commit reviews use the subject's run target and ask the reviewer to inspect that exact commit. Draft reviews use a separate work tree identified by the draft's subject digest. Repeating a subject with the same profile reuses its operation; changing the subject or profile starts a new review operation.

The report must end with `Review verdict: accept` or `Review verdict: change`. The worker records this verdict separately before truncating the report. Only `accept` sets `accepted: true`; feedback is the report text before the verdict, within the worker's report limits. `findings` is 1 for a `change` verdict with a report that is not empty. Otherwise it is 0. A missing final verdict returns `accepted: false`, `findings: 0` and `The review turn has no verdict line.` A failed turn rejects with its effect reason. Fake scenarios provide `{ summary, reviewVerdict }` worker results through `effects["claude run-turn:checker"]`, with `reviewVerdict` set to `"accept"`, `"change"` or `null`.

Use `mergeWhenGreen` to merge a pull request when its checks pass:

```ts
import { mergeWhenGreen } from "cloving/workflows/steps/merge-when-green";

const pull = { number: opened.number, url: opened.url, commit: opened.commit, target: runTarget };
const merge = await mergeWhenGreen({ pull: pull, check: "beforeMerge" });
```

`check: "beforeMerge"` runs the `checks.beforeMerge` command of the settings before the merge. When that setting is missing, the result is `{ merged: false, reason: "check-not-configured", output: "" }`, and the pull request stays open. `check: null` merges with no local check, also after an update from the default branch. A missing setting never turns the check off. In both cases, CI must pass on the updated head. The review of the pull commit stays valid when the step updates the branch from the default branch.

The result is `{ merged, reason, output }`. After a merge, `merged` is `true` and `reason` is `null`. For `check-failed`, `merge-conflict` and `ci-failed`, `output` holds the check, conflict or CI output for a fix turn. `ci-pending` means that CI did not finish within the wait limit. In queue mode, `merge-queue-removed` and `merge-queue-timeout` tell that the pull request left the merge queue with no merge (see "The GitHub merge queue"). To try the merge again, call the step with a higher `round`, for example `{ pull: pull, check: "beforeMerge", round: 2 }`. `round` is a positive integer and defaults to 1. A call with the same pull, commit and round uses the same operation, so a resumed workflow does not merge twice. To try a merge that failed with a short git or network failure again in the same round, add a positive integer `retry`, for example `{ pull: pull, check: "beforeMerge", round: 1, retry: 1 }`. Each `retry` value starts a new merge operation for the same commit. When an earlier attempt pushed a merge of the default branch, the new operation uses that head. If that attempt ran no local check and the new call asks for one, the step runs the check on that head before the merge. Other failures reject with the effect reason, and a malformed result rejects with `invalid-merge-result`. An invalid `pull` or `check` rejects with `invalid-merge-request` before any request.

Replace that call with `mergeByPerson({ pull: pull, check: "beforeMerge" })` to let a person decide when the merge starts. The step opens an approval for the pull number and commit. After an approval, it merges with the same check rules and `round`. After a denial, the result is `{ merged: false, reason: "not-approved", output }`, where `output` is the answer of the person, and no merge starts. The approval belongs to the pull commit, so a retry with a higher `round` does not ask again.

Both steps use the existing GitHub `merge` worker method and one protected effect unit. The candidate declaration must include the `github` capability and `methods: { "github": ["merge"] }`. The step subpaths and `cloving/workflows` export the step functions. Import the types `PullRequest`, `MergeRequest` and `MergeResult` from `cloving/workflows`. Fake scenarios give worker results in `effects["github merge"]` and person decisions in `decisions`.

To show a file on a pull request, for example a demo video, a worker turn writes the file into the folder in `CLOVING_ATTACHMENTS_DIRECTORY`. Each turn of a run gets the same folder, outside the work tree. Then the workflow asks for the GitHub method `attach-asset`:

```ts
const attached = await protectedEffect({
  scope: { phase: "pull-request", operation: "github-attach-demo", round: 1 },
  capability: "github",
  method: "attach-asset",
  target: runTarget,
  payload: JSON.stringify({ number: pull.number, name: "demo.mp4", release: "pr-demos", comment: "Demo of the change." }),
  units: 1,
});
```

The method uploads the file as an asset of the release `release`, with the asset name `pr-<number>-<name>`. Then it creates or updates one comment on the pull request with a link to the asset, so a second call adds no second comment. GitHub does not play a release video in the page. An optional `place` is `comment` (the default) or `description`. With `description`, the method writes the text and the file into the pull request body between the markers `<!-- cloving-attachment:<number>:<name> -->` and `<!-- /cloving-attachment:<number>:<name> -->`, with `gh pr edit --body-file <file> --attach <file>`. `gh` uploads the file to GitHub, and GitHub shows a video as a player. This place makes no release asset and no comment, a second call replaces the block, and it needs a `gh` version with `gh pr edit --attach`. When the release does not exist, the method creates it as a pre-release that is not the latest release. `name` is a file name with the extension `.mp4`, `.webm` or `.png`. The file must be a regular file of at most 100 MB, and a symbolic link is refused. `release` has lowercase letters, digits and hyphens, and it cannot start with `v` and a digit, so it never matches a version tag. The comment text must pass the same privacy check as issue texts. The failure reasons are `invalid-payload`, `attachment-not-available`, `attachment-too-large` and the usual GitHub reasons. The candidate declaration must include `methods: { "github": ["attach-asset"] }`.

The template tests use `fakeStepBridge` from `cloving/workflows/testing` to record effect and gate requests and supply fake results. `templates/develop/develop.test.ts` exercises the develop template through that public testing API.

Use `cloving workflows list` to inspect project and user workflows without a service. `--json` prints an array with `scope`, `workflowId`, `file`, `admitted`, `codes` and each valid parsed declaration. Invalid declarations have a null ID. Inspection uses the same folder admission and compiler as startup in a disposable project directory.

Put tests beside each folder workflow as `<name>.test.ts`, then run `cloving workflows test <workflow-id>`. Omit the ID to run all available project and user workflow tests. Both commands accept `--repository <directory>`. The Node test runner prints its results and supplies the exit status. Unknown IDs report `unknown-workflow`; known workflows without tests report `workflow-test-missing`. Neither needs a running service.

The package contains workflow templates. `cloving templates list` shows each template with its summary and its number of decision points, and `cloving templates show <name>` shows its decision points and its workflow files. With `--json`, `list` prints an array of `{ name, summary, points }`, and `show` prints `{ template, files }`, where `template` is the content of `template.json`.

`cloving templates copy <name>` writes the workflow file, its helper folder, its declaration and its test into `.cloving/workflows/` of the current repository (or of `--repository <directory>`), and prints the decision points and the next command `cloving workflows test <workflow-id>`. The declaration of the copy names its template in the field `template`. `--id <workflow-id>` gives the copy another workflow ID: the command renames the files, the helper folder, the workflow ID and the exported function, and changes the imports and the test references. The ID uses lowercase letters, digits and single hyphens and starts with a letter; another ID fails with `invalid-workflow-id`. A copy writes no file when a workflow file or folder of that ID is already present, and fails with `workflow-exists`. The command writes the files into a temporary folder first, and then puts each file in place; after a failure, it removes the files that it put in place. When two workflows of the project and user folders have `"queue": true` after a copy, the command prints `queue-workflow-conflict`; select "a person" for the select point of one copy.

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

Each scenario runs in an isolated Node process. `effects` maps `"<capability> <method>"` to result queues; `effects.handoff` supplies handoff results, `effects.continueRun` supplies `continueRun` results, `waits` supplies one run-wait answer for each check, and `decisions` supplies `{ decision, answer }` results for `waitForDecision` in call order. A `waits` entry `{ kind: "waiting" }` answers one check with waiting; each other entry is the outcome of the awaited run. A missing run-wait answer gives the outcome `unavailable` with reason `no-scenario-result`. A waiting answer records a sleep until the next check of the normal check schedule, on a clock that starts at 0. Each wait has its own clock. The clock of a wait starts at the lowest whole number of milliseconds, from 0, that no other active wait for the same run uses. A waiting answer at or after the deadline on the clock of the wait ends the wait with `run-wait-timeout`. A missing `waitForDecision` result throws `no-scenario-result`. Sleep requests are recorded in order and complete immediately in both testing APIs, without consuming the simulated effect budget. An optional `effectLimit` simulates a budget and adds `spent` to the result. Missing effect results return `unavailable`. For tests that import the workflow directly, `using bridge = fakeStepBridge(scenario)` installs the same fake bridge until disposal and exposes `requests` and `spent`. It refuses to replace an active host bridge. The test command resolves public Cloving imports from its own package, including a global installation, without adding a package to the consumer repository.

There are no built-in registrations. Workflow IDs are available to project and user declarations.

For a repository or user folder workflow, use one `<name>.ts` file with one exported workflow function. Put one `<name>.declaration.json` file beside it. Function names and workflow IDs must be unique across the project and user folders.

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

A declaration can have one `"ticket": { "type": "ticket" }` field, named `ticket`. Submit its ID as a string. When it is the only required field, use `cloving run <workflow-id> --ticket 312` or `--next`. You can also use `--input ticket.json` with `{"ticket":"312"}`; include every other required field in that file. At admission, the daemon reads the configured ticket command and replaces the ID with `{ "id": "312", "text": "# ..." }` inside the workflow's `input`. `--next` selects the ID through the configured next command. Missing sources keep the `ticket-source-not-configured` and `next-source-not-configured` refusals. The `Needs #N` dependency rule and `ticket-active` refusal apply as for `develop`. Active tickets are checked within each workflow, so different workflows can work on the same ticket. Doctor requires `ticket-command` for these declarations, and the watch form labels the field **Ticket ID**.

Optional `commands` lists distinct names from `CLOVING_COMMANDS`; executable paths and arguments belong only in the operator setting. The `command` capability requires at least one name. Registration refuses an unknown name with `command-unknown`. The execution pin retains these names with each run, and authority refuses `command` effects whose `run:<name>` method is absent from that run's pinned list with `command-not-declared`. Reordering names preserves the pin; changing names changes it. Omitted and empty lists preserve legacy pins.

Optional `commandWaits` declares named command checks outside the ordinary effect budget. Internal `HostPorts.commandWait` methods open a wait with serialized input, request its next check and read its durable state. Authority admits checks from the pinned declaration and recorded schedule, permits one in-flight check, and schedules the next check from settlement time. Checks use the command worker and operation journal, with each process bounded by the shorter of its command time limit and the remaining wait duration. Pending output is a JSON object with `ready: false`; `ready: true` completes with the optional `value` or `null`. Command failure, interruption or malformed output fails the wait without retry. Restart preserves the deadline, schedule and results. Expiry continues while paused or stopped and requests that an in-flight check stop; dropping the run also requests a stop. Status JSON includes `commandWaits` in both run details and list summaries. Each entry shows its name, command, state, declared `maximumWaitSeconds`, `startedAt`, `deadline`, `nextCheckAt`, `checkCount`, `remainingSeconds` and terminal `reason`. Before opening, its state is `not-started`, its times are null and the full allowance remains. Active countdowns round up to whole seconds and stop at zero; early settlement freezes the remaining time. Plain status, watch cards and run details show these times beside the ordinary effect budget. Watch refreshes quiet waits between polls and retains active runs beyond one week. Wait data excludes command input and output.

The map accepts names of 1–64 ASCII letters, digits or hyphens, with entries containing exactly `command`, `maximumWaitSeconds` and `pollEverySeconds`. The command must be declared in `commands`, configured in `CLOVING_COMMANDS` and permitted by the `command` capability. Maximum wait is an integer from 60 through 2,592,000 seconds; polling interval is an integer from 60 through 86,400 seconds and cannot exceed that maximum. For example, `"commandWaits": { "team-review": { "command": "review-state", "maximumWaitSeconds": 2592000, "pollEverySeconds": 3600 } }` pins that named permission. Reordering entries preserves the execution pin; changing a name, command, duration or interval changes it and refuses incompatible resumption. Legacy runs retain their original pin without wait permission. Ordinary `runCommand` calls still spend effect units, including calls to a command named in this map. Operators must choose read-only, repeat-safe checks; command execution does not enforce read-only access.

Internal command delivery accepts the wait's absolute deadline. An attempt uses the shorter of `CLOVING_COMMAND_SECONDS` and the remaining milliseconds, refuses to spawn at or after expiry, and reports `command-wait-timeout` if it settles too late. A recorded result still replays after expiry; authority accepts readiness only when it records the result before the wait's deadline. An unfinished journaled command retains `command-interrupted` recovery. This internal cap is not exposed through ordinary workflow command requests.

Use `waitForCommand({ name, input })` for a declared command wait, imported from `cloving/workflows` or `cloving/workflows/steps/wait-for-command`:

```ts
import { waitForCommand } from "cloving/workflows/steps/wait-for-command";

const outcome = await waitForCommand({
  name: "team-review",
  input: { change: 42 },
});
if (outcome.kind === "ready") return outcome.value;
```

The request accepts only a declared literal `name` and JSON-serializable `input`. Extra fields, including callbacks, executables, arguments, deadlines and exemptions, are refused before dispatch. The step returns a terminal result: `{ kind: "ready", value }`, `{ kind: "timed-out", reason: "command-wait-timeout" }` or `{ kind: "failed", reason }`. Missing hosts return `kind: "unavailable"`; unknown waits and invalid requests return `kind: "refused"` with an explicit reason. Pending checks stay inside the workflow loop and never reach its caller.

The first check is immediate. Each later check is due at the previous settlement time plus the declared interval. The workflow uses durable SDK suspension between checks and wakes at the earlier of the next check and the original deadline. The deadline continues through host downtime and pauses; restart preserves it and never catches up missed checks. No check starts at or after the deadline, no automatic SDK retry repeats a failed check, and wait checks spend no ordinary effect units. Each name identifies one wait per run: identical input joins it and changed input is refused. The operator must configure a read-only check command that is safe to run again; Cloving does not enforce read-only filesystem or network access.

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

`cloving red-green` checks the changed tests of a commit. It reads `{"head":"<full commit ID>"}` on standard input in the repository folder. The base is the merge base of that commit and `refs/remotes/origin/HEAD`. Configure `checks.redGreen` in `.cloving/config.json`:

```json
{
  "version": 1,
  "checks": {
    "redGreen": {
      "test": ["node", "--test"],
      "testFiles": ["test/"],
      "prepare": ["npm", "ci", "--ignore-scripts"]
    }
  }
}
```

The daemon maps this object to `CLOVING_RED_GREEN`. An environment value takes priority. For direct use, set `CLOVING_RED_GREEN` to the same JSON object. `test` is an argument array. The tool appends the added or changed file paths under the `testFiles` prefixes. It excludes deleted files. `prepare` is optional and runs before each test command. Optional `assertionPattern` and `skipPattern` are regular expression strings. The defaults are `ERR_ASSERTION` and `# SKIP\b`, which match non-terminal `node --test` output.

Register the tool in `CLOVING_COMMANDS` with the absolute path of the installed executable, for example `{"red-green":["/opt/cloving/bin/cloving","red-green"]}`. Declare `red-green` in the workflow's `commands` list. A workflow can then call `runCommand` with `name: "red-green"` and `input: { head: commitId }`. Increase `CLOVING_COMMAND_SECONDS`, for example to `600`, to allow both preparation and test runs. This setting also bounds each preparation or test command inside the tool.

The red run uses a detached temporary worktree at the base with only the selected tests restored from the head. The green run uses another detached worktree at the head. Both runs use the same test paths. The tool removes each tree after the run, a command failure, a timeout, SIGINT or SIGTERM. Cleanup also runs after the operator stops the command or its process group. It preserves the repository folder's branch, index and files. The commands run as the current user.

The tool prints one JSON object with `verdict`, `base`, `head`, `files` and `output`. The output contains the last 16,000 characters from the command that decides the verdict. Successful preparation logs do not supply assertion or skip evidence. With no selected tests, the verdict is `no-test-change` and no command runs. Otherwise, both runs occur. The first applicable rule decides:

1. Preparation fails in either run: `prepare-failed`.
2. Either run matches the skip pattern: `skipped-test`.
3. The red run succeeds: `false-red`.
4. The red run is interrupted, times out, or fails without the assertion pattern: `red-not-assertion`.
5. The green run fails: `green-failed`.
6. Otherwise: `accepted`.

Every verdict exits with status 0 so a workflow can send the result to a fix turn. Invalid input, invalid settings and git errors exit with status 1. This tool does not change the develop template or the full-suite checks on the head.

Optional `handoffs` lists distinct registered workflow IDs. Registration refuses unknown targets. The execution pin retains these permissions with each run: target order does not affect the pin, while adding or removing a target changes it. Omitted and empty lists keep existing pins. Stored permissions survive restart and retained workflow versions. The `idea-to-issue` template declares `develop` as its only handoff target and calls it after creating an issue. Both workflows must be copied and admitted. A refused PRD handoff adds `cloving: ready` for the queue and records the refusal in the PRD run's outcome.

Use `handoff` inside a workflow to submit input to a declared target:

```typescript
import { handoff } from "cloving/workflows/steps/handoff";

const runId = await handoff({
  workflowId: "develop",
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

The wait is a loop of short check steps with a durable sleep between them. The first check sets the start time and the deadline. The interval between checks is the time that the wait has used, but not less than 2 seconds and not more than 1 minute. The next check never comes after the deadline. While the awaited run is active, a check makes no step retry, so a wait of many hours does not reach the queue delivery limit of the Workflow SDK. A daemon restart keeps the deadline, includes the downtime in the wait, continues the checks and replays the same terminal outcome. `cloving status` shows condition `waiting-run` and the awaited run ID (`awaitedRunId` in JSON); watch cards show a link labeled “Waiting for run”.

Use `continueRun` to continue a failed or blocked run of the same handoff chain, as `cloving run continue` does:

```typescript
import { continueRun, handoff, waitForRun } from "cloving/workflows";

const runId = await handoff({ workflowId: "develop", input: {} });
const outcome = await waitForRun({ runId, maximumWaitSeconds: 3600 });
if (outcome.kind === "failed") {
  const next = await continueRun({ runId });
  await waitForRun({ runId: next, maximumWaitSeconds: 3600 });
}
```

The step returns the run ID of the continuation. The optional `from` names a step, as `--from` does. The optional `bundle` is `retained`, the default, or `current`. The step spends one protected-effect unit of the `handoff` capability, so the declaration must list `handoffs`. The service admits the continuation only when the two runs have the same `chainId`. Otherwise the step fails with `continuation-outside-chain`. The continuation keeps the `parentRunId` and `chainId` of the old run, so a parent can wait for it with `waitForRun`. Each refusal of `cloving run continue`, for example `run-active`, fails the step with the same code. Replays use the command ID `continue:<operation ID>` and return the same run ID.

A run that a workflow bundle of an earlier Cloving version started keeps the single wait step of that version. The daemon still answers that step. It uses the same check schedule and deadline, and it tells the step to try again at the next check time. Each try is one queue delivery, so such a wait can still reach the delivery limit.

Optional `stages` contains 1–12 entries in board order. Each entry has a unique `name` (1–64 ASCII letters, digits or hyphens), a unique `label` (1–40 printable characters on one line, without outer spaces), and any combination of `operations`, `gateKinds` and `gateIds`. At least one selector array must be nonempty; the others may be omitted or empty. Operations match the `scope.operation` passed to `protectedEffect`; gate IDs match the `gateId` recorded when a gate opens. Both use 1–128 ASCII letters, digits or `._:/-`. Gate kinds are `approval` and `question`. Selectors cannot repeat within an array or belong to two stages of the same selector type within one workflow. Different selector types may share text, and different workflows may reuse IDs. Unknown fields and labels `Other`, `Done` and `Stopped` are rejected.

For declared stages, the board and its `data.json` response use the latest committed `effect.requested` or `gate.opened` sequence, preserving that event's start time. Effect requests select by operation. Gate openings first search every stage for an exact, case-sensitive gate ID match, regardless of declaration order; without one, they fall back to the gate kind. Unmatched events and runs without a relevant event use Other. Unused valid IDs are allowed. Decisions and worker output do not advance a card; later requests or gate openings can move it back. Declared labels are followed by Other, Done and Stopped. Existing terminal retention rules take precedence. Declared stages apply regardless of the workflow ID. Unstaged workflows keep their existing columns and placement. Declarations load at service startup; stages provide display metadata and grant no capabilities.

For example, a `review-flow` declaration can distinguish successive approval gates without another workflow or handoff step:

```json
{
  "stages": [
    {
      "name": "your-review",
      "label": "Your review",
      "gateIds": ["your-review"]
    },
    {
      "name": "team-review",
      "label": "Team review",
      "gateIds": ["team-review"]
    },
    {
      "name": "ready-to-merge",
      "label": "Ready to merge",
      "gateIds": ["merge-review"]
    }
  ]
}
```

Each committed opening moves the run's single card to the matching column. Completion with outcome kind `handoff_requested` places it in Done; failure, cancellation or completed outcome `blocked` places it in Stopped. Those terminal columns retain the twenty newest cards within the inclusive past seven days. Other completed outcomes have no terminal card. Done is reserved and cannot be declared as a stage.

After startup, `cloving status` lists the declared ID. Submit JSON with `cloving run review-run --input input.json`. The function receives `{ cycleId, repository, input }`, where `cycleId` is `task-` followed by 12 characters derived from the command ID, `repository` is the service repository, and `input` retains the checked JSON values. Invalid input is rejected before a run starts. Invalid declarations or duplicate workflow IDs or function names stop startup.

A declared workflow can include a schedule. A schedule has one of two shapes. An interval schedule repeats after a fixed number of seconds:

```json
"schedule": { "everySeconds": 300, "input": {} }
```

`everySeconds` must be a whole number from 60 through 2592000 (30 days).

A calendar schedule runs at a time of day in a named time zone:

```json
"schedule": {
  "at": "07:00",
  "timeZone": "America/Los_Angeles",
  "weekdays": ["monday"],
  "input": {}
}
```

- `at` is a local time `HH:MM` from `00:00` through `23:59`.
- `timeZone` is an IANA name, for example `America/Los_Angeles` or `UTC`. A calendar schedule must have it.
- `weekdays` is an optional list of day names from `monday` through `sunday`, with no duplicates. With no list, the schedule runs each day.

A calendar schedule gets `invalid-schedule-shape` in these conditions:

- It also has `everySeconds`.
- The `at` text is not `HH:MM` from `00:00` through `23:59`, for example `24:00`.
- It has no `timeZone`, or it has a `timeZone` or `weekdays` but no `at`.
- The `weekdays` list is empty, has a duplicate or has a name that is not a day.

The pure check cannot read the time zone data. The daemon checks the time zone when it registers the schedule. It refuses an unknown name, or an offset such as `+05:00`, with `invalid-schedule-time-zone`.

In both shapes, `input` must satisfy the workflow's submission contract, including its byte limit. The resolved input, including the daemon's cycle and repository fields, must also fit the service's 262144-byte document limit. Set `CLOVING_SCHEDULES` to a JSON object to replace a declaration's schedule or schedule an otherwise unscheduled declared workflow. Each value has one of the two shapes, for example `{"review-queue":{"everySeconds":600,"input":{}}}` or `{"review-queue":{"at":"07:00","timeZone":"UTC","weekdays":["monday","thursday"],"input":{}}}`. Only registered declared workflow IDs are accepted. Invalid settings fail startup with `invalid-schedules`, `unknown-schedule-workflow`, `invalid-schedule-interval`, `invalid-schedule-shape`, `invalid-schedule-time-zone` or `invalid-schedule-input`. Invalid declaration files retain the `invalid-workflow-declaration` refusal.

The first run of an interval schedule starts after one interval. Slots retain increasing numbers in private Cloving state (`state/schedules.json`); each submission uses the operator command ID `schedule:<workflowId>:<slot>`. Restart preserves the next boundary and retries an unacknowledged submission with its saved input and command ID. Missed intervals coalesce into the latest due slot rather than a burst of catch-up runs. Changing the interval starts a fresh interval while retaining slot numbers and any active run.

The daemon computes the slots of a calendar schedule from the local calendar of its time zone. The first run starts at the next slot after the daemon registers the schedule. Each run or skip of a calendar schedule adds one to the slot number. When the daemon was stopped during one or more slots, it submits one run when it starts again. The next slot is then the first slot after that start. A change of `at`, `timeZone` or `weekdays`, or a change between the two shapes, computes a new next slot. The change keeps the slot numbers and any active run.

Daylight saving time changes the local clock two times each year. The daemon applies these rules:

- When the clock moves forward, a local time in the skipped hour does not occur on that day. The schedule runs at the first minute after the gap. For example, a schedule at `02:30` in `America/Los_Angeles` runs at 03:00 on 2027-03-14.
- When the clock moves back, a local time in the repeated hour occurs two times. The schedule runs one time, at the first occurrence. For example, a schedule at `01:30` in `America/Los_Angeles` runs at 01:30 PDT on 2026-11-01, and not again at 01:30 PST.

An earlier scheduled run blocks later scheduled slots while queued, running, waiting for a decision or paused. Each overlap records a `schedule.skipped` event on that earlier run, with `workflowId` and `slot`, without changing its status or observation. Manual runs remain independent. The ticket queue continues to use `CLOVING_QUEUE_SECONDS`.

Use `cloving schedule [--json]` to list workflow IDs, intervals or calendar times, state, failure counts, slots, next run times and active runs. `cloving schedule pause <workflowId> [--json]` stops new scheduled runs without interrupting an active run or recording skips. `cloving schedule resume <workflowId> [--json]` clears the failure count and starts the next run one interval later, or at the next calendar slot, retaining increasing slot numbers. Repeating pause or resume leaves the current state and timing unchanged. Paused and stopped schedules survive restarts and interval changes.

`cloving status` shows each schedule after the queue lines, for example `Schedule review-queue: every 300 s, active, next run at 2026-10-14T12:05:00.000Z, 0 failures in a row`. Paused schedules show `paused` without a next run time; stopped schedules show `stopped`, the stop time and the failure count. The watch board shows the same information on the workflow's board and refreshes it on the next poll. Status times use ISO timestamps; watch times use the browser's local date and time.

A calendar schedule shows its days, its time and its time zone. The next run shows the local time of that time zone with its offset, in status, in `cloving schedule` and on the watch board. For example, `cloving status` shows `Schedule review: Mondays at 07:00 America/Los_Angeles, active, next run at 2026-11-16T07:00:00-08:00, 0 failures in a row`. A schedule with no `weekdays` shows `each day`, for example `each day at 07:00 UTC`.

Status JSON includes `schedules` entries with `workflowId`, `everySeconds`, `state`, `failuresInRow`, `nextAt` and `stoppedAt`. Times are epoch milliseconds or `null`; paused and stopped schedules have `nextAt: null`. A calendar entry has `at`, `timeZone` and, when set, `weekdays` in place of `everySeconds`. It also has `nextLocal`, the next run as a local ISO time with its offset, or `null` when `nextAt` is `null`. The field is absent when no schedules are configured. A scheduler that is not running yet is shown as `schedules: { "status": "unavailable" }` and `Schedules: unavailable` in status and watch.

Runs admitted by a schedule show `scheduled 12` for slot 12 on the status run line, in run status, on the watch card and in the watch run detail. Their JSON summary and detail include `scheduled: { "slot": 12 }`. Manual runs have no scheduled mark.

Three consecutive failed scheduled runs stop a schedule. A completed run with outcome `blocked` counts as a failure; cancellation leaves the count unchanged, and any other completion clears it. With `CLOVING_NOTIFY_COMMAND` configured, each stop sends a `schedule-stopped` notification with the three failed run IDs and the resume command; its `runId` names the third failed run.

Schedule settings load at startup. A scheduler transport or journal failure stops scheduling and writes a diagnostic; reconcile the state and restart to retry a pending slot. Full product admission remains subject to the external verification policy.

Startup retains each complete compiled project under `workflow-bundles` in private daemon state, beside the generated `project` directory. Each content-addressed snapshot includes workflow sources, declarations, registration manifests, all compiler artifacts, and the installed dependency graph and Node identity. Snapshots bind to the canonical repository and survive later source edits or removal. Storage lookup validates every captured file and returns `pinned-workflow-unavailable` for missing or changed bytes; startup refuses reuse of a matching damaged snapshot without repairing it. Before Local World starts, the daemon loads the retained generations needed by unfinished runs. Their starts, replays and continuations use the recorded bundle, including after workflow removal; new submissions use current registrations. A workflow message of a dropped run gets a done answer. No workflow code runs, the daemon records no observation, and the Local World queue stops its retries. Duplicate answers and replay preserve effect receipts and spending.

The retention rule removes old workflow bundles. The daemon examines the bundles at startup and at each retention pass, after it loads the generations of the unfinished runs. It removes a bundle only when all of these conditions are true:

- No unfinished run is pinned to the bundle.
- The bundle is not the current generation of the daemon.
- The bundle was not current during the last `retention.days` days.

The age of a bundle starts at the last time when the daemon used it as the current generation. The daemon records this time at startup, at each retention pass and at each workflow reload. A bundle that was never current gets the time when the daemon wrote it.

Earlier Cloving versions did not record this time. Thus the first pass after an upgrade records the current time for all stored bundles. Then it writes the empty file `workflow-bundles/.current-times`. Each old bundle stays for at least `retention.days` days after the upgrade.

With `retention.action` set to `archive`, the bundle moves to `workflow-bundles/<digest>` in the archive folder. With `delete`, the daemon deletes the bundle. With `retention.days` set to `null`, the daemon keeps all bundles.

The daemon removes a bundle as one unit. It first renames the bundle folder to `.removing-<digest>`, which lookup ignores, and then removes that folder. When a removal stops before its end, the next pass completes it. A removal also deletes the record of the bundle in `.history`, so that a later start can build the bundle again from equal sources. Each removal writes one log line with the digest and the action, for example `retention: archived workflow bundle <digest>`.

Each pass removes no more than five bundles. The next pass continues after the last bundle of the pass before it. Thus a bundle that the daemon cannot remove does not stop the other bundles.

The archive folder can already have a bundle with the same digest. Then the daemon compares all files of the two copies. When the copies are equal, it deletes the `.removing-<digest>` folder. Otherwise it keeps that folder and writes the log line `retention: workflow bundle <digest> not removed (archive-copy-differs)`.

The retention rule also removes old work trees. At each pass, before it moves records, the daemon finds the runs of each work tree from the `started.json` files in `journal/` and `github/`. It adds these runs to the run list of the work tree in `journal/trees/`. The retention rule does not move this folder, so a run stays on the list after its records move to the archive. The daemon removes the work tree, its `cloving/<name>` branch and its attachments folder only when all of these conditions are true:

- All runs of the work tree ended `failed` or `cancelled`.
- Each of these runs ended more than `retention.days` days ago.
- GitHub has no open pull request for the branch.

A run counts for a work tree only when the run did not end before the daemon made the work tree. The daemon reads that time from the modification time (`mtime`) of the `.git` file in the work tree. Thus a new work tree of a target does not count the runs of an earlier work tree of the same target, also when the earlier work tree went away between two passes.

The daemon keeps the work tree when a run is not known, when a run is active or completed, or when the pull request check fails. It also keeps the work tree when it cannot read the `.git` file or the run list of the work tree. The daemon does not change a run list that it cannot read, and the log line names the work tree with `tree-runs-unreadable`. When the daemon cannot read the `journal/trees/` folder, the pass removes no work tree. It never removes the work tree of a `branch:` target. When a work tree is gone, the daemon deletes its run list. With `retention.days` set to `null`, the daemon keeps all work trees. A run whose records moved to the archive before the first pass that wrote the run list is not on the list.

A pass checks at most three work trees with GitHub, and the next pass continues with the others. Each GitHub read stops after 10 seconds, and a stop of the daemon cancels it. Each pass writes one log line, `retention: removed <count> work trees, kept <count> with an open pull request`, with the failures at the end.

### Project and user workflows

At daemon startup, Cloving also checks these folders on both macOS and Linux:

- Project: `.cloving/workflows` under the repository selected by `cloving start --repository REPOSITORY` (the current repository by default).
- User: `$XDG_CONFIG_HOME/cloving/workflows` when `XDG_CONFIG_HOME` is absolute; otherwise `$HOME/.config/cloving/workflows`. macOS uses these same XDG rules.

Missing folders are left absent. Discovery reads top-level `.ts` files, excluding `.d.ts`, and requires a matching `<name>.declaration.json`. A project or user declaration wraps the workflow metadata and lists the effect methods it may request:

```json
{
  "workflow": {
    "workflowId": "project-review",
    "effectLimit": 1,
    "capabilities": ["claude"],
    "input": {
      "maximumBytes": 1024,
      "fields": { "task": { "type": "string" } }
    }
  },
  "methods": { "claude": ["run-turn"] }
}
```

Use one exported async workflow function with `"use workflow"` and the public `cloving/workflows` helpers. Each capability requires a nonempty list of distinct method names. Declaration, source and actual SDK compilation must pass admission before registration. Declaring a method grants no execution authority; the broker still enforces each run's capabilities and budget. Submit inputs with `cloving run project-review --input input.json`.

Only admitted project and user workflows are registered. A refused neighbor does not stop valid workflows from loading. `cloving status --json` exposes `workflowRefusals`; status and watch show each refusal's scope, safe file label and codes without its source text. These codes identify the failed check:

| Codes | Meaning |
| --- | --- |
| `invalid-declaration` | Missing, malformed or invalid declaration. |
| `forbidden-import`, `missing-export` | Import outside the public helper surface, or an unavailable named export. |
| `unsupported-source`, `dynamic-effect`, `direct-effect` | Unsupported source form, a nonliteral effect request, or a direct effect outside helpers. |
| `undeclared-effect`, `effect-limit` | Requested method absent from the declaration, or statically known work exceeding the limit. |
| `workflow-conflict` | Conflicting basename, workflow ID or function name across project and user files. |
| `unsafe-workflow-path`, `workflow-read-failed`, `workflow-source-changed` | Unsafe file or folder path, unreadable input, or input changed during capture. |
| `compile-failed` | Candidate analysis or SDK compilation could not complete. |

Project and user files form one conflict set; neither scope overrides the other. Sources and declarations are captured at startup. Edits take effect on the next start, when new runs use the newly admitted version. A restored question retains its original prompt and decision identity. After a source edit and a restart, unfinished runs continue on the retained generation that they started with, as the paragraph on `workflow-bundles` above describes, and new runs use the newly admitted version.

Every operator run binds to the daemon's canonical repository, including workflows loaded from the user folder. Its top-level `repository` input comes from the daemon; an input field also named `repository` remains ordinary submitted data under `input.repository`. A repository alias resolves to the same canonical binding. Retained snapshots are repository-bound and cannot be reused for another repository.

Candidate policy checking is available internally through `checkWorkflowCandidate` in `src/workflow-candidate.ts`. It takes serializable analysis facts, an export snapshot and a candidate declaration containing `workflow` and `methods`. Each declared capability requires a nonempty list of distinct method names. The existing workflow sidecar format is unchanged. Results are sorted, unique refusal codes; an empty list grants no admission or execution authority.

The caller supplies imported symbol names, literal effect pairs (`null` represents a dynamic value), direct-effect and unsupported-form findings, and known call and unit totals. Unknown portions of a total still require runtime budget enforcement. This pure checker does not analyze source or verify these facts. The installed admission adapter in `tools/admit-workflow.ts` derives those facts from source and performs SDK compilation; the pure checker alone cannot admit or authorize a run.

## Development of Cloving

The terminal integration test uses `/usr/bin/python3` (Python 3.9 or newer) and its standard `pty` module to exercise a real terminal. No Python packages are needed.

The shell tests require both zsh at `/bin/zsh` and Bash at `/bin/bash`. macOS includes them. Linux contributors and CI runners must install both before setup; on Ubuntu, install the `zsh` and `bash` system packages. The fixtures exercise zsh 5.9 and Bash 3.2 or 5.2, including their real startup files; neither shell's tests are optional. `npm run check:setup` checks that both executables run and reports a missing prerequisite before compilation.

```sh
npm ci --ignore-scripts
npm run check:setup
npm run build
node dist/src/cli.js --help
npm pack --ignore-scripts
```

After a merge or branch update changes `package.json` or `package-lock.json`, rerun `npm ci --ignore-scripts` in the worktree before running checks. Copied `node_modules` can still contain the previous versions; the developer gate rejects a mismatch with the lockfile.

`npm pack` prints the file name of the tarball. Install it into a separate project with `npm install --ignore-scripts --omit=dev /absolute/path/to/TARBALL`, then run `./node_modules/.bin/cloving --version` or `./node_modules/.bin/cloving start`. The package includes the emitted CLI, start program, compiler and workflow templates; startup uses the installed runtime dependencies. The package has no installation hooks. An import of `cloving/workflows` gives the step helpers `loadCycle`, `protectedEffect`, `waitForDecision`, `handoff`, `continueRun`, `waitForRun`, `runCommand`, `sleep` and `waitForCommand`, and starts no service.

`npm run check` and `npm run test:concurrency` currently reject admission because the complete quality policy is not implemented. Setup checks are not product acceptance. State and retained releases will live outside the package installation; installing or updating the package does not activate a daemon or migrate state.

Run `npm run test:scale` on an otherwise idle machine to measure authority opening at 1,000, 10,000 and 50,000 events. This command runs the benchmark alone, without coverage; the regular test suite excludes it. The fixture uses completed runs with budgets, gates and released continuations. It requires each opening to take less than two seconds and the largest opening to take less than eight times the 10,000-event opening. Replay uses the pure reducer with run-scoped projections and preserves shared effect and lease state. Large effect histories, growing gate or pending-intent state within one run, and cancelled-run recovery still require separate scaling work; this benchmark does not establish their bounds. The generated-history parity and tamper tests compare replay with the full reducer and cover every event type. The same command also measures the first status page of a service with 700 runs and 7,000 events, and requires an answer in less than 200 ms. The service keeps the projected authority state in memory, so a status request reads no projected table in full after the start.

`npm run check:quality` checks the npm manifest, lock and installed versions, builds the package with `npm run build`, regenerates TypeScript output in memory, inventories first-party files, and runs strict compilation, the proposed module catalog, workflow/effect boundaries, suppression and test-integrity checks, formatting, typed lint, structural checks, clone detection and the regular local test suite. Production modules require at least 90% line, statement and function coverage and 85% branch coverage per file. Coverage uses native V8 ranges mapped to the syntax tree of the exact Node-stripped source; unimported production files fail. Class and named object types allow at most 24 callable members; interfaces allow 10. Clone checks support ordinary TypeScript and JavaScript; JSX is rejected until separately qualified. `npm run check:lint`, `npm run check:format` and `npm run test:quality` run individual development checks.

The gate uses the committed `quality/test-durations.json` record to start files with unknown durations first in path order, then recorded files from longest to shortest, breaking ties by path. Stale entries have no effect. The launcher passes the ordered list directly to Node’s programmatic test runner because CLI discovery sorts positional paths. The test inventory and sorted report stay the same. Run `npm run record:test-durations` to refresh the record after adding or changing tests, then commit the JSON. This runs the regular suite with the gate's worker count, timeout settings, isolated environment and V8 coverage, sums each file's top-level test and suite durations in seconds, and writes entries in path order after a successful complete run. Nested tests are not counted twice. Temporary coverage stays outside the repository and is removed afterward. The command accepts the same concurrency and time-factor settings as the gate.

CI runs three duration-balanced shards for macOS and each Linux Node version on each pull request and each push to `main`. Only shard 1 runs the static checks. Each shard builds the package before testing, the same as the local gate, so runtime declarations are available independently of other test files. On a pull request, each shard exports raw production coverage, and a final job checks their joined coverage. A push to `main` runs the same shards with `CLOVING_TEST_COVERAGE=off`, so its test processes collect no coverage, and it skips the coverage job. The required checks remain `quality` and `quality_linux`. Without a shard setting, the local gate runs all checks and coverage as before and ignores `CLOVING_TEST_COVERAGE`.

A version tag runs no tests, because the `main` CI already tested its commit. The `release_check` job requires that the tagged commit is on `main`, and it waits up to 80 minutes for the `main` CI run of the same commit to pass. Then the publish job builds the package, publishes it and creates the GitHub release.

The quality report includes elapsed time and the effective limit in milliseconds for each bounded command: npm inventory, clone detection, tests and coverage conversion. Commands using more than 80 percent of their limit produce a warning in the JSON report and on stderr after the report. Failed checks print the collected timings and warnings with the original error and a failing exit status. Warnings preserve a passing result. If your change made the check slower, address the warning in the same ticket.

The watch scrolling tests launch an isolated headless Chrome process at desktop and phone widths. They require Chrome on the test machine. Run them with `node --test test/watch-scrolling.test.ts`. The fixture serves bundled Preact and board data over loopback and blocks external page resources.

To check the 390 px expansion race, run both phone scrolling scenarios twenty times with the CI timing factor:

```sh
for run in $(seq 1 20); do
  CLOVING_CHECK_TIME_FACTOR=3 node --test --test-name-pattern='CLV-(134|196).*390px$' test/watch-scrolling.test.ts || exit 1
done
```

The expansion helper waits for two animation frames before horizontal input. Resolving in the first callback can send the gesture before the widened Done column renders, leaving the board at its old horizontal scroll limit even after scrolling settles. The regression delays that rendering pass with `testMilliseconds(250)` and keeps the full card visibility assertion. A failure reports the card, column and board rectangles, both scroll positions and the viewport; compare the card's right edge with the board's right edge to distinguish horizontal clipping from an incomplete vertical scroll.

Before a ticket report, commit your work and run `npm run check:clean`. It refuses uncommitted changes, archives the committed tree of `HEAD` into a temporary directory, copies the worktree's `node_modules`, and runs `node tools/check-quality.ts` there with the same environment and exit code. Ignored files are absent, so tests that rely on stale local files fail. The gate builds `dist/` again from the committed sources. The temporary copy is removed after success, failure or SIGINT/SIGTERM interruption.

After merging dependency changes, run `npm ci --ignore-scripts` in the worktree before checking it. Copied dependencies can belong to an earlier lockfile; `check:clean` copies them unchanged. An `installed-lock-mismatch` requires refreshing that installation and rerunning the checks.

Set `CLOVING_CHECK_TIME_FACTOR` to a whole number from 1 to 9 (default 1) to multiply the developer gate test and coverage command time limits, the inner hook check limit (15 seconds by default), and the installed hook limit (30 seconds by default). With factor 3, the hook limits are 45 and 90 seconds, respectively.

Set `CLOVING_TEST_CONCURRENCY` to a whole number from 1 to 16 to override the developer gate's test worker count. Without the setting, the gate uses one fewer worker than the available cores, with a minimum of 2 and a maximum of 4. macOS CI sets it to 3 and Ubuntu CI sets it to 4. CI also sets `NODE_OPTIONS` to `--max-old-space-size=4096`, because the gate process needs about 2 GB of heap, and the hosted macOS runner gives only about 2 GB by default. Fork pull requests and other events use GitHub-hosted runners. Pushes start CI only for `main` and `v*` tags. A new push to a pull request cancels the older CI runs of that pull request, and a new manual run cancels the older manual runs of its branch; runs of `main` and of tags are never cancelled. Invalid values fail with an error.

Tests that stop a child process should await `stopChild` from `test/stop-child.ts`. Use `stopChildGroup` for a detached process group, including descendants whose leader has exited. Both helpers send `SIGTERM`, wait up to five seconds times `CLOVING_CHECK_TIME_FACTOR` for exit, then escalate to `SIGKILL`. When a test requires a hard crash or an unresponsive child, start that child with `NODE_V8_COVERAGE` omitted so a kill cannot interrupt its coverage recording. Keep coverage enabled for ordinary child runs and recovery runs.

The catalog and checker configuration are local proposals. The bounded SDK artifact, dependency-surface, production-coverage and mandatory-test inventory components have local qualification fixtures. Protected activation of their records, verifier execution and hooks remain pending. Dependency snapshots and supplied review records cannot activate a candidate. The local quality command cannot accept a product candidate. Static workflow checks are not isolation or replay proof. Deterministic sequencing fixtures qualify the test mechanism; they do not prove ownership or storage concurrency in the service.

The coverage profile supports strip-only TypeScript and JavaScript (`ts`, `mts`, `cts`, `js`, `mjs`, `cjs`). It rejects source-map and coverage-ignore patterns interpreted by the provider, including patterns inside strings. Native V8 limitations around throwing calls and default arguments remain; coverage does not replace behavioral assertions. Production roles come from the complete module catalog, independently of which files tests import. Nested npm workspaces and unsupported dependency directory links fail explicitly until qualified.

For trusted development fixtures, `npm run build:workflows -- SOURCE_DIRECTORY OUTPUT_DIRECTORY` runs the selected directive compiler with deterministic manifest ordering. Run the compiler in an isolated fixture project; its output directory must resolve that project's installed `workflow` dependency. Compiler caches and generated handlers stay outside the application source tree. Generated handlers are development artifacts and do not grant authority to execute effects.

SDK qualification uses a fixed logical output path and an empty root TypeScript configuration. Its separate input preflight rejects ancestor/nested compiler configuration, outside first-party inputs, dynamic/CommonJS loading and ambiguous local declaration/runtime resolution. Record the full installed tool/helper closure and every generated handler, manifest and debug artifact, then regenerate at the same logical path and compare preserved bytes. The direct build command does not authenticate these records. Real packed-helper execution is qualified with a disposable prototype.
