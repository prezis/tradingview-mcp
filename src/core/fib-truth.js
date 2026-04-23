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
 * Set exact Fib values on a custom Fibonacci-style indicator (Manual mode).
 * Takes approximate screen values, looks up exact OHLCV wicks, sets them on
 * the matching study.
 *
 * Assumes the target indicator has Manual-mode inputs:
 *   - in_0: mode string ("Manual")
 *   - in_1: high price (float)
 *   - in_2: low price (float)
 *
 * @param {object} opts
 * @param {number} opts.approx_high - approximate high price (for logging only)
 * @param {number} opts.approx_low - approximate low price (for logging only)
 * @param {string} [opts.study_id] - explicit study ID (skips auto-detection)
 * @param {string[]} [opts.study_name_includes] - all-of substrings to match
 *   the study name when study_id is not provided. Default: ["Fib"]. Customize
 *   to your indicator naming convention (e.g. ["MyTeam", "Fibo"]).
 * @returns {{ exact_high, exact_low, high_time, low_time }}
 */
export async function setExactFib({
  approx_high,
  approx_low,
  study_id,
  study_name_includes = ['Fib'],
} = {}) {
  // 1. Get exact wicks from OHLCV
  const wicks = await getExactWicks();

  // 2. Find closest wick to approximate values (within 10% tolerance)
  // For now, use absolute max/min — later can search for closest match
  const exact_high = wicks.wick_high;
  const exact_low = wicks.wick_low;

  // 3. Find target study (auto-detect via name substring(s) if no ID given)
  const matchersJson = JSON.stringify(study_name_includes);
  const sid = study_id || await evaluate(`
    (function(){
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var studies = chart.getAllStudies();
      var matchers = ${matchersJson};
      for (var s of studies) {
        var ok = true;
        for (var m of matchers) { if (!s.name.includes(m)) { ok = false; break; } }
        if (ok) return s.id;
      }
      return null;
    })()
  `);

  if (!sid) {
    throw new Error(
      `No study found matching all of [${study_name_includes.join(', ')}]. ` +
      `Pass a different study_name_includes array, or pass study_id directly.`
    );
  }

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
