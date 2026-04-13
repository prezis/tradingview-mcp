# Pine Editor Gotchas & Workarounds

Hard-won lessons from real sessions. Each one cost time and frustration.

## 1. `pine_open` does NOT switch the editor UI

**Problem**: `pine_open("My Script")` fetches the script via internal TV API but does NOT change what's displayed in the Pine editor panel. The editor may still show the previous script.

**What happens**: You call `pine_set_source` thinking you're editing "My Script" but you're actually overwriting whatever was previously open (e.g., RSI pane).

**Fix**: Use `pine_switch_script` tool (added 2026-04-13) which clicks the nameButton dropdown in the UI. Falls back to the proven method:
```js
// 1. Click nameButton dropdown
document.querySelector('[class*="nameButton"]').click()
// 2. Find target script element by exact text match
// 3. Click at coordinates via CDP Input.dispatchMouseEvent
// 4. Verify nameButton text changed
```

## 2. `pine_set_source` writes to WHATEVER is currently open

**Problem**: There's no "target script" parameter. It injects into the active Monaco editor. If the wrong script is open, you corrupt it.

**Rule**: ALWAYS screenshot + verify `nameButton` text BEFORE calling `pine_set_source`.

## 3. Large Pine scripts (800+ lines) may fail via MCP tool

**Problem**: The MCP `pine_set_source` tool parameter has practical size limits. A 38KB/800-line script may silently fail or timeout.

**Workaround**: Use Node.js direct import instead:
```bash
cd ~/ai/tradingview-mcp && node -e "
import('./src/core/pine.js').then(async (pine) => {
    const fs = await import('fs');
    const source = fs.readFileSync('/path/to/script.pine', 'utf8');
    await pine.setSource({ source });
    const r = await pine.smartCompile();
    console.log(r.has_errors ? 'ERRORS' : 'OK');
    process.exit(0);
});
"
```

## 4. Monaco editor has NO React Fiber in TV's Pine editor

**Problem**: Standard React Fiber traversal (`__reactFiber$` on `.monaco-editor` DOM) returns nothing. TV bundles Monaco differently — no fiber keys on editor elements.

**Impact**: Cannot use `el.__reactFiber$.stateNode.getModel().setValue()` like in standard React+Monaco apps.

**How `pine_set_source` actually works**: The MCP tool uses TV's internal API, not direct Monaco DOM manipulation. The `setSource()` function in `src/core/pine.js` handles this.

## 5. Drawing tools are partially broken

**Problem**: `draw_list`, `draw_remove_one` fail with `getChartApi is not defined`. Individual shape removal doesn't work.

**Nuclear option**: `removeAllDrawingTools()` works via:
```js
var chart = window._exposed_chartWidgetCollection.getAll()[0];
chart.removeAllDrawingTools();
```
**WARNING**: This removes ALL drawings including user's manual Fib drawings, trendlines, etc. Never use without user's explicit permission.

**Safer alternative**: Draw shapes via `draw_shape` tool (which returns `entity_id`), but accept that you cannot selectively remove them later via MCP. User must manually delete.

## 6. `indicator_set_inputs` — input key naming

**Problem**: Input keys are `in_0`, `in_1`, `in_2`, ... (positional, matching declaration order in Pine code). Not the input variable names.

**Example**: For an indicator with `mode`, `man_low`, `man_high` as first 3 inputs:
```json
{"in_0": "Manual", "in_1": 0.01736, "in_2": 0.0941}
```

## 7. Script names in TV ≠ indicator titles in Pine code

**Problem**: The saved script name in "My Scripts" may differ from the `indicator("Title")` in Pine code. E.g., script saved as "Popanaczi Fibo v5" but code says `indicator("Popanaczi Fibo v6")`.

**Impact**: `pine_open` matches by saved name. `chart_get_state` shows the indicator title from code. `switchScript` searches dropdown by saved name.

**Rule**: Use `pine_list_scripts` to see actual saved names, not the indicator title.

## 8. `data_get_study_values` returns 0 studies on some symbols

**Problem**: On low-liquidity pairs or when chart is still loading, `data_get_study_values` returns `study_count: 0` even though `chart_get_state` confirms studies exist.

**Workaround**: Wait for chart to fully load. Retry after switching symbol/TF. Some pairs (e.g., TRIAUSDT 4h) consistently fail — likely insufficient data for indicators to compute.

## 9. Batch operations need sequential symbol+TF switching

**Problem**: `batch_run` only supports `screenshot`, `get_ohlcv`, `get_strategy_results` — NOT `get_study_values`. To read oscillator data across multiple assets, must manually:
1. `chart_set_symbol`
2. `chart_set_timeframe`
3. Wait for `chart_ready`
4. `data_get_study_values`

**Potential improvement**: Add `get_study_values` as a batch_run action.

## 10. Always screenshot before AND after Pine editor operations

Not optional. The editor state is invisible to MCP tools — only screenshots tell you what's actually happening. A 2-second screenshot saves 20 minutes of debugging the wrong script.
