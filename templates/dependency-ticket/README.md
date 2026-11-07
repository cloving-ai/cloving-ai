# Dependency ticket

Copy the template into the private workflow folder of `dependency-audit` with
`cloving templates copy dependency-ticket`. Then run
`cloving workflows test dependency-ticket`.

The `dependency-audit` workflow hands off one run of this workflow for each
ticket, with the input `{"text": "<ticket>"}`. The text starts with
`# <title>`. You can also start a run with
`cloving run dependency-ticket --input ticket.json`.

The run does two steps:

1. The GitHub method `create-issue` with `{"text": "<ticket>"}` creates the
   issue. The method uses the privacy check of the service, so set
   `privateTexts`. A text with a private text, a local path, a mention or a link
   to an issue of another repository blocks the run with
   `private-path-in-change`.
2. The GitHub method `label` adds the label `cloving: security` to the issue.

The outcome has the promotion ID `issue-<number>`. A failed step blocks the run.
When the issue is not created, the open issues do not name the advisories, so
the next audit gives them to a turn again.

`create-issue` makes one issue for each run, because its duplicate marker uses
the target of the run. A retry of the same run does not create a second issue.

The static effect count is 2.
