const binding =
  "--expected-revision <n> --generation <n> --subject-digest <digest>";

export const commandUsage: Readonly<Record<string, string>> = {
  run: `Usage: cloving run <workflow-id> (--prompt <text> | --input <json-file>) [--command-id <id>] [--json]

Submits one run of an admitted workflow. Use exactly one input source.
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
  deny: `Usage: cloving deny <decision-ref> ${binding} [--command-id <id>] [--json]

Denies one pending approval. The workflow continues with the denial.
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
};

export const usage = `Usage: cloving [--help] [--version]
       cloving workflows validate <manifest-path> [--input <json-file>] [--json]
       cloving <command> [--help]

Commands:
  workflows validate  Check a compiled workflow manifest, its artifacts and optional runtime input.
  run        Submit one run of an admitted workflow.
  status     List the runs or show one run.
  questions  List the pending decisions.
  answer     Answer one design question.
  approve    Approve one pending approval.
  deny       Deny one pending approval.
  pause      Stop new dispatch for a run.
  resume     Resume a paused run.
  drop       Cancel a run and keep its files.
  events     Print the committed events.

The runtime commands need a Cloving service. CLOVING_RUNTIME_DIR names its runtime directory.
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
