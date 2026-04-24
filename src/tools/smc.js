/**
 * SMC tools — bridge tv-mcp ↔ smc-engine Python sidecar.
 *
 * Three MCP tools:
 *   - smc_analyze       : pull OHLCV from current chart, run smc-engine,
 *                          return ranked patterns as JSON
 *   - smc_render_top    : pull OHLCV, generate Pine overlay code, push to
 *                          Pine editor (and optionally save as named slot)
 *   - smc_rank_assets   : iterate a list of symbols, run analyze on each,
 *                          return ranked by best-pattern composite score
 *
 * All three depend on smc-engine being installed at $SMC_ENGINE_PATH
 * (default ~/ai/smc-engine, override via env). The bridge auto-spawns the
 * Python subprocess on first call and evicts after 5 min idle.
 */

import { z } from 'zod';
import { jsonResult } from './_format.js';
import { callSmcEngine } from '../core/smc-bridge.js';
import * as data from '../core/data.js';
import * as chart from '../core/chart.js';
import * as pine from '../core/pine.js';

/**
 * Pull OHLCV from the current TV chart and reshape to smc-engine's expected
 * format: list of [ts_seconds, o, h, l, c, v] rows.
 */
async function _pullOhlcvForSmc({ count } = {}) {
  const raw = await data.getOhlcv({ count, summary: false });
  // raw.bars is an array of {time, open, high, low, close, volume}
  const bars = raw?.bars || raw?.data || [];
  if (!Array.isArray(bars) || bars.length === 0) {
    throw new Error('No OHLCV available — is a chart open with bars loaded?');
  }
  return bars.map((b) => [
    Math.floor((b.time || b.timestamp || 0) / 1000), // ms → s
    b.open, b.high, b.low, b.close, b.volume || 0,
  ]);
}

export function registerSmcTools(server) {
  server.tool(
    'smc_analyze',
    'Detect SMC patterns (Order Blocks + Fair Value Gaps) on the current TV chart via the prezis/smc-engine Python sidecar. Returns ranked patterns with quality scores. Pulls OHLCV automatically — chart must be open.',
    {
      concepts: z.array(z.enum(['ob', 'fvg'])).optional().default(['ob', 'fvg'])
        .describe('Which SMC concepts to detect'),
      top_n: z.coerce.number().int().min(1).max(50).optional().default(10)
        .describe('Max patterns to return'),
      side: z.enum(['bullish', 'bearish', 'both', 'auto']).optional().default('auto')
        .describe('"auto" = bullish below price + bearish above (bias-aware)'),
      pivot_length: z.coerce.number().int().min(3).max(20).optional().default(7)
        .describe('Swing pivot length (also drives bias-guard truncation)'),
      min_score: z.coerce.number().min(0).max(100).optional().default(50.0)
        .describe('Drop patterns scoring below this'),
      bars: z.coerce.number().int().min(100).max(20000).optional().default(2000)
        .describe('How many recent bars to pull from TV (more = more patterns + slower)'),
    },
    async ({ concepts, top_n, side, pivot_length, min_score, bars }) => {
      try {
        const ohlcv = await _pullOhlcvForSmc({ count: bars });
        const result = await callSmcEngine('analyze', {
          ohlcv,
          concepts,
          top_n,
          side,
          pivot_length,
          min_score,
        });
        return jsonResult({
          symbol: (await chart.getState())?.symbol || null,
          n_patterns: result.patterns?.length || 0,
          patterns: result.patterns || [],
          summary: result.summary || {},
        });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'smc_render_top',
    'Generate a Pine v6 overlay highlighting the top-N SMC patterns and push it to the Pine editor (optionally save as named slot). Combines smc_analyze + Pine deploy in one shot.',
    {
      indicator_name: z.string().optional().default('SMC-Overlay')
        .describe('Indicator title (becomes the slot name on save)'),
      top_n: z.coerce.number().int().min(1).max(20).optional().default(5)
        .describe('How many top patterns to render'),
      concepts: z.array(z.enum(['ob', 'fvg'])).optional().default(['ob', 'fvg']),
      side: z.enum(['bullish', 'bearish', 'both', 'auto']).optional().default('auto'),
      pivot_length: z.coerce.number().int().min(3).max(20).optional().default(7),
      min_score: z.coerce.number().min(0).max(100).optional().default(50.0),
      bars: z.coerce.number().int().min(100).max(20000).optional().default(2000),
      push_to_editor: z.coerce.boolean().optional().default(true)
        .describe('If true, sets editor source via pine_set_source'),
      save_as_slot: z.coerce.boolean().optional().default(false)
        .describe('If true, also calls pine_save_as with indicator_name'),
    },
    async ({
      indicator_name, top_n, concepts, side, pivot_length, min_score, bars,
      push_to_editor, save_as_slot,
    }) => {
      try {
        const ohlcv = await _pullOhlcvForSmc({ count: bars });
        const result = await callSmcEngine('render', {
          ohlcv,
          concepts,
          top_n,
          side,
          pivot_length,
          min_score,
          indicator_name,
          right_bars: 30,
        });
        const pineCode = result.pine_snippet;
        if (!pineCode) {
          throw new Error('smc-engine returned no Pine snippet');
        }

        let pineSetResult = null;
        let pineSaveResult = null;
        if (push_to_editor) {
          pineSetResult = await pine.setSource({ source: pineCode, allow_unverified: true });
        }
        if (save_as_slot) {
          pineSaveResult = await pine.saveAs({ name: indicator_name });
        }

        return jsonResult({
          symbol: (await chart.getState())?.symbol || null,
          n_patterns: result.patterns?.length || 0,
          pine_chars: pineCode.length,
          push_to_editor,
          save_as_slot,
          pine_set_result: pineSetResult,
          pine_save_result: pineSaveResult,
          summary: result.summary || {},
        });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );

  server.tool(
    'smc_rank_assets',
    'Rank multiple symbols by best SMC setup quality. Iterates the supplied symbols, switches the chart to each, pulls OHLCV, runs smc-engine, and returns a ranked list (best top-pattern score first). Slow — sequential per-symbol chart switches.',
    {
      symbols: z.array(z.string()).min(1).max(20)
        .describe('List of TradingView symbols (e.g., ["BINANCE:BTCUSDT", "BINANCE:ETHUSDT"])'),
      timeframe: z.string().optional()
        .describe('Optional TF to switch to (e.g., "240" for 4h). Otherwise keeps current.'),
      top_per_symbol: z.coerce.number().int().min(1).max(10).optional().default(3),
      bars: z.coerce.number().int().min(100).max(10000).optional().default(2000),
      concepts: z.array(z.enum(['ob', 'fvg'])).optional().default(['ob', 'fvg']),
      side: z.enum(['bullish', 'bearish', 'both', 'auto']).optional().default('auto'),
      min_score: z.coerce.number().min(0).max(100).optional().default(50.0),
    },
    async ({ symbols, timeframe, top_per_symbol, bars, concepts, side, min_score }) => {
      try {
        const originalState = await chart.getState();
        const results = [];

        for (const sym of symbols) {
          try {
            await chart.setSymbol({ symbol: sym });
            if (timeframe) await chart.setTimeframe({ timeframe });
            // Wait briefly for chart to load — TV's redraw isn't instant
            await new Promise((r) => setTimeout(r, 800));

            const ohlcv = await _pullOhlcvForSmc({ count: bars });
            const result = await callSmcEngine('analyze', {
              ohlcv,
              concepts,
              top_n: top_per_symbol,
              side,
              pivot_length: 7,
              min_score,
            });
            const patterns = result.patterns || [];
            const top = patterns[0];
            results.push({
              symbol: sym,
              n_patterns: patterns.length,
              top_score: top?.score || 0,
              top_type: top?.type || null,
              top_zone: top ? { high: top.top, low: top.bottom } : null,
              bias: result.summary?.bias?.bias || 'unknown',
            });
          } catch (perr) {
            results.push({ symbol: sym, error: perr.message });
          }
        }

        // Restore original chart state
        if (originalState?.symbol) {
          try {
            await chart.setSymbol({ symbol: originalState.symbol });
            if (originalState.timeframe) await chart.setTimeframe({ timeframe: originalState.timeframe });
          } catch (_) { /* ignore restore errors */ }
        }

        results.sort((a, b) => (b.top_score || 0) - (a.top_score || 0));
        return jsonResult({
          ranked: results,
          best: results[0]?.symbol || null,
        });
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    }
  );
}
