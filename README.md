# Cloving

Cloving is a local durable development workflow service in TypeScript. This pre-release has one supervised slice: a service for one git repository, a workflow host, a Claude Code worker and one approval for each run. `cloving --help` lists the commands. The worker is not confined. Automatic review and autonomous development are not implemented.

The current pilot is the Node and npm versions of `package.json` (`engines`), on macOS 27.0 on arm64. Other platforms and runtime versions are unqualified. This pre-release package is not published to npm.

The runtime dependencies are the Workflow SDK (`workflow`) and Solid Objects (`solid-objects`). The official builder of the SDK is development tooling.

```sh
npm ci --ignore-scripts
npm run check:setup
npm run build
node dist/src/cli.js --help
npm pack --ignore-scripts
```

`npm pack` prints the file name of the tarball. Install the tarball into a separate project with `npm install --save-dev --ignore-scripts /absolute/path/to/TARBALL`, then run `npm exec -- cloving --version`. The package has no installation hooks. Importing `cloving/workflows` gives the step helpers `loadCycle`, `protectedEffect` and `decisionGate`, and starts no service.

`npm run check` and `npm run test:concurrency` currently reject admission because the complete quality policy is not implemented. Setup checks are not product acceptance. State and retained releases will live outside the package installation; installing or updating the package does not activate a daemon or migrate state.

`npm run check:quality` checks the npm manifest, lock and installed versions, regenerates TypeScript output in memory, inventories first-party files, and runs strict compilation, the proposed module catalog, workflow/effect boundaries, suppression and test-integrity checks, formatting, typed lint, structural checks, clone detection and all local tests. Production modules require at least 90% line, statement and function coverage and 85% branch coverage per file. Coverage uses native V8 ranges mapped to the syntax tree of the exact Node-stripped source; unimported production files fail. Class and named object types allow at most 24 callable members; interfaces allow 10. Clone checks support ordinary TypeScript and JavaScript; JSX is rejected until separately qualified. `npm run check:lint`, `npm run check:format` and `npm run test:quality` run individual development checks.

The catalog and checker configuration are local proposals. The bounded SDK artifact, dependency-surface, production-coverage and mandatory-test inventory components have local qualification fixtures. Protected activation of their records, verifier execution and hooks remain pending. Dependency snapshots and supplied review records cannot activate a candidate. The local quality command cannot accept a product candidate. Static workflow checks are not isolation or replay proof. Deterministic sequencing fixtures qualify the test mechanism; they do not prove ownership or storage concurrency in the service.

The coverage profile supports strip-only TypeScript and JavaScript (`ts`, `mts`, `cts`, `js`, `mjs`, `cjs`). It rejects source-map and coverage-ignore patterns interpreted by the provider, including patterns inside strings. Native V8 limitations around throwing calls and default arguments remain; coverage does not replace behavioral assertions. Production roles come from the complete module catalog, independently of which files tests import. Nested npm workspaces and unsupported dependency directory links fail explicitly until qualified.

For trusted development fixtures, `npm run build:workflows -- SOURCE_DIRECTORY OUTPUT_DIRECTORY` runs the selected directive compiler with deterministic manifest ordering. Run the compiler in an isolated fixture project; its output directory must resolve that project's installed `workflow` dependency. Compiler caches and generated handlers stay outside the application source tree. Generated handlers are development artifacts and do not grant authority to execute effects.

SDK qualification uses a fixed logical output path and an empty root TypeScript configuration. Its separate input preflight rejects ancestor/nested compiler configuration, outside first-party inputs, dynamic/CommonJS loading and ambiguous local declaration/runtime resolution. Record the full installed tool/helper closure and every generated handler, manifest and debug artifact, then regenerate at the same logical path and compare preserved bytes. The direct build command does not authenticate these records. Real packed-helper execution is qualified with a disposable prototype.

## Supervised self-host (bootstrap slice)

In a development checkout, `cloving start` starts one Cloving service for the git repository of the current directory, with the workflow host, the Claude worker and the watch page. The client commands find the service with no setting, because the two sides use the same default runtime directory (`~/.local/state/cloving/run`). `CLOVING_RUNTIME_DIR` selects a different place for the two sides. The directory above the runtime directory holds the authority state, the Local World data, the turn records and the git work trees.

```sh
cloving start                                  # terminal 1, in the repository
cloving run develop-ticket --ticket TICKET_ID  # terminal 2
cloving run develop-issue --ticket TICKET_ID   # the work goes through a pull request
cloving run develop-prompt --prompt "the text of the task"
cloving watch                                  # the live page, also started by cloving start
cloving questions
cloving approve DECISION_REF --expected-revision N --generation N --subject-digest DIGEST
```

`cloving watch` serves a read-only page on `http://127.0.0.1:3663/` (`--port` selects a different port). The page shows the runs, the events, the work of the Claude worker as it occurs, and each pending decision with its approve and deny commands. `cloving start` starts the page too; `CLOVING_WATCH_PORT` selects its port, and the value `off` starts none.

The workflow is the file `workflows/develop-ticket.ts` of this repository. `cloving start` copies it into a host project, compiles it there and admits it under three names. `develop-ticket` takes a ticket ID and reads the ticket itself. `develop-prompt` takes the text of a task. `develop-issue` takes a ticket ID too, and sends the work through a GitHub pull request.

`CLOVING_TICKET_COMMAND` (a JSON list of texts) names the ticket command. The daemon runs it with the ticket ID as the last argument when it admits a run, and the printed text is the ticket. The text becomes the stored input of the run, so a later change of the ticket does not change the run. A ticket that the command does not give is refused with `ticket-not-available`. With no ticket command, `develop-ticket` is refused with `ticket-source-not-configured`.

One run does one Claude Code turn in a new work tree on the branch `cloving/<ticket id>-…`, then opens one approval. The approval text has the ticket ID, the branch, the commits, the changed files and the report of the worker. Read the diff before you approve. An approval completes the run; it does not merge the branch. Merge the branch yourself.

The worker is not confined. It runs the `claude` command of the search path as the current user, with file edits and shell commands permitted in the work tree and a spend limit of 5 USD for each turn. `CLOVING_CLAUDE_COMMAND` (a JSON list of texts) replaces the command. A stop of the service stops a turn in work; submit that ticket again.

A run of `develop-issue` opens no approval. The GitHub worker makes the work tree from the newest commit of the default branch of `origin`. After the Claude turn, the worker pushes the branch and opens a pull request. The title is the first line of the ticket, and the text closes the GitHub issue of the ticket. Then the worker waits for the Greptile review of the pushed commit, and asks for a review with a comment after 5 minutes.

At the confidence score 5/5, the worker merges the pull request with a merge commit. Then it removes the remote branch, the work tree and the local branch. With a lower score, the Claude worker gets the summary and the findings of the review for one more round. After three such rounds, or after 60 minutes with no review, the run stops and the pull request stays open.

The GitHub worker does not push a change that has the path of the home folder in a file or in a commit message. `CLOVING_PRIVATE_TEXTS` (a JSON list of texts) adds more texts to refuse, with no difference between capital and small letters. `CLOVING_CHECK_COMMAND` (a JSON list of texts) names a check that must pass in the work tree before a merge. `CLOVING_GH_COMMAND` replaces the `gh` command. The worker uses the `gh` login and the git credentials of the current user.

To get the `cloving` command in a development checkout, put a launcher in a directory of the search path that runs `src/cli.ts` with the Node version of `package.json`, or run `npm run build` and `npm link`.
