# TradingView MCP — Troubleshooting Guide

Common setup and runtime issues encountered in real sessions.
Each entry cost time to diagnose — this guide exists so you don't repeat the investigation.

---

## Setup Issues

### MCP server won't load / tools not available

**Symptom**: Claude Code session starts but no `tradingview-mcp` tools appear (no `tv_health_check`, no `chart_set_symbol`, etc.).

**Cause**: TradingView Desktop is not running, not logged in, or the CDP connection was never established.

**Fix**:
1. Launch TradingView Desktop first (`tv_launch` tool or manually).
2. Make sure you are logged into your TV account — the chart page must be open, not the login screen.
3. The MCP server connects via Chrome DevTools Protocol (CDP) to the Electron app's remote debugging port.
4. Run `tv_health_check` to verify the connection. If it fails, TV is not reachable.
5. On Linux, confirm TV was launched with `--remote-debugging-port=9222` (the default port the MCP server expects).

### "Cannot connect to CDP" / health check fails

**Common causes**:
- TradingView Desktop was not running when the MCP server started.
- TV was restarted after the MCP server connected — the CDP target ID changed, so the MCP server needs a restart too.
- On Linux: the `--remote-debugging-port` flag was missing from the TV launch command.
- The port (default 9222) is occupied by another process. Check with `lsof -i :9222`.

**Fix**: Restart TradingView Desktop with `--remote-debugging-port=9222`, then restart the MCP server (restart the Claude Code session or reload MCP config).

### "No TradingView chart target found"

**Symptom**: CDP connects to the debugging port but no chart page is detected.

**Cause**: TV is open but showing a non-chart page (e.g., settings, login screen, or the app is still loading).

**Fix**: Navigate to a chart in TradingView Desktop. The MCP server looks for pages with `tradingview.com/chart` in the URL.

---

## Runtime Issues

### chart_set_symbol succeeds but chart_ready: false

**Cause**: Some symbols take longer to load (low liquidity, exotic pairs, or large historical datasets).

**Workaround**:
- Add a 1.5-2 second sleep after `chart_set_symbol` before reading data.
- Retry `chart_set_symbol` if subsequent data tools return empty results.
- Some pairs are consistently slow — give them extra time.

### data_get_study_values returns 0 studies

**Symptom**: `chart_get_state` confirms studies exist on the chart, but `data_get_study_values` returns `study_count: 0`.

**Causes**:
- Chart is still loading data for the new symbol/timeframe.
- The pair has insufficient historical data for indicators to compute values.
- Known problematic example: TRIAUSDT on 4h consistently returns 0 studies.

**Workaround**: Wait longer after symbol/timeframe change. Switch away and back to force a reload. If a specific pair consistently fails, it likely lacks enough data.

### indicator_set_inputs — input naming

Input keys are **positional**: `in_0`, `in_1`, `in_2`, ... matching declaration order in the Pine source code. They are NOT the variable names from Pine (`man_low`, `man_high`, etc.).

**Example**: For an indicator with `mode`, `man_low`, `man_high` as the first 3 declared inputs:
```json
{"in_0": "Manual", "in_1": 0.01736, "in_2": 0.0941}
```

Check the Pine source to know which `in_N` maps to which setting.

### pine_set_source writes to the wrong script

`pine_set_source` injects into **whatever is currently open** in the Pine editor. There is no "target script" parameter.

**Critical rule**: ALWAYS verify which script is active before calling `pine_set_source`.

- `pine_open` does NOT reliably switch the editor UI context.
- Use `pine_switch_script` (or the manual nameButton dropdown click method) to switch first.
- Screenshot before `pine_set_source` to confirm which script is displayed.

See also: [Pine Editor Gotchas](PINE_EDITOR_GOTCHAS.md) for the full switching procedure.

### Large Pine scripts (800+ lines) fail via MCP tool

The MCP tool parameter may be too large for the transport layer.

**Workaround** — use Node.js direct import:
```bash
cd ~/ai/tradingview-mcp && node -e "
import('./src/core/pine.js').then(async (pine) => {
    const fs = await import('fs');
    const src = fs.readFileSync('/path/to/script.pine', 'utf8');
    await pine.setSource({ source: src });
    const r = await pine.smartCompile();
    console.log(r.has_errors ? 'ERRORS' : 'OK');
    process.exit(0);
});
"
```

### Drawing removal tools broken (draw_remove_one, draw_list)

**Symptom**: Fails with `getChartApi is not defined`.

**Nuclear option**: `removeAllDrawingTools()` works but removes ALL drawings, including user's manual Fib drawings and trendlines.
```js
var chart = window._exposed_chartWidgetCollection.getAll()[0];
chart.removeAllDrawingTools();
```
**Only use with explicit user permission.** There is no selective removal via MCP.

### Unicode minus signs in study values

Some indicator values contain `−` (U+2212, MINUS SIGN) instead of `-` (U+002D, HYPHEN-MINUS). Direct `float()` parsing will fail.

**Fix**: Normalize before parsing:
```python
str(v).replace('\u2212', '-')
```

### batch_run does not support get_study_values

`batch_run` only supports: `screenshot`, `get_ohlcv`, `get_strategy_results`.

To read study/oscillator values across multiple assets, use a manual loop:
1. `chart_set_symbol(symbol)`
2. `chart_set_timeframe(tf)`
3. Wait for chart to load (1-2 seconds)
4. `data_get_study_values()`

---

## TV Essential Plan — 5 Indicator Limit

If you are on a TV Essential plan, you have 5 indicator slots total. This includes indicators saved in your layout that reload on page refresh.

- `removeAllStudies()` from JS removes them visually but does NOT free plan slots — TV counts them server-side.
- Saved layout indicators reload on refresh — they are account-level, not session-level.
- Before adding a custom indicator: manually remove others from chart settings, or use a blank layout with 0 saved indicators.

---

## Quick Diagnostic Checklist

When something isn't working, run through this in order:

1. `tv_health_check` — Is CDP connected? Is the chart API available?
2. `chart_get_state` — What symbol/TF is loaded? How many studies?
3. `capture_screenshot` — What does the user actually see?
4. `tv_ui_state` — Is the Pine editor open? What buttons are visible?
5. Check the MCP server logs for transport-level errors.
