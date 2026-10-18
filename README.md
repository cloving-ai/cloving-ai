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
- In a run of `develop-ticket` or `develop-prompt`, the operator approves or denies the work of each round. A run has a maximum of three rounds.
- In a run of `develop-issue`, Greptile reviews the pull request. The GitHub worker merges the pull request at the confidence score 5/5, with no human approval.
- Cloving develops itself through `develop-issue`, with a Greptile review and an automatic merge.
- The watch page shows the runs, the events and the work of the Claude worker as it occurs.
- `cloving chats import -- FILE_A FILE_B` imports selected Claude Code transcripts into private runtime files without a service.
- `cloving chats redact IMPORT_ID` creates a redacted corpus and a separate counts manifest without a service.

What does not work yet:

- The Claude worker is not confined. It runs as the current user.
- An approval does not merge the branch. You merge the branch yourself.
- `cloving start` loads only the workflow file `workflows/develop-ticket.ts`. A new workflow file also needs changes of the code (see "Develop a workflow").
- Cloving cannot make a workflow from your earlier chats yet. The issues [#42](https://github.com/cloving-ai/cloving-ai/issues/42), [#43](https://github.com/cloving-ai/cloving-ai/issues/43) and [#44](https://github.com/cloving-ai/cloving-ai/issues/44) are open for this work. Until then, the prompt "Find workflows in your chats" is a guide for a coding agent.
- This pre-release package is not published to npm.

### Import selected chats

```sh
cloving chats import -- TRANSCRIPT_A.jsonl TRANSCRIPT_B.jsonl
```

Select each file explicitly. Relative paths use the current directory. The command does not scan directories or expand globs. Your shell can expand an unquoted glob. A source must be a regular file of at most 10 MiB (10,485,760 bytes). Symbolic links are refused. Sources keep their original bytes.

Each import accepts at most 50 MiB (52,428,800 bytes) of normalized corpus JSONL, measured as UTF-8 including newline separators. Repeated selections count toward this total. This bounds the message content retained for structure analysis. Exceeding the limit returns `output-failed` with exit code `1`, leaves no completed coverage manifest and may leave partial data files. Select fewer sources for each import; copy and conflict comparisons apply within each import.

The supported Claude Code JSONL subset has `user` and `assistant` envelopes with a matching `message.role`. Content can be a string or an ordered array of `text`, `tool_use` and `tool_result` blocks. Records preserve the role, timestamp, session ID, tool fields and original block positions. Missing timestamps and session IDs become `null`. Thinking blocks and non-message metadata are omitted and counted. Unknown message shapes or blocks refuse the entire source. Claude Code's internal transcript format can change between versions.

Each import creates `chats/IMPORT_ID/corpus.jsonl`, `structure.json` and `coverage.json` below the resolved Cloving runtime directory. Selection uses a nonempty `CLOVING_RUNTIME_DIR`, then `XDG_RUNTIME_DIR/cloving`, then `XDG_STATE_HOME/cloving/run`, then `HOME/.local/state/cloving/run`. Relative settings resolve against the current directory. Destinations inside a Git repository are refused, including through symbolic links. New directories have mode `0700`; files have mode `0600`. These permissions add no encryption or redaction.

New corpus records have `schemaVersion: 2` and a `sourceId` of `sha256:HEX:OFFSET`. The digest covers the exact source bytes. The offset is the zero-based byte position of the source line. `text` joins the message's text blocks with a newline; `blocks` retains each supported block's `position`. Tool result content is copied as JSON data. The versioned coverage manifest has one entry per selection, including its resolved path, status, fixed reason code, digest when available, record count and omission counts (`metadataRecords` and `thinkingBlocks`). Refused sources contribute no records. The final coverage manifest appears only after the corpus and structure files close successfully. Output failure leaves no completed coverage manifest; partial data files may remain.

Version 2 preserves nonempty envelope `uuid` strings exactly, with `null` for unknown identity. It preserves boolean `isSidechain` flags, otherwise `null`. A nonempty `parentUuid` string is an observed link and explicit `null` is an observed root. Absent, empty or invalid parents are omitted and remain unknown. Import retains all supported branches and side chains and never uses API message IDs, paths, content or neighbors to infer identity.

The version 1 structure sidecar references each occurrence by zero-based `recordIndex` and `sourceId`, including repeated selections with the same source ID. It contains no message content or source paths. Known identity matches across the import mark copies of the earliest occurrence with equal role, text and blocks, ignoring object member order while preserving array order and exact JSON number tokens. All records stay in the corpus. Different content for one identity produces a conflict group containing every variant and its copies; no variant wins.

Structure groups nodes and observed links within known sessions. Null and empty session IDs remain separate, unlinked occurrences. Links with conflicting observed parents or unknown child identity are marked ambiguous. Forks require multiple distinct known child IDs through unambiguous links. Missing parent targets are counted once per session and target ID, separately from unknown parent fields. Cyclic groups include all observed links, including ambiguous links; their IDs form strongly connected groups in occurrence order. Counts include records, known sessions, forks, copies, conflict groups, unknown identities and missing parent targets, including zeros. `historyCompleteness` is always `"unknown"`: selected history and even an explicit root cannot establish complete history. Omitted metadata parents remain unresolved.

Console output contains counts, fixed codes and an opaque import ID. Source paths, event and session IDs, and transcript text stay in the private files. Exit code `0` means every source was included. Code `1` means partial coverage or an output failure. Code `2` means invalid usage. Importing performs only structural comparison; it makes no model or network call and does not execute transcript instructions. Full quality admission and release qualification remain pending.

### Redact an imported corpus

```sh
cloving chats redact IMPORT_ID
```

Use the UUID v4 import ID printed by `chats import`. This command uses the same runtime directory selection and needs no service. It accepts version 1 and version 2 corpus records with the unchanged version 1 coverage manifest. It does not reopen the transcript paths in coverage.

The command writes `redacted.jsonl` and `redaction.json` beside the originals. New files have mode `0600`. Existing outputs are refused. The manifest records rule version `1`, record count, category counts (including zeros), and total replacements. It contains no matched values or replacement map. The manifest is written only after the redacted corpus closes successfully. A failure can leave an incomplete redacted corpus; there is no restart recovery.

`HOME` supplies the home folder. The rules replace home paths (including tilde forms), e-mail addresses, supported GitHub, Anthropic and OpenAI tokens, complete private-key blocks, and URLs with user information. `CLOVING_PRIVATE_TEXTS` adds literal texts with case ignored. For this command, an unset setting or `[]` adds no texts. Malformed lists, non-string entries and blank entries are refused. The issue-posting workflows still require a nonempty private-text list.

Redaction inspects message text, text blocks and nested tool input and result strings, including member names. Overlapping matches count once, with priority given to private keys, credential URLs, home paths, tokens, e-mail addresses, then private texts. Both stored copies of message text count. Source references, schema versions, identity fields, parent-field presence, record order and exact number tokens remain intact. The structure sidecar is private metadata outside redaction scope and is not a redacted export. Member-name collisions are refused.

Console output contains only fixed codes, counts and the import ID. Exit code `0` means success, `1` means processing failure, and `2` means invalid usage. Originals and metadata remain outside redaction scope. Both originals and outputs remain private runtime data. Redaction makes no model or network call and does not execute transcript instructions. It neither guarantees removal of every private value nor authorizes later model use.

## Install

The current pilot uses Node 26.9.0 and npm 11.19.1 on macOS 27.0 on arm64. The installation ranges in `package.json` do not qualify other workflow runtimes: workflow admission still requires exactly Node 26.9.0. GitHub-hosted macOS 15 arm64 qualification is pending its CI quality and packed-startup checks. Other platforms and runtime versions are unqualified.

A run needs these tools:

- `git`.
- The `claude` command of Claude Code on the search path. The Claude worker runs it as the current user.
- For `develop-issue` only: the `gh` command with a login, and a GitHub repository that Greptile reviews. The worker uses the `gh` login and the git credentials of the current user.

Once the operator publishes this package, install the executable with:

```sh
npm install --global cloving --ignore-scripts
cloving --version
```

This package replaces the older Cloving CLI under the same npm name. The registry currently serves that older CLI; the command above is for after this release is published. The installed package includes startup, the watch command, bundled workflows and the SDK compiler integration. It starts without a source checkout or development dependencies, using the installed runtime dependencies. Installation runs no scripts and starts no service.

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

The client commands find the service with no setting, because the two sides use the same default runtime directory (`~/.local/state/cloving/run`). `CLOVING_RUNTIME_DIR` selects a different place for the two sides. The directory above the runtime directory holds the authority state, the Local World data, the turn records and the git work trees.

`cloving watch` serves a read-only page on `http://127.0.0.1:3663/` (`--port` selects a different port). The page shows the runs, the events, the work of the Claude worker as it occurs, and each pending decision with its approve and deny commands. `cloving start` starts the page too; `CLOVING_WATCH_PORT` selects its port, and the value `off` starts none.

`cloving start` reads its settings from the environment. `cloving start --help` gives the form and the default of each setting:

- `CLOVING_RUNTIME_DIR`: the runtime directory.
- `CLOVING_TICKET_COMMAND`: the ticket command (see "Daily development").
- `CLOVING_NOTIFY_COMMAND`: a JSON list naming a command to notify the operator about pending decisions, blocked runs and failed runs. It has no default.
- `CLOVING_NEXT_COMMAND`: a JSON list of a command and its arguments that prints the next ready ticket ID for `--next`. It has no default.
- `CLOVING_CLAUDE_COMMAND`: a replacement of the `claude` command of the worker.
- `CLOVING_PROFILES`: a JSON file of named Claude turn profiles, read once when the service starts.
- `CLOVING_WATCH_PORT`: the port of the watch page, or `off`.
- `CLOVING_WATCH_REPOSITORY`: repository context for a separate watch process. `start` sets this from its service repository. The watch process uses its local origin and has no current-directory default.
- `CLOVING_OWNERSHIP_LEASE_SECONDS` and `CLOVING_HOST_BOUND`: limits of the workflow host.
- `CLOVING_GH_COMMAND`, `CLOVING_CHECK_COMMAND` and `CLOVING_PRIVATE_TEXTS`: settings of `develop-issue`; the GitHub command and private-text list also apply to `develop-prd`.

A command setting is a JSON list of texts, for example `CLOVING_CHECK_COMMAND='["npm", "test"]'`.

The notify command receives no added argument. Its standard input receives one JSON object with `event`, `runId`, `workflowId`, `subject` and `body`. The body contains the decision or outcome text already shown by `cloving questions` or `cloving status`, with complete response commands, up to 4000 characters. The daemon checks every 15 seconds and records each event before calling the command. The first check with no notification record only records existing events. Records survive restarts; a failed command is logged once and never retried. Commands have 30 seconds to finish. A stop after recording an event but before sending it can lose that notification, and decisions opened and closed between checks can be missed.

## Daily development

`cloving start` copies the TypeScript files in `workflows/` into a host project and compiles them there. The bundled workflows are:

- `develop-prompt` takes the text of a task. Use it for a small task with no ticket, or for a first try in a new repository.
- `develop-ticket` takes a ticket ID and reads the ticket itself. Use it for the normal work on a ticket, when you want to read each diff and merge the branch yourself.
- `develop-issue` takes a ticket ID too, and sends the work through a GitHub pull request. Use it for a small ticket with clear criteria, in a GitHub repository that Greptile reviews and that has a check command. It is the workflow of the continuous process.
- `develop-prd` takes an idea, researches the code and web, reviews a draft PRD, and posts it as a GitHub issue. Set `CLOVING_PRIVATE_TEXTS` to a nonempty JSON list before starting the daemon. A refused post preserves the worktree and draft. A successful post removes the worktree and adds no label; read the issue and add `cloving: ready` when it is ready for implementation.

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

### The ticket command

`CLOVING_TICKET_COMMAND` (a JSON list of texts) names the ticket command. The contract of a ticket command:

- It gets a ticket ID as its last argument and prints the text of the ticket.
- For `develop-issue`, a first line that starts with `# ` gives the title of the pull request. With no such line, the title is `Cloving task <cycle ID>`.
- For `develop-issue`, a line `GitHub issue: <owner>/<repository>#<number>` makes the pull request close that issue.

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

An empty selection gives `no-ready-ticket`; a failed command gives `next-ticket-not-available`. Missing configuration gives `next-source-not-configured`. Multiple IDs, an invalid ID, or `next` as the selected ID give `invalid-ticket-id`. Use only one of `--next`, `--ticket`, `--prompt` and `--input`.

### Review rounds of `develop-ticket` and `develop-prompt`

A run of `develop-ticket` or `develop-prompt` has one to three review rounds. Each round does one Claude Code turn in the work tree of the run, on the branch `cloving/<ticket id>-…`, and then opens one approval. The first round makes the work tree. The approval text has the round, the ticket ID, the branch, the commits, the changed files and the report of the worker. Read the diff before you decide. The decision has these results:

- An approval completes the run. It does not merge the branch. Merge the branch yourself.
- A denial with a feedback text (`--text`) in round 1 or 2 starts the next round. The Claude worker gets the feedback text and adds commits to the same branch.
- A denial with no text, or a denial in round 3, ends the run.

The worker is not confined. It runs the `claude` command of the search path as the current user, with file edits and shell commands permitted in the work tree and a spend limit of 5 USD for each turn. `CLOVING_CLAUDE_COMMAND` (a JSON list of texts) replaces the command.

Single-run status (`cloving status RUN_ID`, also with `--json`) and watch show each worker command call and its run totals. Token counts retain the reported input, cache read and output categories separately. Codex input includes cached tokens; cache read tokens are not added to input tokens. These selected counts are not complete billing usage or a record of all subagent work. Missing or invalid fields show `Token usage not known`. Prices show `Price not known` unless every ended turn reports a valid USD value; a reported zero shows `0.00 USD`. Totals for an unfinished run are labeled `so far`. JSON uses `null` for unknown values and retains the total price field `claudeCostUsd`.

Set `CLOVING_TOKEN_PRICES` to a JSON object mapping model names to non-negative finite `input`, `cachedInput` and `output` USD prices per million tokens to show a separate approximate estimate beside known token counts, using the reported model or the worker command's model argument, with `estimatedCostUsd` totals only when every ended turn has an estimate.

`CLOVING_WORKER` selects `claude` (the default) or `codex`. With `codex`, `CLOVING_CODEX_COMMAND` replaces the native Codex command and must still emit native Codex events. A shared-format wrapper uses `CLOVING_CLAUDE_COMMAND` with the `claude` worker selection. Its last JSONL result supplies `total_cost_usd` and `usage.input_tokens`, `usage.cache_read_input_tokens` and `usage.output_tokens`, including on errors. Report only the usage and price of that command call; the wrapper must normalize resumed sessions or multi-input accounting. Cloving does not infer the output format from the executable or model name or reconstruct missing usage from old logs.

Set `CLOVING_PROFILES` to a file such as:

```json
{
  "profiles": {
    "checker": {
      "env": { "REVIEW_ONLY": "1", "TURN_NAME": "{turn}" },
      "allowedTools": ["Read", "Grep", "Skill", "Agent"],
      "maxBudgetUsd": 15,
      "workflows": ["review-loop"]
    },
    "fixer": { "env": { "TURN_NAME": "{turn}" } }
  }
}
```

A workflow selects a profile with a `protectedEffect` request for capability `claude` and method `run-turn:checker` or `run-turn:fixer`. Profile names contain 1–119 ASCII letters, digits, hyphens or underscores. All fields are optional; `model` and `permissionMode` also override the corresponding Claude command flags. Unspecified fields keep the service defaults, and `run-turn` keeps the original command. Flags after `--` remain unchanged.

`workflows` restricts a profile to the service's registered workflow IDs; omitting it allows every workflow. Each turn receives its run ID and journal operation key joined with a hyphen in `CLOVING_TURN_ID`. That value replaces each `{turn}` in profile environment values. Variables added by one profile do not carry into the next turn. The four GitHub token variables and `GH_CONFIG_DIR` are forbidden in profiles; turns retain an empty GitHub configuration directory. Invalid files stop startup with `invalid-profiles`. Turns refuse unknown profiles with `unknown-profile`, disallowed workflows with `profile-not-allowed`, and Codex profiles with `profile-needs-claude`.

To run a Claude or Codex turn on an existing branch, a custom workflow sets
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

A run of `develop-issue` opens no approval. The GitHub worker makes the work tree from the newest commit of the default branch of `origin`. After the Claude turn, the worker pushes the branch and opens a pull request. The title and the closed issue come from the ticket text (see "The ticket command"). Then the worker waits for the Greptile review of the pushed commit, and asks for a review with a comment after 5 minutes.

When the ticket names a GitHub issue, the workflow adds `cloving: in progress` after preparing the work tree and removes `cloving: ready` and `cloving: blocked`. A blocked run adds `cloving: blocked` and removes `cloving: in progress`; a completed merge removes `cloving: in progress`. Operators add `cloving: ready`. Label failures leave the run's outcome unchanged. Cloving creates the labels it adds or removes with the fixed color `ededed`; existing labels have their color and description reset by `gh label create --force`.

At the confidence score 5/5, the worker merges the pull request with a merge commit, with no human approval. Then it removes the remote branch, the work tree and the local branch. With a lower score, the Claude worker gets the summary and the findings of the review for one more round. After three such rounds, or after 60 minutes with no review, the run stops and the pull request stays open.

The watch board keeps blocked `develop-issue` runs in `Stopped`. A qualifying later local run shows `Done in a later run`. Otherwise, the board reads the recorded pull request with `CLOVING_GH_COMMAND` (default `gh`). The service supplies its repository, and the board checks the local origin and the recorded PR identity. A confirmed merge shows `PR merged #N`; a read failure shows `PR status unavailable`. Other PR states keep `Needs attention`. These marks do not change the run outcome.

Reads run in the background, one at a time, with a five-second limit. Board loads can refresh unresolved PRs at least 60 seconds after the previous attempt started. Confirmed merges remain cached until the watch process stops. A later normal page load shows each result.

The GitHub worker does not push a change that has the path of the home folder in a file or in a commit message. `CLOVING_PRIVATE_TEXTS` (a JSON list of texts) adds more texts to refuse, with no difference between capital and small letters. `CLOVING_CHECK_COMMAND` (a JSON list of texts) names a check that must pass in the work tree before a merge. `CLOVING_GH_COMMAND` replaces the `gh` command. The worker uses the `gh` login and the git credentials of the current user.

## Continuous process

In a continuous process, Cloving develops one ticket after the next with `develop-issue`. Use one terminal session for the service that stays open, for example a `tmux` session. Do these steps for each issue:

1. Write a small issue: one behavior, clear criteria that a test can check, and the first tests. The prompt "Write a ticket for Cloving" helps.
2. Run it: `cloving run develop-issue --ticket ISSUE_NUMBER`.
3. Follow the run on the watch page, or with `cloving status RUN_ID` and `cloving events RUN_ID --follow`.
4. Check the merge. The run completes when the GitHub worker merges the pull request. The watch page shows the number of the pull request of the run (`PR_NUMBER`). It is also `pullRequest.number` of the run in `http://127.0.0.1:3663/data.json`. The pull request number and the issue number are different.
   - Make sure that the pull request is merged: `gh pr view PR_NUMBER --json state,mergedAt`.
   - Make sure that the issue is closed: `gh issue view ISSUE_NUMBER --json state`.
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

1. Check the platform: macOS on arm64, with the Node and npm versions of "engines" in package.json of Cloving. Check that git and the claude command work. If I want develop-issue, check that gh has a login and that Greptile reviews the GitHub repository.
2. If I have no Cloving checkout, clone https://github.com/cloving-ai/cloving-ai.git to ~/cloving. In the checkout, run: npm ci --ignore-scripts
3. Write a launcher ~/.local/bin/cloving that runs src/cli.ts of the checkout with the correct node program, and make it executable. Do not use npm link, and do not install the npm package with the name cloving. Make sure that ~/.local/bin is on the search path and that "cloving --version" works.
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
   - Make sure that the issue is closed: gh issue view ISSUE_NUMBER --json state
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
  Only for develop-issue. The pull request closes this issue.
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

A workflow is a TypeScript file in the form of `workflows/develop-ticket.ts`:

- An exported async function with the directive `"use workflow"` as its first statement. The directive needs the compiler of the Workflow SDK, not only TypeScript.
- The first argument is the input of the run. A resolver of the daemon makes it, for example `cycleId`, `ticketId`, `ticket` and `repository`. After a decision, the host calls the function again with the decision (`gateId`, `decision` and `answer`) as the second argument. The function must examine the decision before it asks for an effect, as `decided()` in `workflows/develop-ticket.ts` does. If it does not, it does the work of round 1 again.
- The step helpers come from the subpaths of `cloving/workflows`: `protectedEffect` from `cloving/workflows/steps/protected-effect`, `decisionGate` from `cloving/workflows/steps/decision-gate` and `loadCycle` from `cloving/workflows/steps/load-cycle`. The type `CycleOutcome` comes from `cloving/workflows`. An import of `cloving/workflows` starts no service.
- `protectedEffect` asks the daemon for one effect of a capability, for example a Claude turn. `decisionGate` opens a decision for a person.
- The function returns a `CycleOutcome`: `waiting_for_decision`, `handoff_requested` or `blocked`.

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

The workflow tests run the workflow function with a fake step bridge (`test/develop-workflow-fixture.ts`). The fixture resolves `cloving/workflows` to the files of `src`, records each effect request and gate request, and gives the results of a scenario. `test/develop-ticket-workflow.test.ts` and `test/develop-issue-workflow.test.ts` use it.

`cloving start` compiles the TypeScript files in the application's `workflows` folder. Each file may contain one workflow function, and function names must be unique across files. The four built-in registrations (`develop-ticket`, `develop-issue`, `develop-prd` and `develop-prompt`) keep their existing input contracts and resolvers.

To register another workflow, put `<name>.declaration.json` beside `<name>.ts`:

```json
{
  "workflowId": "review-run",
  "effectLimit": 14,
  "capabilities": ["claude"],
  "input": {
    "maximumBytes": 65536,
    "fields": {
      "prompt": { "type": "string" },
      "rounds": { "type": "integer", "minimum": 1, "maximum": 10, "optional": true }
    }
  }
}
```

The ID accepts 1–64 letters, digits or hyphens. The effect limit is 1–100; capabilities must contain `claude`, `github`, or both. The input byte limit is 1–1048576, subject to the service's own limit. Fields accept nonempty strings, integers with optional inclusive bounds, or booleans. Fields are required unless `optional` is `true`; unknown fields are rejected. Bounds apply only to integers.

After startup, `cloving status` lists the declared ID. Submit JSON with `cloving run review-run --input input.json`. The function receives `{ cycleId, repository, input }`, where `cycleId` is `task-` followed by 12 characters derived from the command ID, `repository` is the service repository, and `input` retains the checked JSON values. Invalid input is rejected before a run starts. Invalid declarations or duplicate workflow IDs or function names stop startup.

## Development of Cloving

```sh
npm ci --ignore-scripts
npm run check:setup
npm run build
node dist/src/cli.js --help
npm pack --ignore-scripts
```

`npm pack` prints the file name of the tarball. Install it into a separate project with `npm install --ignore-scripts --omit=dev /absolute/path/to/TARBALL`, then run `./node_modules/.bin/cloving --version` or `./node_modules/.bin/cloving start`. The package includes the emitted CLI, start program, compiler and bundled workflows; startup uses the installed runtime dependencies. The package has no installation hooks. An import of `cloving/workflows` gives the step helpers `loadCycle`, `protectedEffect` and `decisionGate`, and starts no service.

`npm run check` and `npm run test:concurrency` currently reject admission because the complete quality policy is not implemented. Setup checks are not product acceptance. State and retained releases will live outside the package installation; installing or updating the package does not activate a daemon or migrate state.

Run `npm run test:scale` on an otherwise idle machine to measure authority opening at 1,000, 10,000 and 50,000 events. This command runs the benchmark alone, without coverage; the regular test suite excludes it. The fixture uses completed runs with budgets, gates and released continuations. It requires each opening to take less than two seconds and the largest opening to take less than eight times the 10,000-event opening. Replay uses the pure reducer with run-scoped projections and preserves shared effect and lease state. Large effect histories, growing gate or pending-intent state within one run, and cancelled-run recovery still require separate scaling work; this benchmark does not establish their bounds. The generated-history parity and tamper tests compare replay with the full reducer and cover every event type.

`npm run check:quality` checks the npm manifest, lock and installed versions, regenerates TypeScript output in memory, inventories first-party files, and runs strict compilation, the proposed module catalog, workflow/effect boundaries, suppression and test-integrity checks, formatting, typed lint, structural checks, clone detection and the regular local test suite. Production modules require at least 90% line, statement and function coverage and 85% branch coverage per file. Coverage uses native V8 ranges mapped to the syntax tree of the exact Node-stripped source; unimported production files fail. Class and named object types allow at most 24 callable members; interfaces allow 10. Clone checks support ordinary TypeScript and JavaScript; JSX is rejected until separately qualified. `npm run check:lint`, `npm run check:format` and `npm run test:quality` run individual development checks.

Set `CLOVING_CHECK_TIME_FACTOR` to a whole number from 1 to 5 (default 1) to multiply only the developer gate test and coverage command time limits.

The catalog and checker configuration are local proposals. The bounded SDK artifact, dependency-surface, production-coverage and mandatory-test inventory components have local qualification fixtures. Protected activation of their records, verifier execution and hooks remain pending. Dependency snapshots and supplied review records cannot activate a candidate. The local quality command cannot accept a product candidate. Static workflow checks are not isolation or replay proof. Deterministic sequencing fixtures qualify the test mechanism; they do not prove ownership or storage concurrency in the service.

The coverage profile supports strip-only TypeScript and JavaScript (`ts`, `mts`, `cts`, `js`, `mjs`, `cjs`). It rejects source-map and coverage-ignore patterns interpreted by the provider, including patterns inside strings. Native V8 limitations around throwing calls and default arguments remain; coverage does not replace behavioral assertions. Production roles come from the complete module catalog, independently of which files tests import. Nested npm workspaces and unsupported dependency directory links fail explicitly until qualified.

For trusted development fixtures, `npm run build:workflows -- SOURCE_DIRECTORY OUTPUT_DIRECTORY` runs the selected directive compiler with deterministic manifest ordering. Run the compiler in an isolated fixture project; its output directory must resolve that project's installed `workflow` dependency. Compiler caches and generated handlers stay outside the application source tree. Generated handlers are development artifacts and do not grant authority to execute effects.

SDK qualification uses a fixed logical output path and an empty root TypeScript configuration. Its separate input preflight rejects ancestor/nested compiler configuration, outside first-party inputs, dynamic/CommonJS loading and ambiguous local declaration/runtime resolution. Record the full installed tool/helper closure and every generated handler, manifest and debug artifact, then regenerate at the same logical path and compare preserved bytes. The direct build command does not authenticate these records. Real packed-helper execution is qualified with a disposable prototype.
