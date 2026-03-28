export type BuiltInCommandName = "help" | "new" | "compact" | "session" | "model";

export interface BuiltInCommand {
	name: BuiltInCommandName;
	args: string;
	rawText: string;
}

const HELP_TEXT = `# Slash Commands

The following slash commands are supported:

- \`/help\`
  Show command help
  Example: \`/help\`
- \`/new\`
  Start a new session
  Example: \`/new\`
- \`/compact [instructions]\`
  Manually compact the current session context, with optional custom instructions
  Example: \`/compact\`
  Example: \`/compact Keep the latest TODOs and decisions\`
- \`/session\`
  Show current session state, message stats, token usage, and model info
  Example: \`/session\`
- \`/model [provider/modelId|modelId]\`
  Show the current model, or switch models using an exact match
  Example: \`/model\`
  Example: \`/model anthropic/claude-opus-4-6\`
`;

export function parseBuiltInCommand(text: string): BuiltInCommand | null {
	const rawText = text.trim();
	if (!rawText.startsWith("/")) {
		return null;
	}

	const spaceIndex = rawText.indexOf(" ");
	const rawName = spaceIndex === -1 ? rawText.slice(1) : rawText.slice(1, spaceIndex);
	const args = spaceIndex === -1 ? "" : rawText.slice(spaceIndex + 1).trim();

	switch (rawName) {
		case "help":
		case "new":
		case "compact":
		case "session":
		case "model":
			return { name: rawName, args, rawText };
		default:
			return null;
	}
}

export function renderBuiltInHelp(): string {
	return HELP_TEXT;
}
