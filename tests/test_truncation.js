// Regression: a Claude reply cut off by max_tokens used to be parsed anyway, and the
// half-finished JSON text was sent to FLUX as the image prompt with no error.
const { makeEnv, jsonResponse } = require("./harness");

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log("  PASS", name); } else { fail++; console.log("  FAIL", name, detail || ""); } };

(async () => {
  const truncated = '{"fitReasoning": "Reference model is 69.0 in tall...", "imagePrompt": "A photorealistic studio photo of a model wearing a brown bomber jacket with a ribbed';
  const storage = { anthropicApiKey: "k", falApiKey: "l", modelHeightEnabled: true, modelHeightInches: 59, modelHeight: "4'11\"" };
  const data = { stop_reason: "max_tokens", content: [{ type: "text", text: truncated }] };
  const product = { title: "Jacket", measurementsText: "Model is 5'9\" and wearing size S." };

  const env = makeEnv({ storage, fetchImpl: () => jsonResponse(data) });
  let err = null;
  try { await env.ctx.generatePrompt(product); } catch (e) { err = String(e.message); }
  check("per-product prompt: truncated reply throws a clear error", err && /cut off/.test(err), err);
  check("max_tokens ceiling is generous (>= 4096)", env.fetchLog[0].body.max_tokens >= 4096, env.fetchLog[0].body.max_tokens);

  const env2 = makeEnv({ storage, fetchImpl: () => jsonResponse(data) });
  err = null;
  try { await env2.ctx.generateModelOptions(1); } catch (e) { err = String(e.message); }
  check("model-photo prompt: truncated reply throws too", err && /cut off/.test(err), err);
  check("…and never reaches FLUX", !env2.fetchLog.some((f) => f.url.includes("fal.run")));

  const ok = makeEnv({ storage, fetchImpl: () => jsonResponse({ stop_reason: "end_turn", content: [{ type: "text", text: '{"imagePrompt":"P","fitEditPrompt":null}' }] }) });
  const r = await ok.ctx.generatePrompt(product);
  check("normal end_turn reply still works", r.prompt === "P");
  check("default Claude model is claude-opus-5-5", ok.fetchLog[0].body.model === "claude-opus-5-5", ok.fetchLog[0].body.model);

  console.log(`\n=== truncation: ${pass} passed, ${fail} failed ===`);
  if (fail) process.exit(1);
})();
