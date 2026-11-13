const { makeEnv } = require("./harness");
const { ctx, evalIn } = makeEnv();

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  PASS", name); }
  else { fail++; failures.push(name); console.log("  FAIL", name, detail !== undefined ? "→ " + JSON.stringify(detail) : ""); }
}
const near = (a, b, eps = 0.05) => Math.abs(a - b) <= eps;

// Real text captured from the two live pages we investigated.
const PEPPERMAYO =
  "Size AU 8 / US 4 garment measurements: | Bust: 76 cm / 29.92 in | Waist: 66 cm / 25.98 in | Hem: 82 cm / 32.28 in | Length: 36.5 cm / 14.37 in | Kartier is 177cm and wearing a size AU 6 / and US 2 | Bust: Measure around the fullest part. | Waist: Measure around natural waistline. | Hips: Measure 20cm down from natural waistline.";
const GAP =
  "Smooth vegan leather bomber jacket. In a slightly cropped length. | Fit: Classic. A straight & easy fit. | Slightly cropped, hits above the hip. | Model is 5'9\" and wearing size S.";

console.log("\n[1] Parsing scraped text");
check("Peppermayo: reference height 177cm → ~69.7in", near(ctx.parseReferenceModelHeightInches(PEPPERMAYO), 69.69, 0.02), ctx.parseReferenceModelHeightInches(PEPPERMAYO));
check("Peppermayo: garment length 14.37in", ctx.parseGarmentLengthInches(PEPPERMAYO) === 14.37);
check("Peppermayo: garment bust 29.92in (not the 'Measure around' how-to line)", near(ctx.parseGarmentBustInches(PEPPERMAYO), 29.92, 0.01), ctx.parseGarmentBustInches(PEPPERMAYO));
check("Gap: reference height 5'9\" → 69in", ctx.parseReferenceModelHeightInches(GAP) === 69, ctx.parseReferenceModelHeightInches(GAP));
check("Gap: no garment length → null (graceful)", ctx.parseGarmentLengthInches(GAP) === null);
check("Gap: no garment bust → null (graceful)", ctx.parseGarmentBustInches(GAP) === null);
check("curly quotes 5’9” parse", ctx.parseReferenceModelHeightInches("Grace is 5’9” and wearing a size 6") === 69);
check("empty/undefined input doesn't throw", ctx.parseReferenceModelHeightInches(undefined) === null && ctx.parseGarmentLengthInches("") === null && ctx.parseGarmentBustInches(null) === null);
check("garment cm number never mistaken for model height", ctx.parseReferenceModelHeightInches("Bust: 150 cm / 59 in | Length: 160 cm / 63 in") === null, ctx.parseReferenceModelHeightInches("Bust: 150 cm / 59 in | Length: 160 cm / 63 in"));

console.log("\n[2] Hem math & direction (the logic that was reversed 3 times)");
const s61 = { modelHeightEnabled: true, modelHeightInches: 61, modelHeight: "5'1\"" };
const dShort = ctx.computeHemDirection(s61, { measurementsText: PEPPERMAYO });
check("5'1\" vs 177cm reference → isShorter", dShort && dShort.isShorter === true, dShort);
const shiftShort = ctx.computeHemShift(s61, { measurementsText: PEPPERMAYO });
check("shorter model → POSITIVE shift (hem lower / more coverage)", shiftShort && shiftShort.shiftIn > 0, shiftShort);
check("shift magnitude ≈ L*(1-61/69.69)=1.79in", shiftShort && near(shiftShort.shiftIn, 1.79, 0.02), shiftShort && shiftShort.shiftIn);
const sTall = { modelHeightEnabled: true, modelHeightInches: 75, modelHeight: "6'3\"" };
const shiftTall = ctx.computeHemShift(sTall, { measurementsText: PEPPERMAYO });
check("taller model → NEGATIVE shift (hem higher / more midriff)", shiftTall && shiftTall.shiftIn < 0, shiftTall);
const sentShort = ctx.buildHemReasoningSentence(s61, dShort, shiftShort);
check("fitReasoning for shorter model says SHORTER→LOWER, covering more", /SHORTER than the reference/.test(sentShort) && /hem sits LOWER, covering more/.test(sentShort) && !/HIGHER/.test(sentShort), sentShort);
check("fitReasoning includes exact magnitude when known", /by approximately 1\.8 in/.test(sentShort), sentShort);
const dTall = ctx.computeHemDirection(sTall, { measurementsText: PEPPERMAYO });
const sentTall = ctx.buildHemReasoningSentence(sTall, dTall, shiftTall);
check("fitReasoning for taller model says TALLER→HIGHER, exposing more midriff", /TALLER than the reference/.test(sentTall) && /hem sits HIGHER, exposing more midriff/.test(sentTall) && !/LOWER/.test(sentTall), sentTall);
// The exact Gap scenario Claude got wrong: 4'11" (59in) vs 5'9" (69in), no garment length
const gapSettings = { modelHeightEnabled: true, modelHeightInches: 59, modelHeight: "4'11\"" };
const gapDir = ctx.computeHemDirection(gapSettings, { measurementsText: GAP });
check("Gap (no garment length): direction still computable", gapDir && gapDir.isShorter === true, gapDir);
check("Gap: hem shift correctly null (needs garment length)", ctx.computeHemShift(gapSettings, { measurementsText: GAP }) === null);
const gapSentence = ctx.buildHemReasoningSentence(gapSettings, gapDir, null);
check("Gap sentence: SHORTER → LOWER (the case Claude reversed)", /hem sits LOWER, covering more/.test(gapSentence) && !/by approximately/.test(gapSentence), gapSentence);
check("height setting off → no direction", ctx.computeHemDirection({ modelHeightEnabled: false, modelHeightInches: 59 }, { measurementsText: GAP }) === null);
check("exactly equal heights → no direction (nothing to state)", ctx.computeHemDirection({ modelHeightEnabled: true, modelHeightInches: 69 }, { measurementsText: GAP }) === null);

console.log("\n[3] Bust estimate / width math / severity tiers");
console.log("   cup table:", JSON.stringify(evalIn("CUP_SIZE_BUST_ESTIMATE_IN")));
check("measured bust wins over cup estimate", (() => { const r = ctx.estimateBustCircumferenceInches({ modelBustEnabled: true, modelBustInches: 44, modelChestSize: "A" }); return r && r.inches === 44 && r.source === "measured"; })());
check("cup letter falls back to benchmark estimate", (() => { const r = ctx.estimateBustCircumferenceInches({ modelBustEnabled: false, modelChestSize: "D" }); return r && r.source !== "measured" && r.inches > 30 && r.inches < 50; })(), ctx.estimateBustCircumferenceInches({ modelBustEnabled: false, modelChestSize: "D" }));
check("no bust info at all → null", ctx.estimateBustCircumferenceInches({ modelBustEnabled: false, modelChestSize: null }) === null);
check("cup 'N/A' (flat chest) handled without crashing", (() => { try { ctx.estimateBustCircumferenceInches({ modelChestSize: "N/A" }); return true; } catch (e) { return false; } })());
const ws = ctx.computeWidthShift({ modelBustEnabled: true, modelBustInches: 45 }, { measurementsText: PEPPERMAYO });
check("garment 29.92 vs body 45 → ease ≈ -15.1in", ws && near(ws.easeIn, -15.08, 0.02), ws);
const tiers = [[0.5, "mild"], [2, "mild"], [2.1, "moderate"], [5, "moderate"], [5.1, "extreme"], [15, "extreme"]];
for (const [v, want] of tiers) {
  check(`severity at |ease|=${v} (too tight) → ${want}`, ctx.describeWidthEffect(-v).severity === want, ctx.describeWidthEffect(-v).severity);
}
check("severity at +15 (too loose) → extreme and tooLoose", (() => { const e = ctx.describeWidthEffect(15); return e.severity === "extreme" && e.tooLoose === true; })());
check("extreme too-tight wording mentions strain/closures", /taut|straining|unable to fully close/.test(ctx.describeWidthEffect(-15).imagePromptPhrase), ctx.describeWidthEffect(-15).imagePromptPhrase);
check("mild too-tight wording does NOT escalate", !/taut|straining|unable to fully close/.test(ctx.describeWidthEffect(-1).imagePromptPhrase));
check("buildSizeWarning: extreme → object", (() => { const w = ctx.buildSizeWarning(ctx.describeWidthEffect(-15), { easeIn: -15, easeCm: -38.1 }); return w && w.tooLoose === false && w.easeIn === 15; })());
check("buildSizeWarning: moderate → null (no blur for mild/moderate)", ctx.buildSizeWarning(ctx.describeWidthEffect(-4), { easeIn: -4, easeCm: -10 }) === null);
check("buildSizeWarning: no width data → null", ctx.buildSizeWarning(null, null) === null);

console.log("\n[4] Appearance fingerprint (cache invalidation)");
const base = { modelHeightEnabled: true, modelHeightInches: 61, modelWeightEnabled: true, modelWeightLbs: 188, modelSandbagEnabled: true, modelSandbagPercent: 50, modelChest: "cup E", modelSkinTone: "medium" };
const fp = ctx.computeAppearanceFingerprint(base);
check("same settings → same fingerprint", fp === ctx.computeAppearanceFingerprint({ ...base }));
check("weight change → different fingerprint", fp !== ctx.computeAppearanceFingerprint({ ...base, modelWeightLbs: 150 }));
check("skin tone change → different fingerprint", fp !== ctx.computeAppearanceFingerprint({ ...base, modelSkinTone: "deep" }));
check("sandbag % change → different fingerprint", fp !== ctx.computeAppearanceFingerprint({ ...base, modelSandbagPercent: 20 }));
check("disabling height → different fingerprint", fp !== ctx.computeAppearanceFingerprint({ ...base, modelHeightEnabled: false }));
check("changing weight while weight DISABLED → same fingerprint (ignored)", ctx.computeAppearanceFingerprint({ ...base, modelWeightEnabled: false, modelWeightLbs: 100 }) === ctx.computeAppearanceFingerprint({ ...base, modelWeightEnabled: false, modelWeightLbs: 250 }));
check("bust inches do NOT affect fingerprint (only used for fit math, not the photo)", fp === ctx.computeAppearanceFingerprint({ ...base, modelBustEnabled: true, modelBustInches: 50 }));

console.log("\n[5] Build descriptor / sandbag");
check("sandbag 188 lb +50% → 282", ctx.getSandbaggedWeight({ modelWeightEnabled: true, modelWeightLbs: 188, modelSandbagEnabled: true, modelSandbagPercent: 50 }) === 282);
check("sandbag off → raw weight", ctx.getSandbaggedWeight({ modelWeightEnabled: true, modelWeightLbs: 188, modelSandbagEnabled: false }) === 188);
check("5'6\" 120lb (BMI 19.4) → average/toned, and NOT plus-size or rounded", (() => { const d = ctx.estimateBuildDescriptor({ modelHeightEnabled: true, modelHeightInches: 66, modelWeightEnabled: true, modelWeightLbs: 120 }); return /average, toned/.test(d) && !/plus-size|rounded|curvier/.test(d); })());
check("5'6\" 100lb (BMI 16) → slender", /slender/.test(ctx.estimateBuildDescriptor({ modelHeightEnabled: true, modelHeightInches: 66, modelWeightEnabled: true, modelWeightLbs: 100 })));
check("5'3\" 270lb → plus-size", /plus-size/.test(ctx.estimateBuildDescriptor({ modelHeightEnabled: true, modelHeightInches: 63, modelWeightEnabled: true, modelWeightLbs: 270 })));

console.log("\n[6] parseClaudeJson robustness");
check("plain JSON", ctx.parseClaudeJson('{"fitReasoning":"r","imagePrompt":"p","fitEditPrompt":"e"}').prompt === "p");
check("```json fenced JSON", ctx.parseClaudeJson('```json\n{"imagePrompt":"p","fitEditPrompt":null}\n```').prompt === "p");
check("non-JSON text falls back to treating it as the prompt", (() => { const r = ctx.parseClaudeJson("just a plain prompt"); return r.prompt === "just a plain prompt" && r.fitEditPrompt === null; })());
check("fitEditPrompt null stays null", ctx.parseClaudeJson('{"imagePrompt":"p","fitEditPrompt":null}').fitEditPrompt === null);

console.log(`\n=== logic: ${pass} passed, ${fail} failed ===`);
if (fail) { console.log("FAILED:", failures); process.exit(1); }
