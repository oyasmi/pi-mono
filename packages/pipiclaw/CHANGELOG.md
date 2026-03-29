# Changelog

## [Unreleased]

### Added

- Initial implementation of pipiclaw package
- Memory management guidelines in system prompt
- MEMORY.md size warning (> 5000 chars prompts Agent to consolidate)
- log.jsonl rotation (> 1MB archived to .1)
- Periodic memory consolidation event template in README
- DingTalk channel now intercepts `/help`, `/new`, `/compact`, `/session`, and `/model` as built-in slash commands instead of sending them to the LLM

### Changed

- `syncLogToSessionManager` uses byte-offset incremental reads instead of full file scan
- `syncLogToSessionManager` uses timestamp-based dedup instead of text matching (fixes duplicate-text-drop bug)
- Shared `shellEscape` utility replaces 4 duplicated definitions
- `attachTool` uses factory function instead of module-level global state
- Debug file (`last_prompt.json`) gated behind `PIPICLAW_DEBUG` env var
- Markdown detection regex is more conservative (no longer triggers on plain multi-line text)
- DingTalk reconnection logic auto-retries with exponential backoff on failure
- Message dedup uses `Set` with FIFO eviction instead of `O(n)` array scan
- Replaced inline `await import("axios")` with top-level import
- Refactored DingTalk delivery into an explicit progress/final lifecycle so AI Cards only show process output and final answers are sent as standalone Markdown messages
- Final answer emission now keys off agent turn completion instead of every assistant `message_end`, avoiding intermediate assistant text being sent as the final reply
- Conversation metadata is persisted per channel so scheduled events and proactive sends continue to work after process restarts
- Package, CLI, and data directory renamed to `pipiclaw`, `@oyasmi/pipiclaw`, and `~/.pi/pipiclaw/`
- Pipiclaw now bootstraps `channel.json`, `auth.json`, `models.json`, `settings.json`, and the workspace skeleton automatically on first start
- Auto-generated `models.json` now starts as an empty valid config, and `SOUL.md` / `AGENT.md` are guidance templates instead of prefilled behavior
- Global pipiclaw settings now live in `~/.pi/pipiclaw/settings.json`, and saved default models are restored on restart
- DingTalk channel configuration is now read from `~/.pi/pipiclaw/channel.json`
