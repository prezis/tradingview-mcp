# Multi-Asset Chart Scan Workflow

Proven patterns for scanning multiple assets, setting indicator inputs programmatically, and harvesting indicator values via tv-mcp's CLI / Node API.

This is a recipe doc — the techniques are generic across any indicator and any asset list. Substitute your own indicator names + asset universe.

---

## Quick single-asset scan (Node.js)

```bash
cd ~/your-clone-of-tradingview-mcp && node -e "
import('./src/core/index.js').then(async (core) => {
    // 1. Set symbol + timeframe
    await core.chart.setSymbol({symbol: 'BINANCE:BTCUSDT'});
    await new Promise(r => setTimeout(r, 1500));
    await core.chart.setTimeframe({timeframe: '720'});  // 12h
    await new Promise(r => setTimeout(r, 2000));

    // 2. Set indicator inputs (Manual mode example)
    // in_0, in_1, in_2 = positional input keys (NOT the variable names —
    // see PINE_EDITOR_GOTCHAS.md #6).
    await core.indicators.setInputs({
        entity_id: 'YOUR_INDICATOR_ENTITY_ID',  // get from chart_get_state
        inputs: JSON.stringify({in_0: 'Manual', in_1: 65056.0, in_2: 76000.0})
    });
    await new Promise(r => setTimeout(r, 1500));

    // 3. Harvest all indicator values
    const sv = await core.data.getStudyValues({});
    console.log(JSON.stringify(sv, null, 2));
    process.exit(0);
});
"
```

## Direction mapping for Fibonacci-style indicators (CRITICAL)

If your indicator uses two anchor points (low and high) for retracement levels, the assignment depends on impulse direction:

```
DOWN impulse (high → low):  in_low = swing_low,  in_high = swing_high
UP impulse   (low → high):  in_low = swing_high, in_high = swing_low  ← INVERTED!
```

**Why**: `in_low` is canonically interpreted as "Fib 0.0 level" = end of impulse.
- DOWN impulse: end is at bottom → `in_low = swing_low`
- UP impulse: end is at top → `in_low = swing_high` (confusing name, but correct)

Get this wrong and your Fib levels render upside down on the chart.

## Switching the Pine editor between saved scripts

**NEVER use `pine_open` for switching** — it doesn't change the editor UI, just injects fetched source into the active buffer (see `PINE_EDITOR_GOTCHAS.md` #1 and `PINE_EDITOR_WORKFLOW.md` Recipe F). Use:

```bash
node -e "
import('./src/core/pine.js').then(async (pine) => {
    await pine.switchScript({ name: 'YourSavedScriptName' });  // exact saved name
    // Now safe to call setSource / getSource on this slot
    process.exit(0);
});
"
```

## Deploying large Pine scripts (800+ lines)

The MCP `pine_set_source` tool has practical size limits (see `PINE_EDITOR_GOTCHAS.md` #3). For large scripts, use Node.js direct import:

```bash
node -e "
import('./src/core/pine.js').then(async (pine) => {
    const fs = await import('fs');
    const src = fs.readFileSync('/path/to/script.pine', 'utf8');
    await pine.setSource({ source: src, allow_unverified: true });
    const r = await pine.smartCompile();
    console.log(r.has_errors ? 'ERRORS' : 'OK');
    process.exit(0);
});
"
```

## Batch scan across N assets

```javascript
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Build your asset list with indicator-input values per asset
const assets = [
    {tv: 'BINANCE:BTCUSDT', tf: '720', in1: 65056.0, in2: 76000.0},
    {tv: 'BINANCE:ETHUSDT', tf: '720', in1: 3200.0,  in2: 4100.0},
    // ... more
];

for (const a of assets) {
    await core.chart.setSymbol({symbol: a.tv});
    await sleep(1500);
    await core.chart.setTimeframe({timeframe: a.tf});
    await sleep(2000);

    // Configure your indicator (replace YOUR_INDICATOR_ID with actual entity ID)
    await core.indicators.setInputs({
        entity_id: YOUR_INDICATOR_ID,
        inputs: JSON.stringify({in_0: 'Manual', in_1: a.in1, in_2: a.in2})
    });
    await sleep(1500);

    // Harvest
    const sv = await core.data.getStudyValues({});
    // ... log / append to file / push to DB
    console.log(a.tv, JSON.stringify(sv));
}
```

## Common indicator-output harvesters

For custom Pine indicators that draw graphics primitives (`line.new` / `label.new` / `box.new` / `table.new`), use the dedicated harvesters:

| Tool | What it returns |
|---|---|
| `data_get_pine_lines` | horizontal price levels drawn by `line.new` |
| `data_get_pine_labels` | text + price annotations drawn by `label.new` |
| `data_get_pine_boxes` | price zones (high/low pairs) drawn by `box.new` |
| `data_get_pine_tables` | tables drawn by `table.new` (formatted as rows) |
| `data_get_study_values` | numeric oscillator values from `plot()` calls |

Pass `study_filter` (substring match) to target a specific indicator and avoid the noise from all studies on the chart.

## See also

- `PINE_EDITOR_WORKFLOW.md` — canonical recipes A–G for safe Pine editor manipulation
- `PINE_EDITOR_GOTCHAS.md` — known failure modes (read before any pine_* call)
- `TROUBLESHOOTING.md` — connection / setup issues
