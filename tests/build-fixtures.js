// Builds self-contained fixture pages (real content.js + real styles.css inlined,
// chrome.runtime stubbed) so the actual extension UI code can be exercised in a browser.
const fs = require("fs");
const path = require("path");
const PROJ = path.join(__dirname, "..");
const OUT = path.join(__dirname, "fixtures-generated"); fs.mkdirSync(OUT, { recursive: true });

const contentJs = fs.readFileSync(path.join(PROJ, "content.js"), "utf8");
const stylesCss = fs.readFileSync(path.join(PROJ, "styles.css"), "utf8");

const svg = (label, color, w = 600, h = 900) =>
  "data:image/svg+xml;utf8," +
  encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="100%" height="100%" fill="${color}"/><text x="50%" y="50%" font-size="48" text-anchor="middle" fill="#fff">${label}</text></svg>`);

const ORIGINAL = svg("ORIGINAL", "#777777");
const DECOY = svg("DECOY-RECOMMENDED", "#aa5500", 800, 1000);
const GEN1 = svg("GENERATED-1", "#1155cc");
const GEN2 = svg("GENERATED-2", "#118844");

function page(scenario) {
  const sizeWarning = scenario === "warning" ? "{ tooLoose: false, easeIn: 15.08, easeCm: 38.3 }" : "null";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Fixture ${scenario}</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Test Cami"}</script>
<style>${stylesCss}
body{font-family:sans-serif;margin:0;padding:20px;min-height:2200px}
.gallery{display:flex;gap:20px}
.main{width:300px;height:450px}
.main img{width:300px;height:450px;display:block}
.thumbs img{width:80px;height:120px;display:block;margin-bottom:6px}
.you-may-also-like img{width:400px;height:500px;display:block}
</style></head><body>
<nav><a id="nav-size-guide" href="/pages/sizing">Size Guide</a> <button id="sg-btn" onclick="document.getElementById('sg-panel').hidden=false">Size Guide</button></nav>
<div id="sg-panel" hidden>Generic body chart: M = 36-38in bust</div>
<h1>Test Cami Top</h1><div>$68.00</div><button>Add to cart</button>
<div class="gallery">
  <div class="thumbs" id="thumbs"><img id="thumb1" src="${ORIGINAL}"></div>
  <div class="main" id="mainwrap">
    <picture id="pic"><source type="image/svg+xml" srcset="${ORIGINAL}"><img id="main" src="${ORIGINAL}"></picture>
  </div>
  <img id="hidden-dupe" style="display:none" src="${ORIGINAL}">
</div>
<details id="fit"><summary>FIT &amp; SIZING</summary>
  <p>Size AU 8 / US 4 garment measurements:</p>
  <p>Bust: 76 cm / 29.92 in</p><p>Waist: 66 cm / 25.98 in</p><p>Length: 36.5 cm / 14.37 in</p>
  <p>Kartier is 177cm and wearing a size AU 6 / and US 2</p>
</details>
<div class="you-may-also-like"><h3>You may also like</h3><img id="decoy" src="${DECOY}"></div>

<script>
window.__msgs = [];
window.__startUrl = location.href;
window.chrome = { runtime: { id: "test-ext", lastError: undefined,
  openOptionsPage() {},
  sendMessage(msg, cb) {
    window.__msgs.push(msg);
    setTimeout(() => {
      if (msg.type === "GENERATE_PROMPT") return cb({ ok: true, prompt: "PROMPT TEXT", fitEditPrompt: "EDIT TEXT", fitReasoning: "REASONING", sizeWarning: ${sizeWarning} });
      if (msg.type === "GENERATE_IMAGE") {
        window.__genCount = (window.__genCount || 0) + 1;
        if (window.__failNext) { window.__failNext = false; return cb({ ok: false, error: "fal.ai FLUX request failed (403): Exhausted balance" }); }
        const gen = window.__genCount === 1 ? ${JSON.stringify(GEN1)} : ${JSON.stringify(GEN2)};
        // a late-loading duplicate appears shortly AFTER the swap (lazy gallery)
        setTimeout(() => { const i = document.createElement("img"); i.id = "straggler"; i.style.cssText = "width:80px;height:120px;display:block"; i.src = ${JSON.stringify(ORIGINAL)}; document.getElementById("thumbs").appendChild(i); }, 700);
        return cb({ ok: true, modelImageUrl: "m", tryonImageUrl: "t", finalImageUrl: gen, usedCachedModel: true });
      }
      cb({ ok: true });
    }, 250);
  } } };
</script>
<script>${contentJs.replace(/<\/script>/g, "<\\/script>")}</script>
</body></html>`;
}

fs.writeFileSync(path.join(OUT, "fixture_normal.html"), page("normal"));
fs.writeFileSync(path.join(OUT, "fixture_warning.html"), page("warning"));
fs.writeFileSync(path.join(OUT, "fixture_consts.json"), JSON.stringify({ ORIGINAL, GEN1, GEN2, DECOY }));
console.log("wrote fixtures");
