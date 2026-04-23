/**
 * Core Pine Script logic — shared between MCP tools and CLI.
 * All functions accept plain options objects and return plain JS objects.
 * They throw on error (callers catch and format).
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';

// ── Monaco finder (injected into TV page) ──
export const FIND_MONACO = `
  (function findMonacoEditor() {
    var container = document.querySelector('.monaco-editor.pine-editor-monaco');
    if (!container) return null;
    var el = container;
    var fiberKey;
    for (var i = 0; i < 20; i++) {
      if (!el) break;
      fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
      if (fiberKey) break;
      el = el.parentElement;
    }
    if (!fiberKey) return null;
    var current = el[fiberKey];
    for (var d = 0; d < 15; d++) {
      if (!current) break;
      if (current.memoizedProps && current.memoizedProps.value && current.memoizedProps.value.monacoEnv) {
        var env = current.memoizedProps.value.monacoEnv;
        if (env.editor && typeof env.editor.getEditors === 'function') {
          var editors = env.editor.getEditors();
          if (editors.length > 0) return { editor: editors[0], env: env };
        }
      }
      current = current.return;
    }
    return null;
  })()
`;

/**
 * Opens the Pine Editor panel and waits for Monaco to become available.
 * Returns true if editor is accessible, false on timeout.
 *
 * 3-method cascade for opening the Pine editor — each method runs in order
 * and we stop as soon as Monaco appears. Surfaces which method did the work
 * (useful for TV-version-specific debugging).
 *
 * Method 1: [data-name="pine-dialog-button"] click — the modern selector
 * Method 2: TradingView.bottomWidgetBar.activateScriptEditorTab() — the JS API
 * Method 3: aria-label scan for any button containing "Pine" — old-TV fallback
 */
export async function ensurePineEditorOpen({ _forTesting = null } = {}) {
  // Quick check: is it already open?
  const already = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      return m !== null;
    })()
  `);
  if (already) return true;

  const poll = async (msLeft) => {
    const steps = Math.max(1, Math.ceil(msLeft / 200));
    for (let i = 0; i < steps; i++) {
      await new Promise(r => setTimeout(r, 200));
      const ready = await evaluate(`(function() { return ${FIND_MONACO} !== null; })()`);
      if (ready) return true;
    }
    return false;
  };

  // Method 1 — try modern data-name selector first
  const m1 = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="pine-dialog-button"]');
      if (btn) { btn.click(); return true; }
      return false;
    })()
  `);
  if (m1 && await poll(4000)) return true;

  // Method 2 — bottomWidgetBar JS API
  const m2 = await evaluate(`
    (function() {
      var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
      if (!bwb) return false;
      if (typeof bwb.activateScriptEditorTab === 'function') { bwb.activateScriptEditorTab(); return 'activated'; }
      if (typeof bwb.showWidget === 'function') { bwb.showWidget('pine-editor'); return 'shown'; }
      return false;
    })()
  `);
  if (m2 && await poll(4000)) return true;

  // Method 3 — aria-label scan for any "Pine"-ish button (older TV versions / i18n)
  const m3 = await evaluate(`
    (function() {
      var btn = document.querySelector('[aria-label="Pine"]');
      if (btn) { btn.click(); return 'aria-label-exact'; }
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var label = (btns[i].getAttribute('aria-label') || '').toLowerCase();
        if (label.indexOf('pine') !== -1) { btns[i].click(); return 'aria-label-fuzzy'; }
      }
      return false;
    })()
  `);
  if (m3 && await poll(4000)) return true;

  // All three methods failed — surface a descriptive error via a side-channel.
  // Callers get `false` and can throw with their own context.
  return false;
}

// ── Pure / offline functions ──

export function analyze({ source }) {
  const lines = source.split('\n');
  const diagnostics = [];

  let isV6 = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//@version=6')) { isV6 = true; break; }
    if (trimmed.startsWith('//@version=')) break;
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    break;
  }

  const arrays = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fromMatch = line.match(/(\w+)\s*=\s*array\.from\(([^)]*)\)/);
    if (fromMatch) {
      const name = fromMatch[1].trim();
      const args = fromMatch[2].trim();
      const size = args === '' ? 0 : args.split(',').length;
      arrays.set(name, { name, size, line: i + 1 });
      continue;
    }
    const newMatch = line.match(/(\w+)\s*=\s*array\.new(?:<\w+>|_\w+)\((\d+)?/);
    if (newMatch) {
      const name = newMatch[1].trim();
      const size = newMatch[2] !== undefined ? parseInt(newMatch[2], 10) : null;
      arrays.set(name, { name, size, line: i + 1 });
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const pattern = /array\.(get|set)\(\s*(\w+)\s*,\s*(-?\d+)/g;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      const method = match[1];
      const arrName = match[2];
      const idx = parseInt(match[3], 10);
      const info = arrays.get(arrName);
      if (!info || info.size === null) continue;
      if (idx < 0 || idx >= info.size) {
        diagnostics.push({
          line: i + 1, column: match.index + 1,
          message: `array.${method}(${arrName}, ${idx}) — index ${idx} out of bounds (array size is ${info.size})`,
          severity: 'error',
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const firstLastPattern = /(\w+)\.(first|last)\(\)/g;
    let match;
    while ((match = firstLastPattern.exec(line)) !== null) {
      const arrName = match[1];
      if (arrName === 'array') continue;
      const info = arrays.get(arrName);
      if (info && info.size === 0) {
        diagnostics.push({
          line: i + 1, column: match.index + 1,
          message: `${arrName}.${match[2]}() called on possibly empty array (declared with size 0)`,
          severity: 'warning',
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.includes('strategy.entry') || trimmed.includes('strategy.close')) {
      let hasStrategyDecl = false;
      for (const l of lines) {
        if (l.trim().startsWith('strategy(')) { hasStrategyDecl = true; break; }
      }
      if (!hasStrategyDecl) {
        diagnostics.push({
          line: i + 1, column: 1,
          message: 'strategy.entry/close used but no strategy() declaration found — did you mean to use indicator()?',
          severity: 'error',
        });
        break;
      }
    }
  }

  if (!isV6 && source.includes('//@version=')) {
    const vMatch = source.match(/\/\/@version=(\d+)/);
    if (vMatch && parseInt(vMatch[1]) < 5) {
      diagnostics.push({
        line: 1, column: 1,
        message: `Script uses Pine v${vMatch[1]} — consider upgrading to v6 for latest features`,
        severity: 'info',
      });
    }
  }

  return {
    success: true,
    issue_count: diagnostics.length,
    diagnostics,
    note: diagnostics.length === 0 ? 'No static analysis issues found. Use pine_compile or pine_smart_compile for full server-side compilation check.' : undefined,
  };
}

export async function check({ source }) {
  const formData = new URLSearchParams();
  formData.append('source', source);

  const response = await fetch(
    'https://pine-facade.tradingview.com/pine-facade/translate_light?user_name=Guest&pine_id=00000000-0000-0000-0000-000000000000',
    {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://www.tradingview.com/',
      },
      body: formData,
    }
  );

  if (!response.ok) {
    throw new Error(`TradingView API returned ${response.status}: ${response.statusText}`);
  }

  const result = await response.json();
  const errors = [];
  const warnings = [];
  const inner = result?.result;

  if (inner) {
    if (inner.errors2 && inner.errors2.length > 0) {
      for (const e of inner.errors2) {
        errors.push({
          line: e.start?.line, column: e.start?.column,
          end_line: e.end?.line, end_column: e.end?.column,
          message: e.message,
        });
      }
    }
    if (inner.warnings2 && inner.warnings2.length > 0) {
      for (const w of inner.warnings2) {
        warnings.push({ line: w.start?.line, column: w.start?.column, message: w.message });
      }
    }
  }

  if (result.error && typeof result.error === 'string') {
    errors.push({ message: result.error });
  }

  const compiled = errors.length === 0;
  return {
    success: true,
    compiled,
    error_count: errors.length,
    warning_count: warnings.length,
    errors: errors.length > 0 ? errors : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
    note: compiled ? 'Pine Script compiled successfully.' : undefined,
  };
}

// ── Functions requiring TradingView connection ──

export async function getSource() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor or Monaco not found in React fiber tree.');

  const source = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return null;
      return m.editor.getValue();
    })()
  `);

  if (source === null || source === undefined) {
    throw new Error('Monaco editor found but getValue() returned null.');
  }

  return { success: true, source, line_count: source.split('\n').length, char_count: source.length };
}

/**
 * Read the currently-active saved-slot name from the Pine editor's nameButton.
 * This is the ONLY reliable "which script slot am I about to overwrite?" probe.
 *
 * Returns null if no nameButton found (editor closed / not yet rendered).
 */
export async function getActiveSlotName() {
  return await evaluate(`
    (function() {
      var btn = document.querySelector('[class*="nameButton"]');
      return btn ? btn.textContent.trim() : null;
    })()
  `);
}

/**
 * Set Pine editor source.
 *
 * SAFETY (added 2026-04-23 after the RSI-pane overwrite incident):
 * Pass `expected_script_name` to make setSource refuse when the editor's
 * active saved slot does not match. This prevents the classic failure mode:
 *   1. User has slot "RSI pane" open with their code.
 *   2. Agent calls pine_set_source(...) thinking it's writing to a NEW slot.
 *   3. Ctrl+S later silently destroys "RSI pane".
 *
 * When `expected_script_name` is omitted AND `allow_unverified=false` (default),
 * this throws — forcing callers to either verify the slot or opt out explicitly.
 *
 * @param {object} opts
 * @param {string} opts.source - Pine Script source code to inject
 * @param {string} [opts.expected_script_name] - If set, abort when the live
 *   editor's active slot name doesn't match. Match is exact (trim, case-sensitive).
 * @param {boolean} [opts.allow_unverified=false] - Explicit opt-out of the
 *   slot-verification guard. Use only when you KNOW the editor is empty
 *   (e.g. right after pine_new). Logs a warning in the response either way.
 */
export async function setSource({ source, expected_script_name, allow_unverified = false }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const currentSlot = await getActiveSlotName();

  if (expected_script_name !== undefined && expected_script_name !== null) {
    if (currentSlot === null) {
      throw new Error(
        `setSource slot-verify: could not read editor's nameButton (cannot confirm ` +
        `active slot). Expected "${expected_script_name}". Call pine_switch_script ` +
        `first, or pass allow_unverified=true to bypass.`
      );
    }
    if (currentSlot !== expected_script_name) {
      throw new Error(
        `setSource slot-verify FAILED: editor's active slot is "${currentSlot}" but ` +
        `caller expected "${expected_script_name}". ` +
        `Refusing to write to avoid overwriting the wrong script. ` +
        `Fix: call pine_switch_script({name: "${expected_script_name}"}) first, ` +
        `or pass allow_unverified=true if you really want to write to "${currentSlot}".`
      );
    }
  } else if (!allow_unverified) {
    throw new Error(
      `setSource: no expected_script_name passed and allow_unverified=false. ` +
      `Active slot is "${currentSlot}". Pass expected_script_name="${currentSlot}" ` +
      `to confirm you intend to overwrite this slot, or allow_unverified=true to bypass. ` +
      `This guard was added 2026-04-23 after the RSI-pane overwrite incident.`
    );
  }

  const escaped = JSON.stringify(source);
  const set = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return false;
      m.editor.setValue(${escaped});
      return true;
    })()
  `);

  if (!set) throw new Error('Monaco found but setValue() failed.');
  return {
    success: true,
    lines_set: source.split('\n').length,
    active_slot: currentSlot,
    slot_verified: expected_script_name !== undefined && expected_script_name !== null,
  };
}

/**
 * Save the editor's CURRENT content to a NEW saved-script slot with the given name.
 *
 * Added 2026-04-23 to plug the "no way to create a new slot safely" gap that
 * caused the RSI-pane overwrite. Flow:
 *   1. Ensure Pine editor is open.
 *   2. Click the kebab / "more" menu that exposes the Save As action.
 *   3. Find the "Save as..." / "Zapisz jako..." menu item (i18n-aware) and click.
 *   4. Type `name` into the dialog's text input.
 *   5. Click the confirmation button (Save / Zapisz / OK).
 *   6. Read back the new nameButton text to confirm success.
 *
 * Returns { success, new_slot_name, previous_slot_name } or throws with a
 * descriptive error explaining which step failed so the user can intervene
 * manually if TV's UI markup has changed.
 */
export async function saveAs({ name }) {
  if (!name || typeof name !== 'string' || name.trim() === '') {
    throw new Error('saveAs: "name" must be a non-empty string');
  }
  const targetName = name.trim();
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const previousSlot = await getActiveSlotName();

  // Step 1 — open the "more" menu next to the script name.
  // TV's kebab button sits near the nameButton; multiple selector fallbacks cover i18n.
  const menuOpened = await evaluate(`
    (function() {
      // Primary: the well-known kebab within the pine editor toolbar
      var candidates = [
        '[data-name="more-button"]',
        '[data-name="pine-editor-menu"]',
        '[class*="menuButton"]',
        '[class*="moreButton"]',
      ];
      for (var i = 0; i < candidates.length; i++) {
        var btn = document.querySelector(candidates[i]);
        if (btn) { btn.click(); return candidates[i]; }
      }
      // Fallback: aria-label scan
      var btns = document.querySelectorAll('button');
      for (var j = 0; j < btns.length; j++) {
        var label = (btns[j].getAttribute('aria-label') || '').toLowerCase();
        if (label.indexOf('more') !== -1 || label.indexOf('menu') !== -1 || label.indexOf('wiecej') !== -1) {
          btns[j].click(); return 'aria-' + label;
        }
      }
      return null;
    })()
  `);
  if (!menuOpened) {
    throw new Error(
      'saveAs: could not find the Pine editor "more" / kebab menu button. ' +
      'TV UI selector may have changed. Fall back: use the UI manually to ' +
      'Save As, then pine_switch_script to the new slot.'
    );
  }
  await new Promise(r => setTimeout(r, 300));

  // Step 2 — click "Save as..." menu item
  const saveAsClicked = await evaluate(`
    (function() {
      var items = document.querySelectorAll('[role="menuitem"], [class*="menuItem"], [class*="item"]');
      var patterns = [
        /^Save as(\\.\\.\\.|…)?$/i,         // English
        /^Zapisz jako(\\.\\.\\.|…)?$/i,     // Polish
        /^Speichern unter(\\.\\.\\.|…)?$/i, // German
        /^Guardar como(\\.\\.\\.|…)?$/i,    // Spanish
        /^Enregistrer sous(\\.\\.\\.|…)?$/i,// French
      ];
      for (var i = 0; i < items.length; i++) {
        var t = items[i].textContent.trim();
        for (var p = 0; p < patterns.length; p++) {
          if (patterns[p].test(t)) { items[i].click(); return t; }
        }
      }
      return null;
    })()
  `);
  if (!saveAsClicked) {
    throw new Error(
      'saveAs: menu opened but could not find "Save as" item. ' +
      'UI may have changed or locale is unsupported. ' +
      'Supported locales: en, pl, de, es, fr.'
    );
  }
  await new Promise(r => setTimeout(r, 500));

  // Step 3 — fill the name dialog + confirm
  const filled = await evaluate(`
    (function() {
      // Look for text input inside a dialog
      var inputs = document.querySelectorAll('[role="dialog"] input[type="text"], [class*="dialog"] input[type="text"], input[placeholder*="Nazwa"], input[placeholder*="Name"], input[placeholder*="Title"]');
      if (inputs.length === 0) return { ok: false, reason: 'no_input' };
      var input = inputs[inputs.length - 1];
      // Native setter so React picks up the change
      var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(input, ${JSON.stringify(targetName)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    })()
  `);
  if (!filled || !filled.ok) {
    throw new Error('saveAs: dialog appeared but could not locate/fill the name input (' + (filled && filled.reason) + ').');
  }
  await new Promise(r => setTimeout(r, 300));

  const confirmed = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('[role="dialog"] button, [class*="dialog"] button');
      var patterns = [
        /^Save$/i, /^Zapisz$/i, /^Speichern$/i, /^Guardar$/i, /^Enregistrer$/i, /^OK$/i,
      ];
      for (var i = 0; i < btns.length; i++) {
        var t = btns[i].textContent.trim();
        for (var p = 0; p < patterns.length; p++) {
          if (patterns[p].test(t) && !btns[i].disabled) { btns[i].click(); return t; }
        }
      }
      return null;
    })()
  `);
  if (!confirmed) {
    throw new Error('saveAs: name entered but no Save/OK button found. UI may have changed.');
  }
  // TV needs a moment to round-trip save to server + update nameButton
  await new Promise(r => setTimeout(r, 1500));

  const newSlot = await getActiveSlotName();
  const success = newSlot === targetName;

  return {
    success,
    new_slot_name: newSlot,
    requested_name: targetName,
    previous_slot_name: previousSlot,
    confirm_button: confirmed,
    note: success
      ? `Saved "${previousSlot}" content to new slot "${newSlot}". Original slot is now on a detached editor view — call pine_switch_script to navigate between slots.`
      : `saveAs: clicked confirm but nameButton now reads "${newSlot}" instead of "${targetName}". This may indicate a duplicate-name auto-rename by TV, OR the save failed silently. Inspect via pine_list_scripts.`,
  };
}

export async function compile() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const clicked = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      var fallback = null;
      var saveBtn = null;
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (/save and add to chart/i.test(text)) {
          btns[i].click();
          return 'Save and add to chart';
        }
        if (!fallback && /^(Add to chart|Update on chart)/i.test(text)) {
          fallback = btns[i];
        }
        if (!saveBtn && btns[i].className.indexOf('saveButton') !== -1 && btns[i].offsetParent !== null) {
          saveBtn = btns[i];
        }
      }
      if (fallback) { fallback.click(); return fallback.textContent.trim(); }
      if (saveBtn) { saveBtn.click(); return 'Pine Save'; }
      return null;
    })()
  `);

  if (!clicked) {
    const c = await getClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  }

  await new Promise(r => setTimeout(r, 2000));
  return { success: true, button_clicked: clicked || 'keyboard_shortcut', source: 'dom_fallback' };
}

export async function getErrors() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const errors = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return [];
      var model = m.editor.getModel();
      if (!model) return [];
      var markers = m.env.editor.getModelMarkers({ resource: model.uri });
      return markers.map(function(mk) {
        return { line: mk.startLineNumber, column: mk.startColumn, message: mk.message, severity: mk.severity };
      });
    })()
  `);

  return {
    success: true,
    has_errors: errors?.length > 0,
    error_count: errors?.length || 0,
    errors: errors || [],
  };
}

export async function save() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const c = await getClient();
  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 's', code: 'KeyS' });
  await new Promise(r => setTimeout(r, 800));

  // Handle "Save Script" name dialog that appears for new/unsaved scripts
  const dialogHandled = await evaluate(`
    (function() {
      var saveBtn = null;
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (text === 'Save' && btns[i].offsetParent !== null) {
          // Check if it's in a dialog (not the Pine Editor save button)
          var parent = btns[i].closest('[class*="dialog"], [class*="modal"], [class*="popup"], [role="dialog"]');
          if (parent) { saveBtn = btns[i]; break; }
        }
      }
      if (saveBtn) { saveBtn.click(); return true; }
      return false;
    })()
  `);

  if (dialogHandled) await new Promise(r => setTimeout(r, 500));

  return { success: true, action: dialogHandled ? 'saved_with_dialog' : 'Ctrl+S_dispatched' };
}

export async function getConsole() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const entries = await evaluate(`
    (function() {
      var results = [];
      var rows = document.querySelectorAll('[class*="consoleRow"], [class*="log-"], [class*="consoleLine"]');
      if (rows.length === 0) {
        var bottomArea = document.querySelector('[class*="layout__area--bottom"]')
          || document.querySelector('[class*="bottom-widgetbar-content"]');
        if (bottomArea) {
          rows = bottomArea.querySelectorAll('[class*="message"], [class*="log"], [class*="console"]');
        }
      }
      if (rows.length === 0) {
        var pinePanel = document.querySelector('.pine-editor-container')
          || document.querySelector('[class*="pine-editor"]')
          || document.querySelector('[class*="layout__area--bottom"]');
        if (pinePanel) {
          var allSpans = pinePanel.querySelectorAll('span, div');
          for (var s = 0; s < allSpans.length; s++) {
            var txt = allSpans[s].textContent.trim();
            if (/^\\d{2}:\\d{2}:\\d{2}/.test(txt) || /error|warning|info/i.test(allSpans[s].className)) {
              rows = Array.from(rows || []);
              rows.push(allSpans[s]);
            }
          }
        }
      }
      for (var i = 0; i < rows.length; i++) {
        var text = rows[i].textContent.trim();
        if (!text) continue;
        var ts = null;
        var tsMatch = text.match(/^(\\d{4}-\\d{2}-\\d{2}\\s+)?\\d{2}:\\d{2}:\\d{2}/);
        if (tsMatch) ts = tsMatch[0];
        var type = 'info';
        var cls = rows[i].className || '';
        if (/error/i.test(cls) || /error/i.test(text.substring(0, 30))) type = 'error';
        else if (/compil/i.test(text.substring(0, 40))) type = 'compile';
        else if (/warn/i.test(cls)) type = 'warning';
        results.push({ timestamp: ts, type: type, message: text });
      }
      return results;
    })()
  `);

  return { success: true, entries: entries || [], entry_count: entries?.length || 0 };
}

export async function smartCompile() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const studiesBefore = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);

  const buttonClicked = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      var addBtn = null;
      var updateBtn = null;
      var saveBtn = null;
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (/save and add to chart/i.test(text)) {
          btns[i].click();
          return 'Save and add to chart';
        }
        if (!addBtn && /^add to chart$/i.test(text)) addBtn = btns[i];
        if (!updateBtn && /^update on chart$/i.test(text)) updateBtn = btns[i];
        if (!saveBtn && btns[i].className.indexOf('saveButton') !== -1 && btns[i].offsetParent !== null) saveBtn = btns[i];
      }
      if (addBtn) { addBtn.click(); return 'Add to chart'; }
      if (updateBtn) { updateBtn.click(); return 'Update on chart'; }
      if (saveBtn) { saveBtn.click(); return 'Pine Save'; }
      return null;
    })()
  `);

  if (!buttonClicked) {
    const c = await getClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  }

  await new Promise(r => setTimeout(r, 2500));

  const errors = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return [];
      var model = m.editor.getModel();
      if (!model) return [];
      var markers = m.env.editor.getModelMarkers({ resource: model.uri });
      return markers.map(function(mk) {
        return { line: mk.startLineNumber, column: mk.startColumn, message: mk.message, severity: mk.severity };
      });
    })()
  `);

  const studiesAfter = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);

  const studyAdded = (studiesBefore !== null && studiesAfter !== null) ? studiesAfter > studiesBefore : null;

  return {
    success: true,
    button_clicked: buttonClicked || 'keyboard_shortcut',
    has_errors: errors?.length > 0,
    errors: errors || [],
    study_added: studyAdded,
  };
}

export async function newScript({ type }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const typeMap = { indicator: 'indicator', strategy: 'strategy', library: 'library' };
  const templates = {
    indicator: '//@version=6\nindicator("My script")\nplot(close)',
    strategy: '//@version=6\nstrategy("My strategy", overlay=true)\n',
    library: '//@version=6\n// @description TODO: add library description here\nlibrary("MyLibrary")\n',
  };

  const template = templates[type] || templates.indicator;

  // Simply set the source to a new template — this is the most reliable approach
  const escaped = JSON.stringify(template);
  const set = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return false;
      m.editor.setValue(${escaped});
      return true;
    })()
  `);

  if (!set) throw new Error('Monaco editor not found. Ensure Pine Editor is open.');

  return { success: true, type, action: 'new_script_created', template: typeMap[type] };
}

/**
 * Fetch a saved Pine script's source from TV's pine-facade API, then inject
 * into the CURRENTLY-ACTIVE Monaco editor.
 *
 * WARNING (documented 2026-04-23 after a real overwrite incident):
 * This function REPLACES the active editor's content with the fetched source.
 * It does NOT switch the editor's slot. If the editor's current slot is
 * "MyOscillator" and you call openScript({name: "MyOverlay"}), you get
 * MyOverlay source sitting in the "MyOscillator" slot — one Ctrl+S and you
 * lose your MyOscillator.
 *
 * Defaults changed 2026-04-23: `confirm_overwrite_active_editor` must be true
 * to proceed. For "read source, don't touch editor" workflows use
 * `pine_get_source` after `pine_switch_script` instead.
 *
 * @param {object} opts
 * @param {string} opts.name - Saved script name to fetch.
 * @param {boolean} [opts.confirm_overwrite_active_editor=false] - Required true
 *   to proceed. This acknowledges you understand the active editor slot will
 *   be clobbered with the fetched source, NOT switched to a different slot.
 */
export async function openScript({ name, confirm_overwrite_active_editor = false }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  if (!confirm_overwrite_active_editor) {
    const active = await getActiveSlotName();
    throw new Error(
      `pine_open refusal: this function INJECTS the fetched source into the ` +
      `currently-active editor (slot: "${active}"), it does NOT switch slots. ` +
      `If your intent is "switch editor to show script X", call ` +
      `pine_switch_script({name: "${name}"}) instead. ` +
      `If you really want to overwrite the active slot's content with the ` +
      `fetched source, pass confirm_overwrite_active_editor=true. ` +
      `This guard was added 2026-04-23 after the RSI-pane overwrite incident.`
    );
  }

  const escapedName = JSON.stringify(name.toLowerCase());

  const result = await evaluateAsync(`
    (function() {
      var target = ${escapedName};
      return fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
        .then(function(r) { return r.json(); })
        .then(function(scripts) {
          if (!Array.isArray(scripts)) return {error: 'pine-facade returned unexpected data'};
          var match = null;
          for (var i = 0; i < scripts.length; i++) {
            var sn = (scripts[i].scriptName || '').toLowerCase();
            var st = (scripts[i].scriptTitle || '').toLowerCase();
            if (sn === target || st === target) { match = scripts[i]; break; }
          }
          if (!match) {
            for (var j = 0; j < scripts.length; j++) {
              var sn2 = (scripts[j].scriptName || '').toLowerCase();
              var st2 = (scripts[j].scriptTitle || '').toLowerCase();
              if (sn2.indexOf(target) !== -1 || st2.indexOf(target) !== -1) { match = scripts[j]; break; }
            }
          }
          if (!match) return {error: 'Script "' + target + '" not found. Use pine_list_scripts to see available scripts.'};

          var id = match.scriptIdPart;
          var ver = match.version || 1;
          return fetch('https://pine-facade.tradingview.com/pine-facade/get/' + id + '/' + ver, { credentials: 'include' })
            .then(function(r2) { return r2.json(); })
            .then(function(data) {
              var source = data.source || '';
              if (!source) return {error: 'Script source is empty', name: match.scriptName || match.scriptTitle};
              var m = ${FIND_MONACO};
              if (m) {
                m.editor.setValue(source);
                return {success: true, name: match.scriptName || match.scriptTitle, id: id, lines: source.split('\\n').length};
              }
              return {error: 'Monaco editor not found to inject source', name: match.scriptName || match.scriptTitle};
            });
        })
        .catch(function(e) { return {error: e.message}; });
    })()
  `);

  if (result?.error) {
    throw new Error(result.error);
  }

  return { success: true, name: result.name, script_id: result.id, lines: result.lines, source: 'internal_api', opened: true };
}

/**
 * Switch Pine editor to a different saved script via UI dropdown.
 * This properly switches the editor context (unlike openScript which just sets code).
 *
 * Steps: click nameButton → find script in dropdown → click at coordinates → verify
 */
export async function switchScript({ name }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  // 0. Short-circuit: if already on the target script, skip the switch
  const currentBefore = await evaluate(`
    (function() {
      var btn = document.querySelector('[class*="nameButton"]');
      return btn ? btn.textContent.trim() : null;
    })()
  `);
  if (currentBefore === name) {
    return { success: true, requested: name, current: name, shortCircuited: true };
  }

  // 1. Click the nameButton dropdown
  const dropdownOpened = await evaluate(`
    (function() {
      var btn = document.querySelector('[class*="nameButton"]');
      if (!btn) return false;
      btn.click();
      return true;
    })()
  `);
  if (!dropdownOpened) throw new Error('Could not find Pine editor nameButton dropdown');

  await new Promise(r => setTimeout(r, 500));

  // 2. Find target script coordinates in the dropdown
  const escapedName = JSON.stringify(name);
  const coords = await evaluate(`
    (function() {
      var target = ${escapedName};
      var allEls = document.querySelectorAll('*');
      for (var el of allEls) {
        var t = (el.textContent || '').trim();
        if (t === target && el.offsetParent !== null && el.offsetHeight > 15 && el.offsetHeight < 40 && el.childElementCount <= 1) {
          var rect = el.getBoundingClientRect();
          return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
        }
      }
      return null;
    })()
  `);

  if (!coords) {
    // Close dropdown
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}))`);
    throw new Error('Script "' + name + '" not found in dropdown. Check pine_list_scripts for available names.');
  }

  // 3. Click at coordinates
  const c = await getClient();
  await c.Input.dispatchMouseEvent({ type: 'mousePressed', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });
  await c.Input.dispatchMouseEvent({ type: 'mouseReleased', x: coords.x, y: coords.y, button: 'left', clickCount: 1 });

  await new Promise(r => setTimeout(r, 1000));

  // 4. Verify switch — throw on failure instead of returning success:false
  const currentName = await evaluate(`
    (function() {
      var btn = document.querySelector('[class*="nameButton"]');
      return btn ? btn.textContent.trim() : 'unknown';
    })()
  `);

  if (currentName !== name) {
    throw new Error(
      `switchScript failed: requested "${name}" but nameButton shows "${currentName}". ` +
      `The dropdown click at (${coords.x}, ${coords.y}) may have missed the target.`
    );
  }

  return {
    success: true,
    requested: name,
    current: currentName,
    coords,
  };
}

export async function listScripts() {
  const scripts = await evaluateAsync(`
    fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!Array.isArray(data)) return {scripts: [], error: 'Unexpected response from pine-facade'};
        return {
          scripts: data.map(function(s) {
            return {
              id: s.scriptIdPart || null,
              name: s.scriptName || s.scriptTitle || 'Untitled',
              title: s.scriptTitle || null,
              version: s.version || null,
              modified: s.modified || null,
            };
          })
        };
      })
      .catch(function(e) { return {scripts: [], error: e.message}; })
  `);

  return {
    success: true,
    scripts: scripts?.scripts || [],
    count: scripts?.scripts?.length || 0,
    source: 'internal_api',
    error: scripts?.error,
  };
}
