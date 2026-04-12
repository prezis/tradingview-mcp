/**
 * Fib Ground Truth — extract exact wick values from OHLCV data.
 *
 * Flow: user sees approximate values on screen → this finds exact wick H/L from chart data.
 * Uses TV's internal chart data (all loaded bars), not the MCP's 100-bar limit.
 */
import { evaluate } from '../connection.js';

/**
 * Get exact wick high and wick low from all loaded chart bars.
 * @returns {{ bars, wick_high, high_time, wick_low, low_time, range }}
 */
export async function getExactWicks() {
  const result = await evaluate(`
    (function(){
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var cw = chart._chartWidget;
      var m = cw._model || cw.model();
      var s = m.mainSeries();
      var d = s.data();
      var maxH=-Infinity, minL=Infinity, maxT=0, minT=0, n=0, firstT=0, lastT=0;
      d.each(function(i,b){
        n++;
        if(n===1) firstT=b[0];
        lastT=b[0];
        if(b[2]>maxH){maxH=b[2];maxT=b[0];}
        if(b[3]<minL){minL=b[3];minT=b[0];}
      });
      return {n:n, wick_high:maxH, high_time:maxT, wick_low:minL, low_time:minT, first:firstT, last:lastT};
    })()
  `);

  if (!result || !result.n) throw new Error('Could not read chart data');

  return {
    bars: result.n,
    wick_high: result.wick_high,
    high_time: new Date(result.high_time * 1000).toISOString(),
    wick_low: result.wick_low,
    low_time: new Date(result.low_time * 1000).toISOString(),
    range: {
      from: new Date(result.first * 1000).toISOString(),
      to: new Date(result.last * 1000).toISOString(),
    },
  };
}

/**
 * Get all current indicator values from the chart.
 * @returns {{ studies: Array<{ name, values }> }}
 */
export async function getAllIndicatorValues() {
  const result = await evaluate(`
    (function(){
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var studies = chart.getAllStudies();
      var output = [];
      for (var s of studies) {
        try {
          var study = chart.getStudyById(s.id);
          if (study && study.getInputValues) {
            output.push({id: s.id, name: s.name});
          }
        } catch(e) {}
      }
      return output;
    })()
  `);

  return { studies: result || [] };
}

/**
 * Set Fib values on Popanaczi indicator (Manual mode).
 * Takes approximate screen values, looks up exact OHLCV wicks, sets them.
 *
 * @param {{ approx_high: number, approx_low: number, study_id?: string }}
 * @returns {{ exact_high, exact_low, high_time, low_time }}
 */
export async function setExactFib({ approx_high, approx_low, study_id }) {
  // 1. Get exact wicks from OHLCV
  const wicks = await getExactWicks();

  // 2. Find closest wick to approximate values (within 10% tolerance)
  // For now, use absolute max/min — later can search for closest match
  const exact_high = wicks.wick_high;
  const exact_low = wicks.wick_low;

  // 3. Set on indicator
  const sid = study_id || await evaluate(`
    (function(){
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var studies = chart.getAllStudies();
      for (var s of studies) {
        if (s.name.includes('Popanaczi') && s.name.includes('Fibo')) return s.id;
      }
      return null;
    })()
  `);

  if (!sid) throw new Error('Popanaczi Fibo study not found on chart');

  await evaluate(`
    (function(){
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var study = chart.getStudyById('${sid}');
      var inputs = study.getInputValues();
      for (var i = 0; i < inputs.length; i++) {
        if (inputs[i].id === 'in_0') inputs[i].value = 'Manual';
        if (inputs[i].id === 'in_1') inputs[i].value = ${exact_high};
        if (inputs[i].id === 'in_2') inputs[i].value = ${exact_low};
      }
      study.setInputValues(inputs);
    })()
  `);

  return {
    success: true,
    approx: { high: approx_high, low: approx_low },
    exact: { high: exact_high, low: exact_low },
    high_time: wicks.high_time,
    low_time: wicks.low_time,
    bars_scanned: wicks.bars,
  };
}
