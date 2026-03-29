import { formatSkillsForPrompt, type Skill } from "@mariozechner/pi-coding-agent";
import type { SandboxConfig } from "./sandbox.js";

export function buildSystemPrompt(
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
	// 3. AGENTS.md (behavior instructions)
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
├── AGENTS.md                    # Custom behavior instructions (read-only)
├── MEMORY.md                    # Global memory (all channels, you can read/write)
├── skills/                      # Global CLI tools you create
├── events/                      # Scheduled events
└── ${channelId}/                # This channel
    ├── AGENTS.md                # Channel-specific instructions (read-only)
    ├── MEMORY.md                # Channel-specific memory (you can read/write)
    ├── log.jsonl                # Message history (no tool results)
    ├── scratch/                 # Your working directory
    └── skills/                  # Channel-specific tools`);

	// 3. AGENTS.md — User-defined instructions
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
