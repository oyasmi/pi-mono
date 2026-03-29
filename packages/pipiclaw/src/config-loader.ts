/**
 * Configuration file loaders for pipiclaw workspace files:
 * SOUL.md, AGENTS.md, MEMORY.md, skills/, and API key resolution.
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import { loadSkillsFromDir, type ModelRegistry, type Skill } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import * as log from "./log.js";

/**
 * Load SOUL.md — defines the agent's identity, personality, and communication style.
 * Only loaded from workspace root (global).
 */
export function getSoul(workspaceDir: string): string {
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
 * Load AGENTS.md — defines the agent's behavior instructions, capabilities, and constraints.
 * Supports both global (workspace root) and channel-level override.
 */
export function getAgentConfig(channelDir: string): string {
	const parts: string[] = [];

	// Read workspace-level AGENTS.md (global)
	const workspaceAgentPath = join(channelDir, "..", "AGENTS.md");
	if (existsSync(workspaceAgentPath)) {
		try {
			const content = readFileSync(workspaceAgentPath, "utf-8").trim();
			if (content) {
				parts.push(content);
			}
		} catch (error) {
			log.logWarning("Failed to read workspace AGENTS.md", `${workspaceAgentPath}: ${error}`);
		}
	}

	// Read channel-specific AGENTS.md (overrides/extends global)
	const channelAgentPath = join(channelDir, "AGENTS.md");
	if (existsSync(channelAgentPath)) {
		try {
			const content = readFileSync(channelAgentPath, "utf-8").trim();
			if (content) {
				parts.push(content);
			}
		} catch (error) {
			log.logWarning("Failed to read channel AGENTS.md", `${channelAgentPath}: ${error}`);
		}
	}

	return parts.join("\n\n");
}

/**
 * Load MEMORY.md — persistent working memory, both global and channel-specific.
 */
export function getMemory(channelDir: string): string {
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

/**
 * Load skills from both workspace-level and channel-level skill directories.
 * Channel-level skills override global skills with the same name.
 */
export function loadPipiclawSkills(channelDir: string, workspacePath: string): Skill[] {
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

/**
 * Resolve an API key for the given model's provider.
 * Checks ModelRegistry first, then falls back to ANTHROPIC_API_KEY env var.
 */
export async function getApiKeyForModel(modelRegistry: ModelRegistry, model: Model<Api>): Promise<string> {
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
