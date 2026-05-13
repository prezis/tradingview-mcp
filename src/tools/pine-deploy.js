import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/pine-deploy.js';

export function registerPineDeployTools(server) {
  server.tool('pine_deploy', 'PREFERRED PATH for deploying Pine Script from a file on disk. Reads .pine file → injects into editor via Monaco setValue → saves (Ctrl+S + Save-dialog handler) → clicks "Add to chart" / "Update on chart" (EN + PL) → returns compile-marker errors. SINGLE-SHOT replacement for the older pine_set_source + pine_save + ui_keyboard{Ctrl+Enter} chain. File-based: source is NEVER embedded in the tool call, so no token-tax for 50-100KB Pine files. Set replace_existing=true with replace_title_match to auto-remove a prior instance of the indicator BEFORE adding the new one, avoiding duplicate-instance buildup (TV Essential plan caps at 5 indicator slots).', {
    pine_path: z.string().describe('Absolute path to a .pine file on disk'),
    replace_existing: z.boolean().optional().describe('If true, call removeStudy(replace_title_match) BEFORE the deploy so any prior instance of this indicator is cleared from the chart. Pairs with replace_title_match to avoid duplicates.'),
    replace_title_match: z.string().optional().describe('Case-insensitive substring of the prior indicator title to remove when replace_existing=true. E.g. "SMC Eryk", "Popanaczi". If omitted while replace_existing=true, no removal is attempted.'),
  }, async ({ pine_path, replace_existing, replace_title_match }) => {
    try {
      const out = {};
      if (replace_existing && replace_title_match) {
        out.removed = await core.removeStudy({ titleMatch: replace_title_match });
      }
      out.deploy = await core.deployScript({ pinePath: pine_path });
      out.success = out.deploy?.success ?? false;
      out.errors = out.deploy?.errors || [];
      return jsonResult(out);
    }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_add_builtin_study', 'Add a built-in TradingView indicator to the chart via API. Use full names: "Relative Strength Index", "MACD", "Bollinger Bands", "On Balance Volume", "Moving Average Exponential", "Volume".', {
    name: z.string().describe('Full indicator name (e.g., "Relative Strength Index", "MACD", "Bollinger Bands")'),
    params: z.string().optional().describe('JSON string of input overrides, e.g. \'{"length": 20}\'. Keys are input IDs.'),
  }, async ({ name, params }) => {
    try {
      const parsed = params ? JSON.parse(params) : undefined;
      return jsonResult(await core.addBuiltinStudy({ name, params: parsed }));
    }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_remove_study', 'Remove an indicator/study from the chart by matching its title (case-insensitive substring match). Searches all panes and data sources.', {
    title_match: z.string().describe('Substring to match against study title (case-insensitive, e.g. "RSI", "MACD", "Bollinger")'),
  }, async ({ title_match }) => {
    try { return jsonResult(await core.removeStudy({ titleMatch: title_match })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_get_chart_indicators', 'List all indicators on the chart with pane index, entity ID, visibility, and type info.', {}, async () => {
    try { return jsonResult(await core.getChartIndicators()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
