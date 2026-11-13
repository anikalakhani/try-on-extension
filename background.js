// background.js — MV3 service worker.
// Handles all network calls (Claude, FASHN, fal.ai) so API keys never have
// to live in the content script / page context.

// Optional: load keys from config.local.js (generated from .env.local via
// `node sync-keys.js`) instead of pasting them into the settings page.
// Wrapped in try/catch since the file may not exist yet on first install —
// the placeholder checked in has blank values either way, so this is safe.
try {
  importScripts("config.local.js");
} catch (_) {
  // config.local.js missing or failed to load — fall back to whatever's in
  // the settings page (chrome.storage), handled in getSettings() below.
}

// Clicking the toolbar icon opens the settings page (there's no popup).
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GENERATE_PROMPT") {
    // generatePrompt() returns { prompt, fitEditPrompt } — fitEditPrompt is
    // null unless the page had garment measurements AND a model height is
    // set (see callClaude / buildTemplatePrompt).
    generatePrompt(message.productData)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true; // keep the message channel open for the async response
  }

  if (message.type === "GENERATE_IMAGE") {
    generateImage(message.prompt, message.garmentImageUrl, message.fitEditPrompt)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }

  if (message.type === "GENERATE_MODEL_OPTIONS") {
    // Called from the settings page only (not per try-on) — generates a few
    // candidate base model photos to pick from. Reads settings fresh from
    // chrome.storage, so the settings page saves current form values first.
    generateModelOptions(message.count || 3)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }

  if (message.type === "OPEN_OPTIONS") {
    // Content scripts can't reliably call chrome.runtime.openOptionsPage()
    // themselves — routed through here instead.
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }
});

// Generous ceiling for every Claude call. Thinking tokens count toward
// max_tokens, and the main response is a JSON object with three long fields —
// the old 1024/512 limits could cut the reply off mid-JSON. Not a cost
// concern: you only pay for tokens actually generated, not the ceiling.
const CLAUDE_MAX_TOKENS = 4096;

/**
 * A reply cut off by max_tokens used to be parsed anyway: parseClaudeJson's
 * non-JSON fallback then sent the half-finished JSON text to FLUX as the
 * image prompt (and dropped the fit-edit prompt) with no error — a wasted
 * generation. Fail loudly instead so the user can just retry.
 */
function assertNotTruncated(data) {
  if (data && data.stop_reason === "max_tokens") {
    throw new Error("Claude's reply was cut off (hit the token limit) — please try again.");
  }
}

const FASHN_BASE = "https://api.fashn.ai/v1";
const FAL_BASE = "https://fal.run";

// Fixed seeds so identical settings produce comparable output run-to-run —
// observed real generation-to-generation variance (skinny vs. plus-size from
// the exact same prompt) that made it impossible to tell whether a settings
// change actually did anything. Change these if you deliberately want to
// sample a different random variation instead of a controlled comparison.
const FASHN_TEST_SEED = 424242;
const FLUX_TEST_SEED = 424242;

/**
 * Three-step pipeline:
 *  1. FLUX.1 [dev] (fal.ai) — generate a plus-size model from the prompt.
 *     Replaces FASHN's Model Create: FLUX exposes a real guidance_scale
 *     (prompt-adherence) control that FASHN's endpoint doesn't have, which
 *     is what we need for extreme body-size instructions to actually land.
 *     Skipped entirely (saving a FLUX call every time) when a saved model
 *     photo exists AND its appearance fingerprint still matches current
 *     settings — see computeAppearanceFingerprint(). The model's face/body
 *     doesn't change per product, only the garment does, so regenerating it
 *     on every single try-on was pure waste once a photo has been picked.
 *  2. FASHN Try-On v1.6 — put the scraped garment image on that generated
 *     (or cached) model. This endpoint takes only images, no text (confirmed
 *     against its full documented parameter list) — it can't be told
 *     anything about intended fit/proportions directly.
 *  3. FASHN Edit (optional, only when fitEditPrompt is given) — a genuinely
 *     text-driven endpoint ("freeform instructions for the edits you want to
 *     apply, ideal for pose or view adjustments... or small fixes" per
 *     FASHN's own docs), chained after Try-On specifically to correct hem/
 *     neckline/proportion placement using the model's actual height — the
 *     one thing step 2 has no way to know. Non-fatal if it fails: falls back
 *     to the un-edited Try-On result rather than failing the whole run.
 */
async function generateImage(prompt, garmentImageUrl, fitEditPrompt) {
  const settings = await getSettings();
  const { fashnApiKey, falApiKey } = settings;
  if (!fashnApiKey) {
    throw new Error("No FASHN API key configured. Add one in the extension's settings page.");
  }
  if (!garmentImageUrl) {
    throw new Error("Couldn't determine which image on the page to use as the garment reference.");
  }

  let modelImageUrl;
  let usedCachedModel = false;
  if (
    settings.savedModelImageUrl &&
    settings.savedModelSpecFingerprint === computeAppearanceFingerprint(settings)
  ) {
    modelImageUrl = settings.savedModelImageUrl;
    usedCachedModel = true;
  } else {
    // No saved model yet, or appearance settings changed since it was
    // picked (stale fingerprint) — fall back to generating a fresh one
    // per-product, same as before this caching existed.
    if (!falApiKey) {
      throw new Error("No fal.ai API key configured. Add one in the extension's settings page.");
    }
    modelImageUrl = await callFlux(falApiKey, prompt);
  }

  const tryonJobId = await fashnSubmit(fashnApiKey, "tryon-v1.6", {
    model_image: modelImageUrl,
    garment_image: garmentImageUrl,
    category: "auto",
    // "quality" per FASHN's own docs: "extensively improving skin texture
    // fidelity and realistic garment integration with the original model
    // image" — this specific endpoint (tryon-v1.6) has no text input at all
    // (confirmed against its full documented parameter list) and can only
    // warp the real garment onto whatever silhouette FLUX already drew, so
    // tighter integration with that image is the only lever it has for
    // respecting the hem/fit placement FLUX rendered, rather than
    // approximating. (Fit is also corrected afterward, more directly, via
    // the separate FASHN Edit step below — see fashnEdit().)
    // Slower (~19s vs ~10s for "balanced") but the pipeline already runs
    // 30-90s end to end.
    mode: "quality",
    // garment_image is a photo of the item on the original listing's model,
    // not a flat-lay — tell FASHN explicitly rather than relying on "auto"
    // detection.
    garment_photo_type: "model",
    // segmentation_free:true (the default) per FASHN's own docs: "direct
    // garment fitting without clothing segmentation, enabling ... improved
    // preservation of body shape and skin texture." This was previously set
    // to false (FASHN's guidance for when "original garments are not
    // removed properly") back when FASHN's own Model Create was generating
    // the base model and left an AI-imagined top on it that needed cleanly
    // stripping first. Confirmed live (side-by-side of the FLUX model image
    // vs. the FASHN output) that segmentation_free:false was quietly
    // reverting body-type fidelity — a genuinely curvy/full-bust FLUX model
    // came back visibly slimmer after Try-On, even though the prompt and
    // FLUX generation were both correct. Reverting to true trades this back
    // for body-shape preservation; if garment fidelity regresses now that
    // FLUX (not Model Create) is generating the base photo, revisit this.
    segmentation_free: true,
    seed: FASHN_TEST_SEED,
  });
  const tryonResult = await fashnPoll(fashnApiKey, tryonJobId);
  const tryonImageUrl = tryonResult.output && tryonResult.output[0];
  if (!tryonImageUrl) {
    throw new Error("Try-On finished but returned no image.");
  }

  let finalImageUrl = tryonImageUrl;
  if (fitEditPrompt) {
    try {
      finalImageUrl = await fashnEdit(fashnApiKey, tryonImageUrl, fitEditPrompt);
    } catch (err) {
      // Don't fail the whole generation over a refinement step — the
      // un-edited Try-On result is still a valid (if less precise) output.
      console.warn("FASHN Edit (fit correction) failed, using un-edited Try-On result:", err);
    }
  }

  return { modelImageUrl, tryonImageUrl, finalImageUrl, usedCachedModel };
}

/**
 * FASHN's Edit endpoint — unlike Try-On, this genuinely accepts a text
 * prompt alongside images ("freeform instructions for the edits you want to
 * apply... small fixes"). Used here specifically to correct where the
 * garment's hem/neckline/proportions land on the model, using her actual
 * height — information Try-On has no way to receive.
 *
 * Does NOT pass image_context (garmentImageUrl) — confirmed live this was
 * a real bug, not a hardening measure: garmentImageUrl is the raw scraped
 * product photo, which almost always shows the garment on THE RETAILER'S
 * OWN MODEL, not an isolated flat-lay. FASHN's Edit treats image_context as
 * general visual reference, not "garment only" — it pulled the retailer's
 * model's face/identity from it, silently replacing our model's face in
 * the final output even though the Try-On step immediately before it had
 * the correct face. The image being edited already has the correct
 * garment applied (that's Try-On's job, already done) — Edit's job here is
 * small, targeted hem/width adjustments, which don't need an external
 * fidelity anchor at all.
 */
async function fashnEdit(apiKey, imageUrl, prompt) {
  const editJobId = await fashnSubmit(apiKey, "edit", {
    image: imageUrl,
    prompt,
    generation_mode: "balanced",
    resolution: "1k",
    seed: FASHN_TEST_SEED,
  });
  const editResult = await fashnPoll(apiKey, editJobId);
  const editedImageUrl = editResult.output && editResult.output[0];
  if (!editedImageUrl) {
    throw new Error("FASHN Edit finished but returned no image.");
  }
  return editedImageUrl;
}

/**
 * FLUX.1 [dev] via fal.ai's synchronous endpoint — no polling needed, unlike
 * FASHN (a single dev-tier image generation is fast enough to return inline).
 * guidance_scale is pushed above the 3.5 default to force stronger adherence
 * to the explicit body-size instructions in the prompt — but not too far:
 * high guidance is also a well-known cause of the "overcooked"/waxy, overly
 * airbrushed skin look in diffusion models, so this is a deliberate
 * middle-ground value, not maxed out.
 * seed defaults to the pinned FLUX_TEST_SEED (per-product generation, where
 * reproducibility across runs matters) — generateModelOptions() overrides it
 * with random seeds instead, since that path wants genuine variety.
 */
async function callFlux(apiKey, prompt, seed = FLUX_TEST_SEED) {
  const response = await fetch(`${FAL_BASE}/fal-ai/flux/dev`, {
    method: "POST",
    headers: {
      Authorization: `Key ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt,
      image_size: "portrait_4_3",
      num_inference_steps: 28,
      guidance_scale: 6.5,
      seed,
      num_images: 1,
      output_format: "png",
      enable_safety_checker: true,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    // fal.ai returns 4xx with a message mentioning balance/credits when the
    // account has no funds — surfaced here as-is so it's visible in the UI
    // rather than a generic "request failed".
    throw new Error(`fal.ai FLUX request failed (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const imageUrl = data.images && data.images[0] && data.images[0].url;
  if (!imageUrl) {
    throw new Error("FLUX finished but returned no image.");
  }
  return imageUrl;
}

async function fashnSubmit(apiKey, modelName, inputs) {
  const response = await fetch(`${FASHN_BASE}/run`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model_name: modelName, inputs }),
  });
  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(`FASHN ${modelName} submit failed: ${data.error || response.statusText}`);
  }
  return data.id;
}

async function fashnPoll(apiKey, predictionId, { intervalMs = 3000, timeoutMs = 120000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const response = await fetch(`${FASHN_BASE}/status/${predictionId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(`FASHN status check failed: ${response.statusText}`);
    }
    if (data.status === "completed") return data;
    if (data.status === "failed") {
      throw new Error(`FASHN job failed: ${JSON.stringify(data.error)}`);
    }
    await sleep(intervalMs);
  }
  throw new Error("Timed out waiting for FASHN job to complete.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getSettings() {
  const stored = await chrome.storage.local.get([
    "anthropicApiKey",
    "fashnApiKey",
    "falApiKey",
    "claudeModel",
    "modelHeight",
    "modelHeightInches",
    "modelHeightEnabled",
    "modelWeightLbs",
    "modelWeightEnabled",
    "modelSandbagEnabled",
    "modelSandbagPercent",
    "modelChest",
    "modelChestSize",
    "modelBustInches",
    "modelBustEnabled",
    "modelSkinTone",
    "savedModelImageUrl",
    "savedModelSpecFingerprint",
  ]);
  // Settings-page values (chrome.storage) win if set; otherwise fall back to
  // config.local.js (from .env.local via sync-keys.js), if it loaded.
  const fileConfig = self.FIT_FOR_ME_CONFIG || {};
  return {
    anthropicApiKey: stored.anthropicApiKey || fileConfig.ANTHROPIC_API_KEY || "",
    fashnApiKey: stored.fashnApiKey || fileConfig.FASHN_API_KEY || "",
    falApiKey: stored.falApiKey || fileConfig.FAL_API_KEY || "",
    claudeModel: stored.claudeModel || "claude-opus-5-5",
    modelHeight: stored.modelHeight || "",
    modelHeightInches: stored.modelHeightInches || 0,
    modelHeightEnabled: !!stored.modelHeightEnabled,
    modelWeightLbs: stored.modelWeightLbs || 0,
    modelWeightEnabled: !!stored.modelWeightEnabled,
    modelSandbagEnabled: !!stored.modelSandbagEnabled,
    modelSandbagPercent: stored.modelSandbagPercent ?? 50,
    // modelChest is the qualitative display string ("cup C") used in the
    // appearance prompt; modelChestSize is the raw letter (A-J or "N/A"),
    // used as a lookup key into CUP_SIZE_BUST_ESTIMATE_IN when
    // modelBustInches isn't provided — see estimateBustCircumferenceInches.
    modelChest: stored.modelChest || "",
    modelChestSize: stored.modelChestSize || "",
    modelBustInches: stored.modelBustInches || 0,
    modelBustEnabled: !!stored.modelBustEnabled,
    modelSkinTone: stored.modelSkinTone || "",
    // Cached base model photo — see computeAppearanceFingerprint() and
    // generateImage()'s cache check. Picked on the settings page from
    // generateModelOptions()'s candidates; savedModelSpecFingerprint pins it
    // to the appearance settings that were active when it was picked.
    savedModelImageUrl: stored.savedModelImageUrl || "",
    savedModelSpecFingerprint: stored.savedModelSpecFingerprint || "",
  };
}

/**
 * Weight is computed here (not read as a pre-formatted string) so the
 * sandbag multiplier can be applied at prompt-build time. Image models tend
 * to under-deliver on extreme body-size instructions — this inflates the
 * number actually sent while leaving the user's real saved value untouched.
 */
function getSandbaggedWeight(settings) {
  if (!settings.modelWeightEnabled || !settings.modelWeightLbs) return null;
  if (!settings.modelSandbagEnabled) return settings.modelWeightLbs;
  const factor = 1 + settings.modelSandbagPercent / 100;
  return Math.round(settings.modelWeightLbs * factor);
}

// Lines like "Bust: 76 cm / 29.92 in" — used to tell garment-measurement
// lines apart from the "model is X, wearing size Y" reference-model line in
// scraped measurementsText (see parseReferenceModelHeightInches below).
const GARMENT_MEASUREMENT_LINE_REGEX = /\b(bust|waist|hem|hip|sleeve|shoulder|inseam|length)\s*:/i;

// Retailer-written fit language with no attached numbers — e.g. gap.com's
// "Fit: Classic. A straight & easy fit. Slightly cropped, hits above the
// hip." Confirmed live: some sites (gap.com) publish no garment
// measurements at all, only text like this, so computeWidthShift has
// nothing numeric to work with — this is the fallback signal used instead
// (see the qualitative branch of the WIDTH/EASE section in callClaude and
// buildTemplatePrompt below). Kept in sync with content.js's
// MEASUREMENT_LINE_KEYWORDS, which is what makes sure this text actually
// gets scraped into measurementsText in the first place.
const QUALITATIVE_FIT_REGEX =
  /\b(oversized|relaxed(?:\s+fit)?|slim fit|loose fit|boxy(?:\s+fit)?|tailored fit|straight\s*&?\s*easy|easy fit|cropped|hits above|hits below|hits at|classic fit|regular fit|true to size|runs small|runs large)\b/i;

/**
 * Best-effort regex extraction of the reference model's height (in inches)
 * from scraped measurementsText — e.g. "Kartier is 177cm and wearing a size
 * AU 6" or "model is 5'8", wearing a size 6". Deliberately narrow/simple:
 * real-world phrasing varies a lot across sites, so this is meant to
 * degrade gracefully (return null) rather than guess wrong — callers must
 * treat null as "couldn't determine this precisely" and fall back to the
 * qualitative-only instructions, not synthesize a number.
 */
function parseReferenceModelHeightInches(measurementsText) {
  if (!measurementsText) return null;
  // Skip lines that are themselves garment measurements (bust/waist/hem/
  // etc.) so a garment's own cm number never gets mistaken for the model's
  // height — only look at the remaining (likely "model is..."-style) lines.
  const candidateLines = measurementsText
    .split("|")
    .map((line) => line.trim())
    .filter((line) => line && !GARMENT_MEASUREMENT_LINE_REGEX.test(line));

  for (const line of candidateLines) {
    // feet'inches" pattern, e.g. 5'8" or 5' 9" — constrained to a plausible
    // adult height range to avoid matching unrelated numbers.
    const feetInches = line.match(/\b(\d)\s*['’]\s*(\d{1,2})\s*(?:["“”]|in\b)/);
    if (feetInches) {
      const feet = Number(feetInches[1]);
      const inches = Number(feetInches[2]);
      if (feet >= 4 && feet <= 7 && inches >= 0 && inches < 12) {
        return feet * 12 + inches;
      }
    }
    // Plain cm pattern, e.g. "is 177cm" — 140-209cm covers the plausible
    // adult human height range, avoiding false matches on unrelated numbers
    // (prices, years, etc.) that happen to be followed by other text.
    const cm = line.match(/\b(1[4-9]\d|20\d)\s*cm\b/);
    if (cm) {
      return Number(cm[1]) / 2.54;
    }
  }
  return null;
}

/**
 * Best-effort regex extraction of the garment's own length measurement (in
 * inches) from scraped measurementsText — e.g. "Length: 36.5 cm / 14.37 in".
 * Same graceful-degradation contract as parseReferenceModelHeightInches.
 */
function parseGarmentLengthInches(measurementsText) {
  if (!measurementsText) return null;
  const both = measurementsText.match(/length\s*:\s*([\d.]+)\s*cm\s*\/\s*([\d.]+)\s*in/i);
  if (both) return Number(both[2]);
  const inOnly = measurementsText.match(/length\s*:\s*([\d.]+)\s*in\b/i);
  if (inOnly) return Number(inOnly[1]);
  const cmOnly = measurementsText.match(/length\s*:\s*([\d.]+)\s*cm\b/i);
  if (cmOnly) return Number(cmOnly[1]) / 2.54;
  return null;
}

/**
 * Deterministically computes how many inches lower/higher the garment's hem
 * will land on this model vs. the reference model, given a fixed physical
 * garment length and both models' heights. This is real arithmetic done in
 * code specifically so it's NOT left to Claude — asking an LLM to both
 * reason about direction AND compute an exact number turned out to be
 * unreliable (confirmed live, twice: Claude has stated the correct
 * shorter/taller rule and then written a numerically/directionally
 * contradictory conclusion anyway). Returns null if either number couldn't
 * be parsed — callers must fall back to qualitative-only language in that
 * case, not guess a number.
 *
 * Math: assumes body proportions (specifically, how far down the torso a
 * garment's landing point sits) scale linearly with total height — a
 * simplification (real torso/leg ratios vary by individual, and we only
 * have overall height to work with), but a standard, defensible one for an
 * estimate like this. If a garment of length L lands at some point on the
 * reference model (height H_ref), the same fixed L on this model (height
 * H_this) covers a different fraction of her (typically shorter or taller)
 * frame. The shift, in inches on THIS model's body:
 *   shiftIn = L * (1 - H_this / H_ref)
 * Positive shiftIn = hem sits further down (more coverage) than on the
 * reference model — always true when this model is shorter (H_this <
 * H_ref), matching the established correct physics (fixed-length garment +
 * shorter/proportionally-shorter torso = hem covers more). Negative =
 * higher (less coverage), when this model is taller.
 */
function computeHemShift(settings, productData) {
  if (!settings.modelHeightEnabled || !settings.modelHeightInches) return null;
  const refHeightIn = parseReferenceModelHeightInches(productData.measurementsText);
  const garmentLengthIn = parseGarmentLengthInches(productData.measurementsText);
  if (!refHeightIn || !garmentLengthIn) return null;

  const shiftIn = garmentLengthIn * (1 - settings.modelHeightInches / refHeightIn);
  return {
    refHeightIn,
    garmentLengthIn,
    shiftIn,
    shiftCm: shiftIn * 2.54,
  };
}

/**
 * Just the DIRECTION (shorter/taller, and therefore lower/higher-sitting
 * hem) — doesn't need the garment's length at all, only both heights, so
 * it's available far more often than the full computeHemShift (which also
 * needs a garment length number that many sites just don't publish).
 *
 * This exists because of a confirmed, repeated failure mode: even when
 * handed an explicit fill-in-the-blank fitReasoning template with a
 * flagged warning about this exact mistake, Claude has TWICE stated the
 * correct rule and then written a directionally-reversed conclusion anyway
 * — once with an exact number available, once in the pure-qualitative
 * case with no number to lean on at all. Warning it about the mistake
 * hasn't been reliable enough. So this direction is computed here, in
 * code, and handed to Claude as a settled fact it copies rather than
 * something it derives — see buildHemReasoningSentence, which turns this
 * into the literal fitReasoning text Claude is told to reproduce verbatim.
 */
function computeHemDirection(settings, productData) {
  if (!settings.modelHeightEnabled || !settings.modelHeightInches) return null;
  const refHeightIn = parseReferenceModelHeightInches(productData.measurementsText);
  if (!refHeightIn || refHeightIn === settings.modelHeightInches) return null;
  return {
    refHeightIn,
    isShorter: settings.modelHeightInches < refHeightIn,
  };
}

/**
 * Builds the COMPLETE fitReasoning sentence in code — Claude is told to
 * reproduce this verbatim, not fill in blanks or paraphrase it, removing
 * the inference step that's twice produced a directionally-reversed
 * conclusion despite explicit warnings. Includes the exact magnitude when
 * computeHemShift resolved one, otherwise stays qualitative (direction
 * only, still 100% reliable since that part is also code-computed).
 */
function buildHemReasoningSentence(settings, hemDirection, hemShift) {
  if (!hemDirection) return null;
  const shorterOrTaller = hemDirection.isShorter ? "SHORTER" : "TALLER";
  const proportionallyText = hemDirection.isShorter ? "SHORTER" : "LONGER";
  const hemBehaviorText = hemDirection.isShorter
    ? "extends further down her body, covering MORE, showing LESS or NO midriff"
    : "sits higher relative to her body, covering LESS, showing MORE midriff";
  const conclusionText = hemDirection.isShorter ? "LOWER, covering more" : "HIGHER, exposing more midriff";
  const magnitudeText = hemShift ? `, by approximately ${Math.abs(hemShift.shiftIn).toFixed(1)} in (${Math.abs(hemShift.shiftCm).toFixed(1)} cm)` : "";
  return `Reference model is ${hemDirection.refHeightIn.toFixed(1)} in tall. This model is ${settings.modelHeightInches} in tall, which is ${shorterOrTaller} than the reference. A garment's physical length is fixed regardless of who wears it, but torso length scales with height. Since this model is ${shorterOrTaller}, her torso is proportionally ${proportionallyText}, so the same fixed-length hem ${hemBehaviorText}. Conclusion: the hem sits ${conclusionText} than it did on the reference model${magnitudeText}.`;
}

/**
 * Hardcoded benchmark: rough full bust circumference (inches) per cup
 * letter, used ONLY when the user hasn't entered their real number
 * (modelBustEnabled off). NOT AI-generated and not medically precise —
 * standard bra sizing needs a band size too (which this tool doesn't
 * collect), so this assumes a common average band (~34) and applies the
 * standard ~1-1.5in step per cup letter used in general bra-size charts.
 * Real fit varies more than a single letter can capture; this exists so the
 * width fit-check still does *something* useful without asking for a
 * measurement, not as a substitute for entering a real one.
 */
const CUP_SIZE_BUST_ESTIMATE_IN = {
  "N/A": 32,
  A: 34,
  B: 35.5,
  C: 37,
  D: 38.5,
  E: 40,
  F: 41.5,
  G: 43,
  H: 44.5,
  I: 46,
  J: 47.5,
};

/**
 * Real bust/chest circumference if the user entered one, else the
 * cup-size benchmark table above, else null (no cup size set either).
 */
function estimateBustCircumferenceInches(settings) {
  if (settings.modelBustEnabled && settings.modelBustInches) {
    return { inches: settings.modelBustInches, source: "measured" };
  }
  const estimate = CUP_SIZE_BUST_ESTIMATE_IN[settings.modelChestSize];
  return estimate ? { inches: estimate, source: "estimated from cup size" } : null;
}

/**
 * Best-effort regex extraction of the garment's own bust measurement (in
 * inches) from scraped measurementsText — e.g. "Bust: 76 cm / 29.92 in".
 * Same graceful-degradation contract as parseGarmentLengthInches.
 */
function parseGarmentBustInches(measurementsText) {
  if (!measurementsText) return null;
  const both = measurementsText.match(/bust\s*:\s*([\d.]+)\s*cm\s*\/\s*([\d.]+)\s*in/i);
  if (both) return Number(both[2]);
  const inOnly = measurementsText.match(/bust\s*:\s*([\d.]+)\s*in\b/i);
  if (inOnly) return Number(inOnly[1]);
  const cmOnly = measurementsText.match(/bust\s*:\s*([\d.]+)\s*cm\b/i);
  if (cmOnly) return Number(cmOnly[1]) / 2.54;
  return null;
}

/**
 * Deterministically estimates how much looser/tighter a garment will fit
 * around the bust/chest than its own tailored measurement — this is what
 * actually explains a garment reading as "oversized" or "too small": FASHN
 * Try-On has no sizing input at all (confirmed against its documented
 * parameters), so it just replicates whatever fit is shown in the scraped
 * garment photo, with no way to know if that garment's actual size runs
 * looser or tighter than this model's real measurements. Unlike
 * computeHemShift, this doesn't need a reference model's measurements at
 * all — it's a direct garment-vs-model comparison. Positive easeIn = the
 * garment's own bust measurement is bigger than hers (will read loose/
 * oversized); negative = smaller (will read snug/tight). Returns null if
 * either number is unavailable.
 */
function computeWidthShift(settings, productData) {
  const bust = estimateBustCircumferenceInches(settings);
  const garmentBustIn = parseGarmentBustInches(productData.measurementsText);
  if (!bust || !garmentBustIn) return null;

  const easeIn = garmentBustIn - bust.inches;
  return {
    garmentBustIn,
    modelBustIn: bust.inches,
    modelBustSource: bust.source,
    easeIn,
    easeCm: easeIn * 2.54,
  };
}

/**
 * Turns a raw ease number into wording that actually scales with how
 * extreme the mismatch is. Confirmed live this was a real gap: the number
 * was always correct, but a 1in mismatch and a 15in mismatch both produced
 * the same soft "slightly snug" / "bring the fit in slightly" language —
 * badly underselling a garment that genuinely wouldn't close in real life.
 * "mild" keeps the original wording; "moderate" and "extreme" escalate to
 * describing visible strain (too small) or the garment swimming on her
 * frame (too big), including that closures may not fully close at the
 * extreme end — since that's the realistic outcome, not a cosmetic detail.
 */
function describeWidthEffect(easeIn) {
  const absIn = Math.abs(easeIn);
  const tooLoose = easeIn >= 0;
  const severity = absIn <= 2 ? "mild" : absIn <= 5 ? "moderate" : "extreme";

  const directionLabel = tooLoose ? `LOOSER than its tailored fit` : `TIGHTER than its tailored fit`;

  const imagePromptPhrase = tooLoose
    ? {
        mild: `drapes with a bit of extra ease through the chest and shoulders, a relaxed fit`,
        moderate: `drapes noticeably loose through the chest and shoulders, a relaxed, oversized fit`,
        extreme: `hangs dramatically oversized on her — swimming loosely through the chest and shoulders, well beyond a simply relaxed fit, looking like several sizes too big`,
      }[severity]
    : {
        mild: `fits close through the chest, slightly snugger than its tailored measurement`,
        moderate: `fits tightly through the chest and shoulders, visibly snug with the fabric pulling`,
        extreme: `fits severely undersized through the chest and shoulders — the fabric pulled taut and straining, visibly too small for her frame, with any zipper or buttons unable to fully close`,
      }[severity];

  const fitEditPhrase = tooLoose
    ? {
        mild: `add a touch of visible ease through the chest and shoulders`,
        moderate: `add noticeable ease/looseness through the chest and shoulders, giving it a relaxed, oversized drape`,
        extreme: `render the garment dramatically oversized through the chest and shoulders — hanging loosely on her, well past a normal relaxed fit, looking like it's several sizes too big`,
      }[severity]
    : {
        mild: `render the garment's fit slightly snugger through the chest and shoulders`,
        moderate: `render the garment fitting tightly and visibly snug through the chest and shoulders, with the fabric pulling`,
        extreme: `render the garment as severely undersized on her — visibly straining across the chest and shoulders, fabric pulled taut, and any zipper or buttons unable to fully close`,
      }[severity];

  return { severity, tooLoose, directionLabel, imagePromptPhrase, fitEditPhrase };
}

/**
 * Rough BMI-based body-build descriptor, used only by the local template
 * fallback (buildTemplatePrompt) — Claude reasons about this contextually
 * itself given the raw numbers, but the template has no LLM to do that, so
 * this does the equivalent arithmetic directly rather than hardcoding a
 * "plus-size" assumption regardless of what height/weight actually say.
 * Uses the sandbagged weight so the described build stays consistent with
 * the weight number stated elsewhere in the same prompt.
 */
function estimateBuildDescriptor(settings) {
  const heightInches = settings.modelHeightEnabled ? settings.modelHeightInches : 0;
  const weightLbs = getSandbaggedWeight(settings);
  if (!heightInches || !weightLbs) return null;

  const bmi = (weightLbs / (heightInches * heightInches)) * 703;
  if (bmi < 18.5) return "a slender, slight build, with a flat stomach";
  if (bmi < 25) return "an average, toned build, with a flat, naturally fit stomach";
  if (bmi < 30) return "a curvier build, fuller through the bust, waist, and hips, with a softly rounded stomach";
  return "a plus-size build, with a fuller bust, waist, and hips, and her stomach and sides softly rounded";
}

/** Builds the "here are the concrete appearance specs" block, or null if none are set. */
function buildAppearanceSpec(settings) {
  const parts = [];
  if (settings.modelHeight) parts.push(`Height: ${settings.modelHeight}`);
  const weight = getSandbaggedWeight(settings);
  if (weight) parts.push(`Weight: ${weight} lbs`);
  if (settings.modelChest) parts.push(`Chest/bust size: ${settings.modelChest}`);
  if (settings.modelSkinTone) parts.push(`Skin tone: ${settings.modelSkinTone}`);
  return parts.length ? parts.join(", ") : null;
}

/**
 * Fingerprint of just the settings that actually affect what the base model
 * photo looks like. Used to detect "appearance settings changed since this
 * photo was picked" so a stale cached model doesn't silently keep getting
 * reused forever after e.g. changing weight or skin tone — see
 * generateImage()'s cache check and getSettings()'s savedModelSpecFingerprint.
 * Deliberately excludes anything garment/product-specific.
 */
function computeAppearanceFingerprint(settings) {
  return JSON.stringify([
    settings.modelHeightEnabled ? settings.modelHeightInches : null,
    settings.modelWeightEnabled ? settings.modelWeightLbs : null,
    settings.modelSandbagEnabled ? settings.modelSandbagPercent : null,
    settings.modelChest || null,
    settings.modelSkinTone || null,
  ]);
}

// Framing for the garment-neutral "pick your model photo" prompt (settings
// page) — same body-build reasoning as the per-product prompt (via
// buildBodyInstructions), but she's dressed in plain, unbranded, form-fitting
// basics instead of any specific garment, since this photo is meant to be
// reused as the base for many different real garments applied later via
// FASHN Try-On/Edit.
const BASE_MODEL_INTRO = {
  withSpec: `You write image-generation prompts for a virtual try-on tool. Write ONE detailed prompt describing a photorealistic studio fashion photograph of a female model wearing simple, plain, form-fitting basics (e.g. a solid-color fitted tank top and leggings, no logos or patterns) — this photo will be reused as a base for trying on many different real garments later via image-based garment overlay, so nothing about the specific outfit should stand out.`,
  noSpec: `You write image-generation prompts for a virtual try-on tool. Write ONE detailed prompt describing a photorealistic studio fashion photograph of a plus-size female model wearing simple, plain, form-fitting basics (e.g. a solid-color fitted tank top and leggings, no logos or patterns) — this photo will be reused as a base for trying on many different real garments later via image-based garment overlay, so nothing about the specific outfit should stand out.`,
};

async function buildBaseModelPrompt(settings) {
  if (settings.anthropicApiKey) {
    return callClaudeBaseModel(settings);
  }
  return buildTemplateBaseModelPrompt(settings);
}

async function callClaudeBaseModel(settings) {
  const { openingSentence, bodyInstruction } = buildBodyInstructions(settings, { intro: BASE_MODEL_INTRO });

  const systemPrompt = `${openingSentence}

${bodyInstruction}

Other requirements:
- CRITICAL — sharpness: the image must be in sharp focus throughout — crisp fine detail on the face, hair, jewelry, and fabric. Explicitly state the subject is in sharp focus with no blur, haze, or soft-focus effect. Do not describe any depth-of-field or bokeh effect on the subject herself (a plain, undetailed backdrop is fine and expected, but her face and body must be tack-sharp, not blurred).
- Standing three-quarter pose, full body or chest-to-mid-thigh framing, arms relaxed at her sides rather than crossed or covering her torso, so garments can be clearly overlaid onto this photo later.
- Neutral very light grey seamless studio backdrop, soft even lighting.
- CRITICAL — skin texture: explicitly describe realistic, unretouched skin — visible pores, subtle natural texture, faint blemishes or unevenness, natural specular highlights. Explicitly state the skin should NOT look airbrushed, waxy, plastic, overly smooth, or like a beauty filter — it should read as an authentic photograph of a real person, not a digitally smoothed rendering.
- CRITICAL — outfit: describe simple, solid-color, form-fitting basics with no visible logos, patterns, or distinctive design details — this is a neutral base photo, not a styled outfit.
- Same framing and lighting style as a retail e-commerce product photo.
Output ONLY the prompt text. No preamble, no markdown, no quotation marks.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": settings.anthropicApiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: settings.claudeModel,
      max_tokens: CLAUDE_MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: "user", content: "Write the prompt now." }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  assertNotTruncated(data);
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock || !textBlock.text) {
    throw new Error("Claude returned no text content.");
  }
  return textBlock.text.trim();
}

/** Local fallback used when no Anthropic key is configured yet. */
function buildTemplateBaseModelPrompt(settings) {
  const appearanceSpec = buildAppearanceSpec(settings || {});
  const buildDescriptor = estimateBuildDescriptor(settings || {});
  const bodyDescription = appearanceSpec
    ? `a female model matching these exact specs — ${appearanceSpec} — ${buildDescriptor || "with a build consistent with those measurements"}`
    : "a plus-size (roughly US size 18-20) female model, with a fuller bust, waist, and hips, and her stomach and sides softly rounded";
  return (
    `Full-body studio fashion photograph of ${bodyDescription}, wearing simple, solid-color, ` +
    `form-fitting basics (a fitted charcoal grey tank top and leggings, no logos or patterns) — ` +
    `a neutral base photo meant for trying on other garments later, in sharp focus throughout with ` +
    `crisp fine detail on the face, hair, and fabric — no blur, haze, or soft-focus effect — standing ` +
    `in a relaxed three-quarter pose, arms at her sides, against a seamless very light grey backdrop, ` +
    `soft even studio lighting, shot from chest to mid-thigh. Photorealistic, editorial e-commerce ` +
    `fashion photography, with realistic unretouched skin — visible pores, subtle natural texture, ` +
    `natural specular highlights, NOT airbrushed, waxy, plastic, or beauty-filtered.`
  );
}

/**
 * Generates `count` candidate base model photos (different seeds, same
 * prompt) for the settings page's "pick your model photo" picker — called
 * once when setting up or changing appearance preferences, not per product.
 * Each candidate costs one FLUX call (~$0.015); this only runs when the user
 * explicitly asks for new options, never automatically per try-on.
 */
async function generateModelOptions(count = 3) {
  const settings = await getSettings();
  if (!settings.falApiKey) {
    throw new Error("No fal.ai API key configured. Add one in the extension's settings page.");
  }
  const prompt = await buildBaseModelPrompt(settings);
  const images = [];
  for (let i = 0; i < count; i += 1) {
    // Genuine variety wanted here (3 different-looking candidates to choose
    // from), unlike the per-product pipeline's FLUX_TEST_SEED pinning
    // (which exists for run-to-run reproducibility during testing) — so
    // these are randomly seeded rather than deterministic.
    const seed = Math.floor(Math.random() * 2 ** 31);
    const url = await callFlux(settings.falApiKey, prompt, seed);
    images.push(url);
  }
  return { images, prompt };
}

/**
 * Builds { prompt, fitEditPrompt } for this product — prompt is fed to
 * FLUX to generate the model photo; fitEditPrompt (null unless garment
 * measurements + a model height are available) is fed to FASHN's Edit
 * endpoint after Try-On to correct hem/neckline placement. Uses live Claude
 * if an Anthropic API key is configured; otherwise falls back to a
 * deterministic local template so the rest of the UI still works.
 */
async function generatePrompt(productData) {
  const settings = await getSettings();

  if (settings.anthropicApiKey) {
    return callClaude(settings, productData);
  }
  return buildTemplatePrompt(productData, settings);
}

/**
 * Shared by callClaude (per-product prompt) and callClaudeBaseModel (the
 * garment-neutral "pick your model photo" prompt) — the body-build framing
 * doesn't depend on which garment (if any) she's wearing, so this shouldn't
 * be duplicated between the two.
 *
 * When explicit specs are given, the body description must be DERIVED from
 * those numbers (reasoned out, like a rough BMI/build assessment), never
 * assumed. Previously this branch still hardcoded "fuller figure, softly
 * rounded stomach" regardless of what the numbers actually said — so e.g. a
 * 5'6"/120lb spec (a slim build) still got described as plus-size, directly
 * contradicting the stated height/weight. Only the no-spec fallback below
 * defaults to plus-size, matching this tool's original purpose when the
 * user hasn't overridden it with real numbers.
 */
function buildBodyInstructions(settings, { intro } = {}) {
  const appearanceSpec = buildAppearanceSpec(settings);

  // Callers can override the framing sentence (used for the garment-neutral
  // base-model prompt, which has no scraped product page at all) — default
  // preserves the original per-product wording unchanged.
  const defaultIntro = {
    withSpec: `You write image-generation prompts for a virtual try-on tool. Given scraped text from an online clothing product page, write ONE detailed prompt describing a photorealistic studio fashion photograph of a female model wearing the exact garment described on the page.`,
    noSpec: `You write image-generation prompts for a virtual try-on tool. Given scraped text from an online clothing product page, write ONE detailed prompt describing a photorealistic studio fashion photograph of a plus-size female model wearing the exact garment described on the page.`,
  };
  const { withSpec, noSpec } = intro || defaultIntro;
  const openingSentence = appearanceSpec ? withSpec : noSpec;

  const bodyInstruction = appearanceSpec
    ? `CRITICAL — body type: the person specifying this request has given exact physical specs to use for the model: ${appearanceSpec}. State the height and weight explicitly and prominently in your prompt. Then reason out what build those specific numbers would realistically produce — do the mental math (e.g. a 5'6", 120 lb figure is slender/average, roughly a US size 2-4; a 5'3", 270 lb figure is plus-size, roughly a US size 22-24+) — and describe her body accordingly. Do NOT default to plus-size, fuller-figured, or a "softly rounded stomach" unless the stated height and weight actually indicate that build. For numbers implying a slim or average build, describe a flat or naturally toned stomach and a slender/average silhouette instead. The body description must be internally consistent with the stated height/weight — never a fixed assumption independent of them.`
    : `CRITICAL — body type: do not use the vague word "midsize" — it hasn't been producing visible divergence from a standard model. Instead describe a genuinely plus-size figure in concrete, specific terms: state an approximate size (e.g. "a plus-size model, roughly a US size 18-20"), and describe a fuller bust, waist, and hips, with her stomach and sides softly rounded. Explicitly state that the body should look visibly larger and rounder than a typical straight-size fashion model.`;

  return { appearanceSpec, openingSentence, bodyInstruction };
}

async function callClaude(settings, productData) {
  const { appearanceSpec, openingSentence, bodyInstruction } = buildBodyInstructions(settings);

  // Some product pages give garment measurements (bust/waist/hem/length) and
  // the reference model's own height + the size she's wearing — e.g. "model
  // is 177cm, wearing a size AU 6". A garment's physical length is FIXED
  // regardless of who wears it, while torso length scales with height — so
  // on a SHORTER model (proportionally shorter torso), the same fixed-length
  // hem extends further down her body, typically covering MORE (less or no
  // midriff shown), and on a TALLER model (proportionally longer torso) it
  // rides higher, showing MORE midriff than it did on the reference model.
  // Only included when both a height spec AND scraped measurement text
  // exist — reasoning about relative proportions needs a height to compare
  // against.
  //
  // This reasoning now drives TWO separate outputs, not one:
  //  - imagePrompt: same as before, so FLUX renders the hem in roughly the
  //    right place on the base model photo.
  //  - fitEditPrompt: a standalone instruction for FASHN's Edit endpoint,
  //    which runs AFTER Try-On applies the real garment and genuinely does
  //    accept a text prompt ("freeform instructions... ideal for pose or
  //    view adjustments... small fixes" per FASHN's own docs) — unlike
  //    Try-On itself, which only takes images (confirmed against its full
  //    documented parameter list: model_image, garment_image, category,
  //    segmentation_free, moderation_level, garment_photo_type, mode, seed,
  //    num_samples, output_format/return_base64 — no text field anywhere).
  //    Edit is the actual place this reasoning can act on the real garment
  //    photo's placement, not just an AI-imagined stand-in.
  // Confirmed live: Claude sometimes states the correct rule (shorter model
  // -> shorter torso -> hem sits LOWER, less/no midriff) but then writes a
  // conclusion that silently reverses it anyway — a reasoning slip, not an
  // instruction-wording problem, since the rule as given is unambiguous.
  // Mitigation: force the shorter/taller comparison and its consequence to
  // be written out as its own JSON field (fitReasoning), emitted BEFORE
  // imagePrompt/fitEditPrompt, so the model has to commit to a direction as
  // a discrete step rather than composing prose where the two can silently
  // diverge.
  // Precomputed deterministically in code (see computeHemShift) whenever
  // both the reference model's height and the garment's own length could be
  // parsed out of the scraped text — never left to Claude to calculate
  // itself. null when either number couldn't be found, in which case the
  // instructions below fall back to qualitative-only language exactly as
  // before this existed.
  const hemShift = computeHemShift(settings, productData);
  const hemShiftDirectionText = hemShift
    ? hemShift.shiftIn >= 0
      ? `LOWER on her body (more coverage) than it did on the reference model`
      : `HIGHER on her body (less coverage) than it did on the reference model`
    : "";
  const hemShiftMagnitudeText = hemShift
    ? `${Math.abs(hemShift.shiftIn).toFixed(1)} in (${Math.abs(hemShift.shiftCm).toFixed(1)} cm)`
    : "";

  // Width/ease is a separate concern from hem/length above — doesn't need
  // a reference model's measurements at all, just a direct garment-vs-model
  // comparison (see computeWidthShift). Composed independently so it can
  // fire even when height isn't set (or vice versa) — see the outer gate
  // below, which now also requires either modelHeightEnabled OR a bust
  // estimate, not just modelHeightEnabled.
  const widthShift = computeWidthShift(settings, productData);
  const hasBustEstimate = !!estimateBustCircumferenceInches(settings);
  // Fallback signal for sites (confirmed live: gap.com) that publish no
  // garment measurements at all, only retailer-written fit language like
  // "Fit: Classic. A straight & easy fit. Slightly cropped, hits above the
  // hip." — see QUALITATIVE_FIT_REGEX. Used only when the precise numeric
  // path (widthShift) isn't available; numeric always wins when present.
  const hasQualitativeFit = !!(productData.measurementsText && QUALITATIVE_FIT_REGEX.test(productData.measurementsText));

  const hemDirection = computeHemDirection(settings, productData);
  const hemReasoningSentence = buildHemReasoningSentence(settings, hemDirection, hemShift);

  const hemSection = settings.modelHeightEnabled
    ? hemReasoningSentence
      ? // hemDirection resolved — the shorter/taller comparison and its
        // consequence are both fully settled in code. Claude is told to
        // reproduce the sentence VERBATIM, not derive or paraphrase it —
        // asking it to fill in [SHORTER/TALLER]-style blanks itself was
        // tried twice and confirmed to still produce a directionally
        // reversed conclusion despite an explicit warning about exactly
        // this mistake, so the inference step is removed entirely here.
        `\n\nHEM/LENGTH — a complete, verified conclusion has ALREADY been worked out for you in code. Do NOT re-derive, re-evaluate, recompute, or second-guess whether this model is shorter or taller than the reference, or which way the hem moves — that reasoning is done and settled, not a judgment call for you to make.

Set fitReasoning to EXACTLY this sentence, character-for-character, with no changes, additions, or rephrasing:
"${hemReasoningSentence}"

In imagePrompt, state explicitly and concretely where the garment's key hem/neckline/proportion points land on this specific model, consistent with — and only with — that exact conclusion (${
          hemShift
            ? `e.g. "the hem extends roughly ${hemShiftMagnitudeText} further down than shown in the original photo, landing past her natural waist toward her hip, showing no midriff"`
            : hemDirection.isShorter
              ? `e.g. "the cropped hem extends past her natural waist toward her hip, showing no midriff"`
              : `e.g. "the cropped hem sits well above her natural waist, exposing several inches of midriff"`
        }) — don't leave this vague or assume the same fit shown in the original photo, and don't write anything implying the opposite direction from the fitReasoning sentence above.

In fitEditPrompt, include an instruction to adjust only where the garment's hem/neckline/proportions sit on her body, consistent with — and only with — that same exact conclusion. State the target placement concretely${
          hemShift
            ? ` and with the exact measurement (e.g. "Extend the garment's hemline downward by approximately ${hemShiftMagnitudeText} compared to how it appears in this photo, so it falls past her natural waist toward her hip and shows no exposed midriff — she is notably shorter than the garment's reference model.")`
            : hemDirection.isShorter
              ? ` (e.g. "Adjust the top so its hemline falls past her natural waist, extending toward her hip, so it shows no exposed midriff — she is notably shorter than the garment's reference model.")`
              : ` (e.g. "Adjust the top so its hemline sits higher, well above her natural waist, exposing several inches of midriff — she is notably taller than the garment's reference model.")`
        }.`
      : // Couldn't even parse a reference model height at all — genuinely
        // nothing to compute from, so this is the only case that still
        // asks Claude to reason it out itself.
        `\n\nHEM/LENGTH — the scraped text may include the height and size worn by the model in the original product photo. Compare that to this model's actual height (${settings.modelHeight}) and reason out how that changes where the garment's hemline/neckline/waistband lands on THIS model's body.

First, fill in the fitReasoning field with EXACTLY this template, filled in — do not skip or shorten it:
"Reference model is [height]. This model is ${settings.modelHeight}, which is [SHORTER/TALLER] than the reference. A garment's physical length is fixed regardless of who wears it, but torso length scales with height. Since this model is [SHORTER/TALLER], her torso is proportionally [SHORTER/LONGER], so the same fixed-length hem [extends further down her body, covering MORE, showing LESS or NO midriff / sits higher relative to her body, covering LESS, showing MORE midriff]. Conclusion: the hem sits [LOWER, covering more / HIGHER, exposing more midriff] than it did on the reference model."
This is a common point where reasoning silently reverses itself — SHORTER model = LOWER-sitting hem = LESS midriff; TALLER model = HIGHER-sitting hem = MORE midriff. Pick the bracketed options consistent with each other and with which one (shorter/taller) is actually true here — do not let imagePrompt or fitEditPrompt contradict the conclusion you just wrote in fitReasoning.

In imagePrompt, state explicitly and concretely where the garment's key hem/neckline/proportion points land on this specific model, consistent with the fitReasoning conclusion above (e.g. "the top's cropped hem extends past her natural waist toward her hip, showing no midriff" for a notably shorter model, or "sits well above her natural waist, exposing several inches of midriff" for a notably taller model) — don't leave this vague or assume the same fit shown in the original photo.

In fitEditPrompt, include an instruction (consistent with the SAME fitReasoning conclusion — do not re-derive it independently) to adjust only where the garment's hem/neckline/proportions sit on her body. State the target placement concretely (e.g. "Adjust the top so its hemline falls past her natural waist, extending toward her hip, so it shows no exposed midriff — she is notably shorter than the garment's reference model.").`
    : "";

  const widthEffect = widthShift ? describeWidthEffect(widthShift.easeIn) : null;

  const widthSection = hasBustEstimate || hasQualitativeFit
    ? `\n\nWIDTH/EASE (independent of hem/length above) — FASHN's Try-On step (which applies the real garment) has NO sizing input at all (confirmed against its full documented API parameters) — it can only replicate whatever fit is shown in the scraped garment photo, with no way to know if that specific photographed size runs looser or tighter than this model's real measurements. This is exactly why a garment can end up looking implausibly oversized or too-small in the final result.${
        widthShift
          ? ` An exact estimate has ALREADY been computed for you in code — do not recompute it: this garment's own bust measurement is ${widthShift.garmentBustIn.toFixed(1)} in; this model's bust/chest circumference is ${
              widthShift.modelBustSource === "measured"
                ? `${widthShift.modelBustIn.toFixed(1)} in (a real measurement she provided)`
                : `estimated at ${widthShift.modelBustIn.toFixed(1)} in from her cup size (a rough benchmark, not exact — say "approximately")`
            }. That means, compared to how it's shown in the original photo, the garment will fit her ${Math.abs(widthShift.easeIn).toFixed(1)} in (${Math.abs(widthShift.easeCm).toFixed(1)} cm) ${widthEffect.directionLabel} — this is a ${widthEffect.severity.toUpperCase()} mismatch, so the wording below MUST match that severity, not a generic "slightly snug"/"slightly loose" description regardless of how large the number is.

In imagePrompt, state this specific fit effect concretely, matching the ${widthEffect.severity} severity above (e.g. "the jacket ${widthEffect.imagePromptPhrase}").

In fitEditPrompt, include an instruction to adjust the GARMENT's fit (not her body) by approximately ${Math.abs(widthShift.easeIn).toFixed(1)} in (${Math.abs(widthShift.easeCm).toFixed(1)} cm) — ${widthEffect.fitEditPhrase} — making explicit that this resizes the GARMENT's drape only, never her body.${
              widthEffect.severity === "extreme"
                ? ` This is an EXTREME mismatch — do not soften it to "slightly" anything. At this magnitude the realistic outcome is visible strain (too small) or the garment visibly swimming on her (too big), not a subtle adjustment.`
                : ""
            }`
          : hasQualitativeFit
            ? ` No exact garment measurements were found on this page, but the scraped text (see "Garment measurements / reference model info" below) includes the retailer's own qualitative fit description — wording like "oversized," "relaxed fit," "slim fit," "cropped," "hits above/below the hip," "true to size," etc. Treat that as your best available signal for how loose or fitted the garment should actually look — it is not a precise number, but it is real information, not a guess.

In imagePrompt, describe the garment's silhouette consistent with that wording. A "classic," "regular," "straight & easy," or "true to size" fit reads as a normal, moderate drape — NOT skin-tight, but also NOT dramatically oversized or baggy. An explicit "oversized," "relaxed fit," or "boxy" description DOES support a visibly roomier drape. Don't default to describing it as loose/oversized unless the source text actually says so.

In fitEditPrompt, ALWAYS include an instruction ensuring the garment's fit (not her body) matches that described silhouette. You are writing this before the garment is even generated — you have NOT seen the rendered image and cannot judge whether it "currently" looks right, so state this as a standing correction to apply regardless, not a conditional check. If the source describes a normal/moderate fit ("classic," "straight," "regular," "true to size"), instruct that the garment should have a normal, moderate drape through the chest and shoulders — not exaggeratedly oversized or baggy. If the source explicitly says "oversized," "relaxed fit," or "boxy," instruct that a visibly roomy, relaxed drape should be preserved. This is a qualitative adjustment — do not invent a specific inch measurement for it.`
            : ` The garment's own bust measurement wasn't found in the scraped text, so skip this specific correction rather than guessing a number — don't mention garment width/ease at all unless the source text makes it unambiguous.`
      }`
    : "";

  const hasHemFit = !!hemSection;
  const hasWidthFit = !!widthSection;
  const bodyPreservationConstraint =
    hasHemFit && hasWidthFit
      ? `Then add, word for word: "These are GARMENT fit changes only (length and/or width of the fabric itself) — do not narrow, widen, slim, or otherwise resize HER waist, torso, arms, bust, shoulders, or any other body measurement. Her exact body shape and proportions must stay pixel-for-pixel identical to the current photo; only how the garment's fabric drapes or hangs on her may change."`
      : hasHemFit
        ? `Then add, word for word: "This is a LENGTH change only — extend or shorten the fabric itself, do not narrow, widen, slim, or otherwise resize her waist, torso, arms, bust, or any other body measurement to accommodate it. Her exact body width and proportions everywhere outside the hem/neckline region must stay pixel-for-pixel identical to the current photo."`
        : `Then add, word for word: "This is a WIDTH change to the garment only — do not narrow, widen, slim, or otherwise resize her waist, torso, arms, bust, or any other body measurement. Her exact body shape and proportions must stay pixel-for-pixel identical to the current photo; only how the garment's fabric drapes on her may change."`;

  const garmentFitInstruction =
    productData.measurementsText && (settings.modelHeightEnabled || hasBustEstimate || hasQualitativeFit)
      ? `\n\nCRITICAL — garment fit: the scraped text (see "Garment measurements / reference model info" below) may include the garment's own measurements (bust/waist/hem/length, in cm or inches) and/or the height and size worn by the model in the original product photo.${hemSection}${widthSection}

Also produce fitEditPrompt: a short, SELF-CONTAINED instruction (it will be sent alone, with no other context, to a separate image-editing step that already has a photo of this exact model wearing the real garment) combining whichever of the hem/length and width/ease adjustments above apply. ${bodyPreservationConstraint} Confirmed live: without an explicit body-preservation constraint, the edit model tends to also resize her body as an unwanted side effect of adjusting the garment, contradicting the 'leave body shape unchanged' instruction it was already given. End with an instruction to leave everything else — her face, pose, body shape, the garment's color/pattern/construction, lighting, and background — unchanged.`
      : "";

  const systemPrompt = `${openingSentence}

${bodyInstruction}${garmentFitInstruction}

Other requirements for imagePrompt:
- CRITICAL — sharpness: the image must be in sharp focus throughout — crisp fine detail on the face, hair, jewelry, and fabric. Explicitly state the subject is in sharp focus with no blur, haze, or soft-focus effect. Do not describe any depth-of-field or bokeh effect on the subject herself (a plain, undetailed backdrop is fine and expected, but her face and body must be tack-sharp, not blurred).
- Standing three-quarter pose, full body or chest-to-mid-thigh framing
- Neutral very light grey seamless studio backdrop, soft even lighting
- CRITICAL — skin texture: explicitly describe realistic, unretouched skin — visible pores, subtle natural texture, faint blemishes or unevenness, natural specular highlights. Explicitly state the skin should NOT look airbrushed, waxy, plastic, overly smooth, or like a beauty filter — it should read as an authentic photograph of a real person, not a digitally smoothed rendering.
- Describe how the garment's fabric drapes, stretches, and settles differently across a fuller figure than it would on a slim body
- Incorporate any material/fabric composition and construction details found in the source text (necklines, straps, hems, fabric type) — do not invent details that contradict the source
- Same framing and lighting style as a retail e-commerce product photo

Output format: respond with ONLY a single raw JSON object, no markdown code fences, no commentary, with keys in EXACTLY this order (fitReasoning must be written before imagePrompt/fitEditPrompt so it isn't rationalized backward from them):
{"fitReasoning": "<the filled-in template described above, or null if garment fit/proportion data wasn't available>", "imagePrompt": "<the full prompt described above>", "fitEditPrompt": "<the standalone edit instruction described above, or null if garment fit/proportion data wasn't available>"}`;

  const userContent = [
    `Product title: ${productData.title || "(unknown)"}`,
    `Price: ${productData.price || "(unknown)"}`,
    "Product detail / description text scraped from the page (may include material composition and measurements):",
    productData.detailsText || "(none found on page)",
    "Garment measurements / reference model info scraped from the page (bust/waist/hem/length, and/or the original photo's model height + size worn, if the page listed them — may be empty):",
    productData.measurementsText || "(none found on page)",
  ].join("\n");

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": settings.anthropicApiKey,
      "anthropic-version": "2023-06-01",
      // Required to call the Messages API directly from a browser-origin
      // context (this service worker's origin is chrome-extension://...).
      // Acknowledges that the API key is exposed client-side — acceptable
      // for a personal-use extension you built yourself, not for anything
      // distributed to other users.
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: settings.claudeModel,
      max_tokens: CLAUDE_MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  assertNotTruncated(data);
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock || !textBlock.text) {
    throw new Error("Claude returned no text content.");
  }
  // sizeWarning is code-computed (see below), not something Claude outputs —
  // merged in after parsing, same severity classification used to word the
  // fitEditPrompt instruction above.
  return { ...parseClaudeJson(textBlock.text.trim()), sizeWarning: buildSizeWarning(widthEffect, widthShift) };
}

/**
 * Surfaced to the user directly (blurred image + confirmation prompt in
 * content.js) rather than just softened wording, when the width mismatch is
 * extreme enough that the garment likely doesn't come in a size that fits —
 * not just "runs a little big/small."
 */
function buildSizeWarning(widthEffect, widthShift) {
  if (!widthEffect || !widthShift || widthEffect.severity !== "extreme") return null;
  return {
    tooLoose: widthEffect.tooLoose,
    easeIn: Math.abs(widthShift.easeIn),
    easeCm: Math.abs(widthShift.easeCm),
  };
}

/**
 * Parses Claude's { fitReasoning, imagePrompt, fitEditPrompt } JSON
 * response. Strips accidental ```json code fences (models sometimes add
 * them despite being told not to) before parsing. Falls back to treating
 * the raw text as the image prompt with no fit-edit prompt if parsing fails
 * for any reason — this must never hard-fail the whole generation over a
 * formatting slip. fitReasoning is passed through (not otherwise used) so
 * it can be logged for verification — see content.js's console.log of it —
 * since this is exactly the field meant to catch Claude silently reversing
 * the shorter/taller conclusion.
 */
function parseClaudeJson(text) {
  const cleaned = text.replace(/^```(?:json)?\n?/, "").replace(/```$/, "").trim();
  try {
    const data = JSON.parse(cleaned);
    return {
      prompt: data.imagePrompt || cleaned,
      fitEditPrompt: data.fitEditPrompt || null,
      fitReasoning: data.fitReasoning || null,
    };
  } catch (_) {
    return { prompt: cleaned, fitEditPrompt: null };
  }
}

/** Local fallback used when no Anthropic key is configured yet. */
function buildTemplatePrompt(productData, settings) {
  const title = productData.title || "the garment shown in the reference image";
  const details = productData.detailsText
    ? ` Material/construction notes from the product page: ${productData.detailsText}.`
    : "";
  const appearanceSpec = buildAppearanceSpec(settings || {});
  const buildDescriptor = estimateBuildDescriptor(settings || {});
  const bodyDescription = appearanceSpec
    ? `a female model matching these exact specs — ${appearanceSpec} — ${buildDescriptor || "with a build consistent with those measurements"}`
    : "a plus-size (roughly US size 18-20) female model, with a fuller bust, waist, and hips, and her stomach and sides softly rounded";
  // No LLM available here, but the hem-shift and width/ease math themselves
  // are plain arithmetic (see computeHemShift / computeWidthShift) —
  // doesn't need one. Each degrades independently: falls back to a flat,
  // qualitative hem note when the exact hem numbers couldn't be parsed, and
  // simply omits the width correction when the exact width numbers
  // couldn't be parsed (no qualitative-only width fallback, to avoid
  // guessing a direction with nothing to anchor it).
  const hasHeightFitData = !!(settings && settings.modelHeightEnabled && productData.measurementsText);
  const hemShift = hasHeightFitData ? computeHemShift(settings, productData) : null;
  const widthShift = productData.measurementsText ? computeWidthShift(settings || {}, productData) : null;
  // Fallback for sites with no numeric garment measurements at all
  // (confirmed live: gap.com) — see QUALITATIVE_FIT_REGEX / the matching
  // callClaude comment. Numeric widthShift always wins when available.
  const hasQualitativeFit = !!(productData.measurementsText && QUALITATIVE_FIT_REGEX.test(productData.measurementsText));
  const hasFitData = hasHeightFitData || !!widthShift || hasQualitativeFit;

  const hemNote = hemShift
    ? ` Reference — this garment's own length is ~${hemShift.garmentLengthIn.toFixed(1)} in and the reference model is ~${hemShift.refHeightIn.toFixed(1)} in tall; this model is ${settings.modelHeightInches} in tall. The hem should land approximately ${Math.abs(hemShift.shiftIn).toFixed(1)} in (${Math.abs(hemShift.shiftCm).toFixed(1)} cm) ${hemShift.shiftIn >= 0 ? "lower on her body (more coverage)" : "higher on her body (less coverage)"} than it did on the reference model.`
    : hasHeightFitData
      ? ` Reference — garment measurements and/or the original photo's model height/size from the product page: ${productData.measurementsText}. Position hemlines, necklines, and other proportions on this model according to her actual height relative to that reference, rather than assuming identical placement to the original photo.`
      : "";
  const widthEffect = widthShift ? describeWidthEffect(widthShift.easeIn) : null;
  const widthNote = widthShift
    ? ` This garment's own bust measurement is ${widthShift.garmentBustIn.toFixed(1)} in vs. this model's ${widthShift.modelBustSource === "measured" ? "" : "estimated "}bust/chest circumference of ${widthShift.modelBustIn.toFixed(1)} in${widthShift.modelBustSource === "measured" ? "" : " (from her cup size)"} — the garment will fit ${Math.abs(widthShift.easeIn).toFixed(1)} in (${Math.abs(widthShift.easeCm).toFixed(1)} cm) ${widthEffect.directionLabel.toLowerCase()}: it ${widthEffect.imagePromptPhrase}.`
    : hasQualitativeFit
      ? ` No exact garment measurements were listed, but the product page describes this garment's fit qualitatively (see scraped text) — reflect that described silhouette (e.g. "classic"/"straight"/"true to size" reads as a normal, moderate drape, not oversized; "oversized"/"relaxed fit"/"boxy" supports a visibly roomier drape) rather than assuming a generic fit.`
      : "";
  const fitNote = `${hemNote}${widthNote}`;
  const prompt =
    `Full-body studio fashion photograph of ${bodyDescription}, in sharp focus throughout ` +
    `with crisp fine detail on the face, hair, and fabric — no blur, haze, or soft-focus ` +
    `effect on the subject — ` +
    `standing in a relaxed three-quarter pose against a seamless very light grey backdrop, ` +
    `soft even studio lighting, shot from chest to mid-thigh. She is wearing ${title}.` +
    `${details} Photorealistic, editorial e-commerce fashion photography, with realistic ` +
    `unretouched skin — visible pores, subtle natural texture, natural specular highlights, ` +
    `NOT airbrushed, waxy, plastic, or beauty-filtered — accurate garment drape and fabric ` +
    `behavior for the body type, neutral studio backdrop, same framing and lighting as the ` +
    `original product photo.${fitNote}`;

  // Sent to FASHN's Edit endpoint (genuinely text-driven, unlike Try-On) as
  // a follow-up correction step — see callClaude's garmentFitInstruction
  // comment for why Try-On itself can't receive this directly. Composed
  // from independent hem and width clauses so either can be present alone.
  const hemEditClause = hasHeightFitData
    ? `Adjust the garment's hemline/neckline so it fits this model's actual height (${settings.modelHeight}) rather than the original product photo's proportions. ${
        hemShift
          ? `Extend the garment's hemline ${hemShift.shiftIn >= 0 ? "downward" : "upward"} by approximately ${Math.abs(hemShift.shiftIn).toFixed(1)} in (${Math.abs(hemShift.shiftCm).toFixed(1)} cm) compared to how it appears in this photo, since this model (${settings.modelHeightInches} in) is notably ${hemShift.shiftIn >= 0 ? "shorter" : "taller"} than the reference model (~${hemShift.refHeightIn.toFixed(1)} in).`
          : `Reference from the product page: ${productData.measurementsText}. A garment's physical length is fixed regardless of who wears it, so if this model is shorter than the reference model, the hem should sit lower on her body (more coverage, less or no midriff shown); if taller, it should sit higher (less coverage, more midriff shown).`
      }`
    : "";
  const widthEditClause = widthShift
    ? `Adjust the garment's fit (not her body) through the chest and shoulders by approximately ${Math.abs(widthShift.easeIn).toFixed(1)} in (${Math.abs(widthShift.easeCm).toFixed(1)} cm) — ${widthEffect.fitEditPhrase}, since this garment's own bust measurement (${widthShift.garmentBustIn.toFixed(1)} in) differs from her ${widthShift.modelBustSource === "measured" ? "measured" : "estimated"} bust/chest circumference (${widthShift.modelBustIn.toFixed(1)} in).${
        widthEffect.severity === "extreme"
          ? ` This is an extreme mismatch — depict real strain (too small) or the garment visibly swimming on her (too big), not a subtle adjustment.`
          : ""
      }`
    : hasQualitativeFit
      ? `Adjust the garment's fit (not her body) to match its qualitative fit description from the product page: for a "classic"/"straight"/"regular"/"true to size" description, ensure a normal, moderate drape through the chest and shoulders — not exaggeratedly oversized or baggy; for an "oversized"/"relaxed fit"/"boxy" description, ensure a visibly roomy, relaxed drape is preserved. This is a standing correction (this prompt is written before the garment is rendered, so there is no "current" image to judge against) — a qualitative adjustment, not an exact measurement.`
      : "";
  const bodyPreservationClause =
    hemEditClause && widthEditClause
      ? `These are GARMENT fit changes only (length and/or width of the fabric itself) — do not narrow, widen, slim, or otherwise resize her waist, torso, arms, bust, shoulders, or any other body measurement. Her exact body shape and proportions must stay pixel-for-pixel identical to the current photo; only how the garment's fabric drapes or hangs on her may change.`
      : hemEditClause
        ? `This is a LENGTH change only — extend or shorten the fabric itself, do not narrow, widen, slim, or otherwise resize her waist, torso, arms, bust, or any other body measurement to accommodate it. Her exact body width and proportions everywhere outside the hem/neckline region must stay pixel-for-pixel identical to the current photo.`
        : `This is a WIDTH change to the garment only — do not narrow, widen, slim, or otherwise resize her waist, torso, arms, bust, or any other body measurement. Her exact body shape and proportions must stay pixel-for-pixel identical to the current photo; only how the garment's fabric drapes on her may change.`;

  const fitEditPrompt = hasFitData
    ? [
        hemEditClause,
        widthEditClause,
        bodyPreservationClause,
        `Leave her face, pose, body shape, the garment's color/pattern/construction, lighting, and background unchanged — only adjust the garment's fit as described above.`,
      ]
        .filter(Boolean)
        .join(" ")
    : null;

  return { prompt, fitEditPrompt, sizeWarning: buildSizeWarning(widthEffect, widthShift) };
}
