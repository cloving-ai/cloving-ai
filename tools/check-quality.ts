import { checkProject } from "../quality/project.ts";

const result = await checkProject(process.cwd());
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
