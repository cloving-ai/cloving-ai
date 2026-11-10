export const transcriptStyle = `
.transcript { --terminal-edge: color-mix(in srgb, var(--color-terminal-text) 16%, var(--color-terminal-background)); margin: 12px 0; scroll-margin-top: 7rem; }
.transcript.code-window { background: var(--color-terminal-background); color: var(--color-terminal-text); box-shadow: inset 0 0 0 var(--shape-border) var(--terminal-edge), var(--shadow); }
.transcript .code-head { display: flex; gap: 10px; align-items: center; background: var(--color-terminal-background); color: var(--color-terminal-dim); border-bottom: var(--shape-border) solid var(--terminal-edge); }
.transcript-toggle, .transcript-jump, .transcript-earlier, .transcript-retry { font: 500 12px/1.4 var(--font-code); color: var(--color-terminal-text); background: var(--terminal-edge); border: 0; border-radius: var(--shape-cut); padding: 3px 10px; cursor: pointer; }
.transcript-link, .transcript-full { color: var(--color-terminal-dim); }
.transcript .meta { padding: 8px 12px; margin: 0; color: var(--color-terminal-dim); }
.transcript .bad { padding: 8px 12px; margin: 0; color: var(--color-terminal-red); }
.transcript-earlier, .transcript-jump, .transcript-retry { margin: 8px 12px; }
.transcript-lines { height: calc(100vh - 10rem); overflow: auto; padding: 10px 14px 14px; font: 400 13px/1.5 var(--font-code); color: var(--color-terminal-text); background: var(--color-terminal-background); }
.transcript-lines pre { margin: 0; padding: 0; border: 0; border-radius: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; color: inherit; background: none; }
.transcript-lines .entry { margin: 0 0 10px; }
.transcript-lines .entry .entry { margin: 0; }
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
.transcript-lines .entry-cut { margin: 2px 0 0; color: var(--color-terminal-dim); font-style: italic; }
.terminal-page { position: fixed; inset: 0; display: flex; }
.terminal-page > .transcript { flex: 1; display: flex; flex-direction: column; min-width: 0; margin: 0; border-radius: 0; }
.terminal-page .code-head { border-radius: 0; }
.terminal-page .transcript-lines { flex: 1; height: auto; min-height: 0; }
`;
