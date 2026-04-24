/**
 * Pine Script deployment — reliable compile, save, add-to-chart, and
 * built-in study management via TradingView internal APIs.
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';
import { FIND_MONACO, ensurePineEditorOpen, switchScript } from './pine.js';
import { readFile } from 'node:fs/promises';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

// ── Helper: read the active script name from the Pine editor nameButton ──

/**
 * Returns the text of the Pine editor's nameButton (the active script name).
 * @returns {Promise<string|null>}  Script name or null if not found.
 */
export async function getActiveScriptName() {
  return evaluate(`
    (function() {
      var btn = document.querySelector('[class*="nameButton"]');
      return btn ? btn.textContent.trim() : null;
    })()
  `);
}

// ── 1. deployScript ──

/**
 * Full Pine deployment pipeline:
 *   open editor → set source → save → handle dialog → add/update on chart
 *
 * @param {string} pinePath  Absolute path to a .pine file on disk
 * @returns {{ success, errors, studyAdded, paneCount }}
 */
export async function deployScript({ pinePath }) {
  // Read source from disk
  const source = await readFile(pinePath, 'utf-8');
  if (!source.trim()) throw new Error(`File is empty: ${pinePath}`);

  // Step 1 — open Pine Editor
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor (Monaco not found).');

  // Step 2 — inject source via React Fiber Monaco setValue (proven reliable)
  const escaped = JSON.stringify(source);
  const injected = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return false;
      m.editor.setValue(${escaped});
      return true;
    })()
  `);
  if (!injected) throw new Error('Monaco editor found but setValue() failed.');

  // Step 3 — count studies before compile
  const studiesBefore = await evaluate(`
    (function() {
      try {
        var chart = ${CHART_API};
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);

  // Step 4 — click saveButton class (most reliable selector)
  const saveClicked = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        if (btns[i].className.indexOf('saveButton') !== -1 && btns[i].offsetParent !== null) {
          btns[i].click();
          return true;
        }
      }
      return false;
    })()
  `);

  if (!saveClicked) {
    // Fallback: Ctrl+S
    const c = await getClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 's', code: 'KeyS' });
  }

  await new Promise(r => setTimeout(r, 1200));

  // Step 5 — handle "Save Script" dialog (name input + Save button)
  await evaluate(`
    (function() {
      var dialog = document.querySelector('[role="dialog"]')
        || document.querySelector('[class*="dialog"]')
        || document.querySelector('[class*="modal"]');
      if (!dialog) return false;
      var saveBtn = null;
      var btns = dialog.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (text === 'Save' || text === 'Zapisz') {
          saveBtn = btns[i];
          break;
        }
      }
      if (saveBtn) { saveBtn.click(); return true; }
      return false;
    })()
  `);

  await new Promise(r => setTimeout(r, 1000));

  // Step 6 — click "Add to chart" or "Update on chart" (EN + PL, handles doubled text)
  const addClicked = await evaluate(`
    (function() {
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        // EN: "Add to chart", "Update on chart"
        // PL: "Dodaj do wykresu", doubled: "Dodaj do wykresuDodaj do wykresu"
        // Also: "Aktualizuj na wykresie"
        if (/^(Add to chart|Update on chart)/i.test(text)
          || /^(Dodaj do wykresu|Aktualizuj na wykresie)/i.test(text)) {
          btns[i].click();
          return text;
        }
      }
      return null;
    })()
  `);

  if (!addClicked) {
    // Fallback: Ctrl+Enter (TradingView shortcut for "Add to chart")
    const c = await getClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  }

  await new Promise(r => setTimeout(r, 2500));

  // Step 7 — collect errors from Monaco markers
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

  // Step 8 — count studies after + get pane count
  const postState = await evaluate(`
    (function() {
      try {
        var chart = ${CHART_API};
        var studyCount = chart.getAllStudies().length;
        var cwc = window.TradingViewApi._chartWidgetCollection;
        var paneCount = null;
        if (cwc && cwc._paneWidgets) paneCount = cwc._paneWidgets.length;
        else {
          // Fallback: count pane wrappers in DOM
          var panes = document.querySelectorAll('[class*="pane-"]');
          if (panes.length > 0) paneCount = panes.length;
        }
        return { studyCount: studyCount, paneCount: paneCount };
      } catch(e) { return { studyCount: null, paneCount: null }; }
    })()
  `);

  const studyAdded = (studiesBefore !== null && postState.studyCount !== null)
    ? postState.studyCount > studiesBefore
    : null;

  // Read the nameButton to confirm which script slot we actually saved to
  const savedAs = await getActiveScriptName();

  return {
    success: (errors || []).length === 0,
    errors: errors || [],
    studyAdded,
    savedAs,
    paneCount: postState.paneCount,
    buttonClicked: addClicked || 'keyboard_shortcut',
    saveMethod: saveClicked ? 'saveButton_class' : 'ctrl_s',
  };
}

// ── 1b. deployMultipleScripts ──

/**
 * Deploy multiple Pine scripts to chart as separate indicators.
 * For i > 0, uses switchScript (UI dropdown click + verification) to
 * switch the editor to the correct saved script slot before deploying.
 *
 * @param {Array<{pinePath: string, savedScriptName?: string}>} scripts
 *   Array of scripts to deploy. First one deploys normally.
 *   Subsequent ones MUST have savedScriptName — the name of an existing
 *   saved script to switch to before deploying into that slot.
 * @returns {{ success, results: Array, finalStudies: string[] }}
 */
export async function deployMultipleScripts({ scripts }) {
  if (!scripts || scripts.length === 0) throw new Error('No scripts provided');

  const results = [];

  for (let i = 0; i < scripts.length; i++) {
    const { pinePath, savedScriptName } = scripts[i];

    if (i > 0) {
      // For scripts after the first, we must switch editor context
      if (!savedScriptName) {
        throw new Error(
          `scripts[${i}] (${pinePath}): savedScriptName is required for all scripts after the first. ` +
          `The editor needs a target script slot to switch to before deploying.`
        );
      }

      // Use the proven switchScript from pine.js (nameButton dropdown + CDP mouse click + verify)
      const switchResult = await switchScript({ name: savedScriptName });
      if (!switchResult.success) {
        throw new Error(
          `Failed to switch editor to "${savedScriptName}" before deploying ${pinePath}. ` +
          `nameButton shows "${switchResult.current}" instead. ` +
          `Available scripts can be checked with pine_list_scripts.`
        );
      }
    }

    // Deploy this script into the current editor slot
    const result = await deployScript({ pinePath });

    // Verify we saved to the expected slot (for i > 0)
    if (i > 0 && savedScriptName && result.savedAs && result.savedAs !== savedScriptName) {
      // The deploy went to a different slot than intended — warn but don't fail
      result._slotMismatch = {
        expected: savedScriptName,
        actual: result.savedAs,
      };
    }

    results.push({ pinePath, ...result });

    if (!result.success) break;
  }

  // Final state
  const finalStudies = await evaluate(`
    (function() {
      try {
        return ${CHART_API}.getAllStudies().map(function(s) { return s.name; });
      } catch(e) { return []; }
    })()
  `);

  return {
    success: results.every(r => r.success),
    results,
    finalStudies: finalStudies || [],
  };
}

// ── 2. addBuiltinStudy ──

/**
 * Add a built-in TradingView indicator via the chart API.
 *
 * @param {string} name   Full study name, e.g. 'Relative Strength Index'
 * @param {object} [params]  Input overrides as {id: value} pairs
 * @returns {{ success, entityId, studyName }}
 */
export async function addBuiltinStudy({ name, params }) {
  const inputArr = params ? Object.entries(params).map(([k, v]) => ({ id: k, value: v })) : [];

  const before = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);

  await evaluate(`
    (function() {
      var chart = ${CHART_API};
      chart.createStudy(${JSON.stringify(name)}, false, false, ${JSON.stringify(inputArr)});
    })()
  `);

  await new Promise(r => setTimeout(r, 1500));

  const after = await evaluate(`${CHART_API}.getAllStudies().map(function(s) { return s.id; })`);
  const newIds = (after || []).filter(id => !(before || []).includes(id));

  return {
    success: newIds.length > 0,
    entityId: newIds[0] || null,
    studyName: name,
    newStudyCount: newIds.length,
  };
}

// ── 3. removeStudy ──

/**
 * Remove an indicator/study by matching its title substring.
 *
 * BUG FIX 2026-04-24: previous implementation walked dataSources() and called
 * removeDataSource(), which silently failed in current TradingView builds —
 * returned success+removedCount but chart_get_state immediately after still
 * showed the same studies. Discovered while building pine_push.js auto-cleanup
 * for the smc-engine indicator (max-5-instance error).
 *
 * Fix: use the same internal API that chart_manage_indicator uses successfully:
 * chart.getAllStudies() returns [{id, name, ...}] and chart.removeEntity(id)
 * actually removes. This is the canonical TradingView API path.
 *
 * @param {string} titleMatch  Substring to match against study title (case-insensitive)
 * @returns {{ success, removed, matched }}
 */
export async function removeStudy({ titleMatch }) {
  const result = await evaluate(`
    (function() {
      var target = ${JSON.stringify(titleMatch.toLowerCase())};
      var chart = ${CHART_API};
      var studies = (typeof chart.getAllStudies === 'function') ? (chart.getAllStudies() || []) : [];
      var removed = [];
      var matched = [];

      for (var i = 0; i < studies.length; i++) {
        var s = studies[i];
        var name = (s && s.name) ? String(s.name).toLowerCase() : '';
        if (name.indexOf(target) !== -1) {
          matched.push(s.name);
          try {
            chart.removeEntity(s.id);
            removed.push(s.name);
          } catch(e) {
            // Best-effort: keep the title in matched but not in removed if removeEntity throws
          }
        }
      }
      return { removed: removed, matched: matched };
    })()
  `);

  return {
    success: (result?.removed?.length || 0) > 0,
    removed: result?.removed || [],
    matched: result?.matched || [],
    removedCount: result?.removed?.length || 0,
  };
}

// ── 4. getChartIndicators ──

/**
 * List all indicators on the chart with pane information.
 *
 * @returns {{ success, indicators[], paneCount }}
 */
export async function getChartIndicators() {
  const result = await evaluate(`
    (function() {
      var chart = ${CHART_API};
      var model = chart._chartWidget.model();
      var sources = model.model().dataSources();
      var indicators = [];

      for (var i = 0; i < sources.length; i++) {
        var src = sources[i];
        var info = { title: '', type: '', entityId: null, paneIndex: null, visible: null };

        try {
          if (typeof src.title === 'function') info.title = src.title();
          else if (src._metaInfo && src._metaInfo.description) info.title = src._metaInfo.description;
        } catch(e) {}

        try {
          if (src._metaInfo) {
            info.type = src._metaInfo.shortId || src._metaInfo.id || '';
          }
        } catch(e) {}

        try {
          if (typeof src.entityId === 'function') info.entityId = src.entityId();
        } catch(e) {}

        try {
          if (typeof src.isVisible === 'function') info.visible = src.isVisible();
        } catch(e) {}

        // Find which pane this source belongs to
        try {
          var paneViews = model.model().panes();
          for (var p = 0; p < paneViews.length; p++) {
            var paneSources = paneViews[p].dataSources();
            for (var ps = 0; ps < paneSources.length; ps++) {
              if (paneSources[ps] === src) { info.paneIndex = p; break; }
            }
            if (info.paneIndex !== null) break;
          }
        } catch(e) {}

        // Skip main series (the candlestick data itself)
        if (info.type === 'MainSeries' || info.title === '') continue;

        indicators.push(info);
      }

      var paneCount = null;
      try { paneCount = model.model().panes().length; } catch(e) {}

      return { indicators: indicators, paneCount: paneCount };
    })()
  `);

  return {
    success: true,
    indicators: result?.indicators || [],
    indicatorCount: result?.indicators?.length || 0,
    paneCount: result?.paneCount,
  };
}
