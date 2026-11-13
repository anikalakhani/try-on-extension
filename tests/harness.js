// Loads the REAL background.js into a vm sandbox with stubbed chrome/fetch so
// its functions can be exercised without a browser, API keys, or spending money.
const fs = require("fs");
const vm = require("vm");

const SRC = require("path").join(__dirname, "..", "background.js");

function makeEnv({ storage = {}, fetchImpl } = {}) {
  const store = { ...storage };
  const fetchLog = [];
  let messageListener = null;

  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    // Simulate "no config.local.js" so NO real keys can leak into tests.
    importScripts() { throw new Error("no config.local.js in tests"); },
    chrome: {
      action: { onClicked: { addListener() {} } },
      runtime: {
        onMessage: { addListener(fn) { messageListener = fn; } },
        openOptionsPage() { ctx.__opened = true; },
      },
      storage: {
        local: {
          async get(keys) {
            const out = {};
            for (const k of keys) if (k in store) out[k] = store[k];
            return out;
          },
          async set(obj) { Object.assign(store, obj); },
        },
      },
    },
    fetch: async (url, opts) => {
      const entry = { url, method: (opts && opts.method) || "GET", body: opts && opts.body ? JSON.parse(opts.body) : null, headers: opts && opts.headers };
      fetchLog.push(entry);
      return fetchImpl(entry);
    },
    setTimeout, clearTimeout, Math, Date, JSON, Promise, Number, String, Array, Object, Error, RegExp,
  };
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SRC, "utf8"), ctx, { filename: "background.js" });
  const evalIn = (code) => vm.runInContext(code, ctx);
  return { ctx, evalIn, fetchLog, store, getListener: () => messageListener };
}

function jsonResponse(obj, status = 200) {
  return { ok: status >= 200 && status < 300, status, statusText: String(status), json: async () => obj, text: async () => JSON.stringify(obj) };
}

module.exports = { makeEnv, jsonResponse };
