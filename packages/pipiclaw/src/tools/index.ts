import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { Executor } from "../sandbox.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createReadTool } from "./read.js";
import { createSubAgentTool } from "./subagent.js";
import { createWriteTool } from "./write.js";

export interface CreatePipiclawToolsOptions {
	executor: Executor;
	getCurrentModel: () => Model<Api>;
	getAvailableModels: () => Model<Api>[];
	resolveApiKey: (model: Model<Api>) => Promise<string>;
	workspaceDir: string;
}

export function createPipiclawBaseTools(executor: Executor): AgentTool<any>[] {
	return [createReadTool(executor), createBashTool(executor), createEditTool(executor), createWriteTool(executor)];
}

export function createPipiclawTools(options: CreatePipiclawToolsOptions): AgentTool<any>[] {
	const baseTools = createPipiclawBaseTools(options.executor);
	return [
		...baseTools,
		createSubAgentTool({
			executor: options.executor,
			getCurrentModel: options.getCurrentModel,
			getAvailableModels: options.getAvailableModels,
			resolveApiKey: options.resolveApiKey,
			workspaceDir: options.workspaceDir,
		}),
	];
}
