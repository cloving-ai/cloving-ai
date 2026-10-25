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
- `cloving chats import -- FILE_A FILE_B` imports selected Claude Code transcripts into private runtime files without a service.
- `cloving chats redact IMPORT_ID` creates a redacted corpus and a separate counts manifest without a service.

What does not work yet:

- The Claude worker is not confined. It runs as the current user.
- An approval does not merge the branch. You merge the branch yourself.
- Cloving cannot make a workflow from your earlier chats yet. The issues [#42](https://github.com/cloving-ai/cloving-ai/issues/42), [#43](https://github.com/cloving-ai/cloving-ai/issues/43) and [#44](https://github.com/cloving-ai/cloving-ai/issues/44) are open for this work. Until then, the prompt "Find workflows in your chats" is a guide for a coding agent.

### Import selected chats

Chat import and redaction currently require macOS. On Linux, the chat commands return `platform-unsupported` with exit status `1` before file access.

```sh
cloving chats import -- TRANSCRIPT_A.jsonl TRANSCRIPT_B.jsonl
cloving chats import --previous-import IMPORT_ID -- TRANSCRIPT_A.jsonl TRANSCRIPT_B.jsonl
cloving chats import --root PROJECTS_A --root PROJECTS_B --exclude-project project-skip -- TRANSCRIPT_A.jsonl
```

Select files positionally, projects folders with repeatable `--root`, or both. Relative paths use the current directory. At least one file or root is required. After `--`, every argument is a literal file path, including names that look like options. The command does not expand globs; your shell can expand an unquoted glob. A source must be a regular file of at most 10 MiB (10,485,760 bytes). Symbolic links are refused. Sources keep their original bytes.

Each root explicitly selects a projects folder. Claude Code normally stores projects below its configuration folder, whose default name is `.claude` below the home folder; `CLAUDE_CONFIG_DIR` can change that location. Cloving never discovers a root from configuration or reads settings to expand your selection. This layout does not guarantee supported transcript formats or complete history. [Claude Code session storage](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored) and [subagent storage](https://code.claude.com/docs/en/sub-agents) describe the source layout.

`--exclude-project NAME` matches a direct project folder name exactly, preserving case. Repeat it for several names. Exclusions require roots and never affect positional files. Names cannot contain separators, parent-directory markers or glob patterns. An excluded subtree produces one `project-excluded` entry; its children are never listed or opened.

Positional files retain their order and repetitions and come before scanned files. Roots sort by canonical path, retaining repeated selections with stable ties. Entries sort by relative path using JavaScript string order. Scans select regular files ending in lowercase `.jsonl`; other filenames produce `unsupported-extension` without a content read. Root children have depth one. Session files at depth two and subagent files at depth four fit the limit. Folders at depth four are pending with `depth-limit` and disclose no descendant inventory.

Across all roots, at most 100 eligible scanned candidates receive a source-read attempt. A failed open, oversized file, invalid encoding or unsupported transcript still consumes a slot. Repeated roots and overlapping selections consume separate slots; positional files are outside this budget. All metadata candidates are ordered before slots are allocated. Later candidates are pending with `file-limit` and are never opened. Select a pending file explicitly in a later import. The supported macOS scanner refuses links in roots, ancestors and entries, canonical containment escapes, Git repository roots (including worktrees and bare repositories), and source or ancestor identity changes before reading bytes. Inaccessible directories produce unreadable subtree entries. Directory enumeration also refuses raced links; an unavailable kernel protection fails closed.

Each import accepts at most 50 MiB (52,428,800 bytes) of normalized corpus JSONL, measured as UTF-8 including newline separators. Repeated selections count toward this total. This bounds the message content retained for structure analysis. Exceeding the limit returns `output-failed` with exit code `1`, leaves no completed coverage manifest and may leave partial data files. Select fewer sources for each import; copy and conflict comparisons apply within each import.

The supported Claude Code JSONL subset has `user` and `assistant` envelopes with a matching `message.role`. Content can be a string or an ordered array of `text`, `tool_use` and `tool_result` blocks. Records preserve the role, timestamp, session ID, tool fields and original block positions. Missing timestamps and session IDs become `null`. Thinking blocks and non-message metadata are omitted and counted. Unknown message shapes or blocks refuse the entire source. Claude Code's internal transcript format can change between versions.

Each import creates `chats/IMPORT_ID/corpus.jsonl`, `structure.json` and `coverage.json` below the resolved Cloving runtime directory. Selection uses a nonempty `CLOVING_RUNTIME_DIR`, then `XDG_RUNTIME_DIR/cloving`, then `XDG_STATE_HOME/cloving/run`, then `HOME/.local/state/cloving/run`. Relative settings resolve against the current directory. Destinations inside a Git repository are refused, including through symbolic links. New directories have mode `0700`; files have mode `0600`. These permissions add no encryption or redaction.

New corpus records have `schemaVersion: 2` and a `sourceId` of `sha256:HEX:OFFSET`. The digest covers the exact source bytes. The offset is the zero-based byte position of the source line. `text` joins the message's text blocks with a newline; `blocks` retains each supported block's `position`. Tool result content is copied as JSON data. Positional-only imports retain coverage version 1 with its ordered `files` array. Imports containing roots write coverage version 2 with ordered `roots`, `exclusions`, fixed `limits` and ordered `entries`. Each entry identifies its zero-based positional or sorted-root selection, file or subtree kind, resolved path, status, fixed reason code, digest when available, record count and omission counts (`metadataRecords` and `thinkingBlocks`). Excluded and pending subtree entries count only themselves. Scanned oversized files are `unsupported` with `file-too-large`; positional oversized files retain `too-large`, including mixed imports. Refused sources contribute no records. Included sources also record `byteSize`, measured from the exact hashed bytes. Both coverage versions accept legacy entries without sizes. The final coverage manifest appears only after the corpus, structure and optional revision files close successfully. Output failure leaves no completed coverage manifest; partial data files may remain.

Use `--previous-import IMPORT_ID` before `--` to compare with one earlier import in the resolved runtime chats folder. It accepts one UUID v4 ID, using the same syntax as redaction. Missing, repeated and malformed values are usage errors (`missing-value`, `repeated-previous-import` and `invalid-import-id`). At least one current file or root is still required. The earlier coverage manifest must be valid and carry the same ID; completed partial imports are allowed. Existing revisions must also be valid with a positive safe revision number that can be incremented. Missing coverage, invalid metadata or linked inputs return `previous-import-refused`, exit `1`, a null import ID and zero counts before selection, source reads or new output.

Comparison writes private `revision.json` with `schemaVersion: 1`, `importId`, `previousImportId`, `evidenceRevision`, `counts` and ordered `entries`. An earlier import without a revision starts revision `1`; otherwise its revision increases by one. Each entry stores `path`, `root` (null for positional selections), `before` and `after` evidence, one `status` and one fixed `reason`. Absent evidence is null; present evidence contains a nullable digest and optional byte size. No message text is stored. Counts always include `new`, `missing`, `unchanged`, `changed`, `truncated` and `extended`, including zeros.

Selections match only by stored source path and selected root path, resolving each manifest's root indexes independently. Repeated keys pair in order. Current entries come first, followed by unmatched earlier entries in their earlier order. New selections are `new`; absent or currently refused selections are `missing`. Equal non-null digests are `unchanged`. An unavailable earlier digest or size makes differing evidence `changed`. Fewer bytes are `truncated`; more bytes are `extended` only when SHA-256 of exactly the earlier byte count equals the earlier digest. Other differences are `changed`. Prefixes use the same bounded source read; no source is reopened. Earlier entries never select sources or invent subtree descendants. Missing or truncated evidence forces `import-partial` and exit `1`. Revisions do not merge corpora, establish complete history or invoke later analysis. Without the option, no revision file is created and the summary retains its existing shape.

Version 2 preserves nonempty envelope `uuid` strings exactly, with `null` for unknown identity. It preserves boolean `isSidechain` flags, otherwise `null`. A nonempty `parentUuid` string is an observed link and explicit `null` is an observed root. Absent, empty or invalid parents are omitted and remain unknown. Import retains all supported branches and side chains and never uses API message IDs, paths, content or neighbors to infer identity.

The version 1 structure sidecar references each occurrence by zero-based `recordIndex` and `sourceId`, including repeated selections with the same source ID. It contains no message content or source paths. Known identity matches across the import mark copies of the earliest occurrence with equal role, text and blocks, ignoring object member order while preserving array order and exact JSON number tokens. All records stay in the corpus. Different content for one identity produces a conflict group containing every variant and its copies; no variant wins.

Structure groups nodes and observed links within known sessions. Null and empty session IDs remain separate, unlinked occurrences. Links with conflicting observed parents or unknown child identity are marked ambiguous. Forks require multiple distinct known child IDs through unambiguous links. Missing parent targets are counted once per session and target ID, separately from unknown parent fields. Cyclic groups include all observed links, including ambiguous links; their IDs form strongly connected groups in occurrence order. Counts include records, known sessions, forks, copies, conflict groups, unknown identities and missing parent targets, including zeros. `historyCompleteness` is always `"unknown"`: selected history and even an explicit root cannot establish complete history. Omitted metadata parents remain unresolved.

Console output contains counts, fixed codes and an opaque import ID. Source paths, exclusion names, event and session IDs, and transcript text stay in the private files. Root imports add `excluded` and `pending` entry totals. `refused` counts unreadable, unsupported and positional oversized entries. Exit code `0` and `import-complete` mean no refused or pending entries and, when comparing revisions, no missing or truncated evidence; exclusions alone permit success without comparison. Code `1` and `import-partial` mean refused, pending, missing or truncated entries when output completes. Output failures return code `1`, a null import ID and zeroed counts. Code `2` means invalid usage, before source or destination access. Importing performs only structural comparison; it makes no model or network call and does not execute transcript instructions. Full quality admission and release qualification remain pending.

### Redact an imported corpus

```sh
cloving chats redact IMPORT_ID
```

Use the UUID v4 import ID printed by `chats import`. This command uses the same runtime directory selection and needs no service. It accepts version 1 and version 2 corpus records and coverage manifests. It validates coverage without reopening transcript paths. Original corpus, coverage and structure files remain unchanged.

The command writes `redacted.jsonl` and `redaction.json` beside the originals. New files have mode `0600`. Existing outputs are refused. The manifest records rule version `1`, record count, category counts (including zeros), and total replacements. It contains no matched values or replacement map. The manifest is written only after the redacted corpus closes successfully. A failure can leave an incomplete redacted corpus; there is no restart recovery.

`HOME` supplies the home folder. The rules replace home paths (including tilde forms), e-mail addresses, supported GitHub, Anthropic and OpenAI tokens, complete private-key blocks, and URLs with user information. `CLOVING_PRIVATE_TEXTS` adds literal texts with case ignored. For this command, an unset setting or `[]` adds no texts. Malformed lists, non-string entries and blank entries are refused. The issue-posting workflows still require a nonempty private-text list.

Redaction inspects message text, text blocks and nested tool input and result strings, including member names. Overlapping matches count once, with priority given to private keys, credential URLs, home paths, tokens, e-mail addresses, then private texts. Both stored copies of message text count. Source references, schema versions, identity fields, parent-field presence, record order and exact number tokens remain intact. The structure sidecar is private metadata outside redaction scope and is not a redacted export. Member-name collisions are refused.

Console output contains only fixed codes, counts and the import ID. Exit code `0` means success, `1` means processing failure, and `2` means invalid usage. Originals and metadata remain outside redaction scope. Both originals and outputs remain private runtime data. Redaction makes no model or network call and does not execute transcript instructions. It neither guarantees removal of every private value nor authorizes later model use.

### Validate process analysis data

The pure `validateAnalysis(candidate, { records, structure })` function in `src/chats/analysis.ts` validates one version 1 process candidate against an ordered redacted corpus and its matching pre-redaction, in-memory `ImportStructure`. The evidence object keeps the API within the repository's two-parameter quality limit. Stored sidecar envelopes are not this input type. This pure validator makes no model call.

Candidates declare IDs and descriptions for inputs, ordered stages, branches, bounded loops, artifacts, stopping conditions, gates and non-gates. Branch links use `sourceStageId` and `targetStageId`; loops use ordered `stageIds` and `exhaustedStoppingConditionId`. Stages, gates and loops declare a claim `kind`, `sourceRefs` and `counterevidenceRefs`. References identify exact occurrences by `recordIndex` and `sourceId`. Copies add no support; observed repetition needs two directly cited original source IDs. Routine repair, accidental interruption and tool-imposed confirmation require matching non-gate classifications.

Version 1 also accepts an optional `openQuestion` object containing only `claimId`, `description`, `sourceRefs` and `choices`. It names a stage, gate or loop claim and cites distinct known occurrences from that claim's support and counterevidence, with no unrelated references. Two to four choices each contain only a unique nonempty `id` and an inert `description`. Malformed or multiple questions return `invalid-question`; absent claims or missing declared conflict return `question-without-conflict`. Missing and unknown sources retain their existing codes, as do recursive authority fields. Validation checks the declared relations and makes no claim that the prose describes a real conflict. A validated question remains unresolved analysis data.

Acceptance returns the candidate plus limitations preserving conflict groups, unknown history and unestablished independence. Refusal returns only fixed, unique codes in declaration order. Candidate fields are closed; authority and executable fields are refused, and descriptions remain inert. Validation does not certify redaction, evidence authenticity, inference quality, publication safety or permission for any action. Evidence content and exact numeric tokens remain unchanged. Full product admission remains pending CLV-002 through CLV-004.

The internal pure `inspectWorkflowGenerationText(analysis)` check in `src/chats/workflow-generation-text.ts` inspects the identifiers and prose of an `AnalysisResult`, including branch and loop links, condition descriptions and optional question choices. Each inspected field must contain 1–240 printable ASCII characters. It returns unique codes in this fixed order: `text-length`, `text-characters`, `machine-path`, `parent-traversal`, `email-form`, `user-mention`, `access-token-form`, `credential-form`. Known disclosure forms include absolute and home-relative paths, Windows paths and home placeholders, literal and percent-encoded parent traversal, addresses and mentions, common token prefixes, authorization values, credential assignments, private-key headers and URL user information. Pattern checks run only on fields within the length bound; text is never truncated, decoded or sanitized.

The text check takes no corpus input and never reads source references, counterevidence or limitations. It makes no file, process, network or model call and returns no inspected text or artifact. Empty codes establish only that these fixed checks found no violation; arbitrary prose can still contain private information. Callers must validate the analysis separately and retain provenance privately. This check grants no admission, execution or publication authority.

The internal pure `generateWorkflow(analysis, availability)` entry point in `src/chats/workflow-generation.ts` accepts one structurally validated `AnalysisResult` and a serializable snapshot `{ exports, methods }`. `exports` maps public module names to available named exports; `methods` maps capability names to available methods. No snapshot provider or installation command is supplied. The result is `generated` with one TypeScript source, candidate declaration and versioned JSON prompt assets plus a separate private report; `gap` with a private report and no artifact; or `refused` with fixed text-check codes only. Generation performs no I/O or model call. Availability, analysis and generation confer no authority; source admission and run authorization remain separate requirements.

The fixed `review-repair/v1` projection accepts exactly two executable stages in array order: an explicit-human-instruction or observed-repetition work stage, then a routine-repair stage with one of those claim kinds. One branch must link review to repair with the exact condition `Defect found.`. One explicit-human-instruction loop must list those stages in that order, use the exact exit condition `Checks and review pass.`, and reference an existing exhaustion stop. These phrases select this fixed protocol; arbitrary condition prose is never evaluated. The analysis iteration count is preserved, with two possible one-unit `claude` / `run-turn` effects per iteration and a declaration bound of 100 effects. Other work claims remain annotations; any extra executable stage, ambiguous control flow or unresolved analysis question returns a gap. Historical exceptions, rejected approaches, assistant claims, uncertainty, interruptions and tool confirmations cannot select executable work.

The projection permits at most one design question or configured action approval associated with the review stage, opened after a successful review. Gates on other stages return a gap. Factual decisions become required string inputs after the analysis inputs. Fields, functions, assets, stages and gates use reserved ordinal names. Submission fields resolve through the existing `{ cycleId, repository, input }` envelope without historical defaults. Worker completion requires an outer JSON result envelope whose `summary` is itself a JSON object with status `complete`, `repair` or `blocked`; malformed or unknown statuses block. Routine repair consumes the declared loop; exhaustion blocks. A gate returns `waiting_for_decision`. A host-authorized fresh SDK segment supplies the optional typed `{ gateId, decision, answer }` continuation. The generated code validates it before requesting effects and reconstructs the same bounded visits; existing durable operation receipts and run spending prevent accepted effects from repeating. After reconstructing the successful review, a design answer enters the remaining iterations as the `decision` payload slot. The worker must apply and check that answer before reporting completion, and subsequent repair receives it too. With no iterations remaining, the continuation blocks. An answer supplies no publication permission.

Generated declarations limit serialized submission fields to 16,384 UTF-8 bytes. Before requesting any effects, the workflow checks both stage payloads, including assets and the resolved workspace, against a 32,758-byte budget. This reserves 32,768 bytes for the JSON-encoded completed review envelope and 10 bytes for its property separator within the worker's 65,536-byte payload limit. The final summary JSON has a separate 16,000-byte limit, fitting within the worker's 16,000-character retention limit; oversized summaries block as `worker-blocked`. Repair receives the retained completed review without further truncation. An oversized review envelope blocks with `review-too-large` before a repair request; oversized run data blocks with `invalid-run-input` before spending. Both final payloads, including any design answer, are checked against 65,536 bytes before delivery. These limits include UTF-8 encoding and JSON escaping.

The report retains the process and stage summaries, ordinal name map, excluded annotations, non-gates, claim kinds, source references, counterevidence, conflicts and uncertainty limitations. **Retain it privately and exclude it from public source and assets.** The generator does not save it and never reads corpus records. Only checked descriptions enter assets, embedded identically as escaped JSON literals in the source. Synthetic tests exercise source checking, real SDK compilation, compiled-artifact admission, declaration loading, worker status handling, gates and continuation across process termination. Product admission remains subject to the separate accepted verification policy.

## Install

Cloving supports macOS and Linux on arm64 and x64, with the Node and npm ranges in `package.json`. Workflow admission still requires exactly Node 26.9.0. CI runs the developer gate and packed-install checks on macOS 15 arm64 and Ubuntu 24.04 x64 with Node 26.9.0 and npm 11.19.1. Chat import and redaction currently require macOS; other platforms return `platform-unsupported` before file access. Windows is unsupported.

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

`cloving watch` serves a local page on `http://127.0.0.1:3663/` (`--port` selects a different port). The page shows the runs, the events, the work of the Claude worker as it occurs, and each pending decision with its approve and deny commands. `cloving start` starts the page too; `CLOVING_WATCH_PORT` selects its port, and the value `off` starts none.

Each workflow board with supported inputs has **+ Add a card** at the bottom of its first column, including an empty board. It opens an inline form: **Issue number** for `develop-issue`, **Ticket ID** for `develop-ticket`, **Idea** for `develop-prd` and **Task** for `develop-prompt`. Declared workflows use the string fields in their bundled declaration. Unsupported inputs have no control. Select **Add card**, press Enter in a one-line field, or Command/Control+Enter in a text area to send. **Cancel** and Esc close the form. The service reply shows the admitted run ID or a refusal code; admitted cards arrive through the existing live stream. For `workflow-active`, add `cloving: ready` to the issue to queue it.

The form sends the same run request as the CLI and retains its random command ID for retries, including a lost reply. Retry the same form to avoid duplicate runs. The write endpoint accepts at most 16 KiB of JSON, requires the page's random token, matching Origin and a loopback/localhost Host with the bound port, and allows no cross-origin preflight. `CLOVING_WATCH_ACTIONS=off` removes both the form control and the endpoint; actions are enabled by default. The **Start a run** section remains available with prompts to copy into agents. Decisions and other run actions still use their displayed CLI commands.

`cloving start` reads its settings from the environment. `cloving start --help` gives the form and the default of each setting:

- `CLOVING_RUNTIME_DIR`: the runtime directory.
- `CLOVING_TICKET_COMMAND`: the ticket command (see "Daily development").
- `CLOVING_NOTIFY_COMMAND`: a JSON list naming a command to notify the operator about pending decisions, blocked runs and failed runs. It has no default.
- `CLOVING_NEXT_COMMAND`: a JSON list of a command and its arguments that prints the next ready ticket ID for `--next`. It has no default.
- `CLOVING_CLAUDE_COMMAND`: a replacement of the `claude` command of the worker.
- `CLOVING_PROFILES`: a JSON file of named Claude turn profiles, read once when the service starts.
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

### Daily loop facts

Run `cloving report --since 24 --json` for a versioned JSON report, or omit `--json` for text. `--since` accepts whole hours from 1 to 168 and defaults to 24. The window includes its start and excludes its end; the command captures the end time once. It reads the daemon's committed events and individual run status through the control socket. Set `CLOVING_WATCH_REPOSITORY` to the service repository to enable GitHub reads; its local origin supplies the host, owner and repository. There is no current-directory fallback. `CLOVING_GH_COMMAND` selects the GitHub command as a JSON argument array, defaulting to `gh`.

This is the first part of the daily report. The implemented values are:

| JSON value | Meaning |
| --- | --- |
| `metrics.tickets.completed` | Currently closed GitHub issues whose state reason is completed and whose latest closure falls in the window. Pull requests and issues closed for another reason are excluded. This is a current snapshot: reopening an issue removes that closure from these figures. |
| `metrics.pullRequests.merged` | Pull requests with a GitHub merge timestamp in the window. Closed, unmerged pull requests are excluded. |
| `metrics.runs.completed` | Terminal `run.completed` events with no outcome or with `handoff_requested`, excluding partial ticket handoffs. |
| `metrics.runs.partial` | Handoffs explicitly marked with partial ticket status. |
| `metrics.runs.blocked` | Terminal `run.completed` events with the blocked outcome. |
| `metrics.runs.failed` | Terminal `run.failed` events. |
| `metrics.runs.cancelled` | Terminal `run.cancelled` events. |
| `metrics.cost.medianRunUsd` | Median lifetime actual turn cost among runs ending in the window. Any unknown run cost makes this value unavailable. |
| `runCosts` | Each ended run's outcome, end time, actual total USD cost, individual turn operation IDs and actual prices, plus the historical daily median run-cost baseline. All of a run's turn cost is attributed to its end time, including turns before the window. Estimates never replace unknown actual prices. An observed run with no worker turns and settled effects has cost zero. A cancelled run that is still draining, or any unresolved effect, leaves its total unavailable. Active runs are excluded. |

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
- The first argument is the input of the run. A resolver of the daemon makes it, for example `cycleId`, `ticketId`, `ticket` and `repository`. After a decision, the host calls the function again with the decision (`gateId`, `decision` and `answer`) as the second argument. The function must examine the decision before it asks for an effect, as `decided()` in `workflows/develop-ticket.ts` does. If it does not, it does the work of round 1 again.
- The step helpers come from the subpaths of `cloving/workflows`: `protectedEffect` from `cloving/workflows/steps/protected-effect`, `decisionGate` from `cloving/workflows/steps/decision-gate`, `loadCycle` from `cloving/workflows/steps/load-cycle`, `handoff` from `cloving/workflows/steps/handoff`, `waitForRun` from `cloving/workflows/steps/wait-for-run` and `runCommand` from `cloving/workflows/steps/run-command`. The type `CycleOutcome` comes from `cloving/workflows`. An import of `cloving/workflows` starts no service.
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

The workflow tests run the workflow function with a fake step bridge (`test/develop-workflow-fixture.ts`). The fixture resolves `cloving/workflows` to the files of `src`, records each effect request and gate request, and gives the results of a scenario. `test/develop-ticket-workflow.test.ts` and `test/develop-issue-workflow.test.ts` use it.

The four built-in registrations (`develop-ticket`, `develop-issue`, `develop-prd` and `develop-prompt`) keep their existing input contracts and resolvers.

For a repository or user folder workflow, use one `<name>.ts` file with one exported workflow function. Put one `<name>.declaration.json` file beside it. Function names and workflow IDs must be unique across the folders and bundled workflows.

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

The ID accepts 1–64 letters, digits or hyphens. The effect limit is 1–100; capabilities contain one or more of `claude`, `github` and `command`. The input byte limit is 1–1048576, subject to the service's own limit. Fields accept nonempty strings, integers with optional inclusive bounds, or booleans. Fields are required unless `optional` is `true`; unknown fields are rejected. Bounds apply only to integers.

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
if (outcome.kind === "handoff_requested" && outcome.promotionId === "size-small")
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

```sh
npm ci --ignore-scripts
npm run check:setup
npm run build
node dist/src/cli.js --help
npm pack --ignore-scripts
```

`npm pack` prints the file name of the tarball. Install it into a separate project with `npm install --ignore-scripts --omit=dev /absolute/path/to/TARBALL`, then run `./node_modules/.bin/cloving --version` or `./node_modules/.bin/cloving start`. The package includes the emitted CLI, start program, compiler and bundled workflows; startup uses the installed runtime dependencies. The package has no installation hooks. An import of `cloving/workflows` gives the step helpers `loadCycle`, `protectedEffect`, `decisionGate`, `handoff` and `runCommand`, and starts no service.

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

Set `CLOVING_CHECK_TIME_FACTOR` to a whole number from 1 to 5 (default 1) to multiply the developer gate test and coverage command time limits, the inner hook check limit (5 seconds by default), and the installed hook limit (10 seconds by default). With factor 3, the hook limits are 15 and 30 seconds, respectively.

Set `CLOVING_TEST_CONCURRENCY` to a whole number from 1 to 8 to override the developer gate's test worker count. Without the setting, the gate uses one fewer worker than the available cores, with a minimum of 2 and a maximum of 4. macOS CI sets it to 3 and Ubuntu CI sets it to 4. Pull requests from branches of this repository run both jobs on local runners with the label `cloving-ci` (macOS arm64 and Linux arm64) with 8 workers; the local macOS runner accepts the macOS version of its machine. Invalid values fail with an error.

Tests that stop a child process should await `stopChild` from `test/stop-child.ts`. Use `stopChildGroup` for a detached process group, including descendants whose leader has exited. Both helpers send `SIGTERM`, wait up to five seconds times `CLOVING_CHECK_TIME_FACTOR` for exit, then escalate to `SIGKILL`. When a test requires a hard crash or an unresponsive child, start that child with `NODE_V8_COVERAGE` omitted so a kill cannot interrupt its coverage recording. Keep coverage enabled for ordinary child runs and recovery runs.

The catalog and checker configuration are local proposals. The bounded SDK artifact, dependency-surface, production-coverage and mandatory-test inventory components have local qualification fixtures. Protected activation of their records, verifier execution and hooks remain pending. Dependency snapshots and supplied review records cannot activate a candidate. The local quality command cannot accept a product candidate. Static workflow checks are not isolation or replay proof. Deterministic sequencing fixtures qualify the test mechanism; they do not prove ownership or storage concurrency in the service.

The coverage profile supports strip-only TypeScript and JavaScript (`ts`, `mts`, `cts`, `js`, `mjs`, `cjs`). It rejects source-map and coverage-ignore patterns interpreted by the provider, including patterns inside strings. Native V8 limitations around throwing calls and default arguments remain; coverage does not replace behavioral assertions. Production roles come from the complete module catalog, independently of which files tests import. Nested npm workspaces and unsupported dependency directory links fail explicitly until qualified.

For trusted development fixtures, `npm run build:workflows -- SOURCE_DIRECTORY OUTPUT_DIRECTORY` runs the selected directive compiler with deterministic manifest ordering. Run the compiler in an isolated fixture project; its output directory must resolve that project's installed `workflow` dependency. Compiler caches and generated handlers stay outside the application source tree. Generated handlers are development artifacts and do not grant authority to execute effects.

SDK qualification uses a fixed logical output path and an empty root TypeScript configuration. Its separate input preflight rejects ancestor/nested compiler configuration, outside first-party inputs, dynamic/CommonJS loading and ambiguous local declaration/runtime resolution. Record the full installed tool/helper closure and every generated handler, manifest and debug artifact, then regenerate at the same logical path and compare preserved bytes. The direct build command does not authenticate these records. Real packed-helper execution is qualified with a disposable prototype.
