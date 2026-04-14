# Fibo Workflow — How to Use TV MCP for Fibonacci Analysis

Proven workflow for scanning assets, setting Fib levels, and collecting indicator data.

## Quick Asset Scan (Node.js)

```bash
cd ~/ai/tradingview-mcp && node -e "
import('./src/core/index.js').then(async (core) => {
    // 1. Set symbol + timeframe
    await core.chart.setSymbol({symbol: 'BINANCE:BTCUSDT'});
    await new Promise(r => setTimeout(r, 1500));
    await core.chart.setTimeframe({timeframe: '720'});  // 12h
    await new Promise(r => setTimeout(r, 2000));
    
    // 2. Set Fib inputs (Manual mode)
    // in_0 = mode, in_1 = man_low (CT_ZERO), in_2 = man_high (CT_ONE)
    await core.indicators.setInputs({
        entity_id: 'YOUR_FIBO_ENTITY_ID',  // from chart_get_state
        inputs: JSON.stringify({in_0: 'Manual', in_1: 65056.0, in_2: 76000.0})
    });
    await new Promise(r => setTimeout(r, 1500));
    
    // 3. Read all indicators
    const sv = await core.data.getStudyValues({});
    console.log(JSON.stringify(sv, null, 2));
    process.exit(0);
});
"
```

## Direction Mapping (CRITICAL — don't get this wrong)

```
DOWN impulse (high → low):  man_low = swing_low,  man_high = swing_high
UP impulse   (low → high):  man_low = swing_high, man_high = swing_low  ← INVERTED!
```

Why: `man_low` = CT_ZERO = Fib 0.0 level (end of impulse).
- DOWN: end is at bottom → man_low = swing_low
- UP: end is at top → man_low = swing_high (confusing name, but correct)

## Pine Editor Switching

**NEVER use pine_open** — it doesn't switch the UI. Use:
```bash
node -e "
import('./src/core/pine.js').then(async (pine) => {
    await pine.switchScript({ name: 'Popanaczi v6' });  // exact saved name!
    // Now safe to setSource / getSource
    process.exit(0);
});
"
```

## Deploying Large Pine Scripts (800+ lines)

```bash
node -e "
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

## Batch Scan All Assets

```javascript
const assets = [
    {db: 'BTCUSDT', tv: 'BINANCE:BTCUSDT', tf: '720', ml: 65056.0, mh: 76000.0},
    // ... more assets
];

for (const a of assets) {
    await core.chart.setSymbol({symbol: a.tv});
    await sleep(1500);
    await core.chart.setTimeframe({timeframe: a.tf});
    await sleep(2000);
    await core.indicators.setInputs({
        entity_id: FIBO_ID,
        inputs: JSON.stringify({in_0: 'Manual', in_1: a.ml, in_2: a.mh})
    });
    await sleep(1500);
    const sv = await core.data.getStudyValues({});
    // Parse oscillator: RSI, %K, %D, MFI, CVD Z, Pivot Dist
    // Parse fibo: Trend, CHoCH Dir, EMAs
    // Parse companion: Inst Volume
}
```

## What We Collect Per Asset

From **Popanaczi Oscillator** (overlay=false pane):
- RSI (14)
- Stochastic %K / %D
- MFI (Money Flow Index)
- OB/OS Anchor (fired or not)
- CVD Z-Score (volume delta breadth)
- Fib Pivot Points (PP, R1/R2, S1/S2)
- Divergence (regular + hidden, bull + bear)
- Failure Swings (Wilder)
- Cardwell RSI Regime

From **Popanaczi Fibo v6** (overlay=true):
- Trend (+1/-1)
- CHoCH Dir (+1/-1)
- EMA 33/66/144/288
- BOS/CHoCH signals
- QM Buy/Sell dots
- KUP/SPRZEDAJ signals

From **Popanaczi Companion**:
- Institutional Volume

## Key Finding (2026-04-14)

RSI is the strongest predictor of Fib direction (r=0.803).
When RSI > 65 + Stoch > 70 → popek draws DOWN Fib (SHORT setup).
When RSI < 45 + Stoch < 30 → popek draws UP Fib (LONG setup).

Zone hit rates (post-swing retracement, 13 assets):
- 0.45-0.50: 100%
- 0.577-0.618: 92%
- OTE 0.705: 31%
