import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Executor } from "../sandbox.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

export function createPipiclawTools(executor: Executor): AgentTool<any>[] {
	return [createReadTool(executor), createBashTool(executor), createEditTool(executor), createWriteTool(executor)];
}
