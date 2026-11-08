# Docs drift

Copy the template into your private workflow folder, named by `workflows.folder`,
with `cloving templates copy docs-drift`. This operator step happens outside
the application repository. Then run `cloving workflows test docs-drift`.

The audit does not change a doc. The tickets that it writes make the changes.
It does not check code comments or text inside the source.

## The schedule

The default schedule runs on Mondays at 07:00 in the time zone `UTC`, with `{}`
input:

```json
"schedule": {
  "at": "07:00",
  "timeZone": "UTC",
  "weekdays": ["monday"],
  "input": {}
}
```

Check `timeZone` in the copied declaration. When it is not your time zone,
change it to your IANA name, for example `America/Los_Angeles`. You can also set
the schedule in `CLOVING_SCHEDULES`, for example
`{"docs-drift":{"at":"07:00","timeZone":"America/Los_Angeles","weekdays":["monday"],"input":{}}}`.

## The operator commands

The copy has two reference scripts. Set `CLOVING_COMMANDS` to a JSON argv array
for each command:

```json
{
  "docs-candidates": [
    "<absolute-node-executable>",
    "<absolute-workflow-folder>/docs-drift/docs-candidates.mts",
    "<absolute-github-cli-folder>",
    "<absolute-record-file>",
    "README.md",
    "AGENTS.md",
    "templates/*/README.md"
  ],
  "docs-drift-record": [
    "<absolute-node-executable>",
    "<absolute-workflow-folder>/docs-drift/docs-drift-record.mts",
    "<absolute-record-file>"
  ]
}
```

Replace the placeholders with absolute paths. Bare executable names are refused
by command configuration. Give both commands the same record file. Keep the
record file outside the repository, for example in the state folder of the
operator.

The last items of `docs-candidates` are the operator list of docs. Each item is
a path relative to the repository, or a pattern in which `*` is any text in one
folder name and `?` is one character. Only Markdown files (`.md`) of the list
count. A doc path can have only letters, digits, `_`, `-`, `.` and `/`, and no
`..`. Other docs do not count.

The service gives an operator command no GitHub token variable and an empty
`GH_CONFIG_DIR`, as it does for a turn. Thus the third item of `docs-candidates`
is the GitHub CLI configuration folder of a login that can read the contents and
the issues of the repository. The script sets `GH_CONFIG_DIR` to this folder for
its `git` and `gh` calls, so `git fetch` can also use `gh` as its credential
helper. To make a folder for this command alone, run
`GH_CONFIG_DIR=<absolute-github-cli-folder> gh auth login` one time. With bad
arguments, a script runs no command, prints nothing to standard output and ends
with code 1.

### `docs-candidates`

The script runs `git` and `gh` from `PATH` in the folder of the service, which is
the repository. It does these steps:

1. It reads the current default branch of the remote `origin` with
   `git ls-remote --symref origin HEAD` and fetches that branch. The newest
   commit of that branch is the commit of the audit.
2. It lists the files of that commit and keeps the docs of the operator list.
3. It reads the record file. A file that does not exist is an empty record.
4. It reads all pages of the open issues with the label `cloving: docs` through
   `gh api`. A doc whose path is a word of the title of such an issue is not a
   candidate. A pull request does not count.
5. For each other doc, it compares the commit of the doc in the record with the
   commit of the audit. With no record, or with a recorded commit that `git`
   does not know, it compares the empty tree with the commit of the audit, so
   each file counts as changed.
6. It reads the doc from the commit of the audit and finds the code that it
   names.

Each tracked file that is not Markdown counts as code. A doc names a changed
code file in two ways:

- The doc contains the path of the file, relative to the repository or to the
  folder of the doc.
- A code span of the doc, for example `` `queue.seconds` `` or
  `` `invalid-input` ``, is a word of an added or a removed line of the file.
  Only a code span of 3 to 100 characters with a `.`, `_`, `-` or `@`, or with a
  lowercase letter before an uppercase letter, counts as a name.

A doc that names no changed code file is not a candidate. The script prints one
JSON object with at most 15 docs, the docs with the most code files first, then
in the order of their paths:

```json
{
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "candidates": [
    {
      "doc": "README.md",
      "since": "89abcdef0123456789abcdef0123456789abcdef",
      "code": ["src/settings.ts"],
      "codeCount": 1
    }
  ],
  "more": 0
}
```

| Field       | Value                                                                    |
| ----------- | ------------------------------------------------------------------------ |
| `commit`    | The newest commit of the default branch.                                 |
| `doc`       | The path of the doc.                                                     |
| `since`     | The recorded commit of the doc, or `null` with no known record.          |
| `code`      | At most 50 changed code files that the doc names, in the order of paths. |
| `codeCount` | The number of all changed code files that the doc names.                 |
| `more`      | The number of candidates over the limit of 15. A later audit gives them. |

When a step fails, the script prints nothing, writes the cause to standard error
and ends with code 1. A record file that is not a record of this template stops
the script with `The file <path> is not a docs-drift record.`

### `docs-drift-record`

The workflow sends `{"commit": "<commit ID>", "docs": ["<doc path>"]}` on
standard input. The script writes the commit for each doc to the record file and
keeps the commits of the other docs. It prints `{"recorded": <number of docs>}`.
The record file has this form:

```json
{
  "version": 1,
  "docs": {
    "README.md": "0123456789abcdef0123456789abcdef01234567"
  }
}
```

The script writes a new file and renames it, so a stop does not leave half a
record. Another input stops the script with code 1 and no change.

## The audit turn

A run with no candidate ends `completed` with no turn and no record.

Else the `prepare` method gives a clean work tree of the newest default branch,
and one turn audits the candidates. The turn gets the candidates as untrusted
data. For each candidate, it reads each statement that names code: a setting, a
command, a file, a default, an error code or a field. It compares each statement
with the code in the work tree. It does not change a file. For each statement
that does not match the code, it writes one row:

- the line number in the doc;
- what the doc says;
- what the code does;
- the evidence as a relative `path:line` in the work tree;
- the commit that changed that line;
- the change of the doc that makes the row match the code.

The turn returns JSON of at most 48000 characters in its final summary. After
the turn, also after a failure, the `discard` method removes the work tree.

The turn reads files. Before you enable the schedule, add a turn profile for this
workflow with `maxBudgetUsd` and the tools for this work, for example `Read`,
`Glob`, `Grep` and `Bash` for `git log` and `git blame`. Change the method of the
turn and its declaration entry from `run-turn` to `run-turn:<profile>` to use
the profile.

The workflow checks the result. A row whose evidence is not a relative
`path:line` is dropped, and the turn must not guess. A commit that is not a
hexadecimal ID shows as `not known`. A doc with no row left did not drift. A doc
that is not a candidate, a doc that is in the result two times, or a row with a
bad line number or text blocks the run with `invalid-drift-result`. A summary
above 48000 characters blocks it with `drift-result-too-large`.

## The tickets

The workflow puts the docs with the most rows first and keeps at most 5 docs.
For each doc it writes a ticket in the PRD form of the repository: `Problem`,
`Desired outcome`, `Concrete scenario`, `Scope`, `Non-goals`,
`Acceptance criteria` and `First tests`. The title is
``Make `<doc>` match the code on main``. The ticket has:

- the table with the doc line, what the doc says, what the code does, the
  evidence and the commit;
- one step of the scope for each row, with the change of the doc;
- the acceptance criteria: each row matches the code on main, the change
  touches only the doc, and every other statement of the doc stays.

`create-issue` makes one issue for each run, because its duplicate marker uses
the target of the run. Thus the audit hands off one small `docs-drift` run for
each ticket with the input `{"text": "<ticket>"}`. The declaration names
`docs-drift` in `handoffs` for this. A ticket above 48000 bytes blocks the run
before the first handoff with `drift-ticket-too-large`.

A run with a `text` does not audit. It does two steps:

1. The GitHub method `create-issue` with `{"text": "<ticket>"}` creates the
   issue. The method uses the privacy check of the service, so set
   `privateTexts`. A text with a private text, a local path, a mention or a link
   to an issue of another repository blocks the run with
   `private-path-in-change`. A result with no issue number blocks it with
   `invalid-issue-result`.
2. The GitHub method `label` adds the label `cloving: docs` to the issue.

The outcome has the promotion ID `issue-<number>`. A failed step blocks the run.
A retry of the same run does not create a second issue. The title names the
doc, so a later audit leaves the doc out while the issue is open. You can also
start such a run with `cloving run docs-drift --input ticket.json`.

## The record

After the handoffs, the workflow runs `docs-drift-record` with the commit of the
audit and each audited doc with no drift. A run with no drift ends `completed`
with no issue and records each candidate. The next run lists only the code that
changed after the recorded commit of each doc.

A doc that drifted keeps its earlier record. While its issue is open, the audit
leaves it out. When the issue closes, or when its ticket run did not create
the issue, the next audit gives the doc to a turn again. A drifted doc
over the limit of 5 also keeps its record, and a later audit gives it again.

The static effect count is 12: the two commands, `prepare`, the turn,
`discard`, 5 handoffs, `create-issue` and `label`.
