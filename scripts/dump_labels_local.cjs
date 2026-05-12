const CDP = require("chrome-remote-interface");
(async () => {
  const client = await CDP({ port: 9222 });
  const { Runtime } = client;
  await Runtime.enable();
  const expr = `(function() {
    var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
    var model = chart.model();
    var sources = model.model().dataSources();
    var results = [];
    for (var si = 0; si < sources.length; si++) {
      var s = sources[si];
      if (!s.metaInfo) continue;
      try {
        var meta = s.metaInfo();
        var name = meta.description || meta.shortDescription || '';
        if (!name.includes('SMC Eryk R1')) continue;
        var g = s._graphics;
        if (!g || !g._primitivesCollection) continue;
        var pc = g._primitivesCollection;
        var labels = [];
        var outer = pc.dwglines;
        if (outer) {
          var inner = outer.get('labels');
          if (inner) {
            var coll = inner.get(false);
            if (coll && coll._primitivesDataById && coll._primitivesDataById.size > 0) {
              coll._primitivesDataById.forEach(function(v) {
                if (v && v.text) labels.push({ text: v.text });
              });
            }
          }
        }
        results.push({ name: name, labels: labels });
      } catch(e) {}
    }
    return { studies: results };
  })()`;
  const res = await Runtime.evaluate({ expression: expr, returnByValue: true });
  console.log(JSON.stringify(res.result.value));
  await client.close();
})().catch(e => { console.error("ERR:", e.message); process.exit(1); });
