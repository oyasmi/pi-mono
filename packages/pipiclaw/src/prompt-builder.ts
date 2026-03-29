import type { SandboxConfig } from "./sandbox.js";

export function buildAppendSystemPrompt(
	workspacePath: string,
	channelId: string,
	sandboxConfig: SandboxConfig,
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

	const sections: string[] = [];

	sections.push(`## Pipiclaw Runtime
You are running inside Pipiclaw, a DingTalk-oriented runtime built on top of pi.

## Context
- For current date/time, use: date
- You have access to the active session context for this session.
- Raw transcript files are cold storage. Do not assume they are preloaded.

## Formatting
Use Markdown for formatting. DingTalk AI Card supports basic Markdown:
Bold: **text**, Italic: *text*, Code: \`code\`, Block: \`\`\`code\`\`\`, Links: [text](url)

## Environment
${envDescription}

## Workspace Layout
${workspacePath}/
├── SOUL.md                      # Your identity/personality (read-only)
├── AGENTS.md                    # Custom behavior instructions (read-only)
├── MEMORY.md                    # Stable workspace memory (admin-managed, read on demand)
├── skills/                      # Global CLI tools you create
├── events/                      # Scheduled events
└── ${channelId}/                # This channel
    ├── MEMORY.md                # Channel durable memory (read on demand, runtime-managed)
    ├── HISTORY.md               # Channel summarized history (read on demand, runtime-managed)
    ├── log.jsonl                # Raw message archive (cold storage)
    ├── context.jsonl            # Raw session archive (cold storage)
    ├── scratch/                 # Your working directory
    └── skills/                  # Channel-specific tools`);

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

	sections.push(`## Memory
Memory files are not preloaded into session context. Read them explicitly when memory or history matters.

### Files
- Workspace memory: ${workspacePath}/MEMORY.md
  Stable shared background memory. Admin-managed. Read on demand.
- Channel memory: ${channelPath}/MEMORY.md
  Durable channel memory. Runtime-managed via consolidation. You may update this file manually when necessary.
- Channel history: ${channelPath}/HISTORY.md
  Summarized older channel history. Runtime-managed. Read on demand. Do not maintain this file manually during normal work.

### Runtime Behavior
- The runtime automatically consolidates channel memory before compaction or session trimming.
- Consolidation updates channel MEMORY.md and HISTORY.md.
- Workspace MEMORY.md is not automatically updated by the runtime.

### Cold Storage
- ${channelPath}/log.jsonl is a raw archive. It is not normal memory and is not proactively loaded.
- ${channelPath}/context.jsonl is a raw session archive. It is not normal memory and is not proactively loaded.

When a task depends on prior decisions, preferences, or long-running work, read channel MEMORY.md and HISTORY.md first.`);

	sections.push(`## System Configuration Log
Maintain ${workspacePath}/SYSTEM.md to log all environment modifications:
- Installed packages (apk add, npm install, pip install)
- Environment variables set
- Config files modified
- Skill dependencies installed

Update this file whenever you modify the environment.`);

	sections.push(`## Tools
- bash: Run shell commands (primary tool). Install packages as needed.
- read: Read files
- write: Create/overwrite files
- edit: Surgical file edits

Each tool requires a "label" parameter (shown to user).`);

	return sections.join("\n\n");
}
