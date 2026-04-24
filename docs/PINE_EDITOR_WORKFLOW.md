# Pine Editor Workflow — Canonical Recipes

How to drive TradingView's Pine editor via tv-mcp **without overwriting the wrong script**.

This is the "what to do" companion to `PINE_EDITOR_GOTCHAS.md` (the "what NOT to do" reference). Both were written 2026-04-23 after we destroyed an RSI pane slot by writing into the wrong editor buffer.

The rules below are derived from real session experience, not theory. Every recipe was verified live against TradingView Desktop on 2026-04-23.

---

## Mental model — what is a "Pine slot"?

TV stores every Pine script you've saved as a **slot** in its cloud, identified by a UUID. The Pine editor in the desktop app shows ONE slot at a time. Three things that look the same and are NOT the same:

| Concept | What it is | Where to read it | Where to set it |
|---|---|---|---|
| **Slot name** | The "filename" — what shows in the dropdown list of saved scripts | `pine_list_scripts[].name` and the `nameButton` text in the editor toolbar | `pine_save_as`, dropdown → "Rename...", or auto-derived from indicator() title on first save of an Untitled buffer |
| **Indicator title** | The string passed to `indicator("...")` / `strategy("...")` / `library("...")` in the source | First non-comment line of source | Edit the source code |
| **Editor buffer** | The Monaco text area that actually accepts your typing | `pine_get_source` returns this | `pine_set_source` writes to this |

**Critical insight**: `pine_set_source` writes to **whatever slot is currently open in the editor**. It does NOT switch slots. If the editor is showing `MyOscillator` and you call `pine_set_source(source=my_new_indicator_code)`, then `pine_save` (Ctrl+S), you have **destroyed the MyOscillator slot**. There is no undo inside our tooling. TV's manual version history (Pro+ only, dropdown → "Version history...") is the only recovery path.

## TV Pine editor keyboard shortcuts (canonical, learned 2026-04-24)

| Shortcut | Action | Why use over the toolbar button |
|---|---|---|
| **Ctrl+Enter** | **Add to chart / Update on chart** | The toolbar "Add to chart" button has fragile DOM selectors that don't match reliably from automation. **Ctrl+Enter is the only reliable automation path** — invoke via `ui_keyboard {key:"Enter", modifiers:["ctrl"]}`. Idempotent: if already on chart, TV treats as Update. |
| Ctrl+S | Save current source to slot | Saves source but does NOT refresh chart instance — chart still runs the version that was added before the save. Pair with Ctrl+Enter to actually deploy. |

**Recipe — Push Pine + apply to chart (combined save + add)**:
```
1. pine_get_active_slot                                    # confirm correct slot
2. pine_set_source(source=..., expected_script_name="...") # write source
3. pine_smart_compile                                      # find + click Save button
4. ui_keyboard{key:"Enter", modifiers:["ctrl"]}            # ALWAYS — guarantees chart refresh
5. chart_get_state                                         # verify new entity_id appeared
```

The `scripts/pine_push.js` helper now sends Ctrl+Enter unconditionally after the Save click for exactly this reason — see commit `41672b5+` if curious.

---

## The pre-flight check — ALWAYS run before any write

Before ANY `pine_set_source`, `pine_save`, `pine_smart_compile`, `pine_new`, or `pine_open` call, you MUST know:

1. **What slot is currently active in the editor?**
2. **Is the active slot the slot you intend to write to?**

The two read-only probes that answer those questions:

```javascript
// Probe 1 — direct DOM read of the nameButton
mcp__tradingview__ui_evaluate({
  expression: `document.querySelector('[class*="nameButton"]').textContent.trim()`
})
// Returns the active slot's name as displayed in TV. Examples:
//   "RSI pane"          → existing saved slot
//   "Untitled script"   → fresh blank buffer (not yet saved as a slot)
//   "MyOverlay v2"      → existing saved slot

// Probe 2 — full slot inventory (no editor side-effects)
mcp__tradingview__pine_list_scripts()
// Returns every saved slot with id, name, title, version, modified timestamp.
// Compare against probe 1 to confirm the active slot is one you recognise.
```

If `nameButton` returns a slot name you didn't expect → STOP. Either:
- Switch to the right slot first via `pine_switch_script`
- Or change your plan if no slot exists yet for what you wanted

If `nameButton` returns `Untitled script` → you're on an unsaved buffer. Anything you write here is throwaway until you Save. **No existing slot is at risk.**

---

## Decision tree — pick your recipe

```
What am I trying to do?
├─ Edit an EXISTING saved slot (e.g. update MyOverlay with a tweak)
│  └─ Recipe A: Edit existing slot
│
├─ Create a NEW indicator slot from scratch (most common for new tools)
│  └─ Recipe B: Create new Indicator
│
├─ Create a new STRATEGY slot (with strategy.entry/exit calls)
│  └─ Recipe C: Create new Strategy
│
├─ Create a new LIBRARY slot (export reusable functions for other Pine scripts)
│  └─ Recipe D: Create new Library
│
├─ Add a TV BUILT-IN indicator to the chart (RSI / MACD / etc.)
│  └─ Recipe E: Add Built-in indicator (NOT via Pine editor)
│
├─ Just READ a slot's source without modifying anything
│  └─ Recipe F: Read-only inspection
│
└─ RENAME an existing slot
   └─ Recipe G: Rename existing slot
```

---

## Recipe A — Edit an EXISTING saved slot

**Use when**: you want to update MyOverlay with a new feature, fix a bug in MyOscillator, etc.

**Precondition**: the slot already exists in `pine_list_scripts`.

**Steps**:

```
1. pine_list_scripts                                    # confirm slot exists
2. pine_switch_script(name="<exact slot name>")         # switch editor to it
3. ui_evaluate('nameButton text')                       # VERIFY the switch worked
   → MUST equal "<exact slot name>". If not, ABORT.
4. pine_get_source                                      # save a copy of current code
   → write to /tmp/<slot>-backup-<timestamp>.pine      # explicit backup, not optional
5. pine_set_source(source=new_code,
                   expected_script_name="<slot>")       # safety guard catches mismatches
6. ui_evaluate('nameButton text')                       # VERIFY still on same slot
7. pine_save                                            # Ctrl+S, slot version bumps
8. pine_list_scripts                                    # confirm version incremented,
                                                        # other slots untouched
```

**Why so paranoid?** A real overwrite incident on 2026-04-23 destroyed a saved indicator slot by skipping steps 1–3. A pre-existing automation session had left the editor on the wrong slot; the next `pine_set_source(...)` (intending to create something new) wrote into that slot; `pine_smart_compile` saved over it. That entire incident is preventable with steps 1, 3, and 5's `expected_script_name` guard.

---

## Recipe B — Create a NEW Indicator slot

**Use when**: shipping a fresh on-chart visualisation (FVG overlay, custom oscillator, etc.).

**Precondition**: nothing — this recipe creates the slot from scratch.

**Steps**:

```
1. pine_list_scripts                                    # baseline — note current slot count
2. ui_evaluate('nameButton text')                       # note current active slot
                                                        # (will be replaced in editor view)

3. ui_click(by="class-contains", value="nameButton")    # opens dropdown menu
4. capture_screenshot + local_vision                    # CONFIRM dropdown opened, see items
5. ui_hover(by="text", value="Create new")              # opens flyout submenu
6. capture_screenshot + local_vision                    # CONFIRM submenu shows
                                                        # Indicator/Strategy/Library/Built-in
7. ui_click → coordinates of "Indicator" item           # use ui_evaluate first to get coords
   (selector path: walk DOM for buttonContent-_b0ghPff containing direct text "Indicator")
8. capture_screenshot + local_vision                    # CONFIRM:
                                                        # - nameButton now reads "Untitled script"
                                                        # - editor body is short blank template
                                                        # - chart unchanged
                                                        # - NO existing slot was touched

9. pine_set_source(source=YOUR_PINE,
                   allow_unverified=true)               # Untitled buffer → no slot to verify
                                                        # IMPORTANT: edit the indicator() line
                                                        # to your desired NAME before this push
10. capture_screenshot + local_vision                   # CONFIRM editor shows YOUR code,
                                                        # nameButton still "Untitled script"
11. pine_save                                           # Ctrl+S → first save of an Untitled
                                                        # buffer auto-derives slot name from
                                                        # the indicator("...") title argument
12. pine_list_scripts                                   # CONFIRM:
                                                        # - new slot present with v1.0
                                                        # - slot name matches indicator() title
                                                        # - all OTHER slots unchanged (compare
                                                        #   modified timestamps + versions)
```

**Critical mechanic** (verified live 2026-04-23): on the FIRST save of an Untitled buffer, TradingView reads the title argument from the `indicator("...")` line and uses that string as the new slot name. There is **no name dialog**. So you must edit `indicator("My script")` → `indicator("YourDesiredName")` BEFORE pressing Ctrl+S. Otherwise you get a slot literally called "My script".

**Common error** (we hit it): pressing Ctrl+S without editing the title first → leftover "My script" slot polluting the cloud. To clean up: dropdown → switch to "My script" → dropdown → "Rename..." or delete.

---

## Recipe C — Create a NEW Strategy slot

**Use when**: building backtest-able entry/exit logic with `strategy.entry` / `strategy.close` calls. The Strategy Tester pane will appear on the chart.

**Steps**: identical to Recipe B but click **"Strategy"** instead of "Indicator" in step 7.

The blank template will start with `strategy("My script")` instead of `indicator(...)`. Same auto-derive-name-from-title rule on first save.

**When NOT to use Strategy**:
- You only want to draw boxes/lines/labels — that's an Indicator, not a Strategy.
- You want reusable helper functions — that's a Library.

---

## Recipe D — Create a NEW Library slot

**Use when**: exporting reusable functions for other Pine scripts to `import` (e.g. an SMC detection library that 5 different indicators consume).

**Steps**: identical to Recipe B but click **"Library"** instead of "Indicator" in step 7.

The blank template will start with `library("My script")` and include `export` decorators. Same auto-derive-name-from-title rule. Library scripts can't be added directly to a chart — they're consumed via `import` from another Indicator/Strategy script.

**Side note**: TV requires Library scripts to be **published** (made public or private-shared) before other scripts can import them. Single-user testing of a Library is awkward — usually faster to write the same logic inline in an Indicator and refactor to Library only when 2+ consumers actually exist.

---

## Recipe E — Add a TV BUILT-IN indicator (NOT via Pine editor)

**Use when**: you want RSI / MACD / Volume / Ichimoku Cloud / etc. — TV's pre-shipped, non-editable indicators.

**These are NOT created through the Pine editor's "Create new" menu.** That menu's "Built-in..." item opens TV's library browser to add a built-in to the chart, but you cannot edit a built-in's source.

The right tool:

```
mcp__tradingview__chart_manage_indicator({
  action: "add",
  indicator: "<full TV name>"
})

# Examples — must use the FULL name, not abbreviations:
#   "Relative Strength Index"   ← NOT "RSI"
#   "Moving Average Exponential" ← NOT "EMA"
#   "Bollinger Bands"            ← NOT "BB"
#   "Volume"                     ← that one is short
```

Built-ins live alongside your custom Pine indicators on the chart but never appear in `pine_list_scripts`.

---

## Recipe F — Read-only inspection of a slot

**Use when**: you want to see a slot's source code WITHOUT modifying or activating anything.

**Critical**: `pine_open(name="X")` is **NOT read-only** — it injects the fetched source into the active editor buffer (overwriting whatever is there). The `pine_open` guard added 2026-04-23 refuses to run unless you explicitly opt in.

**The actually-read-only path**:

```
1. pine_list_scripts                                    # confirm slot exists, get exact name
2. pine_switch_script(name="<exact slot name>")         # switches editor, doesn't write
3. ui_evaluate('nameButton text')                       # verify switch landed
4. pine_get_source                                      # read-only: returns current source
                                                        # of whatever slot is active
```

If you only need slot METADATA (name, version, last-modified), `pine_list_scripts` alone is enough — no editor switch needed.

---

## Recipe G — RENAME an existing slot

**Use when**: an old slot's name no longer fits ("My script" → "Volume Profile FVG"), or you want to free up a name for a new use.

**Steps**:

```
1. pine_list_scripts                                    # confirm both:
                                                        # - source slot exists
                                                        # - target name NOT already taken
2. pine_switch_script(name="<source slot>")             # switch editor to the slot
3. ui_evaluate('nameButton text')                       # verify
4. ui_click(by="class-contains", value="nameButton")    # open dropdown
5. ui_click → "Rename..." menu item                     # via coordinate path
6. capture_screenshot + local_vision                    # CONFIRM rename dialog opened
7. ui_evaluate → fill input field with target name
8. ui_click → "Save" / "OK" / locale-equivalent button
9. pine_list_scripts                                    # CONFIRM new name in list,
                                                        # version unchanged or +0.1
```

**Note**: renaming a slot does NOT change the `indicator("...")` title argument inside the source code. Those are independent strings after the first save. To keep them in sync, edit the source line too and `pine_save`.

---

## Top 10 anti-patterns (do NOT do these)

| # | What | Why it's bad | Right tool |
|---|---|---|---|
| 1 | `pine_set_source` without first running pre-flight check | Writes to whatever slot happens to be active. Caused the RSI pane disaster. | Always probe `nameButton` first; pass `expected_script_name=` |
| 2 | `pine_open(name="X")` thinking it switches editor | It REPLACES current editor's content with X's source. Slot stays where it was. | Use `pine_switch_script` for switching |
| 3 | `pine_new(type="indicator")` thinking it creates a new slot | It inserts a blank template into the **active** editor — overwriting current content. Slot is created only on first save. | Use Recipe B (drives the UI menu, creates a fresh Untitled buffer cleanly) |
| 4 | Ctrl+S before editing the `indicator("My script")` line on a fresh template | Slot gets named "My script" — TV auto-derives from the title. Leftover clutter. | Edit the title first, then save |
| 5 | Trusting `pine_save`'s `action: "saved_with_dialog"` return value | False signal — TV often saves without opening any dialog. | Verify via `pine_list_scripts` (version + modified) and `nameButton` text |
| 6 | Pushing > 800 lines via `pine_set_source` | May silently truncate / fail. Documented in `PINE_EDITOR_GOTCHAS.md #3` | Split into smaller scripts or use `scripts/pine_push.js` direct path |
| 7 | Skipping the screenshot-after-each-step verification | UI state is invisible to MCP tools without DOM probes. Errors compound silently. | `capture_screenshot` + `local_vision` after every state-changing call |
| 8 | Calling `chart_manage_indicator` with abbreviated names ("RSI", "EMA") | TV's API requires FULL names. Returns "indicator not found" otherwise. | "Relative Strength Index", "Moving Average Exponential", etc. |
| 9 | Using `pine_open` as a shortcut to "load a script for review" | Overwrites the active editor buffer. Use Recipe F instead. | `pine_switch_script` + `pine_get_source` |
| 10 | Not noting `pine_list_scripts` baseline before any TV write | Can't tell after-the-fact what changed. Compare versions + modified timestamps. | Snapshot list before, snapshot after, diff manually |

---

## Recovery — if you DID overwrite the wrong slot

TV Pro+ accounts have script version history (per-slot), but our MCP tooling has no API for it. Manual recovery only:

1. In TV web/desktop UI, switch to the damaged slot
2. Click the script-name dropdown → **"Version history..."**
3. Find the version BEFORE your overwrite (look at timestamps)
4. Click "Restore"
5. Verify via `pine_list_scripts` — slot version will increment

If version history is unavailable (free account, history limit reached, etc.):
- Search local repos for the script's source: `grep -r "indicator(\"<title>\"" ~/ai/`
- Check `~/ai/.archive/` tarballs from per-task auto-commit hooks
- Check tmux scrollback / Claude Code transcripts in `~/.claude/projects/-home-palyslaf0s/*.jsonl` for `pine_get_source` results from earlier sessions

The grep-your-private-pine-repo path is what saved us — the canonical source for the lost slot was preserved in a separate private git repo, despite the cloud copy being trashed. **Lesson: keep your Pine sources mirrored to git outside TV.**

---

## Workflow checklist (print this)

For every TV write session:

```
[ ] Read nameButton — note current active slot
[ ] Read pine_list_scripts — note all slot versions + modified timestamps
[ ] Decide: Recipe A / B / C / D / E / F / G
[ ] Execute recipe step-by-step, screenshotting after each state change
[ ] After every screenshot, run local_vision with SPECIFIC questions
   (do NOT ask "what do you see?" — ask "did X happen?")
[ ] After all writes done: re-read pine_list_scripts, diff against baseline
[ ] Confirm only the intended slot changed (version + modified date)
[ ] Confirm nameButton matches the intended slot
```

If any step fails the verification → STOP, report the unexpected state, ask for human guidance. Do NOT keep going on the assumption that "it'll probably work". The cost of an unrecoverable overwrite is hours of restoration work; the cost of pausing to ask is seconds.

---

## Tool support added 2026-04-23

After today's RSI pane incident, tv-mcp gained these guards (commit `fbe4b22`):

- `pine_get_active_slot` — read nameButton text in one MCP call (preferred over `ui_evaluate`)
- `pine_set_source(expected_script_name=...)` — refuses to run if active slot doesn't match
- `pine_set_source(allow_unverified=true)` — explicit opt-out for fresh Untitled buffers
- `pine_open(confirm_overwrite_active_editor=true)` — required flag, error message redirects to `pine_switch_script` for "open script X" intent
- `pine_save_as(name)` — drives kebab → Save As dialog (i18n: en/pl/de/es/fr) — needed for renaming or for explicit-name saves where indicator() title is different from desired slot name
- `ensurePineEditorOpen` — 3-method cascade for opening the Pine editor reliably across TV versions

These tools are exposed only if your tv-mcp MCP server has been restarted to pick up commit `fbe4b22`. Old sessions still using cached tool schemas will fall back to the unguarded behaviour — fall back to `ui_evaluate` probes instead.

---

## See also — Pine ↔ Python porting

When porting Pine indicators to Python (or auditing an existing port for parity):

- `~/ai/smc-engine/pine/` — our in-house Pine v6 indicator source + `smc_engine/pine_emit.py` Pine-code generator
- `~/ai/global-graph/references/lazytrader-pine-port-flux-charts.md` — reference port log: 398-line function-by-function mapping of Flux Charts "Market Structure Dashboard" Pine → Python (from `psyd3x/lazytrader`, MIT). Good template for mapping methodology; paths cited reference LazyTrader's internal modules, not ours.
