#!/usr/bin/env node
// Big sweep: iterate 28 FX symbols × 3 TFs, scrape COMBO counts from
// SMC Eryk R1 indicator via CDP. Saves one JSON per (symbol, tf).
//
// Auto-runs in background. Sleep durations tuned for indicator recompute
// on a chart with ~500-1000 historical bars + universal-edges (HTF EMA via
// request.security which is the slow path).
//
// Usage: node big-sweep.cjs [start_index]
//   start_index optional, resume from chart N if interrupted (0-indexed).

const CDP = require('chrome-remote-interface');
const fs = require('fs');
const path = require('path');

const SYMBOLS = [
  'OANDA:USDCAD','OANDA:EURGBP','OANDA:AUDCAD','OANDA:NZDUSD','OANDA:EURUSD',
  'OANDA:AUDUSD','OANDA:GBPNZD','OANDA:USDJPY','OANDA:NZDJPY','OANDA:CHFJPY',
  'OANDA:EURNZD','OANDA:GBPJPY','OANDA:AUDCHF','OANDA:CADJPY','OANDA:EURJPY',
  'OANDA:AUDJPY','OANDA:EURAUD','OANDA:NZDCHF','OANDA:CADCHF','OANDA:EURCAD',
  'OANDA:AUDNZD','OANDA:GBPCHF','OANDA:GBPCAD','OANDA:USDCHF','OANDA:GBPUSD',
  'OANDA:GBPAUD','OANDA:NZDCAD','OANDA:EURCHF'
];
const TFS = ['15', '60', '240'];

const SCRAPE_JS = `
(function(){
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var model = chart.model();
    var sources = model.model().dataSources();
    var counts = {};
    var total = 0;
    var filter = 'SMC Eryk R1';
    for (var si = 0; si < sources.length; si++) {
      var s = sources[si];
      if (!s.metaInfo) continue;
      try {
        var meta = s.metaInfo();
        var name = meta.description || meta.shortDescription || '';
        if (!name || name.indexOf(filter) === -1) continue;
        var g = s._graphics;
        if (!g || !g._primitivesCollection) continue;
        var pc = g._primitivesCollection;
        var outer = pc.dwglabels;
        if (!outer) continue;
        var inner = outer.get('labels');
        if (!inner) continue;
        var coll = inner.get(false);
        if (!coll || !coll._primitivesDataById) continue;
        coll._primitivesDataById.forEach(function(v, id) {
          var t = v.t || '';
          var m = t.match(/^COMBO ([BYN])([01])([01]) (WIN|LOSS)$/);
          if (m) {
            var key = m[1]+m[2]+m[3]+'-'+m[4];
            counts[key] = (counts[key]||0)+1;
            total++;
          }
          var im = t.match(/^([\\u2713\\u2717]) INVERSE-(WIN|LOSS)/);
          if (im) {
            var ikey = 'INV24-'+im[2];
            counts[ikey] = (counts[ikey]||0)+1;
          }
          var i11 = t.match(/^([\\u2713\\u2717]) INV1:1-(WIN|LOSS)/);
          if (i11) {
            var ikey2 = 'INV11-'+i11[2];
            counts[ikey2] = (counts[ikey2]||0)+1;
          }
        });
      } catch(e){}
    }
    return JSON.stringify({total: total, counts: counts});
  } catch (e) {
    return JSON.stringify({error: String(e)});
  }
})()
`;

const SET_SYMBOL_TF_JS = (sym, tf) => `
(function() {
  try {
    var chart = window.TradingViewApi._activeChartWidgetWV.value();
    chart.setSymbol(${JSON.stringify(sym)}, {});
    chart.setResolution(${JSON.stringify(tf)}, {});
    return JSON.stringify({ok: true, symbol: ${JSON.stringify(sym)}, tf: ${JSON.stringify(tf)}});
  } catch (e) {
    return JSON.stringify({error: String(e)});
  }
})()
`;

const OUT_DIR = "/home/palyslaf0s/ai/smc-eryk/research/lab/v15-sweep";
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const startIdx = parseInt(process.argv[2] || '0', 10);

  const targets = await (await fetch('http://localhost:9222/json/list')).json();
  const t = targets.find(x => x.url && x.url.includes('tradingview.com'));
  if (!t) { console.error('No TradingView target'); process.exit(1); }
  const c = await CDP({ host: 'localhost', port: 9222, target: t.id });
  await c.Runtime.enable();

  const combos = [];
  for (const sym of SYMBOLS) for (const tf of TFS) combos.push([sym, tf]);

  console.log(`big-sweep: ${combos.length} charts (${SYMBOLS.length} sym × ${TFS.length} tf). Starting at index ${startIdx}.`);

  for (let i = startIdx; i < combos.length; i++) {
    const [sym, tf] = combos[i];
    const baseName = sym.split(':')[1] + '_' + (tf === '15' ? '15m' : tf === '60' ? '1h' : '4h');
    const outFile = path.join(OUT_DIR, baseName + '.json');

    // Switch chart
    const setResp = await c.Runtime.evaluate({
      expression: SET_SYMBOL_TF_JS(sym, tf),
      returnByValue: true,
    });
    const setResult = JSON.parse(setResp.result.value || '{}');
    if (setResult.error) {
      console.error(`[${i+1}/${combos.length}] SET ${baseName} error: ${setResult.error}`);
      continue;
    }

    // Wait for chart + indicator to recompute. 7s should be safe.
    await sleep(7000);

    // Scrape
    const scrapeResp = await c.Runtime.evaluate({
      expression: SCRAPE_JS,
      returnByValue: true,
    });
    const result = JSON.parse(scrapeResp.result.value || '{}');
    if (result.error) {
      console.error(`[${i+1}/${combos.length}] SCRAPE ${baseName} error: ${result.error}`);
      continue;
    }

    const payload = { symbol: sym.split(':')[1], tf: tf, ...result };
    fs.writeFileSync(outFile, JSON.stringify(payload));
    console.log(`[${i+1}/${combos.length}] ${baseName}: total=${result.total} combos=${Object.keys(result.counts || {}).length}`);
  }

  await c.close();
  console.log('big-sweep done.');
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
