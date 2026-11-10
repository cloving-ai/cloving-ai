import { renameRequest } from "./command-requests.ts";
import {
  key,
  mutation,
  mutationCall,
  repeat,
  type Argument,
  type Tool,
} from "./mcp-tool.ts";

const words: Argument = {
  schema: { type: "string" },
  valid: (value) => typeof value === "string",
};

const choice: Argument = {
  schema: { type: "boolean" },
  valid: (value) => typeof value === "boolean",
};

function given(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export const renameTool: Tool = {
  name: "cloving_rename",
  description: `Give an active or ended run a manual title of 1 to 200 characters on one line and an optional label of 1 to 32 letters, digits or the characters # ! . _ / -. With clear and no title or label, remove the manual name so that the run gets its automatic name again. The newest rename wins and stays after a restart. ${repeat}`,
  arguments: {
    runId: key,
    title: words,
    label: words,
    clear: choice,
    commandId: key,
  },
  required: ["runId", "commandId"],
  annotations: mutation,
  call: (values) =>
    mutationCall(values, (commandId) =>
      renameRequest({
        runId: String(values["runId"]),
        title: given(values["title"]),
        label: given(values["label"]),
        clear: values["clear"] === true,
        commandId,
      }),
    ),
};
