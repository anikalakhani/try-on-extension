# Fit For Me — AI Try-On (Chrome extension, personal use)

## What it does right now

- Detects shopping/product pages using a heuristic (JSON-LD `Product` schema, `og:type`,
  "add to cart" buttons, price patterns).
- Shows a **✨ Try This On** button in the top-right of detected pages. Clicking it runs
  the whole pipeline automatically, no further clicks needed:
  1. Scrapes the product title, any material/measurement text, and identifies the main
     product image (highlighted in orange). Also looks specifically for garment
     measurements (bust/waist/hem/length) and the reference model's own height + size
     worn (e.g. "model is 177cm, wearing a size AU 6") — some sites only put this behind
     a "Size Guide"/"Measurements"/"Find My Size" tab, so it first tries clicking one if
     found, then scrapes whatever text that reveals.
  2. Claude writes a try-on prompt describing a model wearing the item — using your
     saved height/weight/cup-size/skin-tone settings as concrete anchors when set. The
     body build (plus-size, average, slender, etc.) is *derived* from those numbers
     (Claude reasons it out; the local template fallback computes a rough BMI) rather
     than assumed — set them thin and the model comes out thin, plus-size and it comes
     out plus-size. **Only** when no settings are provided at all does it default to
     plus-size, matching this tool's original purpose (local template fallback if no
     Anthropic key is configured). When both a height setting and scraped garment
     measurements/reference-model info exist, Claude also reasons about proportions — a
     garment's physical length is fixed, but torso length scales with height, so e.g. a
     cropped top that shows no midriff on a 177cm reference model would extend further
     down (past the waist, covering more) on a notably shorter generated model with a
     proportionally shorter torso, and states explicitly in the prompt where
     hemlines/necklines land on this model, rather than assuming the same fit shown in
     the original photo. Precision here doesn't stop at qualitative reasoning — see
     "Measurement-based fit math" below.
  3. **FLUX.1 [dev]** (fal.ai) generates the model from that prompt — **or skips this
     entirely** and reuses your saved model photo (see "Your model photo" below) if one
     exists and your appearance settings haven't changed since it was picked. The model's
     face/body don't change per product, only the garment does, so generating a fresh one
     on every single try-on was a wasted fal.ai call once a photo has actually been
     chosen.
  4. **FASHN Try-On v1.6** puts the highlighted product image on that model. This
     endpoint takes only images, no text at all (confirmed against its full documented
     parameter list) — it has no way to receive the hem/proportion reasoning from step 2
     directly; that reasoning can only land in what FLUX visually rendered in step 3.
  5. **FASHN Edit** — an optional 3rd FASHN call, only made when step 1 found garment
     measurements AND a model height is set. Unlike Try-On, Edit genuinely accepts a text
     prompt ("freeform instructions for the edits you want to apply... ideal for pose or
     view adjustments... small fixes" per FASHN's docs) — Claude generates a second,
     self-contained instruction (`fitEditPrompt`) alongside the main image prompt
     specifically for this step, telling it to nudge the hem/neckline to where it
     actually belongs given the model's real height, while leaving everything else
     (face, pose, body shape, garment color/pattern, lighting, background) unchanged.
     Non-fatal if this step fails — falls back to the un-edited Try-On result rather than
     failing the whole run.

     Does **not** pass the scraped garment photo as `image_context`, despite that seeming
     like reasonable insurance for garment fidelity — confirmed live this was a real bug:
     that photo almost always shows the garment on the retailer's own model (not an
     isolated flat-lay), and FASHN's Edit pulled that model's face/identity from it,
     silently replacing our model's face in the final image — comparing all pipeline
     stages side by side showed the face was still correct right after Try-On and only
     changed after Edit. The image being edited already has the correct garment applied
     (Try-On's job, already done) — Edit only does small, targeted hem/width adjustments,
     which don't need an external reference image at all.

     The shorter/taller-vs-reference comparison this all depends on is a known place for
     Claude to silently reverse itself — confirmed live *twice*: first with a fill-in-the-
     blank `fitReasoning` template (correctly stating the rule, then contradicting it in
     the conclusion anyway), then again even with an explicit warning about that exact
     mistake added to the template. Warning it about the mistake wasn't reliable enough,
     so the direction is no longer something Claude derives at all: `computeHemDirection()`
     determines shorter/taller in code from the two heights alone (doesn't need a garment
     length, so it's available far more often than the full numeric `computeHemShift`), and
     `buildHemReasoningSentence()` writes the complete `fitReasoning` sentence in code —
     Claude is told to reproduce it character-for-character, not fill in blanks or
     paraphrase it. Removing the inference step is a fundamentally more reliable fix than
     asking an LLM to police its own reasoning. Only falls back to Claude deriving it
     itself in the rare case where no reference-model height could be parsed at all — there
     truly is nothing to compute from there. Logged to the console (not shown in the UI) so
     it's easy to check the stated direction is actually correct for a given run.

     Also confirmed live (comparing all three logged stage images side by side): asking
     Edit to extend a garment's hem length can cause it to also slim/narrow her waist as
     an unwanted side effect, even though it's separately told to leave body shape
     unchanged — extending fabric downward apparently gets reinterpreted as also
     re-tapering the figure. `fitEditPrompt` now appends an explicit "this is a LENGTH
     change only, do not resize her waist/torso/arms/bust" constraint to counter this.

     **Measurement-based fit math** (not left to Claude's arithmetic — it's proven
     unreliable at this specific kind of reasoning, see above): `computeHemShift()` and
     `computeWidthShift()` in `background.js` do real, deterministic math in plain code,
     regex-parsing the actual numbers out of the scraped text rather than trusting an LLM
     to estimate them.
     - **Hem/length**: `shiftIn = garmentLength × (1 − thisHeight / referenceHeight)` — a
       garment's physical length doesn't change with who wears it, but torso length scales
       with height, so this estimates exactly how many inches lower (shorter model) or
       higher (taller model) the hem lands than it did on the reference model. Needs the
       reference model's height and the garment's own length, both regex-parsed from the
       scraped text.
     - **Width/ease**: `easeIn = garmentBust − modelBust` — doesn't need a reference model
       at all, just a direct garment-vs-model comparison; this is what actually explains a
       garment reading as "oversized," since FASHN's Try-On has no sizing input whatsoever
       and just replicates whatever fit is shown in the garment's own photo. `modelBust` is
       your real bust/chest circumference if you've entered one in settings (optional), or
       falls back to `CUP_SIZE_BUST_ESTIMATE_IN` — a hardcoded (not AI-generated) benchmark
       table mapping cup letter to an approximate circumference, assuming a common average
       band size, since this tool doesn't collect band size. Real fit varies more than a
       cup letter alone can capture, so entering a real number in settings gives a more
       accurate result.

       `describeWidthEffect()` scales the resulting wording by how extreme the mismatch
       is — confirmed live this was a real gap: the ease number itself was always correct,
       but a 1in mismatch and a 15in mismatch both produced the same soft "slightly snug" /
       "bring the fit in slightly" language, badly underselling a garment that genuinely
       wouldn't close in real life. Three tiers (mild/moderate/extreme, thresholds at ±2in
       and ±5in): extreme escalates to describing visible strain and fabric pulled taut
       with closures unable to close (too small), or the garment visibly swimming on her
       and looking several sizes too big (too loose), rather than a cosmetic adjustment.
       When `describeWidthEffect()` returns "extreme," `buildSizeWarning()` also attaches a
       `{ tooLoose, easeIn, easeCm }` object to the generation result (`sizeWarning`),
       separate from how the image itself is worded. content.js blurs every copy of the
       generated image (including stragglers that load in during the post-replace sweep —
       `sweepStragglerMatches`/`replaceImageOnPage` both take an `extraApply` callback now
       so late duplicates get blurred too, not just whatever existed at replace time) and
       shows a card over it: *"It appears like this clothing item doesn't come in your
       size... Would you still like to view the generated image?"* (or the "runs large"
       phrasing for the too-loose direction). Clicking "Show anyway" unblurs it. A fresh
       generation clears any previous warning before applying its own.

       Both computations degrade independently and gracefully: if either needed number
       can't be parsed out of a given page's text, that specific correction is just
       omitted (falls back to qualitative-only language for hem, or no width correction at
       all) rather than guessing. Claude (or the local template, when no Anthropic key is
       configured) is handed the precomputed number directly and told explicitly not to
       recompute or second-guess it — its job is reduced to phrasing a sentence around a
       given number, not doing the arithmetic itself.

       Some sites (confirmed live: gap.com) publish no garment measurements at all —
       `computeWidthShift` has nothing to compute from there. For that case there's a third
       tier below the numeric one: `QUALITATIVE_FIT_REGEX` in `background.js` looks for
       retailer-written fit language instead (e.g. Gap's own `"Fit: Classic. A straight &
       easy fit. Slightly cropped, hits above the hip."`) — words like "oversized,"
       "relaxed fit," "cropped," "hits above/below the hip," "true to size," etc. When
       found, the fitEditPrompt instruction leans on that description qualitatively (no
       invented number) instead of skipping the correction entirely. This only works if the
       text actually reaches the scraper in the first place — content.js's
       `MEASUREMENT_LINE_KEYWORDS` had to be broadened to catch this kind of line, since it
       previously matched none of the (numeric-measurement-focused) keywords and was
       silently dropped even though an adjacent "Model is 5'9"..." line on the same page
       was already being captured.

       The original wording of this instruction had a real bug, confirmed live: it told
       Claude to correct the garment's width "if it currently reads as oversized" — but
       `fitEditPrompt` is written *before* FLUX/FASHN generate anything, so Claude has never
       seen an actual rendered image at that point and can't evaluate a "currently looks
       like" condition. The result was Claude silently dropping the width instruction
       entirely and only including the hem correction. Fixed by making the qualitative
       instruction an unconditional standing correction ("ensure a normal, moderate drape"
       vs. "ensure a visibly roomy drape," based purely on the source text's own wording,
       not a judgment about the current image) instead of a conditional check it has no way
       to evaluate.
  6. The result automatically replaces the image on the page — local to that browser
     tab only, undone by a refresh. Anchors to the exact garment image URL (not a
     re-run "biggest image" heuristic) and updates every matching element on the page,
     since lazy-loaded galleries can change which element "looks biggest" over time,
     and keeps re-scanning for a few seconds afterward to catch same-photo duplicates
     (thumbnail rails etc.) that load in slightly later. Also handles `<picture>`
     elements with `<source>` siblings (AVIF/WebP format negotiation, seen on
     quince.com) — the browser resolves those before ever looking at the `<img>`'s own
     `src`, so replace strips the `<source>` tags too, or the swap silently does nothing
     visually despite "succeeding."

  Costs ~$0.015 (FLUX, skipped when reusing a saved model photo) + $0.075 (FASHN Try-On)
  ≈ $0.09 per generation (or ~$0.075 when reusing), plus ~2 FASHN credits for the optional
  Edit step (only incurred when garment measurement data was found on the page).
  The customize panel's "Garment fit correction" field (only shown when this data was
  found) lets you edit that Edit-step instruction directly before regenerating.
- **Your model photo** (settings page): generate 3 candidate base model photos from your
  appearance settings (plain, unbranded, form-fitting outfit — a neutral base meant for
  overlaying real garments onto later, not a styled look) and pick one to keep. That
  choice is then reused for every try-on going forward — the FLUX step above is skipped
  entirely as long as your saved height/weight/sandbag%/cup size/skin tone haven't changed
  since you picked it (tracked via a fingerprint of just those fields; a mismatch shows a
  "regenerate" warning next to the saved photo, but doesn't block anything — it just falls
  back to generating a fresh one for that run, same as before this existed). Only costs
  fal.ai calls when you explicitly click "Generate 3 options," never automatically.
- While waiting (~30–60s), a centered loading card with a small spinner animation shows
  the same progress text as the button ("Writing prompt…", "Generating…", "Replacing
  image on page…") — doesn't block the rest of the page.
- Once done, the button becomes **"Customize my try-on ▾"** — hovering it (mouse over
  button or the panel that appears below it) reveals: the editable prompt textarea,
  **Regenerate prompt** (updates the prompt only), **Regenerate image** (re-runs
  generation with whatever's currently in the textarea and automatically re-replaces the
  page image, with the same loading card), and **Change my image settings** (opens the
  extension's settings page to edit your saved height/weight/cup-size/skin-tone).
- **Sandbagging**: an optional settings toggle that inflates the weight number actually
  sent to the model (e.g. +50%) to compensate for image models under-delivering on
  extreme body-size instructions — your saved weight stays the real number.

## Why FLUX instead of FASHN's own Model Create

FASHN has no structured parameters for weight/height/bust/body type on any of its
endpoints (`model-create`, `edit`, `product-to-model`) — text prompt was the only
lever, and empirically it didn't reliably follow explicit extreme body-size
instructions even when very explicit (confirmed via repeated same-seed tests showing
real run-to-run variance, not just a prompting problem).

FLUX.1 [dev] (via fal.ai) has an actual documented `guidance_scale` (prompt-adherence)
parameter that FASHN's endpoint lacks — currently set well above FLUX's 3.5 default
(see `callFlux` in `background.js`) specifically to force stronger adherence to body
descriptors. It's also independently cited as having comparatively better body-structure
accuracy than GPT-image models in side-by-side comparisons, and is ~5x cheaper per image
than FASHN's own Model Create.

FASHN Try-On v1.6 handles garment fidelity (overlaying the real product onto whatever
body it's given) — `garment_photo_type: "model"` tells it the garment reference photo is
on a person, not a flat-lay. `segmentation_free: true` (FASHN's default) is used for body
shape preservation — FASHN's own docs describe it as "direct garment fitting without
clothing segmentation, enabling ... improved preservation of body shape and skin
texture." This was briefly set to `false` while FASHN's own Model Create was generating
the base model (its guidance for when "original garments are not removed properly"), but
confirmed live via a side-by-side of the FLUX model image vs. the FASHN output that
`false` was quietly slimming down genuinely plus-size/full-bust FLUX models during the
Try-On step — reverted back to `true` once FLUX (not Model Create) took over generating
the base photo.

Both FLUX and FASHN Try-On use a fixed seed (`FLUX_TEST_SEED` / `FASHN_TEST_SEED` in
`background.js`) so identical settings produce comparable output across runs — needed
because otherwise generation-to-generation randomness made it impossible to tell
whether a settings change (e.g. the sandbag %) actually had an effect.

## API keys — two ways to set them

**Option A: `.env.local` (recommended, no UI pasting)**

Service workers can't read arbitrary files off disk at runtime, so this works via a
small generate step: copy `.env.local.example` to `.env.local`, fill in
`ANTHROPIC_API_KEY` / `FASHN_API_KEY` / `FAL_API_KEY` (a few common naming variants
like `claude_api`/`fashn_api`/`fal_api` also work), then run:

```bash
node sync-keys.js
```

This writes `config.local.js` (gitignored, like `.env.local` itself), which
`background.js` loads automatically. Re-run the command any time you change a key,
then reload the extension. The settings-page key fields (below) can stay blank.

**Option B: paste into the settings page**

Anything entered on the settings page overrides the `.env.local` values for that key —
useful for testing a different key temporarily without touching the file.

## Load it in Chrome

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this folder (`shopping-extension`)
5. If using `.env.local`, make sure you've run `node sync-keys.js` first (see above)
6. Click the extension's icon in the toolbar → opens the settings page
   (or right-click the icon → **Options**) to set model appearance preferences
   (height/weight sliders + sandbag exaggeration, cup size chips including N/A for
   flat chest, an optional real bust/chest circumference in inches, skin tone swatches)
   and/or paste keys directly (Option B above)

After editing any file, reload the extension in `chrome://extensions` **and** refresh
the product page tab — a stale content script silently loses its connection to the
extension otherwise.
