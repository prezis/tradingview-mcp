#!/usr/bin/env node
// Push scripts/current.pine → TradingView editor, then compile
import CDP from 'chrome-remote-interface';
import { readFileSync } from 'fs';

const srcPath = new URL('../scripts/current.pine', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const src = readFileSync(srcPath, 'utf-8');

const targets = await (await fetch('http://localhost:9222/json/list')).json();
const t = targets.find(t => t.url?.includes('tradingview.com'));
if (!t) { console.error('No TradingView target'); process.exit(1); }
const c = await CDP({ host: 'localhost', port: 9222, target: t.id });
await c.Runtime.enable();

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
// ALWAYS send Ctrl+Enter as well — this is TV's canonical "Add to chart" shortcut
// (per user 2026-04-24). When source is identical to saved slot, button matcher
// only finds "Pine Save" (saves source but doesn't refresh chart instance).
// Ctrl+Enter is the only reliable way to trigger Add-to-chart from automation.
// Safe to send: if indicator already on chart, TV treats it as Update (idempotent).
await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
console.log('Ctrl+Enter sent (Add to chart shortcut)');

// Wait then check errors
await new Promise(r => setTimeout(r, 3000));
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
