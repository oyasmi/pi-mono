/**
 * DingTalk communication layer using dingtalk-stream SDK with AI Card streaming.
 *
 * Handles:
 * - Receiving messages via DingTalk Stream Mode (DWClient)
 * - Responding via AI Card (streaming) or plain markdown (fallback)
 * - Access token management
 * - Per-channel message queuing
 */

import { DWClient, type DWClientDownStream, type RobotMessage, TOPIC_ROBOT } from "dingtalk-stream";
import * as log from "./log.js";

// ============================================================================
// Types
// ============================================================================

export interface DingTalkConfig {
	clientId: string;
	clientSecret: string;
	robotCode?: string;
	cardTemplateId?: string;
	cardTemplateKey?: string;
	allowFrom?: string[];
}

export interface DingTalkEvent {
	type: "dm" | "group";
	channelId: string; // dm_{staffId} or group_{conversationId}
	ts: string;
	user: string; // sender staff id
	userName: string; // sender nickname
	text: string;
	conversationId: string;
	conversationType: string; // "1" = DM, "2" = group
}

export interface DingTalkContext {
	message: {
		text: string;
		rawText: string;
		user: string;
		userName?: string;
		channel: string;
		ts: string;
	};
	channelName?: string;
	respond: (text: string, shouldLog?: boolean) => Promise<void>;
	replaceMessage: (text: string) => Promise<void>;
	respondInThread: (text: string) => Promise<void>;
	setTyping: (isTyping: boolean) => Promise<void>;
	setWorking: (working: boolean) => Promise<void>;
	deleteMessage: () => Promise<void>;
}

export interface DingTalkHandler {
	isRunning(channelId: string): boolean;
	handleEvent(event: DingTalkEvent, bot: DingTalkBot, isEvent?: boolean): Promise<void>;
	handleStop(channelId: string, bot: DingTalkBot): Promise<void>;
}

// ============================================================================
// AI Card State
// ============================================================================

interface AICard {
	instanceId: string;
	conversationId: string;
	accessToken: string;
	templateKey: string;
	createdAt: number;
	lastUpdated: number;
	content: string;
	finished: boolean;
}

// ============================================================================
// Per-channel queue for sequential processing
// ============================================================================

type QueuedWork = () => Promise<void>;

class ChannelQueue {
	private queue: QueuedWork[] = [];
	private processing = false;

	enqueue(work: QueuedWork): void {
		this.queue.push(work);
		this.processNext();
	}

	size(): number {
		return this.queue.length;
	}

	private async processNext(): Promise<void> {
		if (this.processing || this.queue.length === 0) return;
		this.processing = true;
		const work = this.queue.shift()!;
		try {
			await work();
		} catch (err) {
			log.logWarning("Queue error", err instanceof Error ? err.message : String(err));
		}
		this.processing = false;
		this.processNext();
	}
}

// ============================================================================
// Constants
// ============================================================================

const DINGTALK_API = "https://api.dingtalk.com";
const TOKEN_REFRESH_SECS = 90 * 60; // 1.5 hours (tokens expire after 2 hours)

// ============================================================================
// DingTalkBot
// ============================================================================

export class DingTalkBot {
	private handler: DingTalkHandler;
	private config: DingTalkConfig;

	// Access token cache
	private accessToken: string | null = null;
	private tokenExpiry = 0;

	// Active AI cards: channelId → AICard
	private activeCards = new Map<string, AICard>();

	// Conversation metadata cache: channelId → metadata
	private convMeta = new Map<string, { conversationId: string; conversationType: string; senderId: string }>();

	// Per-channel queues
	private queues = new Map<string, ChannelQueue>();

	constructor(handler: DingTalkHandler, config: DingTalkConfig) {
		this.handler = handler;
		this.config = config;
	}

	// ==========================================================================
	// Public API
	// ==========================================================================

	async start(): Promise<void> {
		if (!this.config.clientId || !this.config.clientSecret) {
			log.logWarning("DingTalk: clientId / clientSecret not configured");
			return;
		}

		if (!this.config.cardTemplateId) {
			log.logWarning("DingTalk: cardTemplateId not configured — AI Card streaming will not work");
		}

		log.logInfo(`DingTalk: initializing stream (clientId=${this.config.clientId.substring(0, 8)}…)`);

		const client = new DWClient({
			clientId: this.config.clientId,
			clientSecret: this.config.clientSecret,
		});

		// Register message handler
		client.registerCallbackListener(TOPIC_ROBOT, (msg: DWClientDownStream) => {
			try {
				const data: RobotMessage = typeof msg.data === "string" ? JSON.parse(msg.data) : msg.data;
				// Fire-and-forget async processing
				this.onStreamMessage(data).catch((err: unknown) => {
					log.logWarning("DingTalk handler error", err instanceof Error ? err.message : String(err));
				});
			} catch (err) {
				log.logWarning("DingTalk: failed to parse message", err instanceof Error ? err.message : String(err));
			}

			// ACK the message to prevent 60-second server-side retry.
			// The SDK's onCallback only emits the event but does NOT send an ACK
			// back to the server automatically (unlike onEvent). Without this,
			// the server will re-deliver the same message after ~60 seconds.
			client.socketCallBackResponse(msg.headers.messageId, { status: "SUCCESS", message: "OK" });

			return { status: "SUCCESS" as const, message: "OK" };
		});

		log.logConnected();

		// Connect (will reconnect automatically by default)
		await client.connect();
	}

	/**
	 * Enqueue an event for processing.
	 * Returns true if enqueued, false if queue is full (max 5).
	 */
	enqueueEvent(event: DingTalkEvent): boolean {
		const queue = this.getQueue(event.channelId);
		if (queue.size() >= 5) {
			log.logWarning(`Event queue full for ${event.channelId}, discarding: ${event.text.substring(0, 50)}`);
			return false;
		}
		log.logInfo(`Enqueueing event for ${event.channelId}: ${event.text.substring(0, 50)}`);
		queue.enqueue(() => this.handler.handleEvent(event, this, true));
		return true;
	}

	// ==========================================================================
	// AI Card operations
	// ==========================================================================

	/**
	 * Get or create an AI Card for a channel.
	 */
	async ensureCard(channelId: string): Promise<void> {
		if (!this.config.cardTemplateId) return;
		const existing = this.activeCards.get(channelId);
		if (existing && !existing.finished) return;
		await this.createCard(channelId);
	}

	/**
	 * Stream content to the active AI Card for a channel.
	 */
	async streamToCard(channelId: string, content: string, finalize: boolean = false): Promise<boolean> {
		const card = this.activeCards.get(channelId);
		if (!card || card.finished) {
			if (finalize) {
				await this.sendPlain(channelId, content);
			}
			return false;
		}
		return this.streamCard(card, content, finalize);
	}

	/**
	 * Finalize and remove the active card for a channel.
	 */
	async finalizeCard(channelId: string, content: string): Promise<void> {
		const card = this.activeCards.get(channelId);
		if (card && !card.finished) {
			await this.streamCard(card, content, true);
			this.activeCards.delete(channelId);
		} else {
			await this.sendPlain(channelId, content);
		}
	}

	/**
	 * Send a plain markdown message (fallback when no card).
	 */
	async sendPlain(channelId: string, text: string): Promise<void> {
		const token = await this.getAccessToken();
		if (!token) return;

		const meta = this.convMeta.get(channelId);
		if (!meta) {
			log.logWarning(`No conversation metadata for ${channelId}, cannot send plain message`);
			return;
		}

		const robotCode = this.config.robotCode || this.config.clientId;

		try {
			const resp = await fetch(`${DINGTALK_API}/v1.0/robot/oToMessages/batchSend`, {
				method: "POST",
				headers: {
					"x-acs-dingtalk-access-token": token,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					robotCode,
					userIds: [meta.senderId],
					msgKey: "sampleMarkdown",
					msgParam: JSON.stringify({ text, title: "Bot" }),
				}),
			});

			if (!resp.ok) {
				const body = await resp.text();
				log.logWarning(`DingTalk plain send failed (${resp.status})`, body);
			}
		} catch (err) {
			log.logWarning("DingTalk plain send error", err instanceof Error ? err.message : String(err));
		}
	}

	// ==========================================================================
	// Private - AI Card implementation
	// ==========================================================================

	private async createCard(channelId: string): Promise<AICard | null> {
		const token = await this.getAccessToken();
		if (!token) return null;

		const meta = this.convMeta.get(channelId);
		if (!meta) {
			log.logWarning(`No conversation metadata for ${channelId}, cannot create card`);
			return null;
		}

		const isGroup = meta.conversationType === "2";
		const instanceId = `card_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
		const robotCode = this.config.robotCode || this.config.clientId;

		// openSpaceId format:
		//   群聊: dtv1.card//IM_GROUP.{openConversationId}
		//   单聊: dtv1.card//IM_ROBOT.{userId}
		const openSpaceId = isGroup
			? `dtv1.card//IM_GROUP.${meta.conversationId}`
			: `dtv1.card//IM_ROBOT.${meta.senderId}`;

		const body: Record<string, unknown> = {
			cardTemplateId: this.config.cardTemplateId,
			outTrackId: instanceId,
			cardData: { cardParamMap: {} },
			callbackType: "STREAM",
			imGroupOpenSpaceModel: { supportForward: true },
			imRobotOpenSpaceModel: { supportForward: true },
			openSpaceId,
			userIdType: 1,
		};

		if (isGroup) {
			body.imGroupOpenDeliverModel = { robotCode };
		} else {
			body.imRobotOpenDeliverModel = { spaceType: "IM_ROBOT" };
		}

		try {
			const resp = await fetch(`${DINGTALK_API}/v1.0/card/instances/createAndDeliver`, {
				method: "POST",
				headers: {
					"x-acs-dingtalk-access-token": token,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			});

			if (!resp.ok) {
				const respBody = await resp.text();
				log.logWarning(`DingTalk Card: create failed (${resp.status})`, respBody);
				return null;
			}
		} catch (err) {
			log.logWarning("DingTalk Card: create failed", err instanceof Error ? err.message : String(err));
			return null;
		}

		const card: AICard = {
			instanceId,
			conversationId: meta.conversationId,
			accessToken: token,
			templateKey: this.config.cardTemplateKey || "content",
			createdAt: Date.now() / 1000,
			lastUpdated: Date.now() / 1000,
			content: "",
			finished: false,
		};
		this.activeCards.set(channelId, card);
		return card;
	}

	private async streamCard(card: AICard, content: string, finalize: boolean = false): Promise<boolean> {
		// Refresh token if needed
		const ageSecs = Date.now() / 1000 - card.createdAt;
		if (ageSecs > TOKEN_REFRESH_SECS) {
			const token = await this.getAccessToken();
			if (token) {
				card.accessToken = token;
			}
		}

		const body = {
			outTrackId: card.instanceId,
			guid: `${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
			key: card.templateKey,
			content,
			isFull: true,
			isFinalize: finalize,
			isError: false,
		};

		try {
			const resp = await fetch(`${DINGTALK_API}/v1.0/card/streaming`, {
				method: "PUT",
				headers: {
					"x-acs-dingtalk-access-token": card.accessToken,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
			});

			if (!resp.ok) {
				const respBody = await resp.text();
				log.logWarning(`DingTalk Card: streaming failed (${resp.status})`, respBody);
				return false;
			}

			card.lastUpdated = Date.now() / 1000;
			card.content = content;
			if (finalize) {
				card.finished = true;
			}
			return true;
		} catch (err) {
			log.logWarning("DingTalk Card: streaming failed", err instanceof Error ? err.message : String(err));
			return false;
		}
	}

	// ==========================================================================
	// Private - Access Token
	// ==========================================================================

	private async getAccessToken(): Promise<string | null> {
		if (this.accessToken && Date.now() / 1000 < this.tokenExpiry) {
			return this.accessToken;
		}

		try {
			const resp = await fetch(`${DINGTALK_API}/v1.0/oauth2/accessToken`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					appKey: this.config.clientId,
					appSecret: this.config.clientSecret,
				}),
			});

			if (!resp.ok) {
				const body = await resp.text();
				log.logWarning(`DingTalk: failed to get access token (${resp.status})`, body);
				return null;
			}

			const data = (await resp.json()) as { accessToken?: string; expireIn?: number };
			this.accessToken = data.accessToken || null;
			this.tokenExpiry = Date.now() / 1000 + (data.expireIn || 7200) - 60;
			return this.accessToken;
		} catch (err) {
			log.logWarning("DingTalk: failed to get access token", err instanceof Error ? err.message : String(err));
			return null;
		}
	}

	// ==========================================================================
	// Private - Message handling
	// ==========================================================================

	private extractContent(data: RobotMessage): string {
		// 1. text 类型消息：从 text.content 提取
		const textContent = (data.text?.content || "").trim();
		if (textContent) return textContent;

		// 2. richText 类型消息：从 content.richText 列表提取文本片段
		// TS SDK 没有 richText 类型定义，需要绕过类型系统
		// 实际 JSON 结构: { msgtype: "richText", content: { richText: [{ text: "..." }, ...] } }
		const raw = data as unknown as Record<string, unknown>;
		const contentObj = raw.content as { richText?: Array<Record<string, string>> } | undefined;
		if (contentObj?.richText) {
			const parts: string[] = [];
			for (const item of contentObj.richText) {
				if (item.text) parts.push(item.text);
			}
			const joined = parts.join("").trim();
			if (joined) return joined;
		}

		return "";
	}

	private async onStreamMessage(data: RobotMessage): Promise<void> {
		const content = this.extractContent(data);
		const senderId = data.senderStaffId || data.senderId || "";
		const senderName = data.senderNick || "Unknown";
		const conversationId = data.conversationId || "";
		const conversationType = data.conversationType || "1";

		if (!content) {
			const msgtype = (data as unknown as Record<string, unknown>).msgtype || "unknown";
			log.logWarning(`DingTalk: empty message (type=${msgtype})`);
			return;
		}

		if (this.config.allowFrom && this.config.allowFrom.length > 0) {
			if (!this.config.allowFrom.includes(senderId)) {
				log.logWarning(`DingTalk: ignoring message from unauthorized user ${senderName} (${senderId})`);
				return;
			}
		}

		// Determine channel ID
		const channelId = conversationType === "2" ? `group_${conversationId}` : `dm_${senderId}`;

		log.logInfo(`DingTalk ← ${senderName} (${senderId}) [${channelId}]: ${content.substring(0, 80)}`);

		// Cache conversation metadata for card creation
		this.convMeta.set(channelId, {
			conversationId,
			conversationType,
			senderId,
		});

		// Pre-create AI card if configured
		if (this.config.cardTemplateId) {
			const existing = this.activeCards.get(channelId);
			if (!existing || existing.finished) {
				await this.createCard(channelId);
			}
		}

		// Build event
		const event: DingTalkEvent = {
			type: conversationType === "2" ? "group" : "dm",
			channelId,
			ts: Date.now().toString(),
			user: senderId,
			userName: senderName,
			text: content,
			conversationId,
			conversationType,
		};

		// Check for stop command
		if (content.toLowerCase().trim() === "stop") {
			if (this.handler.isRunning(channelId)) {
				this.handler.handleStop(channelId, this);
			}
			return;
		}

		// Check if busy
		if (this.handler.isRunning(channelId)) {
			const busyMsg = "正在处理中，请稍候。发送 `stop` 可取消当前任务。";
			await this.sendPlain(channelId, busyMsg);
			return;
		}

		// Enqueue for processing
		this.getQueue(channelId).enqueue(() => this.handler.handleEvent(event, this));
	}

	private getQueue(channelId: string): ChannelQueue {
		let queue = this.queues.get(channelId);
		if (!queue) {
			queue = new ChannelQueue();
			this.queues.set(channelId, queue);
		}
		return queue;
	}
}
