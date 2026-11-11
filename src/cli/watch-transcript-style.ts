export const transcriptStyle = `
.run-tabs { display: flex; gap: 4px; margin: 22px 0 0; border-bottom: var(--shape-border) solid var(--color-line); }
.run-tabs .run-tab { margin: 0 0 -1px; padding: 8px 16px; font: 600 14px/1.4 var(--font-ui); color: var(--color-muted); background: none; clip-path: none; border-bottom: 3px solid transparent; }
.run-tabs .run-tab:hover { color: var(--color-ink); background: none; }
.run-tabs .run-tab[aria-selected="true"] { color: var(--color-ink); border-bottom-color: var(--color-accent-strong); }
.transcript { --terminal-edge: color-mix(in srgb, var(--color-terminal-text) 16%, var(--color-terminal-background)); margin: 12px 0; scroll-margin-top: 7rem; }
.transcript.code-window { background: var(--color-terminal-background); color: var(--color-terminal-text); box-shadow: inset 0 0 0 var(--shape-border) var(--terminal-edge), var(--shadow); }
.transcript .code-head { display: flex; gap: 10px; align-items: center; background: var(--color-terminal-background); color: var(--color-terminal-dim); border-bottom: var(--shape-border) solid var(--terminal-edge); }
.transcript-toggle, .transcript-jump, .transcript-earlier, .transcript-retry { font: 500 12px/1.4 var(--font-code); color: var(--color-terminal-text); background: var(--terminal-edge); border: 0; border-radius: var(--shape-cut); padding: 3px 10px; cursor: pointer; }
.transcript-link, .transcript-full { color: var(--color-terminal-dim); }
.transcript .transcript-expand { margin-left: auto; font: 600 14px/1 var(--font-code); color: var(--color-terminal-text); background: var(--terminal-edge); border: 0; border-radius: var(--shape-cut); padding: 4px 8px; cursor: pointer; clip-path: none; }
.transcript .transcript-expand:hover { color: var(--color-terminal-tool); }
.transcript .meta { padding: 8px 12px; margin: 0; color: var(--color-terminal-dim); }
.transcript .bad { padding: 8px 12px; margin: 0; color: var(--color-terminal-red); }
.transcript-earlier, .transcript-jump, .transcript-retry { margin: 8px 12px; }
.transcript-lines { max-height: 500px; overflow: auto; padding: 10px 14px 14px; font: 400 13px/1.5 var(--font-code); color: var(--color-terminal-text); background: var(--color-terminal-background); }
.transcript-lines.expanded { max-height: none; }
.transcript-lines pre { margin: 0; padding: 0; border: 0; border-radius: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; color: inherit; background: none; }
.transcript-lines .entry { margin: 0 0 10px; }
.transcript-lines .entry .entry { margin: 0; }
.transcript-lines .entry.tool-call { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 2ch; align-items: start; margin: 0 0 2px; }
.transcript-lines .entry.tool-call + .entry:not(.tool-call) { margin-top: 8px; }
.transcript-lines .entry.tool-call > * { grid-column: 1 / -1; margin: 0; }
.transcript-lines .entry.tool-call > .tool-line:not([open]) { grid-column: 1; }
.transcript-lines .entry.tool-call > .tool-line:not([open]) + .tool-result:not([open]) { grid-column: 2; }
.transcript-lines .entry.prompt, .transcript-lines .entry.assistant, .transcript-lines .tool-result, .transcript-lines .detail { display: flex; }
.transcript-lines .mark { flex: none; white-space: pre; }
.transcript-lines .entry.assistant > .mark { width: 2ch; color: var(--color-terminal-text); }
.transcript-lines .entry.prompt > .mark { color: var(--color-terminal-dim); }
.transcript-lines .output { flex: 1; min-width: 0; }
.transcript-lines summary { cursor: pointer; list-style: none; }
.transcript-lines summary::-webkit-details-marker { display: none; }
.transcript-lines .tool-line > summary { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.transcript-lines .tool-line .mark { color: var(--color-terminal-green); }
.transcript-lines .tool-name { color: var(--color-terminal-tool); font-weight: 700; }
.transcript-lines .tool-input { margin: 2px 0 4px 2ch; color: var(--color-terminal-dim); }
.transcript-lines .tool-result, .transcript-lines .detail { padding-left: 2ch; color: var(--color-terminal-dim); }
.transcript-lines .gutter { flex: none; width: 3ch; }
.transcript-lines details.tool-result { display: block; }
.transcript-lines details.tool-result > summary { display: flex; color: inherit; }
.transcript-lines details.tool-result > .output { margin: 2px 0 0 3ch; }
.transcript-lines .output summary, .transcript-lines .entry.notice, .transcript-lines .entry.result { color: var(--color-terminal-dim); }
.transcript-lines .tool-result.error, .transcript-lines .entry.error, .transcript-lines .removed { color: var(--color-terminal-red); }
.transcript-lines .added { color: var(--color-terminal-green); }
.transcript-lines .diff > div { white-space: pre-wrap; overflow-wrap: anywhere; }
.transcript-lines .todo { color: var(--color-terminal-text); }
.transcript-lines .todo.doing { font-weight: 700; }
.transcript-lines .todo.done { color: var(--color-terminal-dim); }
.transcript-lines .todo.done .todo-text { text-decoration: line-through; }
.transcript-lines .entry.thinking > summary { font-style: italic; color: var(--color-terminal-dim); }
.transcript-lines .entry.thinking > pre { margin-top: 2px; color: var(--color-terminal-dim); font-style: italic; }
.transcript-lines .markdown { flex: 1; min-width: 0; }
.transcript-lines .markdown > * { margin: 0 0 6px; }
.transcript-lines .markdown > :last-child { margin-bottom: 0; }
.transcript-lines .markdown p, .transcript-lines .markdown li { white-space: pre-wrap; overflow-wrap: anywhere; }
.transcript-lines .markdown h1, .transcript-lines .markdown h2, .transcript-lines .markdown h3, .transcript-lines .markdown h4, .transcript-lines .markdown h5, .transcript-lines .markdown h6 { font: inherit; font-weight: 700; color: var(--color-terminal-tool); }
.transcript-lines .markdown ul, .transcript-lines .markdown ol { padding-left: 3ch; }
.transcript-lines .markdown strong, .transcript-lines .markdown code { color: var(--color-terminal-tool); }
.transcript-lines .markdown .md-code { padding: 6px 10px; background: var(--terminal-edge); }
.transcript-lines .markdown a { color: var(--color-terminal-green); }
.transcript-lines .entry-cut { margin: 2px 0 0; color: var(--color-terminal-dim); font-style: italic; }
.terminal-page { position: fixed; inset: 0; display: flex; }
.terminal-page > .transcript { flex: 1; display: flex; flex-direction: column; min-width: 0; margin: 0; border-radius: 0; }
.terminal-page .code-head { border-radius: 0; }
.terminal-page .transcript-lines { flex: 1; height: auto; min-height: 0; max-height: none; }
`;
