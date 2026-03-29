import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from "fs";
import { appendFile, writeFile } from "fs/promises";
import { dirname, join } from "path";

export interface LoggedMessage {
	date: string;
	ts: string;
	user: string;
	userName?: string;
	displayName?: string;
	text: string;
	isBot: boolean;
}

export interface ChannelStoreConfig {
	workingDir: string;
}

export class ChannelStore {
	private workingDir: string;
	// Track recently logged message timestamps to prevent duplicates
	private recentlyLogged = new Map<string, number>();

	constructor(config: ChannelStoreConfig) {
		this.workingDir = config.workingDir;

		// Ensure working directory exists
		if (!existsSync(this.workingDir)) {
			mkdirSync(this.workingDir, { recursive: true });
		}
	}

	/**
	 * Get or create the directory for a channel/DM
	 */
	getChannelDir(channelId: string): string {
		const dir = join(this.workingDir, channelId);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		return dir;
	}

	/**
	 * Log a message to the channel's log.jsonl
	 * Returns false if message was already logged (duplicate)
	 */
	async logMessage(channelId: string, message: LoggedMessage): Promise<boolean> {
		// Check for duplicate (same channel + timestamp)
		const dedupeKey = `${channelId}:${message.ts}`;
		if (this.recentlyLogged.has(dedupeKey)) {
			return false; // Already logged
		}

		// Mark as logged and schedule cleanup after 60 seconds
		this.recentlyLogged.set(dedupeKey, Date.now());
		setTimeout(() => this.recentlyLogged.delete(dedupeKey), 60000);

		const logPath = join(this.getChannelDir(channelId), "log.jsonl");

		// Rotate if file exceeds size limit
		this.rotateIfNeeded(logPath);

		// Ensure message has a date field
		if (!message.date) {
			message.date = new Date().toISOString();
		}

		const line = `${JSON.stringify(message)}\n`;
		await appendFile(logPath, line, "utf-8");
		return true;
	}

	/**
	 * Rotate log file if it exceeds 1MB.
	 * Keeps one backup (log.jsonl.1) and resets the sync offset.
	 */
	private rotateIfNeeded(logPath: string): void {
		try {
			if (!existsSync(logPath)) return;
			const stats = statSync(logPath);
			if (stats.size > 1_000_000) {
				renameSync(logPath, `${logPath}.1`);
				// Reset sync offset since log.jsonl was replaced
				const syncOffsetPath = join(dirname(logPath), ".sync-offset");
				try {
					writeFile(syncOffsetPath, "0", "utf-8").catch(() => {});
				} catch {
					/* ignore */
				}
			}
		} catch {
			// Ignore rotation errors
		}
	}

	/**
	 * Log a bot response
	 */
	async logBotResponse(channelId: string, text: string, ts: string): Promise<void> {
		await this.logMessage(channelId, {
			date: new Date().toISOString(),
			ts,
			user: "bot",
			text,
			isBot: true,
		});
	}

	/**
	 * Get the timestamp of the last logged message for a channel
	 * Returns null if no log exists
	 */
	getLastTimestamp(channelId: string): string | null {
		const logPath = join(this.workingDir, channelId, "log.jsonl");
		if (!existsSync(logPath)) {
			return null;
		}

		try {
			const content = readFileSync(logPath, "utf-8");
			const lines = content.trim().split("\n");
			if (lines.length === 0 || lines[0] === "") {
				return null;
			}
			const lastLine = lines[lines.length - 1];
			const message = JSON.parse(lastLine) as LoggedMessage;
			return message.ts;
		} catch {
			return null;
		}
	}
}
