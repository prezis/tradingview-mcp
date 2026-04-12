import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/pine-deploy.js';

export function registerPineDeployTools(server) {
  server.tool('pine_deploy', 'Deploy a Pine Script file to the chart: reads .pine file, injects into editor, saves, handles dialogs, and adds/updates on chart. Returns compilation errors if any.', {
    pine_path: z.string().describe('Absolute path to a .pine file on disk'),
  }, async ({ pine_path }) => {
    try { return jsonResult(await core.deployScript({ pinePath: pine_path })); }
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
