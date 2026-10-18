export const fakeGh = `
import { execFileSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

const file = process.env.FAKE_GH_STATE;
const origin = process.env.FAKE_GH_ORIGIN;
const state = JSON.parse(readFileSync(file, "utf8"));
const args = process.argv.slice(2);
state.calls.push(args);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
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
const out = (value) => process.stdout.write(typeof value === "string" ? value + "\\n" : JSON.stringify(value));
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
    for (const name of [...added, ...removed]) {
      if (!state.labels.some((label) => label.repository === repository && label.name === name)) throw new Error("label does not exist: " + name);
    }
    const issue = state.issues.find((item) => item.repository === repository && item.number === Number(args[2]));
    if (!issue) throw new Error("issue does not exist");
    issue.labels = [...new Set([...(issue.labels ?? []).filter((name) => !removed.includes(name)), ...added])];
  },
  "api GET issue": () => out(state.issues.find((issue) => issue.repository === path.split("/").slice(1, 3).join("/") && issue.number === number)),
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
  "api GET comments": () => {
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
    out({ number, state: merged ? "closed" : "open", merged, merge_commit_sha: merged ? pr.mergeCommit : "e".repeat(40), head: { sha: merged ? pr.mergedHead : readHead(pr) } });
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
const kind = /[/]issues[/]\\d+$/.test(path) ? "issue" : path.includes("/issues?") ? "issues" : path.endsWith("/merge") ? "merge" : path.includes("/git/refs/") ? "refs" : /[/]pulls[/]\\d+$/.test(path) ? "pull" : path.includes("/pulls/") ? "review" : "comments";
const name = args[0] === "api" ? "api " + (option("-X") ?? "GET") + " " + kind : args[0] + " " + args[1];
if (state.fail === name) {
  process.stderr.write(state.failureText ?? "the fake gh refused " + name);
  process.exitCode = 1;
} else if (state.garble === name) process.stdout.write("not json");
else if (state.replies && Object.hasOwn(state.replies, name)) out(state.replies[name]);
else actions[name]();
const staged = file + "." + process.pid;
writeFileSync(staged, JSON.stringify(state));
renameSync(staged, file);
`;
