# TradingView MCP — Readable Screenshot Method (CDP → PIL brighten)

> **Problem:** `capture_screenshot` (method=cdp) on TradingView's dark theme returns images so dark that small `label.style_circle` structure dots (colPivot grey on near-black) are nearly invisible — especially after the harness downscales a 3360px capture for viewing. This cost an entire 2026-06-07 session: I couldn't visually count dots, mis-trusted an ambiguous label-trace, and patched blind. THIS is the fix.

## THE METHOD (use this every time you need to read TV dots/lines)
1. **Capture** with `capture_screenshot(region="chart", method="cdp", filename="...")`. (NOT `method="api"` — see below.)
2. **Brighten with PIL** (ImageMagick `convert`/`magick` are NOT installed on this box — PIL via `python3` is):
   ```bash
   python3 -c "from PIL import Image, ImageEnhance; \
   im=Image.open('RAW.png').convert('RGB'); \
   im=ImageEnhance.Brightness(im).enhance(1.7); \
   im=ImageEnhance.Contrast(im).enhance(1.3); \
   im=ImageEnhance.Color(im).enhance(1.4); \
   im.save('BRIGHT.png')"
   ```
   Brightness 1.7 / Contrast 1.3 / Color 1.4 makes candles vivid + grey dots readable. Tune ±0.1 if washed out.
3. **Read** the `BRIGHT.png` with the Read tool (own multimodal vision — `local_vision` is forbidden per user policy).
4. **Zoom tight** before capturing: a ~12-bar `chart_set_visible_range` makes dots big enough to count. Wide ranges (50+ bars) cram dots into noise.

## WHAT FAILED (don't repeat)
- **`method="api"`** → returns `{"note":"takeScreenshot() triggered — TV saves/shows via its own UI"}` and **NO file path**. Useless for agent reading. Use `cdp`.
- **Raw cdp, no brighten** → too dark to count dots. Always post-process.
- **Debug labels (`showDbgBars`) clutter the view** — the per-bar cyan/yellow state-boxes stack over the price area and overlap the dots. For a clean dot-count you'd want them OFF, BUT: toggling the `showDbgBars` source default does NOT turn them off on an already-added instance — TradingView **persists the input setting per slot**, so a re-add uses the SAVED value (true), not the new source default. To actually turn debug off you must change the INSTANCE setting (settings dialog) — `indicator_set_inputs` CRASHES the study (forbidden). So: either live with the clutter and read circles carefully, or build a cleaner debug (labels above/below price, distinct color).
- **`chart_set_visible_range` clamps** to the first available bar — you can't scroll left of where the data/structure begins; a dot at the left edge stays cut off.

## VERIFY-VIA-DEBUG implication
Label-data (`data_get_pine_labels`) gives REAL values, but it returns TEXT + price, not "is this a circle or a text." Multiple sources emit the same text ("LL") with/without a circle (see `bos-choch/docs/drawing-chain-map.md` Group A). **To verify a DOT count, you need the brightened screenshot — the trace alone overcounts.** Read the screenshot on the OPERATOR'S example region, cite bar/price, THEN say "sprawdź".

## HD detail — crop the ROI, never Read the full frame (combine with brighten above)
**Problem:** even a correctly-brightened capture is downscaled by the Read tool to ~600px wide for display → small grey `style_circle` dots, thin BoS/CHoCH lines and per-bar `showDbgBars` labels blur into noise. 2026-06-08: repeated FAILED dot-count verification on the #207 LL-jump (could not tell 1 dot from 2) until this.
**Root cause:** the capture is already native res (e.g. **3207×1261**); the loss is ENTIRELY the Read-on-display downscale. Reading the whole frame spends the pixel budget on empty chart.
**Fix:** crop the full-res PNG to the Region Of Interest with PIL + upscale 2× LANCZOS, THEN Read the crop. Fewer source pixels per Read → each feature gets more display pixels → sharp. PIL via `python3` is available; ImageMagick `convert`/`magick` are NOT installed on this box.

1. **Narrow first:** `chart_set_visible_range(from,to)` to a few bars (a few hours either side of the target bar) → bigger features. (Compute unix ts with `date -u -d '... ' +%s`.)
2. `capture_screenshot(region="chart")` → native PNG.
3. PIL `.size` for dims.
4. Crop the ROI band (swing-low dots → center-bottom, e.g. y `0.45..0.92`; tune fractions per feature).
5. Upscale 2× LANCZOS.
6. *(optional)* brighten the crop with the PIL Brightness/Contrast/Color block above.
7. Read the crop.

```python
from PIL import Image
im = Image.open('shot.png'); w,h = im.size
crop = im.crop((int(w*0.20), int(h*0.45), int(w*0.80), int(h*0.92)))   # ROI fractions — TUNE per feature
crop = crop.resize((crop.width*2, crop.height*2), Image.LANCZOS)
crop.save('shot-crop.png')
```
**Anti-pattern:** Reading the full-frame screenshot and squinting; re-capturing at the same zoom hoping for clarity. Crop the ROI instead. Operator 2026-06-08: *"masz problem dalej z rozdzielczością ... daj sobie wyższą jakość"* — the fix is cropping, not re-capturing.

## Cross-links
- `~/ai/bos-choch/docs/drawing-chain-map.md` — where each dot is drawn (text vs circle sources)
- `~/ai/global-graph/anti-patterns/ap-pine-smc.md` — the catalogued failures this method prevents
- `~/ai/global-graph/patterns/trace-before-patch.md` — verify-after-patch discipline
