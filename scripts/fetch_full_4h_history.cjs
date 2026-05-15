/**
 * Loop 28 FX pairs on TradingView, switch each to 4H, extract full OHLCV
 * via internal API. Save each to /tmp/tv_4h/<symbol>.json.
 * Bypasses yfinance 60d cap — TV serves 5+ months of 4H per symbol.
 */
const CDP = require("chrome-remote-interface");
const fs = require("fs");

const SYMBOLS = [
  "AUDNZD","AUDCAD","AUDUSD","AUDCHF","AUDJPY"  // retry-only list for the failed 5
];

const OUT_DIR = "/tmp/tv_4h";
fs.mkdirSync(OUT_DIR, { recursive: true });

async function evalExpr(Runtime, expr) {
  const r = await Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.value;
}

async function setSymbolAndTF(Runtime, symbol, tf) {
  // Use the same path as the MCP chart_set_symbol tool.
  await evalExpr(Runtime, `(function(){
    try {
      const chart = window.TradingViewApi._activeChartWidgetWV.value();
      const cw = chart._chartWidget;
      const m = cw._model || cw.model();
      const s = m.mainSeries();
      s.setSymbol("OANDA:" + ${JSON.stringify(symbol)});
      // Resolution change is on the chart object
      cw.setResolution("${tf}");
      return true;
    } catch(e) { return e.message; }
  })()`);
}

async function fetchOHLCV(Runtime) {
  // Mirror the data_get_full_ohlcv MCP traversal (mainSeries().data().each()).
  return await evalExpr(Runtime, `(function(){
    try {
      const chart = window.TradingViewApi._activeChartWidgetWV.value();
      const cw = chart._chartWidget;
      const m = cw._model || cw.model();
      const s = m.mainSeries();
      const d = s.data();
      const out = [];
      d.each(function(i, b) {
        out.push({ time: b[0], open: b[1], high: b[2], low: b[3], close: b[4], volume: b[5] || 0 });
      });
      // Try to get symbol info too
      let info = "";
      try { info = s.symbolInfo()?.full_name || s.symbolInfo()?.name || ""; } catch(e) {}
      return { bars: out, count: out.length, symbol: info };
    } catch(e) { return { error: e.message }; }
  })()`);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const client = await CDP({ port: 9222 });
  const { Runtime } = client;
  await Runtime.enable();

  for (let i = 0; i < SYMBOLS.length; i++) {
    const sym = SYMBOLS[i];
    process.stdout.write(`[${i+1}/${SYMBOLS.length}] ${sym} ... `);
    await setSymbolAndTF(Runtime, sym, "240");
    await sleep(5000);  // longer wait for retry — some pairs are slow to load
    const data = await fetchOHLCV(Runtime);
    if (data && data.bars && data.bars.length > 100) {
      fs.writeFileSync(`${OUT_DIR}/${sym}.json`, JSON.stringify(data));
      console.log(`✓ ${data.count} bars (${data.symbol}, tf=${data.tf})`);
    } else {
      console.log(`✗ failed (${data?.error || 'empty'})`);
    }
  }

  await client.close();
  console.log(`\nSaved to ${OUT_DIR}/`);
})().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
