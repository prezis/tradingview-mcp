#!/usr/bin/env node
// Push scripts/current.pine → TradingView editor, then compile
import CDP from 'chrome-remote-interface';
import { readFileSync } from 'fs';

// Source: command-line arg #1 if given (absolute or relative path),
// else fallback to scripts/current.pine for back-compat.
// Bug fix 2026-04-24: previously argv was silently ignored — pushes always
// went from current.pine even when caller passed a different file.
const argPath = process.argv[2];
const srcPath = argPath
  ? (argPath.startsWith('/') ? argPath : new URL(`../${argPath}`, import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'))
  : new URL('../scripts/current.pine', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const src = readFileSync(srcPath, 'utf-8');
console.log(`Source: ${srcPath} (${src.length} bytes)`);

const targets = await (await fetch('http://localhost:9222/json/list')).json();
const t = targets.find(t => t.url?.includes('tradingview.com'));
if (!t) { console.error('No TradingView target'); process.exit(1); }
const c = await CDP({ host: 'localhost', port: 9222, target: t.id });
await c.Runtime.enable();

// === USER 2026-04-24: ALWAYS remove all matching instances of the indicator
// before pushing. Without this, pine_push double-adds (button click + Ctrl+Enter)
// and TV's max-5-indicator limit is reached after a few pushes. Auto-remove
// ALL instances whose legend title matches the active editor's `indicator()` name.
const indicatorName = (() => {
  // Extract indicator name from source: matches indicator(title="SMC Engine", ...) etc.
  const m = src.match(/indicator\s*\(\s*(?:title\s*=\s*)?["']([^"']+)["']/);
  return m ? m[1] : null;
})();

if (indicatorName) {
  // Use TradingView's internal chart API (same path as tradingview-mcp's
  // chart_manage_indicator). DOM-scraping approach (legend-source-item +
  // hover-reveal delete button) was unreliable across TV UI updates and
  // returned removedCount=0 even when items were visible.
  // chart.getAllStudies() → [{id, name, ...}], chart.removeEntity(id) → removes.
  // VERIFIED 2026-04-24: this is what chart_manage_indicator(remove) calls.
  // Sibling MCP `pine_remove_study` is BROKEN (returns success but no-op).
  const removed = (await c.Runtime.evaluate({
    expression: `(function(){
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        var name = ${JSON.stringify(indicatorName)};
        var studies = chart.getAllStudies() || [];
        var matching = studies.filter(function(s){
          var n = (s.name || '').trim();
          return n === name || n.startsWith(name + ' ') || n.startsWith(name + '\\u00a0') || n.startsWith(name + '(');
        });
        var ids = matching.map(function(s){ return s.id; });
        ids.forEach(function(id){ chart.removeEntity(id); });
        return {removedCount: ids.length, ids: ids};
      } catch (e) {
        return {removedCount: 0, error: e.message};
      }
    })()`,
    returnByValue: true,
  })).result?.value || {removedCount: 0};

  if (removed.removedCount > 0) {
    console.log('Pre-push cleanup: removed', removed.removedCount, 'existing instance(s) of "' + indicatorName + '" via chart.removeEntity');
    // Wait for TV to fully process the removals before adding new (heavy indicator needs more time)
    await new Promise(r => setTimeout(r, 1500));
  } else if (removed.error) {
    console.log('Pre-push cleanup ERROR (continuing anyway):', removed.error);
  }
}

// Inject source
const escaped = JSON.stringify(src);
const set = (await c.Runtime.evaluate({
  expression: `(function(){var c=document.querySelector(".monaco-editor.pine-editor-monaco");if(!c)return false;var el=c;var fk;for(var i=0;i<20;i++){if(!el)break;fk=Object.keys(el).find(function(k){return k.startsWith("__reactFiber$")});if(fk)break;el=el.parentElement}if(!fk)return false;var cur=el[fk];for(var d=0;d<15;d++){if(!cur)break;if(cur.memoizedProps&&cur.memoizedProps.value&&cur.memoizedProps.value.monacoEnv){var env=cur.memoizedProps.value.monacoEnv;if(env.editor&&typeof env.editor.getEditors==="function"){var eds=env.editor.getEditors();if(eds.length>0){eds[0].setValue(${escaped});return true}}}cur=cur.return}return false})()`,
  returnByValue: true,
})).result?.value;

if (!set) { console.error('Could not inject into Pine editor'); await c.close(); process.exit(1); }
console.log(`Pushed ${src.split('\n').length} lines → Pine editor`);

// Click compile button — TV's "Add to chart" is an ICON-ONLY button with text in `title` attr,
// not in textContent. Earlier regex on .textContent never matched. Now also check title attribute.
// (Discovered 2026-04-24 via DOM inspection: button[title="Add to chart"] in Pine editor toolbar.)
const clicked = (await c.Runtime.evaluate({
  expression: '(function(){var btns=document.querySelectorAll("button");for(var i=0;i<btns.length;i++){var b=btns[i];if(!b.offsetParent)continue;var t=b.textContent.trim();var ti=(b.getAttribute("title")||"").trim();if(/save and add to chart/i.test(t)){b.click();return "btn:"+t}if(/^(Add to chart|Update on chart)/i.test(t)||/^(Add to chart|Update on chart)/i.test(ti)){b.click();return "btn:"+(t||ti)}}for(var i=0;i<btns.length;i++){if(btns[i].className.indexOf("saveButton")!==-1&&btns[i].offsetParent!==null){btns[i].click();return "Pine Save"}}return null})()',
  returnByValue: true,
})).result?.value;

console.log('Compile:', clicked || 'keyboard fallback');
// Send Ctrl+Enter ONLY if button click DIDN'T find an Add/Update button.
// USER 2026-04-24: doing BOTH was double-adding the indicator (button + keyboard
// each trigger an add) → multiple stacked instances → "max 5" error after a few pushes.
// Logic: if `clicked` matched "btn:Add to chart" or "btn:Update on chart", that handler
// already triggered the chart update — skip the keyboard fallback. Only fire Ctrl+Enter
// when button matcher returned null OR matched only "Pine Save" (which saves source but
// doesn't add to chart).
const buttonAddedToChart = clicked && /^btn:(Add to chart|Update on chart)/i.test(clicked);
if (!buttonAddedToChart) {
  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  console.log('Ctrl+Enter sent (Add to chart fallback — button matcher missed it)');
} else {
  console.log('Skipping Ctrl+Enter (button matcher already triggered Add/Update)');
}

// Wait then handle the "Cannot add a script with unsaved changes" confirmation dialog if present.
// (Fix 2026-04-24: TV pops a dialog asking to save before adding when source differs from saved slot.
// Without clicking "Save and add to chart" the chart never updates → vision sees stale state → false-positive.)
// USER 2026-04-24 (workflow note): the SMC indicator got heavy — TV needs ~3× more time to load
// it on Add to chart. Old waits (800ms dialog / 2200ms compile) caused premature error checks.
// Increased to 2400ms / 6600ms to match real compile-and-render time.
await new Promise(r => setTimeout(r, 2400));
const dialogClicked = (await c.Runtime.evaluate({
  expression: '(function(){var btns=document.querySelectorAll("button");for(var i=0;i<btns.length;i++){var b=btns[i];if(!b.offsetParent)continue;var t=(b.textContent||"").trim();if(/^save and add to chart$/i.test(t)||/^zapisz i dodaj/i.test(t)){b.click();return "dialog: "+t}}return null})()',
  returnByValue: true,
})).result?.value;
if (dialogClicked) console.log('Dialog handled:', dialogClicked);

// Wait then check errors (3× longer to accommodate heavy indicator compile)
await new Promise(r => setTimeout(r, 6600));
const errors = (await c.Runtime.evaluate({
  expression: '(function(){var c=document.querySelector(".monaco-editor.pine-editor-monaco");if(!c)return[];var el=c;var fk;for(var i=0;i<20;i++){if(!el)break;fk=Object.keys(el).find(function(k){return k.startsWith("__reactFiber$")});if(fk)break;el=el.parentElement}if(!fk)return[];var cur=el[fk];for(var d=0;d<15;d++){if(!cur)break;if(cur.memoizedProps&&cur.memoizedProps.value&&cur.memoizedProps.value.monacoEnv){var env=cur.memoizedProps.value.monacoEnv;if(env.editor&&typeof env.editor.getEditors==="function"){var eds=env.editor.getEditors();if(eds.length>0){var model=eds[0].getModel();var markers=env.editor.getModelMarkers({resource:model.uri});return markers.map(function(m){return{line:m.startLineNumber,msg:m.message}})}}}cur=cur.return}return[]})()',
  returnByValue: true,
})).result?.value || [];

if (errors.length === 0) {
  console.log('✅ Compiled clean — 0 errors');
} else {
  console.log(`❌ ${errors.length} errors:`);
  errors.forEach(e => console.log(`  Line ${e.line}: ${e.msg}`));
}

await c.close();
