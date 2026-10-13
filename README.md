# Cloving

TypeScript development scaffold for a local durable workflow service. Only `--help` and `--version` are available. Workflow execution, authority storage, helpers and autonomous development are not implemented.

The current pilot is Node 26.9.0, npm 11.19.1, macOS 27.0 on arm64. Other platforms and runtime versions are unqualified. This private pre-release package is not published.

The selected Workflow SDK and official builder are installed as development tooling. The shipped scaffold has no runtime dependencies because no workflow command or helper is implemented yet. Runtime SDK packaging still needs qualification before those features are admitted.

```sh
npm ci --ignore-scripts
npm run check:setup
npm run build
node dist/src/cli.js --help
npm pack --ignore-scripts
```

Install the resulting tarball into a separate project with `npm install --save-dev --ignore-scripts /absolute/path/to/cloving-0.4.0.tgz`, then run `npm exec -- cloving --version`. The package has no installation hooks. Importing `cloving/workflows` exposes no helpers yet and starts no service.

`npm run check` and `npm run test:concurrency` currently reject admission because the complete quality policy is not implemented. Setup checks are not product acceptance. State and retained releases will live outside the package installation; installing or updating the package does not activate a daemon or migrate state.

`npm run check:quality` checks the npm manifest, lock and installed versions, regenerates TypeScript output in memory, inventories first-party files, and runs strict compilation, the proposed module catalog, workflow/effect boundaries, suppression and test-integrity checks, formatting, typed lint, structural checks, clone detection and all local tests. Production modules require at least 90% line, statement and function coverage and 85% branch coverage per file. Coverage uses native V8 ranges mapped to the syntax tree of the exact Node-stripped source; unimported production files fail. Class and named object types allow at most 24 callable members; interfaces allow 10. Clone checks support ordinary TypeScript and JavaScript; JSX is rejected until separately qualified. `npm run check:lint`, `npm run check:format` and `npm run test:quality` run individual development checks.

The catalog and checker configuration are local proposals. The bounded SDK artifact, dependency-surface, production-coverage and mandatory-test inventory components have local qualification fixtures. Protected activation of their records, verifier execution and hooks remain pending. Dependency snapshots and supplied review records cannot activate a candidate. The local quality command cannot accept a product candidate. Static workflow checks are not isolation or replay proof. Deterministic sequencing fixtures qualify the test mechanism; they do not prove ownership or storage concurrency in the unimplemented service.

The coverage profile supports strip-only TypeScript and JavaScript (`ts`, `mts`, `cts`, `js`, `mjs`, `cjs`). It rejects source-map and coverage-ignore patterns interpreted by the provider, including patterns inside strings. Native V8 limitations around throwing calls and default arguments remain; coverage does not replace behavioral assertions. Production roles come from the complete module catalog, independently of which files tests import. Nested npm workspaces and unsupported dependency directory links fail explicitly until qualified.

For trusted development fixtures, `npm run build:workflows -- SOURCE_DIRECTORY OUTPUT_DIRECTORY` runs the selected directive compiler with deterministic manifest ordering. Run the compiler in an isolated fixture project; its output directory must resolve that project's installed `workflow` dependency. Compiler caches and generated handlers stay outside the application source tree. Generated handlers are development artifacts and do not grant authority to execute effects.

SDK qualification uses a fixed logical output path and an empty root TypeScript configuration. Its separate input preflight rejects ancestor/nested compiler configuration, outside first-party inputs, dynamic/CommonJS loading and ambiguous local declaration/runtime resolution. Record the full installed tool/helper closure and every generated handler, manifest and debug artifact, then regenerate at the same logical path and compare preserved bytes. The direct build command does not authenticate these records. Real packed-helper execution is qualified with a disposable prototype; actual Cloving helpers and runtime commands remain unimplemented.

## Supervised self-host (bootstrap slice)

`npm run self:start -- HOST_DIRECTORY [REPOSITORY_DIRECTORY]` starts one Cloving daemon for one git repository. The default repository is this repository. Keep the host directory outside each repository: it holds the authority state, the Local World data, the runtime socket, the turn records and the git work trees.

The command compiles one workflow and admits it under two names. `develop-ticket` takes a ticket ID and reads the ticket itself. `develop-prompt` takes the text of a task. The command starts the service with the workflow host, the reconciliation loop, the step bridge and the Claude worker, and it prints the client commands for a second terminal:

```sh
CLOVING_RUNTIME_DIR=HOST_DIRECTORY/runtime node src/cli.ts run develop-ticket --ticket TICKET_ID
CLOVING_RUNTIME_DIR=HOST_DIRECTORY/runtime node src/cli.ts run develop-prompt --prompt "the text of the task"
CLOVING_RUNTIME_DIR=HOST_DIRECTORY/runtime node src/cli.ts questions
CLOVING_RUNTIME_DIR=HOST_DIRECTORY/runtime node src/cli.ts approve DECISION_REF --expected-revision N --generation N --subject-digest DIGEST
```

`CLOVING_TICKET_COMMAND` (a JSON list of texts) names the ticket command. The daemon runs it with the ticket ID as the last argument when it admits a run, and the printed text is the ticket. The text becomes the stored input of the run, so a later change of the ticket does not change the run. A ticket that the command does not give is refused with `ticket-not-available`. With no ticket command, `develop-ticket` is refused with `ticket-source-not-configured`.

One run does one Claude Code turn in a new work tree on the branch `cloving/<ticket id>-…`, then opens one approval. The approval text has the ticket ID, the branch, the commits, the changed files and the report of the worker. Read the diff before you approve. An approval completes the run; it does not merge the branch. Merge the branch yourself.

The worker is not confined. It runs the `claude` command of the search path as the current user, with file edits and shell commands permitted in the work tree and a spend limit of 5 USD for each turn. `CLOVING_CLAUDE_COMMAND` (a JSON list of texts) replaces the command. A stop of the daemon stops a turn in work; submit that ticket again.
