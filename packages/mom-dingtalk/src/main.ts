#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { type AgentRunner, getOrCreateRunner } from "./agent.js";
import {
	DingTalkBot,
	type DingTalkConfig,
	type DingTalkContext,
	type DingTalkEvent,
	type DingTalkHandler,
} from "./dingtalk.js";
import { createEventsWatcher } from "./events.js";
import * as log from "./log.js";
import { parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";
import { ChannelStore } from "./store.js";

// ============================================================================
// Global Network Setup
// ============================================================================

// Clear system-wide proxy settings at the process level to ensure Node's native fetch
// and other libraries (like axios) don't try to use an unreachable proxy.
if (process.env.DINGTALK_FORCE_PROXY !== "true") {
	delete process.env.http_proxy;
	delete process.env.https_proxy;
	delete process.env.all_proxy;
	delete process.env.HTTP_PROXY;
	delete process.env.HTTPS_PROXY;
	delete process.env.ALL_PROXY;
}

// ============================================================================
// Config
// ============================================================================

interface DingTalkAppConfig extends DingTalkConfig {
	// All fields from DingTalkConfig plus any future additions
}

function loadConfig(): DingTalkAppConfig {
	const configPath = join(homedir(), ".pi", "mom-dingtalk", "config.json");

	if (!existsSync(configPath)) {
		console.error(`Config file not found: ${configPath}`);
		console.error("");
		console.error("Create it with:");
		console.error(`  mkdir -p ~/.pi/mom-dingtalk`);
		console.error(`  cat > ${configPath} << 'EOF'`);
		console.error(`  {`);
		console.error(`    "clientId": "your-app-key",`);
		console.error(`    "clientSecret": "your-app-secret",`);
		console.error(`    "robotCode": "your-robot-code",`);
		console.error(`    "cardTemplateId": "your-card-template-id",`);
		console.error(`    "cardTemplateKey": "content",`);
		console.error(`    "allowFrom": ["user-id-1"]`);
		console.error(`  }`);
		console.error(`  EOF`);
		process.exit(1);
	}

	try {
		const content = readFileSync(configPath, "utf-8");
		const config = JSON.parse(content) as DingTalkAppConfig;

		if (!config.clientId || !config.clientSecret) {
			console.error("Config file missing required fields: clientId, clientSecret");
			process.exit(1);
		}

		// Set defaults
		config.cardTemplateKey = config.cardTemplateKey || "content";

		return config;
	} catch (err) {
		console.error(`Failed to parse config file: ${configPath}`);
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}

// ============================================================================
// CLI Arguments
// ============================================================================

interface ParsedArgs {
	sandbox: SandboxConfig;
}

function parseArgs(): ParsedArgs {
	const args = process.argv.slice(2);
	let sandbox: SandboxConfig = { type: "host" };

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--sandbox=")) {
			sandbox = parseSandboxArg(arg.slice("--sandbox=".length));
		} else if (arg === "--sandbox") {
			sandbox = parseSandboxArg(args[++i] || "");
		} else if (arg === "--help" || arg === "-h") {
			console.log("Usage: mom-dingtalk [options]");
			console.log("");
			console.log("Options:");
			console.log("  --sandbox=host              Run tools on host (default)");
			console.log("  --sandbox=docker:<name>     Run tools in Docker container");
			console.log("");
			console.log("Config:    ~/.pi/mom-dingtalk/config.json");
			console.log("Workspace: ~/.pi/mom-dingtalk/workspace/");
			process.exit(0);
		}
	}

	return { sandbox };
}

const parsedArgs = parseArgs();
const sandbox = parsedArgs.sandbox;

// Fixed workspace directory
const workingDir = join(homedir(), ".pi", "mom-dingtalk", "workspace");

// ============================================================================
// Workspace Initialization
// ============================================================================

const DEFAULT_SOUL = `# DingTalk Bot

你是一个友好、专业的钉钉机器人助手。

## 性格特点
- 简洁高效：回答直接、清晰，避免冗余
- 专业可靠：提供准确的信息和建议
- 乐于助人：主动帮助解决问题
- 使用中文：默认使用中文交流

## 沟通风格
- 使用 Markdown 格式化输出
- 代码块使用正确的语言标识
- 适当使用 emoji 增加可读性
`;

const DEFAULT_AGENT = `# Agent 行为指令

## 工具使用
- 优先使用 bash 工具执行命令
- 文件操作使用 read/write/edit 工具
- 安装软件前先检查是否已安装

## 安全规则
- 不执行危险的系统命令（如 rm -rf /）
- 不修改系统关键配置文件
- 不暴露敏感信息（密码、密钥等）
`;

const DEFAULT_MEMORY = `# 工作记忆

（尚无记录）
`;

function initializeWorkspace(workDir: string): void {
	// Create workspace directory
	if (!existsSync(workDir)) {
		mkdirSync(workDir, { recursive: true });
		console.log(`Created workspace: ${workDir}`);
	}

	// Create subdirectories
	const dirs = ["skills", "events"];
	for (const dir of dirs) {
		const dirPath = join(workDir, dir);
		if (!existsSync(dirPath)) {
			mkdirSync(dirPath, { recursive: true });
		}
	}

	// Create default files (only if they don't exist)
	const defaults: Array<[string, string]> = [
		["SOUL.md", DEFAULT_SOUL],
		["AGENT.md", DEFAULT_AGENT],
		["MEMORY.md", DEFAULT_MEMORY],
	];

	let created = false;
	for (const [filename, content] of defaults) {
		const filePath = join(workDir, filename);
		if (!existsSync(filePath)) {
			writeFileSync(filePath, content, "utf-8");
			console.log(`  Created ${filename}`);
			created = true;
		}
	}

	if (created) {
		console.log("Workspace initialized with default files.");
	}
}

// Initialize workspace
await initializeWorkspace(workingDir);

// Load DingTalk config from file
const dingtalkConfig = loadConfig();

await validateSandbox(sandbox);

// ============================================================================
// State (per channel)
// ============================================================================

interface ChannelState {
	running: boolean;
	runner: AgentRunner;
	store: ChannelStore;
	stopRequested: boolean;
}

const channelStates = new Map<string, ChannelState>();

function getState(channelId: string): ChannelState {
	let state = channelStates.get(channelId);
	if (!state) {
		const channelDir = join(workingDir, channelId);
		state = {
			running: false,
			runner: getOrCreateRunner(sandbox, channelId, channelDir),
			store: new ChannelStore({ workingDir }),
			stopRequested: false,
		};
		channelStates.set(channelId, state);
	}
	return state;
}

// ============================================================================
// Create DingTalkContext adapter
// ============================================================================

function createDingTalkContext(
	event: DingTalkEvent,
	bot: DingTalkBot,
	state: ChannelState,
	_isEvent?: boolean,
): DingTalkContext {
	let accumulatedText = "";
	let lastSentTime = 0;
	let updateInProgress = false;
	let pendingUpdate = false;
	let isFinalized = false;
	let finalizeFallsBackToPlain = true;

	const MIN_UPDATE_INTERVAL = 800; // ms between DingTalk API calls

	const triggerUpdate = async (options?: { finalize?: boolean; fallbackToPlain?: boolean }) => {
		if (options?.finalize) {
			isFinalized = true;
			finalizeFallsBackToPlain = options.fallbackToPlain ?? true;
		}

		// If a request is already running, just record that we need to update again later.
		if (updateInProgress) {
			pendingUpdate = true;
			return;
		}

		const now = Date.now();
		const timeSinceLast = now - lastSentTime;

		// Throttling: if it's too soon for a regular update, schedule one.
		// Finalization (isFinalized) always proceeds or is picked up by the next run.
		if (!isFinalized && timeSinceLast < MIN_UPDATE_INTERVAL) {
			if (!pendingUpdate) {
				pendingUpdate = true;
				const delay = MIN_UPDATE_INTERVAL - timeSinceLast;
				setTimeout(() => triggerUpdate(), delay);
			}
			return;
		}

		updateInProgress = true;
		pendingUpdate = false;
		lastSentTime = Date.now();

		try {
			// Always send the latest accumulated text.
			// If isFinalized was set (even by a parallel call that set the flag), we use finalizeCard.
			if (isFinalized) {
				if (finalizeFallsBackToPlain) {
					await bot.finalizeCard(event.channelId, accumulatedText);
				} else {
					await bot.finalizeExistingCard(event.channelId, accumulatedText);
				}
			} else {
				await bot.streamToCard(event.channelId, accumulatedText);
			}
		} catch (err) {
			log.logWarning(`[${event.channelId}] Card update failed`, String(err));
		} finally {
			updateInProgress = false;
			// CRITICAL FIX: If more text arrived OR finalization was requested while we were busy,
			// trigger the next update immediately.
			if (pendingUpdate) {
				triggerUpdate();
			}
		}
	};

	return {
		message: {
			text: event.text,
			rawText: event.text,
			user: event.user,
			userName: event.userName,
			channel: event.channelId,
			ts: event.ts,
		},
		channelName: event.channelId,

		respond: async (text: string, shouldLog = true) => {
			if (isFinalized) return;
			accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;

			if (shouldLog) {
				state.store.logBotResponse(event.channelId, text, Date.now().toString());
			}

			// For ordinary respond, we use the Card
			triggerUpdate().catch(() => {});
		},

		respondPlain: async (text: string, shouldLog = true) => {
			if (isFinalized) return;

			if (shouldLog) {
				state.store.logBotResponse(event.channelId, text, Date.now().toString());
			}

			// For Plain respond, we send direct markdown message
			// and then finalize the existing card with process-only content.
			await bot.sendPlain(event.channelId, text);
			await triggerUpdate({ finalize: true, fallbackToPlain: false });
		},

		replaceMessage: async (text: string) => {
			if (isFinalized) {
				return;
			}
			accumulatedText = text;
			await triggerUpdate({ finalize: true, fallbackToPlain: true });
		},

		respondInThread: async (text: string) => {
			log.logInfo(`[thread] ${text.substring(0, 200)}`);
		},

		setTyping: async (_isTyping: boolean) => {},

		setWorking: async (_working: boolean) => {},

		deleteMessage: async () => {
			isFinalized = true;
		},
	};
}

// ============================================================================
// Handler
// ============================================================================

const handler: DingTalkHandler = {
	isRunning(channelId: string): boolean {
		const state = channelStates.get(channelId);
		return state?.running ?? false;
	},

	async handleStop(channelId: string, _bot: DingTalkBot): Promise<void> {
		const state = channelStates.get(channelId);
		if (state?.running) {
			state.stopRequested = true;
			state.runner.abort();
			log.logInfo(`[${channelId}] Stop requested`);
		}
	},

	async handleEvent(event: DingTalkEvent, bot: DingTalkBot, isEvent?: boolean): Promise<void> {
		const state = getState(event.channelId);

		state.running = true;
		state.stopRequested = false;

		// Log user message to log.jsonl
		state.store.logMessage(event.channelId, {
			date: new Date().toISOString(),
			ts: event.ts,
			user: event.user,
			userName: event.userName,
			text: event.text,
			isBot: false,
		});

		log.logInfo(`[${event.channelId}] Starting run: ${event.text.substring(0, 50)}`);

		try {
			const ctx = createDingTalkContext(event, bot, state, isEvent);

			const result = await state.runner.run(ctx, state.store);

			if (result.stopReason === "aborted" && state.stopRequested) {
				log.logInfo(`[${event.channelId}] Stopped`);
			}
		} catch (err) {
			log.logWarning(`[${event.channelId}] Run error`, err instanceof Error ? err.message : String(err));
		} finally {
			state.running = false;
		}
	},
};

// ============================================================================
// Start
// ============================================================================

log.logStartup(workingDir, sandbox.type === "host" ? "host" : `docker:${sandbox.container}`);

// Ensure working directory exists
if (!existsSync(workingDir)) {
	mkdirSync(workingDir, { recursive: true });
}

const bot = new DingTalkBot(handler, dingtalkConfig);

// Start events watcher
const eventsWatcher = createEventsWatcher(workingDir, bot);
eventsWatcher.start();

// Handle shutdown
process.on("SIGINT", () => {
	log.logInfo("Shutting down...");
	eventsWatcher.stop();
	process.exit(0);
});

process.on("SIGTERM", () => {
	log.logInfo("Shutting down...");
	eventsWatcher.stop();
	process.exit(0);
});

// Start the bot (blocks)
bot.start();
