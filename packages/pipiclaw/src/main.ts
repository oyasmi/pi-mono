#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { type AgentRunner, getOrCreateRunner } from "./agent.js";
import { parseBuiltInCommand } from "./commands.js";
import { createDingTalkContext } from "./delivery.js";
import {
	type BusyMessageMode,
	DingTalkBot,
	type DingTalkConfig,
	type DingTalkEvent,
	type DingTalkHandler,
} from "./dingtalk.js";
import { createEventsWatcher } from "./events.js";
import * as log from "./log.js";
import {
	APP_HOME_DIR,
	APP_NAME,
	AUTH_CONFIG_PATH,
	CHANNEL_CONFIG_PATH,
	MODELS_CONFIG_PATH,
	SETTINGS_CONFIG_PATH,
	WORKSPACE_DIR,
} from "./paths.js";
import { parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";
import { ChannelStore } from "./store.js";

if (process.env.DINGTALK_FORCE_PROXY !== "true") {
	delete process.env.http_proxy;
	delete process.env.https_proxy;
	delete process.env.all_proxy;
	delete process.env.HTTP_PROXY;
	delete process.env.HTTPS_PROXY;
	delete process.env.ALL_PROXY;
}

interface ParsedArgs {
	sandbox: SandboxConfig;
}

interface BootstrapResult {
	created: string[];
	channelTemplateCreated: boolean;
}

const DEFAULT_SOUL = `# SOUL.md

Configure Pipiclaw's identity, voice, and communication style here.

Suggested sections:

- Who the assistant is
- Default language
- Tone and personality
- Reply style
- Formatting preferences

Example topics you may want to define:

- "Answer in Chinese by default."
- "Be concise and direct."
- "Prefer Markdown."
- "Act as an engineering assistant for our team."

Replace this template with your actual identity prompt.
`;

const DEFAULT_AGENT = `# AGENTS.md

Configure Pipiclaw's behavioral rules and operating constraints here.

Suggested sections:

- Tool usage policy
- File access rules
- Security constraints
- Approval rules
- Project-specific workflows
- Things the assistant must always or never do

Example topics you may want to define:

- Which tools should be preferred first
- Whether installation commands are allowed
- How to handle sensitive data
- Coding conventions for your team
- Deployment or release restrictions

Replace this template with your actual operating instructions.
`;

const DEFAULT_MEMORY = `# Workspace Memory

This file is stable workspace-level memory.

- It is intended to be managed by a human administrator.
- Pipiclaw does not automatically rewrite this file during normal memory consolidation.
- Store durable shared background here when it should apply across channels.
`;

const CHANNEL_CONFIG_TEMPLATE = {
	clientId: "your-dingtalk-client-id",
	clientSecret: "your-dingtalk-client-secret",
	robotCode: "your-robot-code",
	cardTemplateId: "your-card-template-id",
	cardTemplateKey: "content",
	allowFrom: ["your-staff-id"],
} satisfies DingTalkConfig;

const MODELS_CONFIG_TEMPLATE = { providers: {} };

function writeTextFileIfMissing(path: string, content: string, label: string, created: string[]): boolean {
	if (existsSync(path)) {
		return false;
	}
	writeFileSync(path, content, "utf-8");
	created.push(label);
	return true;
}

function writeJsonFileIfMissing(path: string, value: unknown, label: string, created: string[]): boolean {
	return writeTextFileIfMissing(path, `${JSON.stringify(value, null, 2)}\n`, label, created);
}

function bootstrapAppHome(): BootstrapResult {
	const created: string[] = [];

	if (!existsSync(APP_HOME_DIR)) {
		mkdirSync(APP_HOME_DIR, { recursive: true });
		created.push("app home");
	}
	if (!existsSync(WORKSPACE_DIR)) {
		mkdirSync(WORKSPACE_DIR, { recursive: true });
		created.push("workspace/");
	}

	for (const dir of ["skills", "events"]) {
		const dirPath = join(WORKSPACE_DIR, dir);
		if (!existsSync(dirPath)) {
			mkdirSync(dirPath, { recursive: true });
			created.push(`workspace/${dir}/`);
		}
	}

	writeTextFileIfMissing(join(WORKSPACE_DIR, "SOUL.md"), DEFAULT_SOUL, "workspace/SOUL.md", created);
	writeTextFileIfMissing(join(WORKSPACE_DIR, "AGENTS.md"), DEFAULT_AGENT, "workspace/AGENTS.md", created);
	writeTextFileIfMissing(join(WORKSPACE_DIR, "MEMORY.md"), DEFAULT_MEMORY, "workspace/MEMORY.md", created);

	const channelTemplateCreated = writeJsonFileIfMissing(
		CHANNEL_CONFIG_PATH,
		CHANNEL_CONFIG_TEMPLATE,
		"channel.json",
		created,
	);
	writeJsonFileIfMissing(AUTH_CONFIG_PATH, {}, "auth.json", created);
	writeJsonFileIfMissing(MODELS_CONFIG_PATH, MODELS_CONFIG_TEMPLATE, "models.json", created);
	writeJsonFileIfMissing(SETTINGS_CONFIG_PATH, {}, "settings.json", created);

	return { created, channelTemplateCreated };
}

function isPlaceholderString(value: string): boolean {
	return value.trim().startsWith("your-");
}

function listChannelConfigIssues(config: Partial<DingTalkConfig>): string[] {
	const issues: string[] = [];

	if (!config.clientId) {
		issues.push("Missing required field `clientId`.");
	} else if (isPlaceholderString(config.clientId)) {
		issues.push("Replace placeholder value for `clientId`.");
	}

	if (!config.clientSecret) {
		issues.push("Missing required field `clientSecret`.");
	} else if (isPlaceholderString(config.clientSecret)) {
		issues.push("Replace placeholder value for `clientSecret`.");
	}

	if (config.robotCode && isPlaceholderString(config.robotCode)) {
		issues.push("Replace placeholder value for `robotCode`, or set it to an empty string to reuse `clientId`.");
	}

	if (config.cardTemplateId && isPlaceholderString(config.cardTemplateId)) {
		issues.push(
			"Replace placeholder value for `cardTemplateId`, or set it to an empty string to disable AI Card streaming.",
		);
	}

	if (Array.isArray(config.allowFrom) && config.allowFrom.some((value) => isPlaceholderString(value))) {
		issues.push("Replace placeholder values in `allowFrom`, or set it to an empty array to allow all users.");
	}

	return issues;
}

function printBootstrapSummary(result: BootstrapResult): void {
	if (result.created.length === 0) {
		return;
	}

	console.log(`Initialized ${APP_NAME} under ${APP_HOME_DIR}:`);
	for (const item of result.created) {
		console.log(`  - ${item}`);
	}
	console.log("");
}

function loadConfig(): DingTalkConfig {
	let parsed: DingTalkConfig;

	try {
		parsed = JSON.parse(readFileSync(CHANNEL_CONFIG_PATH, "utf-8")) as DingTalkConfig;
	} catch (err) {
		console.error(`Failed to parse configuration: ${CHANNEL_CONFIG_PATH}`);
		console.error(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}

	const issues = listChannelConfigIssues(parsed);
	if (issues.length > 0) {
		console.error(`Configuration is not ready: ${CHANNEL_CONFIG_PATH}`);
		for (const issue of issues) {
			console.error(`  - ${issue}`);
		}
		console.error("");
		console.error(`Fill in ${CHANNEL_CONFIG_PATH} and run \`${APP_NAME}\` again.`);
		process.exit(1);
	}

	parsed.cardTemplateKey = parsed.cardTemplateKey || "content";
	parsed.robotCode = parsed.robotCode?.trim() ? parsed.robotCode : parsed.clientId;
	if (Array.isArray(parsed.allowFrom)) {
		parsed.allowFrom = parsed.allowFrom.filter((value) => value.trim().length > 0);
	}

	return parsed;
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
			console.log(`Usage: ${APP_NAME} [options]`);
			console.log("");
			console.log("Options:");
			console.log("  --sandbox=host              Run tools on host (default)");
			console.log("  --sandbox=docker:<name>     Run tools in Docker container");
			console.log("");
			console.log(`Config:    ${CHANNEL_CONFIG_PATH}`);
			console.log(`Workspace: ${WORKSPACE_DIR}`);
			process.exit(0);
		}
	}

	return { sandbox };
}

const parsedArgs = parseArgs();
const sandbox = parsedArgs.sandbox;
const bootstrapResult = bootstrapAppHome();
printBootstrapSummary(bootstrapResult);

if (bootstrapResult.channelTemplateCreated) {
	console.error(`Fill in ${CHANNEL_CONFIG_PATH} and run \`${APP_NAME}\` again.`);
	process.exit(1);
}

const dingtalkConfig = loadConfig();
dingtalkConfig.stateDir = WORKSPACE_DIR;

await validateSandbox(sandbox);

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
		const channelDir = join(WORKSPACE_DIR, channelId);
		state = {
			running: false,
			runner: getOrCreateRunner(sandbox, channelId, channelDir),
			store: new ChannelStore({ workingDir: WORKSPACE_DIR }),
			stopRequested: false,
		};
		channelStates.set(channelId, state);
	}
	return state;
}

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

	async handleBusyMessage(
		event: DingTalkEvent,
		bot: DingTalkBot,
		mode: BusyMessageMode,
		queueText: string,
	): Promise<void> {
		const state = getState(event.channelId);
		const trimmedQueueText = queueText.trim();

		await state.store.logMessage(event.channelId, {
			date: new Date().toISOString(),
			ts: event.ts,
			user: event.user,
			userName: event.userName,
			text: event.text,
			isBot: false,
			deliveryMode: mode,
			skipContextSync: true,
		});

		try {
			if (mode === "followUp") {
				await state.runner.queueFollowUp(trimmedQueueText);
			} else {
				await state.runner.queueSteer(trimmedQueueText);
			}

			const confirmation =
				mode === "followUp"
					? "Queued as follow-up. I’ll handle it after the current task completes."
					: event.text.trim().startsWith("/")
						? "Queued as steer. I’ll apply it after the current tool step finishes."
						: "Queued as steer. I’ll apply this after the current tool step finishes. Use `/followup <message>` to queue it after completion.";
			await bot.sendPlain(event.channelId, confirmation);
			log.logInfo(`[${event.channelId}] Queued ${mode}: ${trimmedQueueText.substring(0, 80)}`);
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			log.logWarning(`[${event.channelId}] Failed to queue ${mode}`, errMsg);
			await bot.sendPlain(event.channelId, `Could not queue this message: ${errMsg}`);
		}
	},

	async handleEvent(event: DingTalkEvent, bot: DingTalkBot, _isEvent?: boolean): Promise<void> {
		const state = getState(event.channelId);

		state.running = true;
		state.stopRequested = false;

		await state.store.logMessage(event.channelId, {
			date: new Date().toISOString(),
			ts: event.ts,
			user: event.user,
			userName: event.userName,
			text: event.text,
			isBot: false,
		});

		try {
			const ctx = createDingTalkContext(event, bot, state.store);
			const builtInCommand = parseBuiltInCommand(event.text);

			if (builtInCommand) {
				log.logInfo(`[${event.channelId}] Executing command: ${builtInCommand.rawText}`);
				await state.runner.handleBuiltinCommand(ctx, builtInCommand);
				return;
			}

			log.logInfo(`[${event.channelId}] Starting run: ${event.text.substring(0, 50)}`);
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

log.logStartup(WORKSPACE_DIR, sandbox.type === "host" ? "host" : `docker:${sandbox.container}`);

if (!existsSync(WORKSPACE_DIR)) {
	mkdirSync(WORKSPACE_DIR, { recursive: true });
}

const bot = new DingTalkBot(handler, dingtalkConfig);
const eventsWatcher = createEventsWatcher(WORKSPACE_DIR, bot);
eventsWatcher.start();

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

bot.start();
