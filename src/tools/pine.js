import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/pine.js';

export function registerPineTools(server) {
  server.tool('pine_get_source', 'Get current Pine Script source code from the editor', {}, async () => {
    try { return jsonResult(await core.getSource()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_set_source',
    'Set Pine Script source code in the editor. SAFETY: by default requires ' +
    'expected_script_name OR allow_unverified=true to prevent accidental ' +
    'overwrites (RSI-pane-incident guard, added 2026-04-23). Use ' +
    'pine_get_active_slot first to discover the current slot name.',
    {
      source: z.string().describe('Pine Script source code to inject'),
      expected_script_name: z.string().optional().describe(
        'Active slot name (from pine_get_active_slot) to verify before writing. ' +
        'If mismatch with editor, throws. Recommended for every production call.'
      ),
      allow_unverified: z.boolean().optional().describe(
        'Set true to bypass slot-verify guard — ONLY safe right after pine_new ' +
        'when the editor is a fresh blank slot. Use sparingly.'
      ),
    }, async ({ source, expected_script_name, allow_unverified }) => {
      try { return jsonResult(await core.setSource({ source, expected_script_name, allow_unverified })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    });

  server.tool('pine_get_active_slot',
    'Read the name of the currently-active saved Pine script slot (nameButton dropdown text). ' +
    'Use this BEFORE pine_set_source to confirm which slot you\'re about to overwrite.',
    {}, async () => {
      try {
        const name = await core.getActiveSlotName();
        return jsonResult({ success: true, active_slot: name });
      }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    });

  server.tool('pine_compile', 'Compile / add the current Pine Script to the chart', {}, async () => {
    try { return jsonResult(await core.compile()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_get_errors', 'Get Pine Script compilation errors from Monaco markers', {}, async () => {
    try { return jsonResult(await core.getErrors()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_save', 'Save the current Pine Script (Ctrl+S) — overwrites the active slot in place.', {}, async () => {
    try { return jsonResult(await core.save()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_save_as',
    'Save the editor\'s CURRENT content to a NEW saved-script slot with the given name. ' +
    'Driving the "more" menu -> "Save as..." -> name dialog -> confirm flow. i18n-aware ' +
    '(en/pl/de/es/fr). Added 2026-04-23 — the safe way to create a new script slot ' +
    'from Pine editor without overwriting any existing slot.',
    {
      name: z.string().describe('Name for the new saved-script slot'),
    }, async ({ name }) => {
      try { return jsonResult(await core.saveAs({ name })); }
      catch (err) { return jsonResult({ success: false, error: err.message }, true); }
    });

  server.tool('pine_get_console', 'Read Pine Script console/log output (compile messages, log.info(), errors)', {}, async () => {
    try { return jsonResult(await core.getConsole()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_smart_compile', 'Intelligent compile: detects button, compiles, checks errors, reports study changes', {}, async () => {
    try { return jsonResult(await core.smartCompile()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_new', 'Create a new blank Pine Script', {
    type: z.enum(['indicator', 'strategy', 'library']).describe('Type of script to create'),
  }, async ({ type }) => {
    try { return jsonResult(await core.newScript({ type })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_open',
    'Fetch a saved Pine script\'s source from TV servers and INJECT it into ' +
    'the currently-active editor slot. This is NOT a slot switcher — use ' +
    'pine_switch_script for that. GUARD (2026-04-23): requires ' +
    'confirm_overwrite_active_editor=true to run. For "read a script\'s source ' +
    'without touching the editor", use pine_switch_script + pine_get_source.',
    {
      name: z.string().describe('Name of the saved script to fetch (case-insensitive match)'),
      confirm_overwrite_active_editor: z.boolean().optional().describe(
        'Required true to proceed. Acknowledges you understand the currently-' +
        'active editor slot\'s content will be REPLACED with the fetched source, ' +
        'NOT that the editor will switch to a different slot.'
      ),
    }, async ({ name, confirm_overwrite_active_editor }) => {
      try { return jsonResult(await core.openScript({ name, confirm_overwrite_active_editor })); }
      catch (err) { return jsonResult({ success: false, source: 'internal_api', error: err.message }, true); }
    });

  server.tool('pine_list_scripts', 'List saved Pine Scripts', {}, async () => {
    try { return jsonResult(await core.listScripts()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_analyze', 'Run static analysis on Pine Script code WITHOUT compiling — catches array out-of-bounds, unguarded array.first()/last(), bad loop bounds, and implicit bool casts. Works offline, no TradingView connection needed.', {
    source: z.string().describe('Pine Script source code to analyze'),
  }, async ({ source }) => {
    try { return jsonResult(core.analyze({ source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_check', 'Compile Pine Script via TradingView\'s server API without needing the chart open. Returns compilation errors/warnings. Useful for validating code before injecting into the chart.', {
    source: z.string().describe('Pine Script source code to compile/validate'),
  }, async ({ source }) => {
    try { return jsonResult(await core.check({ source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_switch_script', 'Switch Pine editor to a different script using the UI dropdown (reliable, unlike pine_open which only fetches code)', {
    name: z.string().describe('Name of the script to switch to in Pine editor'),
  }, async ({ name }) => {
    try { return jsonResult(await core.switchScript({ name })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
