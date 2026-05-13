# TradingView MCP — Claude Instructions

68 tools for reading and controlling a live TradingView Desktop chart via CDP (port 9222).

## 🚨 LAUNCH GOTCHA — read FIRST if tv_health_check fails (Linux snap)

**The `mcp__tradingview__tv_launch` tool invokes the inner binary `/snap/tradingview/current/tradingview` directly. On snap-packaged Linux installs this breaks two things:**

1. **Auth state is NOT loaded** — the wrapper at `/snap/bin/tradingview` (which is a symlink to `/usr/bin/snap`) sets up the snap sandbox env (XDG_RUNTIME_DIR, sandbox cookies path, dbus paths). Inner-binary launch bypasses that → TV opens un-authenticated and shows the "Sign in with browser" dialog. The snap can't spawn the system browser → user stuck.
2. **dbus version mismatch** — TV bundles `libdbus-1.so.3` with `LIBDBUS_PRIVATE_1.12.16` which is missing on newer hosts → TV crashes with "write EPIPE" on first console.debug if launched detached.

### CORRECT launch sequence (Linux snap)

When `tv_launch` fails to reach an authenticated state, OR when CDP port 9222 isn't open, use this instead:

```bash
# 1. Kill any zombie TV processes (no sudo needed — user's own session)
pkill -9 -f "snap/tradingview" 2>/dev/null
sleep 2

# 2. Launch via the SNAP WRAPPER (NOT inner binary) with CDP flag,
#    inside a tmux pane so it inherits the user shell env and doesn't die
#    when the launching process exits.
tmux new-window -t sol: -n tv-launcher
tmux send-keys -t sol:tv-launcher "/snap/bin/tradingview --remote-debugging-port=9222" Enter
# Wait ~6s for TV to open + CDP port to bind.

# 3. Verify:
curl -s --max-time 3 http://localhost:9222/json/version
# Should return JSON with browser version. If not, TV didn't bind CDP yet — wait more.

# 4. Now MCP can attach:
mcp__tradingview__tv_health_check
```

**Why the snap wrapper, not inner binary:** `/snap/bin/tradingview` → `/usr/bin/snap` performs `snap run tradingview` which sets all the snap-sandbox env vars + invokes the inner binary with proper isolation. Without that, auth cookies in `~/snap/tradingview/current/.config/TradingView/` are unreadable.

**Why tmux, not nohup:** when a Bash sub-shell exits, child processes inherit the closed stdout/stderr pipes. TV's first `console.debug` then triggers `write EPIPE` → crash. tmux gives TV a real tty that persists.

### Permanent fix — desktop file override (2026-05-12)

User-level override at `~/.local/share/applications/tradingview_tradingview.desktop` makes the normal app-icon click always include the CDP flag:

```
Exec=/snap/bin/tradingview --remote-debugging-port=9222 %U
```

After write: `update-desktop-database ~/.local/share/applications/` to refresh. The override beats the system-wide snap-installed desktop file at `/var/lib/snapd/desktop/applications/tradingview_tradingview.desktop`. Survives snap updates.

### Don't use this if

- macOS / Windows — different launch paths, `tv_launch` works there.
- User already has TV running and authenticated — just call `tv_health_check`. If port 9222 isn't bound, you still need to relaunch via the snap wrapper.

## 🔗 Companion project — smc-engine

This server is designed to integrate with [prezis/smc-engine](https://github.com/prezis/smc-engine) (PUBLIC, MIT) — the standalone Python SMC (Smart Money Concepts) analytics partner. smc-engine wraps PyIndicators for OB/FVG/BOS/CHoCH detection and emits Pine v6 overlay code that you can deploy to TV via this server's `pine_set_source` + `pine_smart_compile`.

**When working on this codebase, ASK whether smc-engine integration is in scope.** The Phase 1 work (smc-engine ↔ tv-mcp bridge via `src/core/smc-bridge.js` + new MCP tools `smc_analyze`, `smc_render_top`, `smc_rank_assets`) is the planned integration target.

Local clones for context (read-only references):
- `~/ai/smc-engine/` — the SMC analytics module
- `~/ai/smc-engine/DESIGN_NOTES.md` — Phase 1 integration design
- `~/ai/global-graph/projects/smc-engine.md` — full project state + open architecture questions (look for "USER DECISION" block)
- `~/.claude/projects/-home-palyslaf0s/memory/project_smc_engine.md` — hot memory entry

Recall trigger: if user mentions "smc", "smc-engine", or "smart money", read those refs before answering.

## ⚠️ Pine editor — read this BEFORE any pine_* call

**The single most-important doc in this repo:** `docs/PINE_EDITOR_WORKFLOW.md`.

It's the canonical guide on how to drive the Pine editor without overwriting the wrong slot. Written 2026-04-23 after we destroyed an RSI pane slot by skipping the pre-flight check. Covers:

- The mental model (slot vs editor buffer vs indicator title — three things that look the same and aren't)
- Pre-flight checks (always run before any write)
- Decision tree (Edit existing / Create new Indicator / Strategy / Library / Built-in / Read-only / Rename)
- Recipes A–G with step-by-step verified procedures
- Top 10 anti-patterns (do NOT do these)
- Recovery procedure if you DID overwrite the wrong slot

Companion doc: `docs/PINE_EDITOR_GOTCHAS.md` — known failure modes and bugs (the "what NOT to do" list).

If you skip these and call `pine_set_source` blindly, you risk an unrecoverable slot overwrite. The Recipes in WORKFLOW.md take 30 seconds longer per write but cost nothing compared to manual restoration from TV's version history (Pro+ only) or from local repo grep.

## Decision Tree — Which Tool When

### "What's on my chart right now?"
1. `chart_get_state` → symbol, timeframe, chart type, list of all indicators with entity IDs
2. `data_get_study_values` → current numeric values from all visible indicators (RSI, MACD, BBands, EMAs, etc.)
3. `quote_get` → real-time price, OHLC, volume for current symbol

### "What levels/lines/labels are showing?"
Custom Pine indicators draw with `line.new()`, `label.new()`, `table.new()`, `box.new()`. These are invisible to normal data tools. Use:

1. `data_get_pine_lines` → horizontal price levels drawn by indicators (deduplicated, sorted high→low)
2. `data_get_pine_labels` → text annotations with prices (e.g., "PDH 24550", "Bias Long ✓")
3. `data_get_pine_tables` → table data formatted as rows (e.g., session stats, analytics dashboards)
4. `data_get_pine_boxes` → price zones / ranges as {high, low} pairs

Use `study_filter` parameter to target a specific indicator by name substring (e.g., `study_filter: "Profiler"`).

### "Give me price data"
- `data_get_ohlcv` with `summary: true` → compact stats (high, low, range, change%, avg volume, last 5 bars)
- `data_get_ohlcv` without summary → all bars (use `count` to limit, default 100)
- `quote_get` → single latest price snapshot

### "Analyze my chart" (full report workflow)
1. `quote_get` → current price
2. `data_get_study_values` → all indicator readings
3. `data_get_pine_lines` → key price levels from custom indicators
4. `data_get_pine_labels` → labeled levels with context (e.g., "Settlement", "ASN O/U")
5. `data_get_pine_tables` → session stats, analytics tables
6. `data_get_ohlcv` with `summary: true` → price action summary
7. `capture_screenshot` → visual confirmation

### "Change the chart"
- `chart_set_symbol` → switch ticker (e.g., "AAPL", "ES1!", "NYMEX:CL1!")
- `chart_set_timeframe` → switch resolution (e.g., "1", "5", "15", "60", "D", "W")
- `chart_set_type` → switch chart style (Candles, HeikinAshi, Line, Area, Renko, etc.)
- `chart_manage_indicator` → add or remove studies (use full name: "Relative Strength Index", not "RSI")
- `chart_scroll_to_date` → jump to a date (ISO format: "2025-01-15")
- `chart_set_visible_range` → zoom to exact date range (unix timestamps)

### "Work on Pine Script"
1. `pine_set_source` → inject code into editor
2. `pine_smart_compile` → compile with auto-detection + error check
3. `pine_get_errors` → read compilation errors
4. `pine_get_console` → read log.info() output
5. `pine_get_source` → read current code back (WARNING: can be very large for complex scripts)
6. `pine_save` → save to TradingView cloud (Ctrl+S — saves source but does NOT refresh chart instance)
7. **`ui_keyboard {key:"Enter", modifiers:["ctrl"]}` → Ctrl+Enter = "Add to chart" / "Update on chart"** (the canonical TV keyboard shortcut, only reliable automation path — toolbar button DOM is fragile). ALWAYS pair with pine_save to actually deploy code changes.
8. `pine_new` → create blank indicator/strategy/library
9. `pine_open` → load a saved script by name

**Canonical deploy recipe — TWO PATHS** (verified 2026-05-13):

**Path A — file on disk (PREFERRED, single tool call, no token tax):**
```
pine_deploy(pine_path="/abs/path/to/script.pine")
  → returns { success, errors[], preCleaned: {removedCount, removed[]},
              studyAdded, savedAs, unsavedConfirmationDialog }
```
- One tool call: **pre-clean (remove same-title instances)** → open editor → setValue → save (2500ms wait) → handle "Save Script" dialog → click "Add to chart" → handle "Save and add to chart" confirmation dialog → verify.
- **Pre-clean is automatic** — derives the indicator title from `indicator("Title", ...)` line in the source and removes any matching instance from the chart BEFORE adding. Avoids duplicates and the "Update on chart" trap.
- Override the auto-derived title with `preCleanTitleMatch` parameter; pass `""` (empty string) to skip pre-clean entirely.
- Use this for any Pine on disk (repo files, Desktop drag-drops). DO NOT use `pine_set_source` for file-on-disk content — that path embeds 50-100KB of source in the tool call, burning Claude tokens.

**Path B — generated-in-flight source (only when source is computed, not on disk):**
```
pine_get_active_slot → pine_set_source(source=..., expected_script_name=...)
  → pine_smart_compile → ui_keyboard{Ctrl+Enter} → chart_get_state (verify entity_id)
```
- Use only when the source is generated programmatically and isn't worth writing to disk first.
- Always include `expected_script_name` to prevent overwriting the wrong slot.
- Same "Update on chart" trap applies — manually call `pine_remove_study` BEFORE `ui_keyboard{Ctrl+Enter}` if a same-title instance exists.

**Critical ordering rules (2026-05-13 lessons):**

1. **Remove existing instances FIRST, before clicking "Add to chart".** Otherwise TV uses "Update on chart" semantics on the toolbar button, which can either (a) double the indicator when text/version differs, or (b) pop the "Cannot add a script with unsaved changes to chart" confirmation dialog when the prior save raced the add click. `pine_deploy` does this automatically via step 0 (preCleanTitleMatch derived from `indicator()` title).
2. **Wait ≥ 2500ms between saveButton click and "Add to chart" click.** Shorter waits race the save commit and trigger the "Cannot add unsaved" dialog. `pine_deploy` waits 2500ms (was 1200ms before 2026-05-13).
3. **Handle two distinct dialogs after save+add:** (a) "Save Script" rename dialog (only on first save of a new script), (b) "Save and add to chart" confirmation dialog (when the save→add race fires). The current `deployScript` handles both — see steps 5 and 6b.

**Anti-pattern (do NOT repeat 2026-05-13 mistake):** writing a custom Python CDP script to do what `pine_deploy` already does. The MCP exists. Use it.

### "Practice trading with replay"
1. `replay_start` with `date: "2025-03-01"` → enter replay mode
2. `replay_step` → advance one bar
3. `replay_autoplay` → auto-advance (set speed with `speed` param in ms)
4. `replay_trade` with `action: "buy"/"sell"/"close"` → execute trades
5. `replay_status` → check position, P&L, current date
6. `replay_stop` → return to realtime

### "Screen multiple symbols"
- `batch_run` with `symbols: ["ES1!", "NQ1!", "YM1!"]` and `action: "screenshot"` or `"get_ohlcv"`

### "Draw on the chart"
- `draw_shape` → horizontal_line, trend_line, rectangle, text (pass point + optional point2)
- `draw_list` → see what's drawn
- `draw_remove_one` → remove by ID
- `draw_clear` → remove all

### "Manage alerts"
- `alert_create` → set price alert (condition: "crossing", "greater_than", "less_than")
- `alert_list` → view active alerts
- `alert_delete` → remove alerts

### "Navigate the UI"
- `ui_open_panel` → open/close pine-editor, strategy-tester, watchlist, alerts, trading
- `ui_click` → click buttons by aria-label, text, or data-name
- `layout_switch` → load a saved layout by name
- `ui_fullscreen` → toggle fullscreen
- `capture_screenshot` → take a screenshot (regions: "full", "chart", "strategy_tester")

### "TradingView isn't running"
- `tv_launch` → auto-detect and launch TradingView with CDP on Mac/Win/Linux
- `tv_health_check` → verify connection is working

## Context Management Rules

These tools can return large payloads. Follow these rules to avoid context bloat:

1. **Always use `summary: true` on `data_get_ohlcv`** unless you specifically need individual bars
2. **Always use `study_filter`** on pine tools when you know which indicator you want — don't scan all studies unnecessarily
3. **Never use `verbose: true`** on pine tools unless the user specifically asks for raw drawing data with IDs/colors
4. **Avoid calling `pine_get_source`** on complex scripts — it can return 200KB+. Only read if you need to edit the code.
5. **Avoid calling `data_get_indicator`** on protected/encrypted indicators — their inputs are encoded blobs. Use `data_get_study_values` instead for current values.
6. **Use `capture_screenshot`** for visual context instead of pulling large datasets — a screenshot is ~300KB but gives you the full visual picture
7. **Call `chart_get_state` once** at the start to get entity IDs, then reference them — don't re-call repeatedly
8. **Cap your OHLCV requests** — `count: 20` for quick analysis, `count: 100` for deeper work, `count: 500` only when specifically needed

### Output Size Estimates (compact mode)
| Tool | Typical Output |
|------|---------------|
| `quote_get` | ~200 bytes |
| `data_get_study_values` | ~500 bytes (all indicators) |
| `data_get_pine_lines` | ~1-3 KB per study (deduplicated levels) |
| `data_get_pine_labels` | ~2-5 KB per study (capped at 50) |
| `data_get_pine_tables` | ~1-4 KB per study (formatted rows) |
| `data_get_pine_boxes` | ~1-2 KB per study (deduplicated zones) |
| `data_get_ohlcv` (summary) | ~500 bytes |
| `data_get_ohlcv` (100 bars) | ~8 KB |
| `capture_screenshot` | ~300 bytes (returns file path, not image data) |

## Tool Conventions

- All tools return `{ success: true/false, ... }`
- Entity IDs (from `chart_get_state`) are session-specific — don't cache across sessions
- Pine indicators must be **visible** on chart for pine graphics tools to read their data
- `chart_manage_indicator` requires **full indicator names**: "Relative Strength Index" not "RSI", "Moving Average Exponential" not "EMA", "Bollinger Bands" not "BB"
- Screenshots save to `screenshots/` directory with timestamps
- OHLCV capped at 500 bars, trades at 20 per request
- Pine labels capped at 50 per study by default (pass `max_labels` to override)

## Architecture

```
Claude Code ←→ MCP Server (stdio) ←→ CDP (localhost:9222) ←→ TradingView Desktop (Electron)
```

Pine graphics path: `study._graphics._primitivesCollection.dwglines.get('lines').get(false)._primitivesDataById`
