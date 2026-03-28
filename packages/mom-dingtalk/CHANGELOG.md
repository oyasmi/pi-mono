# Changelog

## [Unreleased]

### Added

- Initial implementation of mom-dingtalk package
- Memory management guidelines in system prompt
- MEMORY.md size warning (> 5000 chars prompts Agent to consolidate)
- log.jsonl rotation (> 1MB archived to .1)
- Periodic memory consolidation event template in README

### Changed

- `syncLogToSessionManager` uses byte-offset incremental reads instead of full file scan
- `syncLogToSessionManager` uses timestamp-based dedup instead of text matching (fixes duplicate-text-drop bug)
- Shared `shellEscape` utility replaces 4 duplicated definitions
- `attachTool` uses factory function instead of module-level global state
- Debug file (`last_prompt.json`) gated behind `MOM_DEBUG` env var
- Markdown detection regex is more conservative (no longer triggers on plain multi-line text)
- DingTalk reconnection logic auto-retries with exponential backoff on failure
- Message dedup uses `Set` with FIFO eviction instead of `O(n)` array scan
- Replaced inline `await import("axios")` with top-level import
