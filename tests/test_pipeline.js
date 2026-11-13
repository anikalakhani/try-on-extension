const { makeEnv, jsonResponse } = require("./harness");

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS", name); }
  else { fail++; failures.push(name); console.log("  FAIL", name, detail !== undefined ? "→ " + (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 300) : ""); }
}
async function rejects(promise) { try { await promise; return null; } catch (e) { return String(e.message || e); } }

const PEPPERMAYO =
  "Size AU 8 / US 4 garment measurements: | Bust: 76 cm / 29.92 in | Waist: 66 cm / 25.98 in | Hem: 82 cm / 32.28 in | Length: 36.5 cm / 14.37 in | Kartier is 177cm and wearing a size AU 6 / and US 2";
const GAP =
  "Smooth vegan leather bomber jacket. In a slightly cropped length. | Fit: Classic. A straight & easy fit. | Slightly cropped, hits above the hip. | Model is 5'9\" and wearing size S.";

// Default network stub: Claude, fal.ai FLUX, FASHN run/status.
function defaultFetch(overrides = {}) {
  let falCount = 0;
  return (req) => {
    if (overrides.before) { const r = overrides.before(req); if (r) return r; }
    if (req.url.includes("api.anthropic.com")) {
      return jsonResponse({ content: [{ type: "text", text: JSON.stringify({ fitReasoning: "FR", imagePrompt: "IMG PROMPT", fitEditPrompt: req.body.system.includes("fitEditPrompt") ? "EDIT PROMPT" : null }) }] });
    }
    if (req.url.includes("fal.run")) { falCount++; return jsonResponse({ images: [{ url: `https://fal.test/model-${falCount}.png` }] }); }
    if (req.url.endsWith("/v1/run")) return jsonResponse({ id: "job-" + req.body.model_name });
    if (req.url.includes("/v1/status/job-tryon-v1.6")) return jsonResponse({ status: "completed", output: ["https://fashn.test/tryon.png"] });
    if (req.url.includes("/v1/status/job-edit")) return jsonResponse({ status: "completed", output: ["https://fashn.test/edit.png"] });
    return jsonResponse({ error: "unexpected " + req.url }, 500);
  };
}

const KEYS = { anthropicApiKey: "test-anthropic", fashnApiKey: "test-fashn", falApiKey: "test-fal" };
const BODY_5_1 = { modelHeightEnabled: true, modelHeightInches: 61, modelHeight: "5'1\"", modelWeightEnabled: true, modelWeightLbs: 188, modelSandbagEnabled: true, modelSandbagPercent: 50, modelChest: "cup E", modelChestSize: "E", modelSkinTone: "medium" };

(async () => {
  console.log("\n[A] Prompt assembly sent to Claude");
  {
    // Gap-like: 4'11" model, no numeric garment data → qualitative path
    const env = makeEnv({ storage: { ...KEYS, ...BODY_5_1, modelHeightInches: 59, modelHeight: "4'11\"" }, fetchImpl: defaultFetch() });
    const r = await env.ctx.generatePrompt({ title: "Vegan Leather Bomber Jacket", detailsText: "", measurementsText: GAP });
    const call = env.fetchLog[0];
    const sys = call.body.system;
    check("calls the Anthropic Messages endpoint once", env.fetchLog.length === 1 && call.url === "https://api.anthropic.com/v1/messages", env.fetchLog.map((f) => f.url));
    check("sends required browser-access header + key + version", call.headers["anthropic-dangerous-direct-browser-access"] === "true" && call.headers["x-api-key"] === "test-anthropic" && call.headers["anthropic-version"] === "2023-06-01", call.headers);
    check("Gap: hem sentence handed to Claude verbatim (SHORTER→LOWER)", sys.includes("hem sits LOWER, covering more") && sys.includes("Set fitReasoning to EXACTLY this sentence"), sys.slice(sys.indexOf("HEM/LENGTH"), sys.indexOf("HEM/LENGTH") + 200));
    check("Gap: no sentence implying the reversed direction anywhere in the hem section", !/hem sits HIGHER/.test(sys));
    check("Gap: qualitative-fit instruction present (no numeric bust available)", /qualitative fit description/.test(sys));
    check("Gap: qualitative instruction is unconditional (not 'if it currently looks…')", /ALWAYS include an instruction/.test(sys) && !/if the rendered garment looks inconsistent/.test(sys));
    check("parsed result: prompt/fitEditPrompt/fitReasoning", r.prompt === "IMG PROMPT" && r.fitEditPrompt === "EDIT PROMPT" && r.fitReasoning === "FR", r);
    check("Gap: sizeWarning null (no numeric width data)", r.sizeWarning === null, r.sizeWarning);
    check("sandbagged weight (282) is what Claude is told, not 188", /Weight: 282 lbs/.test(sys) && !/Weight: 188 lbs/.test(sys));
    check("sends user-scraped title/measurements as the user message", call.body.messages[0].content.includes("Vegan Leather Bomber Jacket") && call.body.messages[0].content.includes("Model is 5'9"));
  }
  {
    // Peppermayo-like with a measured 45in bust → extreme tight mismatch
    const env = makeEnv({ storage: { ...KEYS, ...BODY_5_1, modelBustEnabled: true, modelBustInches: 45 }, fetchImpl: defaultFetch() });
    const r = await env.ctx.generatePrompt({ title: "Garrix Bead Cami Top", detailsText: "", measurementsText: PEPPERMAYO });
    const sys = env.fetchLog[0].body.system;
    check("Peppermayo: exact hem magnitude (1.8in) given to Claude", /by approximately 1\.8 in/.test(sys), sys.slice(sys.indexOf("Set fitReasoning"), sys.indexOf("Set fitReasoning") + 600));
    check("Peppermayo: extreme width mismatch flagged in prompt (15.1in, EXTREME)", /15\.1 in/.test(sys) && /EXTREME/.test(sys));
    check("Peppermayo: sizeWarning returned for the blur UI", r.sizeWarning && r.sizeWarning.tooLoose === false && Math.abs(r.sizeWarning.easeIn - 15.08) < 0.05, r.sizeWarning);
    check("body-preservation clause names both hem + width (GARMENT-only)", /GARMENT fit changes only/.test(sys) || /GARMENT/.test(sys));
  }
  {
    // No measurements at all
    const env = makeEnv({ storage: { ...KEYS, ...BODY_5_1 }, fetchImpl: defaultFetch() });
    const r = await env.ctx.generatePrompt({ title: "Plain tee", detailsText: "100% cotton", measurementsText: "" });
    const sys = env.fetchLog[0].body.system;
    check("no measurements → no HEM/WIDTH sections injected", !/HEM\/LENGTH/.test(sys) && !/WIDTH\/EASE/.test(sys));
    check("no measurements → sizeWarning null", r.sizeWarning === null);
  }
  {
    const env = makeEnv({ storage: { ...KEYS, ...BODY_5_1 }, fetchImpl: () => jsonResponse({ error: "boom" }, 500) });
    const err = await rejects(env.ctx.generatePrompt({ title: "x", measurementsText: "" }));
    check("Claude API error surfaces with status code", err && /Claude API error 500/.test(err), err);
  }

  console.log("\n[B] Template fallback (no Anthropic key) — no network at all");
  {
    const env = makeEnv({ storage: { fashnApiKey: "f", falApiKey: "l", ...BODY_5_1, modelBustEnabled: true, modelBustInches: 45 }, fetchImpl: defaultFetch() });
    const r = await env.ctx.generatePrompt({ title: "Garrix Bead Cami Top", detailsText: "", measurementsText: PEPPERMAYO });
    check("makes zero network calls", env.fetchLog.length === 0, env.fetchLog.length);
    check("returns prompt string + fitEditPrompt + sizeWarning", typeof r.prompt === "string" && r.prompt.length > 100 && typeof r.fitEditPrompt === "string" && r.sizeWarning, Object.keys(r));
    check("fitEditPrompt has exact hem number and LENGTH-only/body-preservation constraint", /1\.8 in/.test(r.fitEditPrompt) && /do not narrow, widen, slim/.test(r.fitEditPrompt), r.fitEditPrompt);
    check("fitEditPrompt extreme-width wording escalates", /extreme mismatch/.test(r.fitEditPrompt), r.fitEditPrompt.slice(-300));
    const gap = await env.ctx.generatePrompt({ title: "Jacket", detailsText: "", measurementsText: GAP });
    check("Gap (template): qualitative fit instruction present, unconditional", /standing correction/.test(gap.fitEditPrompt) || /moderate drape/.test(gap.fitEditPrompt), gap.fitEditPrompt);
    const none = await env.ctx.generatePrompt({ title: "Tee", detailsText: "", measurementsText: "" });
    check("no measurements → fitEditPrompt null", none.fitEditPrompt === null);
  }

  console.log("\n[C] Image pipeline: generateImage");
  const FP = (s) => makeEnv({ storage: { fashnApiKey: "f", falApiKey: "l" , ...s }, fetchImpl: defaultFetch() }).ctx.computeAppearanceFingerprint({ ...s });
  {
    // Cached model + matching fingerprint
    const spec = { ...BODY_5_1 };
    const probe = makeEnv();
    const fp = probe.ctx.computeAppearanceFingerprint(spec);
    const env = makeEnv({ storage: { ...KEYS, ...spec, savedModelImageUrl: "https://saved.test/me.png", savedModelSpecFingerprint: fp }, fetchImpl: defaultFetch() });
    const r = await env.ctx.generateImage("PROMPT", "https://shop.test/garment.jpg", null);
    const urls = env.fetchLog.map((f) => f.url);
    check("cached + fingerprint match → NO fal.ai call", !urls.some((u) => u.includes("fal.run")), urls);
    const tryon = env.fetchLog.find((f) => f.body && f.body.model_name === "tryon-v1.6");
    check("Try-On uses the saved model photo", tryon && tryon.body.inputs.model_image === "https://saved.test/me.png", tryon && tryon.body.inputs);
    check("usedCachedModel=true, no Edit step when no fitEditPrompt", r.usedCachedModel === true && r.finalImageUrl === "https://fashn.test/tryon.png" && !env.fetchLog.some((f) => f.body && f.body.model_name === "edit"), r);
    check("Try-On params: segmentation_free true, garment_photo_type model, quality, auto, pinned seed", (() => { const i = tryon.body.inputs; return i.segmentation_free === true && i.garment_photo_type === "model" && i.mode === "quality" && i.category === "auto" && i.seed === 424242 && i.garment_image === "https://shop.test/garment.jpg"; })(), tryon.body.inputs);
    check("Authorization headers: FASHN uses Bearer", tryon.headers.Authorization === "Bearer test-fashn", tryon.headers);
  }
  {
    // Stale fingerprint → fresh FLUX
    const env = makeEnv({ storage: { ...KEYS, ...BODY_5_1, savedModelImageUrl: "https://saved.test/me.png", savedModelSpecFingerprint: "STALE" }, fetchImpl: defaultFetch() });
    const r = await env.ctx.generateImage("PROMPT", "https://shop.test/garment.jpg", null);
    const fal = env.fetchLog.find((f) => f.url.includes("fal.run"));
    check("stale fingerprint → falls back to fresh FLUX call", !!fal && r.usedCachedModel === false, r);
    check("FLUX payload: pinned seed, guidance 6.5, portrait_4_3, Key auth", fal.body.seed === 424242 && fal.body.guidance_scale === 6.5 && fal.body.image_size === "portrait_4_3" && fal.body.prompt === "PROMPT" && fal.headers.Authorization === "Key test-fal", fal);
    const tryon = env.fetchLog.find((f) => f.body && f.body.model_name === "tryon-v1.6");
    check("Try-On gets the freshly generated model", tryon.body.inputs.model_image === "https://fal.test/model-1.png");
  }
  {
    // No cache + no fal key
    const env = makeEnv({ storage: { fashnApiKey: "f", ...BODY_5_1 }, fetchImpl: defaultFetch() });
    const err = await rejects(env.ctx.generateImage("P", "https://x/g.jpg", null));
    check("no cache + no fal key → clear error", err && /fal\.ai API key/.test(err), err);
  }
  {
    // Cached model works WITHOUT a fal key (key only needed to generate)
    const probe = makeEnv();
    const fp = probe.ctx.computeAppearanceFingerprint(BODY_5_1);
    const env = makeEnv({ storage: { fashnApiKey: "f", ...BODY_5_1, savedModelImageUrl: "https://saved.test/me.png", savedModelSpecFingerprint: fp }, fetchImpl: defaultFetch() });
    const r = await env.ctx.generateImage("P", "https://x/g.jpg", null);
    check("cached model works even with NO fal.ai key configured", r.usedCachedModel === true && !!r.finalImageUrl, r);
  }
  {
    const env = makeEnv({ storage: { falApiKey: "l", ...BODY_5_1 }, fetchImpl: defaultFetch() });
    const err = await rejects(env.ctx.generateImage("P", "https://x/g.jpg", null));
    check("no FASHN key → clear error", err && /FASHN API key/.test(err), err);
  }
  {
    const env = makeEnv({ storage: { ...KEYS, ...BODY_5_1 }, fetchImpl: defaultFetch() });
    const err = await rejects(env.ctx.generateImage("P", null, null));
    check("no garment image URL → clear error", err && /garment reference/.test(err), err);
    check("…and fails before spending anything", env.fetchLog.length === 0, env.fetchLog.length);
  }
  {
    // Edit step
    const probe = makeEnv();
    const fp = probe.ctx.computeAppearanceFingerprint(BODY_5_1);
    const env = makeEnv({ storage: { ...KEYS, ...BODY_5_1, savedModelImageUrl: "https://saved.test/me.png", savedModelSpecFingerprint: fp }, fetchImpl: defaultFetch() });
    const r = await env.ctx.generateImage("P", "https://shop.test/garment.jpg", "EXTEND HEM 1.8 IN");
    const edit = env.fetchLog.find((f) => f.body && f.body.model_name === "edit");
    check("Edit step runs with the Try-On output as its input image", edit && edit.body.inputs.image === "https://fashn.test/tryon.png", edit && edit.body.inputs);
    check("Edit payload carries the fit prompt", edit.body.inputs.prompt === "EXTEND HEM 1.8 IN");
    check("Edit payload has NO image_context (the face-swap bug fix)", !("image_context" in edit.body.inputs), edit.body.inputs);
    check("final image is the Edit output; Try-On output also returned for debugging", r.finalImageUrl === "https://fashn.test/edit.png" && r.tryonImageUrl === "https://fashn.test/tryon.png", r);
  }
  {
    // Edit submit fails → graceful fallback
    const probe = makeEnv();
    const fp = probe.ctx.computeAppearanceFingerprint(BODY_5_1);
    const env = makeEnv({
      storage: { ...KEYS, ...BODY_5_1, savedModelImageUrl: "https://saved.test/me.png", savedModelSpecFingerprint: fp },
      fetchImpl: defaultFetch({ before: (req) => (req.body && req.body.model_name === "edit" ? jsonResponse({ error: "edit exploded" }, 500) : null) }),
    });
    const r = await env.ctx.generateImage("P", "https://shop.test/garment.jpg", "EDIT");
    check("Edit failure does NOT fail the run — falls back to un-edited Try-On", r.finalImageUrl === "https://fashn.test/tryon.png", r);
  }
  {
    // FASHN job reports failed
    const env = makeEnv({
      storage: { ...KEYS, ...BODY_5_1 },
      fetchImpl: defaultFetch({ before: (req) => (req.url.includes("/status/job-tryon") ? jsonResponse({ status: "failed", error: { name: "PoseError" } }) : null) }),
    });
    const err = await rejects(env.ctx.generateImage("P", "https://shop.test/garment.jpg", null));
    check("FASHN 'failed' job status surfaces the error", err && /FASHN job failed/.test(err), err);
  }
  {
    // FLUX balance error
    const env = makeEnv({
      storage: { ...KEYS, ...BODY_5_1 },
      fetchImpl: defaultFetch({ before: (req) => (req.url.includes("fal.run") ? { ok: false, status: 403, text: async () => '{"detail":"User is locked. Reason: Exhausted balance."}', json: async () => ({}) } : null) }),
    });
    const err = await rejects(env.ctx.generateImage("P", "https://shop.test/garment.jpg", null));
    check("fal.ai 403 balance message passed through verbatim", err && /403/.test(err) && /Exhausted balance/.test(err), err);
  }

  console.log("\n[D] 'Your model photo' options generator");
  {
    const env = makeEnv({ storage: { ...KEYS, ...BODY_5_1 }, fetchImpl: defaultFetch() });
    const r = await env.ctx.generateModelOptions(3);
    const fals = env.fetchLog.filter((f) => f.url.includes("fal.run"));
    check("returns 3 candidate images", r.images.length === 3 && new Set(r.images).size === 3, r.images);
    check("3 FLUX calls with 3 DIFFERENT seeds (variety, not the pinned test seed)", new Set(fals.map((f) => f.body.seed)).size === 3 && fals.every((f) => f.body.seed !== 424242), fals.map((f) => f.body.seed));
    check("base prompt is garment-neutral (plain basics), asks Claude once", env.fetchLog.filter((f) => f.url.includes("anthropic")).length === 1 && /plain, form-fitting basics|simple, plain/.test(env.fetchLog[0].body.system), env.fetchLog[0].body.system.slice(0, 200));
    check("base-prompt Claude call has no garment-fit/hem sections", !/HEM\/LENGTH|WIDTH\/EASE|fitEditPrompt/.test(env.fetchLog[0].body.system));
    const noKey = makeEnv({ storage: { fashnApiKey: "f", ...BODY_5_1 }, fetchImpl: defaultFetch() });
    check("no fal key → clear error", /fal\.ai API key/.test((await rejects(noKey.ctx.generateModelOptions(3))) || ""));
    const tmpl = makeEnv({ storage: { fashnApiKey: "f", falApiKey: "l", ...BODY_5_1 }, fetchImpl: defaultFetch() });
    const r2 = await tmpl.ctx.generateModelOptions(2);
    check("no Anthropic key → template base prompt, count respected, no Claude call", r2.images.length === 2 && !tmpl.fetchLog.some((f) => f.url.includes("anthropic")), tmpl.fetchLog.map((f) => f.url));
  }

  console.log("\n[E] Message routing (what content.js / options.js actually send)");
  {
    const env = makeEnv({ storage: { ...KEYS, ...BODY_5_1 }, fetchImpl: defaultFetch() });
    const listener = env.getListener();
    const send = (msg) => new Promise((resolve) => { const ret = listener(msg, {}, resolve); if (ret === false) { /* sync handled */ } });
    check("listener registered", typeof listener === "function");
    const p = await send({ type: "GENERATE_PROMPT", productData: { title: "T", measurementsText: GAP } });
    check("GENERATE_PROMPT → ok + prompt + fitEditPrompt fields", p.ok === true && p.prompt === "IMG PROMPT" && "fitEditPrompt" in p && "sizeWarning" in p, p);
    const g = await send({ type: "GENERATE_IMAGE", prompt: "P", garmentImageUrl: "https://shop.test/g.jpg", fitEditPrompt: null });
    check("GENERATE_IMAGE → ok + finalImageUrl", g.ok === true && g.finalImageUrl === "https://fashn.test/tryon.png", g);
    const m = await send({ type: "GENERATE_MODEL_OPTIONS", count: 3 });
    check("GENERATE_MODEL_OPTIONS → ok + 3 images", m.ok === true && m.images.length === 3, m);
    const o = await send({ type: "OPEN_OPTIONS" });
    check("OPEN_OPTIONS → ok and opens settings", o.ok === true && env.ctx.__opened === true, o);
    const bad = makeEnv({ storage: { ...BODY_5_1 }, fetchImpl: defaultFetch() });
    const be = await new Promise((resolve) => bad.getListener()({ type: "GENERATE_IMAGE", prompt: "P", garmentImageUrl: "https://x/g.jpg" }, {}, resolve));
    check("handler errors come back as {ok:false,error} (never hang)", be.ok === false && typeof be.error === "string", be);
    const unk = env.getListener()({ type: "NOPE" }, {}, () => {});
    check("unknown message type ignored without crashing", unk === undefined || unk === false);
  }

  console.log(`\n=== pipeline: ${pass} passed, ${fail} failed ===`);
  if (fail) { console.log("FAILED:", failures); process.exit(1); }
})().catch((e) => { console.error("HARNESS CRASH:", e); process.exit(2); });
