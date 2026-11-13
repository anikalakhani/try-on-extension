const fs = require("fs");
const path = require("path");
const PROJ = path.join(__dirname, "..");
const OUT = path.join(__dirname, "fixtures-generated"); fs.mkdirSync(OUT, { recursive: true });
let html = fs.readFileSync(path.join(PROJ, "options.html"), "utf8");
const js = fs.readFileSync(path.join(PROJ, "options.js"), "utf8");

const cand = (label, color) =>
  "data:image/svg+xml;utf8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="100%" height="100%" fill="${color}"/><text x="50%" y="50%" fill="#fff" font-size="30" text-anchor="middle">${label}</text></svg>`);

const stub = `<script>
window.__store = {};
window.__sent = [];
window.chrome = {
  storage: { local: {
    async get(keys) { const o = {}; for (const k of (Array.isArray(keys) ? keys : Object.keys(keys))) if (k in window.__store) o[k] = window.__store[k]; return o; },
    async set(obj) { Object.assign(window.__store, JSON.parse(JSON.stringify(obj))); },
  } },
  runtime: { async sendMessage(msg) {
    window.__sent.push(msg);
    if (msg.type === "GENERATE_MODEL_OPTIONS") {
      if (window.__optionsFail) return { ok: false, error: "No fal.ai API key configured." };
      return { ok: true, images: [${JSON.stringify(cand("OPT-1", "#aa3355"))}, ${JSON.stringify(cand("OPT-2", "#33aa55"))}, ${JSON.stringify(cand("OPT-3", "#3355aa"))}], prompt: "p" };
    }
    return { ok: true };
  } },
};
</script>`;

html = html.replace('<script src="options.js"></script>', stub + "<script>" + js.replace(/<\/script>/g, "<\\/script>") + "</script>");
fs.writeFileSync(path.join(OUT, "fixture_options.html"), html);
console.log("wrote fixture_options.html");
