import { Agent } from "@mariozechner/pi-agent-core";
import { type Api, getModel, type Model } from "@mariozechner/pi-ai";
import {
	AgentSession,
	AuthStorage,
	convertToLlm,
	DefaultResourceLoader,
	formatSkillsForPrompt,
	loadSkillsFromDir,
	ModelRegistry,
	SessionManager,
	type Skill,
} from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { homedir } from "os";
import { basename, join } from "path";
import { type BuiltInCommand, renderBuiltInHelp } from "./commands.js";
import { MomSettingsManager, syncLogToSessionManager } from "./context.js";
import type { DingTalkContext } from "./dingtalk.js";
import * as log from "./log.js";
import { createExecutor, type SandboxConfig } from "./sandbox.js";
import type { ChannelStore } from "./store.js";
import { createMomTools } from "./tools/index.js";

// Default model - will be overridden by ModelRegistry if custom models are configured
const defaultModel = getModel("anthropic", "claude-sonnet-4-5");

export interface AgentRunner {
	run(ctx: DingTalkContext, store: ChannelStore): Promise<{ stopReason: string; errorMessage?: string }>;
	handleBuiltinCommand(ctx: DingTalkContext, command: BuiltInCommand): Promise<void>;
	abort(): void;
}

type FinalOutcome = { kind: "none" } | { kind: "silent" } | { kind: "final"; text: string };

function isSilentOutcome(outcome: FinalOutcome): outcome is { kind: "silent" } {
	return outcome.kind === "silent";
}

function isFinalOutcome(outcome: FinalOutcome): outcome is { kind: "final"; text: string } {
	return outcome.kind === "final";
}

function getFinalOutcomeText(outcome: FinalOutcome): string | null {
	return isFinalOutcome(outcome) ? outcome.text : null;
}

function formatModelReference(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function findExactModelReferenceMatch(
	modelReference: string,
	availableModels: Model<Api>[],
): { match?: Model<Api>; ambiguous: boolean } {
	const trimmedReference = modelReference.trim();
	if (!trimmedReference) {
		return { ambiguous: false };
	}

	const normalizedReference = trimmedReference.toLowerCase();

	const canonicalMatches = availableModels.filter(
		(model) => `${model.provider}/${model.id}`.toLowerCase() === normalizedReference,
	);
	if (canonicalMatches.length === 1) {
		return { match: canonicalMatches[0], ambiguous: false };
	}
	if (canonicalMatches.length > 1) {
		return { ambiguous: true };
	}

	const slashIndex = trimmedReference.indexOf("/");
	if (slashIndex !== -1) {
		const provider = trimmedReference.substring(0, slashIndex).trim();
		const modelId = trimmedReference.substring(slashIndex + 1).trim();
		if (provider && modelId) {
			const providerMatches = availableModels.filter(
				(model) =>
					model.provider.toLowerCase() === provider.toLowerCase() &&
					model.id.toLowerCase() === modelId.toLowerCase(),
			);
			if (providerMatches.length === 1) {
				return { match: providerMatches[0], ambiguous: false };
			}
			if (providerMatches.length > 1) {
				return { ambiguous: true };
			}
		}
	}

	const idMatches = availableModels.filter((model) => model.id.toLowerCase() === normalizedReference);
	if (idMatches.length === 1) {
		return { match: idMatches[0], ambiguous: false };
	}

	return { ambiguous: idMatches.length > 1 };
}

function formatModelList(models: Model<Api>[], currentModel: Model<Api> | undefined, limit: number = 20): string {
	const refs = models
		.slice()
		.sort((a, b) => formatModelReference(a).localeCompare(formatModelReference(b)))
		.map((model) => {
			const ref = formatModelReference(model);
			const marker =
				currentModel && currentModel.provider === model.provider && currentModel.id === model.id
					? " (current)"
					: "";
			return `- \`${ref}\`${marker}`;
		});

	if (refs.length <= limit) {
		return refs.join("\n");
	}

	return `${refs.slice(0, limit).join("\n")}\n- ... and ${refs.length - limit} more`;
}

async function getApiKeyForModel(modelRegistry: ModelRegistry, model: any): Promise<string> {
	const key = await modelRegistry.getApiKeyForProvider(model.provider);
	if (key) return key;
	// Fallback: try anthropic env var
	const envKey = process.env.ANTHROPIC_API_KEY;
	if (envKey) return envKey;
	throw new Error(
		`No API key found for provider: ${model.provider}.\n\n` +
			"Configure API key in ~/.pi/agent/models.json or set ANTHROPIC_API_KEY environment variable.",
	);
}

// ============================================================================
// Configuration file loaders: SOUL.md, AGENT.md, MEMORY.md
// ============================================================================

/**
 * Load SOUL.md — defines the agent's identity, personality, and communication style.
 * Only loaded from workspace root (global).
 */
function getSoul(workspaceDir: string): string {
	const soulPath = join(workspaceDir, "SOUL.md");
	if (existsSync(soulPath)) {
		try {
			const content = readFileSync(soulPath, "utf-8").trim();
			if (content) return content;
		} catch (error) {
			log.logWarning("Failed to read SOUL.md", `${soulPath}: ${error}`);
		}
	}
	return "";
}

/**
 * Load AGENT.md — defines the agent's behavior instructions, capabilities, and constraints.
 * Supports both global (workspace root) and channel-level override.
 */
function getAgentConfig(channelDir: string): string {
	const parts: string[] = [];

	// Read workspace-level AGENT.md (global)
	const workspaceAgentPath = join(channelDir, "..", "AGENT.md");
	if (existsSync(workspaceAgentPath)) {
		try {
			const content = readFileSync(workspaceAgentPath, "utf-8").trim();
			if (content) {
				parts.push(content);
			}
		} catch (error) {
			log.logWarning("Failed to read workspace AGENT.md", `${workspaceAgentPath}: ${error}`);
		}
	}

	// Read channel-specific AGENT.md (overrides/extends global)
	const channelAgentPath = join(channelDir, "AGENT.md");
	if (existsSync(channelAgentPath)) {
		try {
			const content = readFileSync(channelAgentPath, "utf-8").trim();
			if (content) {
				parts.push(content);
			}
		} catch (error) {
			log.logWarning("Failed to read channel AGENT.md", `${channelAgentPath}: ${error}`);
		}
	}

	return parts.join("\n\n");
}

function getMemory(channelDir: string): string {
	const parts: string[] = [];

	// Read workspace-level memory (shared across all channels)
	const workspaceMemoryPath = join(channelDir, "..", "MEMORY.md");
	if (existsSync(workspaceMemoryPath)) {
		try {
			const content = readFileSync(workspaceMemoryPath, "utf-8").trim();
			if (content) {
				parts.push(`### Global Workspace Memory\n${content}`);
			}
		} catch (error) {
			log.logWarning("Failed to read workspace memory", `${workspaceMemoryPath}: ${error}`);
		}
	}

	// Read channel-specific memory
	const channelMemoryPath = join(channelDir, "MEMORY.md");
	if (existsSync(channelMemoryPath)) {
		try {
			const content = readFileSync(channelMemoryPath, "utf-8").trim();
			if (content) {
				parts.push(`### Channel-Specific Memory\n${content}`);
			}
		} catch (error) {
			log.logWarning("Failed to read channel memory", `${channelMemoryPath}: ${error}`);
		}
	}

	if (parts.length === 0) {
		return "(no working memory yet)";
	}

	const combined = parts.join("\n\n");

	// Warn if memory is getting too large (consumes system prompt token budget)
	if (combined.length > 5000) {
		return `\u26a0\ufe0f Memory is large (${combined.length} chars). Consolidate: remove outdated entries, merge duplicates, tighten descriptions.\n\n${combined}`;
	}

	return combined;
}

function loadMomSkills(channelDir: string, workspacePath: string): Skill[] {
	const skillMap = new Map<string, Skill>();
	const hostWorkspacePath = join(channelDir, "..");

	const translatePath = (hostPath: string): string => {
		if (hostPath.startsWith(hostWorkspacePath)) {
			return workspacePath + hostPath.slice(hostWorkspacePath.length);
		}
		return hostPath;
	};

	// Load workspace-level skills (global)
	const workspaceSkillsDir = join(hostWorkspacePath, "skills");
	for (const skill of loadSkillsFromDir({ dir: workspaceSkillsDir, source: "workspace" }).skills) {
		skill.filePath = translatePath(skill.filePath);
		skill.baseDir = translatePath(skill.baseDir);
		skillMap.set(skill.name, skill);
	}

	// Load channel-specific skills
	const channelSkillsDir = join(channelDir, "skills");
	for (const skill of loadSkillsFromDir({ dir: channelSkillsDir, source: "channel" }).skills) {
		skill.filePath = translatePath(skill.filePath);
		skill.baseDir = translatePath(skill.baseDir);
		skillMap.set(skill.name, skill);
	}

	return Array.from(skillMap.values());
}

// ============================================================================
// System Prompt Builder
// ============================================================================

function buildSystemPrompt(
	workspacePath: string,
	channelId: string,
	soul: string,
	agentConfig: string,
	memory: string,
	sandboxConfig: SandboxConfig,
	skills: Skill[],
): string {
	const channelPath = `${workspacePath}/${channelId}`;
	const isDocker = sandboxConfig.type === "docker";

	const envDescription = isDocker
		? `You are running inside a Docker container (Alpine Linux).
- Bash working directory: / (use cd or absolute paths)
- Install tools with: apk add <package>
- Your changes persist across sessions`
		: `You are running directly on the host machine.
- Bash working directory: ${process.cwd()}
- Be careful with system modifications`;

	// Build system prompt with configuration file layering:
	// 1. SOUL.md (identity/personality)
	// 2. Core instructions
	// 3. AGENT.md (behavior instructions)
	// 4. Skills, Events, Memory

	const sections: string[] = [];

	// 1. SOUL.md — Agent identity
	if (soul) {
		sections.push(soul);
	} else {
		sections.push("You are a DingTalk bot assistant. Be concise and helpful.");
	}

	// 2. Core instructions
	sections.push(`## Context
- For current date/time, use: date
- You have access to previous conversation context including tool results from prior turns.
- For older history beyond your context, search log.jsonl (contains user messages and your final responses, but not tool results).

## Formatting
Use Markdown for formatting. DingTalk AI Card supports basic Markdown:
Bold: **text**, Italic: *text*, Code: \`code\`, Block: \`\`\`code\`\`\`, Links: [text](url)

## Environment
${envDescription}

## Workspace Layout
${workspacePath}/
├── SOUL.md                      # Your identity/personality (read-only)
├── AGENT.md                     # Custom behavior instructions (read-only)
├── MEMORY.md                    # Global memory (all channels, you can read/write)
├── skills/                      # Global CLI tools you create
├── events/                      # Scheduled events
└── ${channelId}/                # This channel
    ├── AGENT.md                 # Channel-specific instructions (read-only)
    ├── MEMORY.md                # Channel-specific memory (you can read/write)
    ├── log.jsonl                # Message history (no tool results)
    ├── scratch/                 # Your working directory
    └── skills/                  # Channel-specific tools`);

	// 3. AGENT.md — User-defined instructions
	if (agentConfig) {
		sections.push(`## Agent Instructions\n${agentConfig}`);
	}

	// 4. Skills
	sections.push(`## Skills (Custom CLI Tools)
You can create reusable CLI tools for recurring tasks (email, APIs, data processing, etc.).

### Creating Skills
Store in \`${workspacePath}/skills/<name>/\` (global) or \`${channelPath}/skills/<name>/\` (channel-specific).
Each skill directory needs a \`SKILL.md\` with YAML frontmatter:

\`\`\`markdown
---
name: skill-name
description: Short description of what this skill does
---

# Skill Name

Usage instructions, examples, etc.
Scripts are in: {baseDir}/
\`\`\`

\`name\` and \`description\` are required. Use \`{baseDir}\` as placeholder for the skill's directory path.

### Available Skills
${skills.length > 0 ? formatSkillsForPrompt(skills) : "(no skills installed yet)"}`);

	// 5. Events
	sections.push(`## Events
You can schedule events that wake you up at specific times or when external things happen. Events are JSON files in \`${workspacePath}/events/\`.

### Event Types

**Immediate** - Triggers as soon as harness sees the file.
\`\`\`json
{"type": "immediate", "channelId": "${channelId}", "text": "New event occurred"}
\`\`\`

**One-shot** - Triggers once at a specific time.
\`\`\`json
{"type": "one-shot", "channelId": "${channelId}", "text": "Reminder", "at": "2025-12-15T09:00:00+08:00"}
\`\`\`

**Periodic** - Triggers on a cron schedule.
\`\`\`json
{"type": "periodic", "channelId": "${channelId}", "text": "Check inbox", "schedule": "0 9 * * 1-5", "timezone": "${Intl.DateTimeFormat().resolvedOptions().timeZone}"}
\`\`\`

### Cron Format
\`minute hour day-of-month month day-of-week\`

### Creating Events
\`\`\`bash
cat > ${workspacePath}/events/reminder-$(date +%s).json << 'EOF'
{"type": "one-shot", "channelId": "${channelId}", "text": "Reminder text", "at": "2025-12-14T09:00:00+08:00"}
EOF
\`\`\`

### Silent Completion
For periodic events where there's nothing to report, respond with just \`[SILENT]\`. This deletes the status message. Use this to avoid spam when periodic checks find nothing.

### Limits
Maximum 5 events can be queued.`);

	// 6. Memory
	sections.push(`## Memory
Write to MEMORY.md files to persist context across conversations.
- Global (${workspacePath}/MEMORY.md): skills, preferences, project info
- Channel (${channelPath}/MEMORY.md): channel-specific decisions, ongoing work

### Guidelines
- Keep each MEMORY.md concise (target: under 50 lines)
- Use clear headers to organize entries (## Preferences, ## Projects, etc.)
- Remove outdated entries when they are no longer relevant
- Merge duplicate or redundant items
- Prefer structured formats (lists, key-value pairs) over prose
- Update when you learn something important or when asked to remember something

### Current Memory
${memory}`);

	// 7. System Configuration Log
	sections.push(`## System Configuration Log
Maintain ${workspacePath}/SYSTEM.md to log all environment modifications:
- Installed packages (apk add, npm install, pip install)
- Environment variables set
- Config files modified
- Skill dependencies installed

Update this file whenever you modify the environment.`);

	// 8. Tools
	sections.push(`## Tools
- bash: Run shell commands (primary tool). Install packages as needed.
- read: Read files
- write: Create/overwrite files
- edit: Surgical file edits
- attach: Share files (note: DingTalk file sharing is limited, output as text when possible)

Each tool requires a "label" parameter (shown to user).`);

	// 9. Log Queries
	sections.push(`## Log Queries (for older history)
Format: \`{"date":"...","ts":"...","user":"...","userName":"...","text":"...","isBot":false}\`
The log contains user messages and your final responses (not tool calls/results).
${isDocker ? "Install jq: apk add jq" : ""}

\`\`\`bash
# Recent messages
tail -30 log.jsonl | jq -c '{date: .date[0:19], user: (.userName // .user), text}'

# Search for specific topic
grep -i "topic" log.jsonl | jq -c '{date: .date[0:19], user: (.userName // .user), text}'
\`\`\``);

	return sections.join("\n\n");
}

// ============================================================================
// Agent Runner
// ============================================================================

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.substring(0, maxLen - 3)}...`;
}

function extractToolResultText(result: unknown): string {
	if (typeof result === "string") {
		return result;
	}

	if (
		result &&
		typeof result === "object" &&
		"content" in result &&
		Array.isArray((result as { content: unknown }).content)
	) {
		const content = (result as { content: Array<{ type: string; text?: string }> }).content;
		const textParts: string[] = [];
		for (const part of content) {
			if (part.type === "text" && part.text) {
				textParts.push(part.text);
			}
		}
		if (textParts.length > 0) {
			return textParts.join("\n");
		}
	}

	return JSON.stringify(result);
}

// Cache runners per channel
const channelRunners = new Map<string, AgentRunner>();

export function getOrCreateRunner(sandboxConfig: SandboxConfig, channelId: string, channelDir: string): AgentRunner {
	const existing = channelRunners.get(channelId);
	if (existing) return existing;

	const runner = createRunner(sandboxConfig, channelId, channelDir);
	channelRunners.set(channelId, runner);
	return runner;
}

function createRunner(sandboxConfig: SandboxConfig, channelId: string, channelDir: string): AgentRunner {
	const executor = createExecutor(sandboxConfig);
	const workspacePath = executor.getWorkspacePath(channelDir.replace(`/${channelId}`, ""));
	const workspaceDir = join(channelDir, "..");
	const momAgentDir = join(homedir(), ".pi", "mom-dingtalk");

	// Create tools
	const tools = createMomTools(executor);

	// Initial system prompt
	const soul = getSoul(workspaceDir);
	const agentConfig = getAgentConfig(channelDir);
	const memory = getMemory(channelDir);
	const initialSkills = loadMomSkills(channelDir, workspacePath);
	let currentSkills = initialSkills;
	const systemPrompt = buildSystemPrompt(
		workspacePath,
		channelId,
		soul,
		agentConfig,
		memory,
		sandboxConfig,
		initialSkills,
	);

	// Create session manager
	const contextFile = join(channelDir, "context.jsonl");
	const sessionManager = SessionManager.open(contextFile, channelDir);
	const settingsManager = new MomSettingsManager(workspaceDir);

	// Create AuthStorage and ModelRegistry
	const authStorage = AuthStorage.create(join(momAgentDir, "auth.json"));
	const modelRegistry = new ModelRegistry(authStorage, join(momAgentDir, "models.json"));

	// Resolve model: prefer available custom models, fall back to default
	const availableModels = modelRegistry.getAvailable();
	let activeModel: Model<Api>;
	if (availableModels.length > 0) {
		activeModel = availableModels[0];
		log.logInfo(`Using model: ${activeModel.provider}/${activeModel.id} (${activeModel.name})`);
	} else {
		activeModel = defaultModel;
		log.logInfo(`Using default model: ${activeModel.provider}/${activeModel.id}`);
	}

	// Create agent
	const agent = new Agent({
		initialState: {
			systemPrompt,
			model: activeModel,
			thinkingLevel: "off",
			tools,
		},
		convertToLlm,
		getApiKey: async () => getApiKeyForModel(modelRegistry, activeModel),
	});

	// Load existing messages
	const loadedSession = sessionManager.buildSessionContext();
	if (loadedSession.messages.length > 0) {
		agent.replaceMessages(loadedSession.messages);
		log.logInfo(`[${channelId}] Loaded ${loadedSession.messages.length} messages from context.jsonl`);
	}

	const resourceLoader = new DefaultResourceLoader({
		cwd: process.cwd(),
		agentDir: momAgentDir,
		settingsManager: settingsManager as any,
		skillsOverride: (base) => ({
			skills: [...base.skills, ...currentSkills],
			diagnostics: base.diagnostics,
		}),
	});

	const baseToolsOverride = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

	// Create AgentSession
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager: settingsManager as any,
		cwd: process.cwd(),
		modelRegistry,
		resourceLoader,
		baseToolsOverride,
	});

	// Mutable per-run state
	const runState: {
		ctx: DingTalkContext | null;
		logCtx: { channelId: string; userName?: string; channelName?: string } | null;
		queue: {
			enqueue(fn: () => Promise<void>, errorContext: string): void;
			enqueueMessage(text: string, target: "main" | "thread", errorContext: string, doLog?: boolean): void;
		} | null;
		pendingTools: Map<string, { toolName: string; args: unknown; startTime: number }>;
		totalUsage: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
		};
		stopReason: string;
		errorMessage: string | undefined;
		finalOutcome: FinalOutcome;
		finalResponseDelivered: boolean;
	} = {
		ctx: null as DingTalkContext | null,
		logCtx: null as { channelId: string; userName?: string; channelName?: string } | null,
		queue: null as {
			enqueue(fn: () => Promise<void>, errorContext: string): void;
			enqueueMessage(text: string, target: "main" | "thread", errorContext: string, doLog?: boolean): void;
		} | null,
		pendingTools: new Map<string, { toolName: string; args: unknown; startTime: number }>(),
		totalUsage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		errorMessage: undefined as string | undefined,
		finalOutcome: { kind: "none" },
		finalResponseDelivered: false,
	};

	const sendCommandReply = async (ctx: DingTalkContext, text: string): Promise<void> => {
		const delivered = await ctx.respondPlain(text);
		if (!delivered) {
			await ctx.replaceMessage(text);
			await ctx.flush();
		}
	};

	const handleModelBuiltinCommand = async (ctx: DingTalkContext, args: string): Promise<void> => {
		modelRegistry.refresh();
		const availableModels = await modelRegistry.getAvailable();
		const currentModel = session.model;

		if (!args.trim()) {
			const current = currentModel ? `\`${formatModelReference(currentModel)}\`` : "(none)";
			const available = availableModels.length > 0 ? formatModelList(availableModels, currentModel) : "- (none)";
			await sendCommandReply(
				ctx,
				`# Model

Current model: ${current}

Use \`/model <provider/modelId>\` or \`/model <modelId>\` to switch. Bare model IDs must resolve uniquely.

Available models:
${available}`,
			);
			return;
		}

		const match = findExactModelReferenceMatch(args, availableModels);
		if (match.match) {
			await session.setModel(match.match);
			activeModel = match.match;
			await sendCommandReply(ctx, `已切换模型到 \`${formatModelReference(match.match)}\`。`);
			return;
		}

		const available = availableModels.length > 0 ? formatModelList(availableModels, currentModel, 10) : "- (none)";
		if (match.ambiguous) {
			await sendCommandReply(
				ctx,
				`未切换模型：\`${args.trim()}\` 匹配到多个模型。请改用精确的 \`provider/modelId\` 形式。

Available models:
${available}`,
			);
			return;
		}

		await sendCommandReply(
			ctx,
			`未找到模型 \`${args.trim()}\`。请使用精确的 \`provider/modelId\` 或唯一的 \`modelId\`。

Available models:
${available}`,
		);
	};

	const handleBuiltInCommand = async (ctx: DingTalkContext, command: BuiltInCommand): Promise<void> => {
		try {
			switch (command.name) {
				case "help":
					await sendCommandReply(ctx, renderBuiltInHelp());
					return;
				case "new": {
					const completed = await session.newSession();
					await sendCommandReply(
						ctx,
						completed
							? `已开启新会话。

Session ID: \`${session.sessionId}\``
							: "新会话已取消。",
					);
					return;
				}
				case "compact": {
					const result = await session.compact(command.args || undefined);
					await sendCommandReply(
						ctx,
						`已压缩当前会话上下文。

- Tokens before compaction: \`${result.tokensBefore}\`
- Summary:

\`\`\`text
${result.summary}
\`\`\``,
					);
					return;
				}
				case "session": {
					const stats = session.getSessionStats();
					const currentModel = session.model ? `\`${formatModelReference(session.model)}\`` : "(none)";
					const sessionFile = stats.sessionFile ? `\`${basename(stats.sessionFile)}\`` : "(none)";
					await sendCommandReply(
						ctx,
						`# Session

- Session ID: \`${stats.sessionId}\`
- Session file: ${sessionFile}
- Model: ${currentModel}
- Thinking level: \`${session.thinkingLevel}\`
- User messages: \`${stats.userMessages}\`
- Assistant messages: \`${stats.assistantMessages}\`
- Tool calls: \`${stats.toolCalls}\`
- Tool results: \`${stats.toolResults}\`
- Total messages: \`${stats.totalMessages}\`
- Tokens: \`${stats.tokens.total}\` (input \`${stats.tokens.input}\`, output \`${stats.tokens.output}\`, cache read \`${stats.tokens.cacheRead}\`, cache write \`${stats.tokens.cacheWrite}\`)
- Cost: \`$${stats.cost.toFixed(4)}\``,
					);
					return;
				}
				case "model":
					await handleModelBuiltinCommand(ctx, command.args);
					return;
			}
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			log.logWarning(`[${channelId}] Built-in command failed`, errMsg);
			await sendCommandReply(ctx, `命令执行失败：${errMsg}`);
		}
	};

	// Subscribe to events ONCE
	session.subscribe(async (event: any) => {
		if (!runState.ctx || !runState.logCtx || !runState.queue) return;

		const { ctx, logCtx, queue, pendingTools } = runState;

		if (event.type === "tool_execution_start") {
			const agentEvent = event as any & { type: "tool_execution_start" };
			const args = agentEvent.args as { label?: string };
			const label = args.label || agentEvent.toolName;

			pendingTools.set(agentEvent.toolCallId, {
				toolName: agentEvent.toolName,
				args: agentEvent.args,
				startTime: Date.now(),
			});

			log.logToolStart(logCtx, agentEvent.toolName, label, agentEvent.args as Record<string, unknown>);
			queue.enqueue(() => ctx.respond(`_→ ${label}_`, false), "tool label");
		} else if (event.type === "tool_execution_end") {
			const agentEvent = event as any & { type: "tool_execution_end" };
			const resultStr = extractToolResultText(agentEvent.result);
			const pending = pendingTools.get(agentEvent.toolCallId);
			pendingTools.delete(agentEvent.toolCallId);

			const durationMs = pending ? Date.now() - pending.startTime : 0;

			if (agentEvent.isError) {
				log.logToolError(logCtx, agentEvent.toolName, durationMs, resultStr);
			} else {
				log.logToolSuccess(logCtx, agentEvent.toolName, durationMs, resultStr);
			}

			if (agentEvent.isError) {
				queue.enqueue(() => ctx.respond(`_Error: ${truncate(resultStr, 200)}_`, false), "tool error");
			}
		} else if (event.type === "message_start") {
			const agentEvent = event as any & { type: "message_start" };
			if (agentEvent.message.role === "assistant") {
				log.logResponseStart(logCtx);
			}
		} else if (event.type === "message_end") {
			const agentEvent = event as any & { type: "message_end" };
			if (agentEvent.message.role === "assistant") {
				const assistantMsg = agentEvent.message as any;

				if (assistantMsg.stopReason) {
					runState.stopReason = assistantMsg.stopReason;
				}
				if (assistantMsg.errorMessage) {
					runState.errorMessage = assistantMsg.errorMessage;
				}

				if (assistantMsg.usage) {
					runState.totalUsage.input += assistantMsg.usage.input;
					runState.totalUsage.output += assistantMsg.usage.output;
					runState.totalUsage.cacheRead += assistantMsg.usage.cacheRead;
					runState.totalUsage.cacheWrite += assistantMsg.usage.cacheWrite;
					runState.totalUsage.cost.input += assistantMsg.usage.cost.input;
					runState.totalUsage.cost.output += assistantMsg.usage.cost.output;
					runState.totalUsage.cost.cacheRead += assistantMsg.usage.cost.cacheRead;
					runState.totalUsage.cost.cacheWrite += assistantMsg.usage.cost.cacheWrite;
					runState.totalUsage.cost.total += assistantMsg.usage.cost.total;
				}

				const content = agentEvent.message.content;
				const thinkingParts: string[] = [];
				const textParts: string[] = [];
				let hasToolCalls = false;
				for (const part of content) {
					if (part.type === "thinking") {
						thinkingParts.push((part as any).thinking);
					} else if (part.type === "text") {
						textParts.push((part as any).text);
					} else if (part.type === "toolCall") {
						hasToolCalls = true;
					}
				}

				const text = textParts.join("\n");

				for (const thinking of thinkingParts) {
					log.logThinking(logCtx, thinking);
					queue.enqueue(() => ctx.respond(`_💭 ${thinking}_`, false), "thinking");
				}

				if (hasToolCalls && text.trim()) {
					queue.enqueue(() => ctx.respond(text, false), "assistant progress");
				}
			}
		} else if (event.type === "turn_end") {
			const turnEvent = event as any & {
				type: "turn_end";
				message: { role: string; stopReason?: string; content: Array<{ type: string; text?: string }> };
				toolResults: unknown[];
			};
			if (turnEvent.message.role === "assistant" && turnEvent.toolResults.length === 0) {
				if (turnEvent.message.stopReason === "error" || turnEvent.message.stopReason === "aborted") {
					return;
				}

				const finalContent = turnEvent.message.content as Array<{ type: string; text?: string }>;
				const finalText = finalContent
					.filter((part): part is { type: "text"; text: string } => part.type === "text" && !!part.text)
					.map((part) => part.text)
					.join("\n");

				const trimmedFinalText = finalText.trim();
				if (!trimmedFinalText) {
					return;
				}

				if (trimmedFinalText === "[SILENT]" || trimmedFinalText.startsWith("[SILENT]")) {
					runState.finalOutcome = { kind: "silent" };
					return;
				}

				if (runState.finalOutcome.kind === "final" && runState.finalOutcome.text.trim() === trimmedFinalText) {
					return;
				}

				runState.finalOutcome = { kind: "final", text: finalText };
				log.logResponse(logCtx, finalText);
				queue.enqueue(async () => {
					const delivered = await ctx.respondPlain(finalText);
					if (delivered) {
						runState.finalResponseDelivered = true;
					}
				}, "final response");
			}
		} else if (event.type === "auto_compaction_start") {
			log.logInfo(`Auto-compaction started (reason: ${(event as any).reason})`);
			queue.enqueue(() => ctx.respond("_Compacting context..._", false), "compaction start");
		} else if (event.type === "auto_compaction_end") {
			const compEvent = event as any;
			if (compEvent.result) {
				log.logInfo(`Auto-compaction complete: ${compEvent.result.tokensBefore} tokens compacted`);
			} else if (compEvent.aborted) {
				log.logInfo("Auto-compaction aborted");
			}
		} else if (event.type === "auto_retry_start") {
			const retryEvent = event as any;
			log.logWarning(`Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})`, retryEvent.errorMessage);
			queue.enqueue(
				() => ctx.respond(`_Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})..._`, false),
				"retry",
			);
		}
	});

	return {
		async handleBuiltinCommand(ctx: DingTalkContext, command: BuiltInCommand): Promise<void> {
			await handleBuiltInCommand(ctx, command);
		},

		async run(ctx: DingTalkContext, _store: ChannelStore): Promise<{ stopReason: string; errorMessage?: string }> {
			// Reset per-run state
			runState.ctx = ctx;
			runState.logCtx = {
				channelId: ctx.message.channel,
				userName: ctx.message.userName,
				channelName: ctx.channelName,
			};
			runState.pendingTools.clear();
			runState.totalUsage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			runState.stopReason = "stop";
			runState.errorMessage = undefined;
			runState.finalOutcome = { kind: "none" };
			runState.finalResponseDelivered = false;

			// Create queue for this run
			let queueChain = Promise.resolve();
			runState.queue = {
				enqueue(fn: () => Promise<void>, errorContext: string): void {
					queueChain = queueChain.then(async () => {
						try {
							await fn();
						} catch (err) {
							const errMsg = err instanceof Error ? err.message : String(err);
							log.logWarning(`DingTalk API error (${errorContext})`, errMsg);
						}
					});
				},
				enqueueMessage(text: string, target: "main" | "thread", errorContext: string, doLog = true): void {
					this.enqueue(
						() => (target === "main" ? ctx.respond(text, doLog) : ctx.respondInThread(text)),
						errorContext,
					);
				},
			};

			try {
				// Ensure channel directory exists
				await mkdir(channelDir, { recursive: true });

				// Update system prompt and runtime resources with fresh config
				const soul = getSoul(workspaceDir);
				const agentConfig = getAgentConfig(channelDir);
				const memory = getMemory(channelDir);
				const skills = loadMomSkills(channelDir, workspacePath);
				currentSkills = skills;
				const systemPrompt = buildSystemPrompt(
					workspacePath,
					channelId,
					soul,
					agentConfig,
					memory,
					sandboxConfig,
					skills,
				);
				session.agent.setSystemPrompt(systemPrompt);
				await session.reload();

				// Sync messages from log.jsonl
				const syncedCount = syncLogToSessionManager(sessionManager, channelDir, ctx.message.ts);
				if (syncedCount > 0) {
					log.logInfo(`[${channelId}] Synced ${syncedCount} messages from log.jsonl`);
				}

				// Reload messages from context.jsonl
				const reloadedSession = sessionManager.buildSessionContext();
				if (reloadedSession.messages.length > 0) {
					agent.replaceMessages(reloadedSession.messages);
					log.logInfo(`[${channelId}] Reloaded ${reloadedSession.messages.length} messages from context`);
				}

				// Log context info
				log.logInfo(`Context sizes - system: ${systemPrompt.length} chars, memory: ${memory.length} chars`);

				// Build user message with timestamp and username prefix
				const now = new Date();
				const pad = (n: number) => n.toString().padStart(2, "0");
				const offset = -now.getTimezoneOffset();
				const offsetSign = offset >= 0 ? "+" : "-";
				const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
				const offsetMins = pad(Math.abs(offset) % 60);
				const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offsetSign}${offsetHours}:${offsetMins}`;
				const userMessage = `[${timestamp}] [${ctx.message.userName || "unknown"}]: ${ctx.message.text}`;

				// Debug: write context to last_prompt.jsonl (only with MOM_DEBUG=1)
				if (process.env.MOM_DEBUG) {
					const debugContext = {
						systemPrompt,
						messages: session.messages,
						newUserMessage: userMessage,
					};
					await writeFile(join(channelDir, "last_prompt.json"), JSON.stringify(debugContext, null, 2));
				}

				await session.prompt(userMessage);
			} catch (err) {
				runState.stopReason = "error";
				runState.errorMessage = err instanceof Error ? err.message : String(err);
				log.logWarning(`[${channelId}] Runner failed`, runState.errorMessage);
			} finally {
				await queueChain;
				const finalOutcome = runState.finalOutcome;
				const finalOutcomeText = getFinalOutcomeText(finalOutcome);

				try {
					if (runState.stopReason === "error" && runState.errorMessage && !runState.finalResponseDelivered) {
						try {
							await ctx.replaceMessage("_Sorry, something went wrong_");
						} catch (err) {
							const errMsg = err instanceof Error ? err.message : String(err);
							log.logWarning("Failed to post error message", errMsg);
						}
					} else if (isSilentOutcome(finalOutcome)) {
						try {
							await ctx.deleteMessage();
							log.logInfo("Silent response - deleted message");
						} catch (err) {
							const errMsg = err instanceof Error ? err.message : String(err);
							log.logWarning("Failed to delete message for silent response", errMsg);
						}
					} else if (finalOutcomeText && !runState.finalResponseDelivered) {
						try {
							await ctx.replaceMessage(finalOutcomeText);
						} catch (err) {
							const errMsg = err instanceof Error ? err.message : String(err);
							log.logWarning("Failed to replace message with final text", errMsg);
						}
					}

					await ctx.flush();
				} finally {
					await ctx.close();
				}

				// Log usage summary
				if (runState.totalUsage.cost.total > 0) {
					const messages = session.messages;
					const lastAssistantMessage = messages
						.slice()
						.reverse()
						.find((m: any) => m.role === "assistant" && m.stopReason !== "aborted") as any;

					const contextTokens = lastAssistantMessage
						? lastAssistantMessage.usage.input +
							lastAssistantMessage.usage.output +
							lastAssistantMessage.usage.cacheRead +
							lastAssistantMessage.usage.cacheWrite
						: 0;
					const currentRunModel = session.model ?? activeModel;
					const contextWindow = currentRunModel.contextWindow || 200000;

					log.logUsageSummary(runState.logCtx!, runState.totalUsage, contextTokens, contextWindow);
				}

				// Clear run state
				runState.ctx = null;
				runState.logCtx = null;
				runState.queue = null;
			}

			return { stopReason: runState.stopReason, errorMessage: runState.errorMessage };
		},

		abort(): void {
			session.abort();
		},
	};
}

/**
 * Translate container path back to host path for file operations
 */
export function translateToHostPath(
	containerPath: string,
	channelDir: string,
	workspacePath: string,
	channelId: string,
): string {
	if (workspacePath === "/workspace") {
		const prefix = `/workspace/${channelId}/`;
		if (containerPath.startsWith(prefix)) {
			return join(channelDir, containerPath.slice(prefix.length));
		}
		if (containerPath.startsWith("/workspace/")) {
			return join(channelDir, "..", containerPath.slice("/workspace/".length));
		}
	}
	return containerPath;
}
