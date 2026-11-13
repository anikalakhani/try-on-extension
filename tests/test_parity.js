const { makeEnv, jsonResponse } = require("./harness");

// Exactly what options.js wrote to storage in the browser run above.
const stored = {
  fashnApiKey: "fashn-test", falApiKey: "fal-test-key",
  modelHeightInches: 61, modelHeightEnabled: true, modelHeight: "5'1\"",
  modelWeightLbs: 190, modelWeightEnabled: true,
  modelSandbagEnabled: true, modelSandbagPercent: 50,
  modelChestSize: "E", modelChest: "cup E", modelSkinToneKey: "medium", modelSkinTone: "medium",
  modelBustEnabled: true, modelBustInches: 41.5,
  savedModelImageUrl: "https://saved.test/opt2.png",
  savedModelSpecFingerprint: "[61,190,50,\"cup E\",\"medium\"]", // computed by options.js in the browser
};

(async () => {
  const fetchImpl = (req) => {
    if (req.url.includes("fal.run")) return jsonResponse({ images: [{ url: "https://fal.test/x.png" }] });
    if (req.url.endsWith("/v1/run")) return jsonResponse({ id: "job-" + req.body.model_name });
    if (req.url.includes("/status/")) return jsonResponse({ status: "completed", output: ["https://fashn.test/out.png"] });
    return jsonResponse({}, 500);
  };
  const env = makeEnv({ storage: stored, fetchImpl });
  const settings = await env.ctx.getSettings();
  const bgFp = env.ctx.computeAppearanceFingerprint(settings);
  console.log("options.js fingerprint   :", stored.savedModelSpecFingerprint);
  console.log("background.js fingerprint:", bgFp);
  console.log(bgFp === stored.savedModelSpecFingerprint ? "PASS fingerprints match across files" : "FAIL fingerprints DIFFER — cache would never hit");
  const r = await env.ctx.generateImage("P", "https://shop.test/g.jpg", null);
  const usedFal = env.fetchLog.some((f) => f.url.includes("fal.run"));
  console.log(r.usedCachedModel && !usedFal ? "PASS real round trip: saved photo reused, zero fal.ai calls" : "FAIL saved photo was NOT reused", { usedCachedModel: r.usedCachedModel, usedFal });
  // and the reverse: change weight in storage, cache must invalidate
  const env2 = makeEnv({ storage: { ...stored, modelWeightLbs: 150 }, fetchImpl });
  const r2 = await env2.ctx.generateImage("P", "https://shop.test/g.jpg", null);
  console.log(!r2.usedCachedModel && env2.fetchLog.some((f) => f.url.includes("fal.run")) ? "PASS weight change invalidates the cache (fresh FLUX call)" : "FAIL stale photo still reused");
})();
