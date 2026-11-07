export const fakeGh = `
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

const file = process.env.FAKE_GH_STATE;
const origin = process.env.FAKE_GH_ORIGIN;
const state = JSON.parse(readFileSync(file, "utf8"));
const args = process.argv.slice(2);
state.calls.push(args);
state.callTimes = [...(state.callTimes ?? []), Date.now()];
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const variable = (key) => args.find((part) => part.startsWith(key + "="))?.slice(key.length + 1);
const queued = () => state.prs.find((item) => "PR_" + item.number === variable("id"));
const headOf = (branch) => execFileSync("git", ["-C", origin, "rev-parse", "refs/heads/" + branch], { encoding: "utf8" }).trim();
const visibleHead = (pr) => state.headAfterReads === undefined ? headOf(pr.head) : pr.visibleHead;
const readHead = (pr) => {
  const pushed = headOf(pr.head);
  if (pushed === pr.visibleHead) return pushed;
  pr.headReads = (pr.headReads ?? 0) + 1;
  pr.headReadTimes = [...(pr.headReadTimes ?? []), Date.now()];
  if (pr.headReads >= (state.headAfterReads ?? 1)) pr.visibleHead = pushed;
  return visibleHead(pr);
};
const url = (number) => "https://github.com/acme/demo/pull/" + number;
const view = (pr) => ({ number: pr.number, url: url(pr.number), state: pr.state, headRefOid: pr.state === "OPEN" ? headOf(pr.head) : pr.mergedHead });
const out = (value) => {
  if (!failure?.after) process.stdout.write(typeof value === "string" ? value + "\\n" : JSON.stringify(value));
};
const path = args.find((item) => item.startsWith("repos/")) ?? "";
const number = Number(path.split("/")[4]);
const summary = (score, head) => "<h2>Confidence Score: " + score + "/5</h2>\\n<!-- greptile_confidence_score:" + score + " -->\\n<sub>Reviews (1) · Last reviewed commit: [\\"Change\\"](https://github.com/acme/demo/commit/" + head + ")</sub>";
const reviewedNow = (pr) => {
  const head = headOf(pr.head);
  if (state.reviewed[head] !== undefined) return;
  if (state.waitForTrigger && !state.triggers.includes(pr.number)) return;
  if (state.scores.length === 0) return;
  const score = state.scores.shift();
  state.reviewed[head] = score;
  state.latest[pr.number] = head;
  if (score < 5) state.reviewComments.push({ pr: pr.number, user: { login: "greptile-apps[bot]" }, path: "src/change.ts", line: score, original_commit_id: head, body: "Finding of the review with the score " + score + "." });
};
const counted = (pattern) => Number(pattern.exec(query)?.[1] ?? 0);
const commentPage = (nodes, end, size) => {
  const start = Math.max(0, end - size);
  return { pageInfo: { hasPreviousPage: start > 0, startCursor: String(start) }, nodes: nodes.slice(start, end) };
};
const threadNode = ({ comments, ...node }) => ({
  ...node,
  comments: { nodes: comments.nodes.slice(0, counted(/(?<!root: )comments\\(first: (\\d+)\\)/)) },
  root: { nodes: comments.nodes.slice(0, counted(/root: comments\\(first: (\\d+)\\)/)) },
  recent: commentPage(comments.nodes, comments.nodes.length, counted(/recent: comments\\(last: (\\d+)\\)/)),
});
const earlierPage = () => {
  const thread = state.reviewPull.reviewThreads.nodes.find((item) => item.id === variable("thread"));
  return { node: { comments: commentPage(thread.comments.nodes, Number(variable("cursor")), counted(/comments\\(last: (\\d+), before:/)) } };
};
const threadPage = () => {
  const nodes = state.reviewPull.reviewThreads.nodes;
  const after = Number(variable("cursor") ?? 0);
  const end = after + counted(/reviewThreads\\(first: (\\d+)/);
  return { ...state.reviewPull, reviewThreads: { pageInfo: { hasNextPage: end < nodes.length, endCursor: String(end) }, nodes: nodes.slice(after, end).map(threadNode) } };
};
const actions = {
  "label create": () => {
    const repository = option("--repo");
    const label = state.labels.find((item) => item.repository === repository && item.name === args[2]);
    const values = { repository, name: args[2], color: option("--color") ?? "random", description: option("--description") ?? "" };
    if (label && !args.includes("--force")) throw new Error("label already exists");
    if (label) Object.assign(label, values);
    else state.labels.push(values);
  },
  "issue edit": () => {
    const repository = option("--repo");
    const labels = (flag) => args.flatMap((item, index) => item === flag ? args[index + 1].split(",") : []);
    const added = labels("--add-label");
    const removed = labels("--remove-label");
    const issue = state.issues.find((item) => item.repository === repository && item.number === Number(args[2]));
    for (const name of [...added, ...removed]) {
      if (!state.labels.some((label) => label.repository === repository && label.name === name) && !issue?.labels?.includes(name)) throw new Error("label does not exist: " + name);
    }
    if (!issue) throw new Error("issue does not exist");
    issue.labels = [...new Set([...(issue.labels ?? []).filter((name) => !removed.includes(name)), ...added])];
  },
  "api GET issue": () => {
    const issue = state.issues.find((issue) => issue.repository === path.split("/").slice(1, 3).join("/") && issue.number === number);
    out(issue);
    if (state.issueEditAfterRead !== undefined) {
      Object.assign(issue, state.issueEditAfterRead);
      delete state.issueEditAfterRead;
    }
  },
  "api PATCH issue": () => {
    const issue = state.issues.find((issue) => issue.repository === path.split("/").slice(1, 3).join("/") && issue.number === number);
    for (const name of ["body", "state", "state_reason"]) {
      const value = option("-f") === undefined ? undefined : args.find((part) => part.startsWith(name + "="));
      if (value !== undefined) issue[name] = value.slice(name.length + 1);
    }
    const labels = args.filter((part) => part.startsWith("labels[]=")).map((part) => part.slice(9));
    if (labels.length > 0 || args.includes("labels[]")) issue.labels = labels;
    out(issue);
  },
  "issue create": () => {
    const created = { number: state.issues.length + 1, title: option("--title"), body: option("--body") };
    created.html_url = "https://github.com/acme/demo/issues/" + created.number;
    state.issues.push(created);
    out(created.html_url);
  },
  "repo view": () => out({ nameWithOwner: "acme/demo" }),
  "api GET check-runs": () => out([{ check_runs: [{ id: 101, name: "quality_linux", app: { slug: "github-actions" }, status: "completed", conclusion: "success", details_url: null }] }]),
  "api GET attempt-jobs": () => out([{ jobs: [101, 102].map((id) => ({ check_run_url: "https://api.github.com/repos/acme/demo/check-runs/" + id })) }]),
  "api GET workflows": () => out([{ workflows: [] }]),
  "api GET workflow-run": () => out({ run_attempt: 2, status: "completed" }),
  "api GET workflow-runs": () => {
    const head = new URL("https://api.github.com/" + path).searchParams.get("head_sha");
    const paths = execFileSync("git", ["-C", origin, "ls-tree", "-r", "--name-only", head, "--", ".github/workflows"], { encoding: "utf8" }).trim().split("\\n");
    out([{ workflow_runs: paths.map((path, index) => ({ id: 88 + index, path, head_sha: head, event: "pull_request", status: "completed", conclusion: "success" })) }]);
  },
  "run rerun": () => out(""),
  "run view": () => out(args.includes("--log-failed") ? "Failed assertion" : { jobs: [{ databaseId: 101, name: "quality_linux", steps: [{ name: "Run quality", conclusion: "failure" }] }] }),
  "api GET issues": () => {
    const pages = state.issuePages ?? [state.issues];
    if (option("--jq")) {
      const marker = JSON.parse(option("--jq").match(/contains\\((".*")\\)/)[1]);
      for (const page of pages) out(JSON.stringify(page.filter((issue) => issue.body?.includes(marker)).map(({ number, html_url }) => ({ number, html_url }))));
      return;
    }
    out(args.includes("--slurp") ? pages : pages[0]);
  },
  "pr list": () => out(state.prs.filter((pr) => pr.head === option("--head") && (option("--state") !== "open" || pr.state === "OPEN")).map(view)),
  "pr create": () => {
    const created = { number: state.prs.length + 1, head: option("--head"), base: option("--base"), title: option("--title"), body: option("--body"), state: "OPEN" };
    created.visibleHead = headOf(created.head);
    state.prs.push(created);
    out(url(created.number));
  },
  "pr comment": () => { state.triggers.push(Number(args[2])); },
  "pr close": () => { state.prs.find((item) => item.number === Number(args[2])).state = "CLOSED"; },
  "issue comment": () => {
    const comments = state.issueComments ?? [];
    const created = { id: comments.length + 1, issue: Number(args[2]), body: option("--body") };
    created.html_url = "https://github.com/acme/demo/issues/" + created.issue + "#issuecomment-" + created.id;
    state.issueComments = [...comments, created];
    out(created.html_url);
  },
  "api GET comments": () => {
    if (option("--jq")) {
      const marker = JSON.parse(option("--jq").match(/contains\\((".*")\\)/)[1]);
      out(JSON.stringify((state.issueComments ?? []).filter((comment) => comment.issue === number && comment.body.includes(marker)).map((comment) => comment.html_url)));
      return;
    }
    const pr = state.prs.find((item) => item.number === number);
    reviewedNow(pr);
    const head = state.latest[number];
    const greptile = head === undefined ? [] : [{ user: { login: "greptile-apps[bot]" }, body: summary(state.reviewed[head], head) }];
    out([{ user: { login: "someone" }, body: "<!-- greptile_confidence_score:1 --> not a review" }, ...greptile]);
  },
  "api GET review": () => out(state.reviewComments.filter((item) => item.pr === number)),
  "api GET pull": () => {
    const pr = state.prs.find((item) => item.number === number);
    if (pr === undefined) {
      process.stderr.write("gh: Not Found (HTTP 404)");
      process.exitCode = 1;
      return;
    }
    const merged = pr.state === "MERGED";
    out({ number, node_id: "PR_" + number, state: merged ? "closed" : "open", merged, merge_commit_sha: merged ? pr.mergeCommit : "e".repeat(40), base: { ref: pr.base, sha: headOf(pr.base) }, head: { ref: pr.head, sha: merged ? pr.mergedHead : readHead(pr) } });
  },
  "api graphql pull": () => {
    const pr = queued();
    pr.queuePolls = (pr.queuePolls ?? 0) + 1;
    const result = existsSync(file + ".queue") ? readFileSync(file + ".queue", "utf8") : undefined;
    const settled = pr.queue && result && pr.queuePolls >= (state.queuePolls ?? 1);
    if (settled && result === "merged") Object.assign(pr, { state: "MERGED", mergedHead: headOf(pr.head), mergeCommit: "d".repeat(40) });
    if (settled) pr.queue = null;
    const merged = pr.state === "MERGED";
    out({ data: { node: { id: "PR_" + pr.number, state: pr.state, headRefOid: merged ? pr.mergedHead : headOf(pr.head), mergeCommit: merged ? { oid: pr.mergeCommit } : null, mergeQueueEntry: pr.queue ?? null } } });
  },
  "api graphql enqueue": () => {
    const pr = queued();
    if (variable("head") !== headOf(pr.head)) {
      process.stderr.write("gh: GraphQL: The head of the pull request changed (HTTP 422)");
      process.exitCode = 1;
      return;
    }
    pr.queue = { state: "QUEUED", position: state.queuePosition ?? 1, enqueuedAt: state.enqueuedAt ?? new Date().toISOString() };
    pr.queuePolls = 0;
    out({ data: { enqueuePullRequest: { mergeQueueEntry: pr.queue } } });
  },
  "api graphql threads": () => out({ data: { viewer: { login: "operator" }, repository: { pullRequest: threadPage() } } }),
  "api graphql earlier": () => out({ data: earlierPage() }),
  "api graphql replies": () => out({ data: { viewer: { login: "operator" }, node: { comments: { nodes: (state.threadReplies ?? []).filter((item) => item.thread === variable("thread")) } } } }),
  "api graphql reply": () => {
    const id = "PRRC_reply" + state.calls.length;
    state.threadReplies = [...(state.threadReplies ?? []), { thread: variable("thread"), id, body: variable("body"), author: { login: "operator" } }];
    out({ data: { addPullRequestReviewThreadReply: { comment: { id } } } });
  },
  "api graphql resolve": () => out({ data: { resolveReviewThread: { thread: { id: variable("thread"), isResolved: true } } } }),
  "api graphql dequeue": () => {
    const pr = queued();
    pr.queue = null;
    pr.dequeued = true;
    out({ data: { dequeuePullRequest: { mergeQueueEntry: null } } });
  },
  "api PUT merge": () => {
    const pr = state.prs.find((item) => item.number === number);
    const now = Date.now();
    const previous = pr.mergeTimes?.at(-1);
    pr.mergeTimes = [...(pr.mergeTimes ?? []), now];
    if (pr.mergeTimes.length <= (state.mergeRefusals ?? 0) || now - previous < (state.mergePollMilliseconds ?? 0)) {
      process.stderr.write("gh: Merge not ready (HTTP " + (state.mergeStatus ?? 409) + ")");
      process.exitCode = 1;
      return;
    }
    if (!args.includes("sha=" + visibleHead(pr))) {
      process.stderr.write("gh: Head branch was modified (HTTP 409)");
      process.exitCode = 1;
      return;
    }
    pr.mergedHead = headOf(pr.head);
    pr.mergeCommit = "f".repeat(40);
    pr.state = "MERGED";
    out({ sha: pr.mergeCommit, merged: true });
  },
  "api DELETE refs": () => { execFileSync("git", ["-C", origin, "branch", "-D", path.split("/heads/")[1]]); },
};
const kind = path.includes("/actions/workflows?") ? "workflows" : path.includes("/attempts/") ? "attempt-jobs" : path.includes("/actions/runs?") ? "workflow-runs" : /[/]actions[/]runs[/]\\d+$/.test(path) ? "workflow-run" : path.includes("/check-runs") ? "check-runs" : /[/]issues[/]\\d+$/.test(path) ? "issue" : path.includes("/issues?") ? "issues" : path.endsWith("/merge") ? "merge" : path.includes("/git/refs/") ? "refs" : /[/]pulls[/]\\d+$/.test(path) ? "pull" : path.includes("/pulls/") ? "review" : "comments";
const query = variable("query") ?? "";
const graphqlNames = { "enqueuePullRequest(": "enqueue", "dequeuePullRequest(": "dequeue", "reviewThreads(": "threads", "addPullRequestReviewThreadReply(": "reply", "resolveReviewThread(": "resolve", "before: $cursor": "earlier", "on PullRequestReviewThread": "replies" };
const mutation = Object.entries(graphqlNames).find(([word]) => query.includes(word))?.[1] ?? "pull";
const name = args[1] === "graphql" ? "api graphql " + mutation : args[0] === "api" ? "api " + (option("-X") ?? "GET") + " " + kind : args[0] + " " + args[1];
if (name === "api GET comments" && state.reviewReadMilliseconds)
  await new Promise(resolve => setTimeout(resolve, state.reviewReadMilliseconds));
if (state.holds?.includes(name)) {
  writeFileSync(file + ".held", name);
  await new Promise(resolve => setTimeout(resolve, 600_000));
}
const index = state.failures?.findIndex((failure) => failure.call === name) ?? -1;
const failure = index < 0 ? undefined : state.failures.splice(index, 1)[0];
if (failure?.after) actions[name]();
if (failure) {
  process.stderr.write(failure.detail);
  process.exitCode = 1;
} else if (state.fail === name) {
  process.stderr.write(state.failureText ?? "the fake gh refused " + name);
  process.exitCode = 1;
} else if (state.garble === name) process.stdout.write("not json");
else if (state.sequences?.[name]) {
  const sequence = state.sequences[name];
  out(sequence.length > 1 ? sequence.shift() : sequence[0]);
}
else if (state.replies && Object.hasOwn(state.replies, name)) out(state.replies[name]);
else actions[name]();
const staged = file + "." + process.pid;
writeFileSync(staged, JSON.stringify(state));
renameSync(staged, file);
`;
