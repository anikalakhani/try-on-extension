const anthropicKeyEl = document.getElementById("anthropicKey");
const claudeModelEl = document.getElementById("claudeModel");
const fashnKeyEl = document.getElementById("fashnKey");
const falKeyEl = document.getElementById("falKey");
const statusEl = document.getElementById("status");
const saveBtn = document.getElementById("save");

const heightRangeEl = document.getElementById("modelHeightRange");
const heightLabelEl = document.getElementById("modelHeightLabel");
const heightEnabledEl = document.getElementById("modelHeightEnabled");

const weightRangeEl = document.getElementById("modelWeightRange");
const weightLabelEl = document.getElementById("modelWeightLabel");
const weightEnabledEl = document.getElementById("modelWeightEnabled");

const sandbagEnabledEl = document.getElementById("sandbagEnabled");
const sandbagPercentEl = document.getElementById("sandbagPercent");
const sandbagLabelEl = document.getElementById("sandbagLabel");

const chestSizeChipsEl = document.getElementById("chestSizeChips");
const chestSizeClearEl = document.getElementById("chestSizeClear");

const bustRangeEl = document.getElementById("bustRange");
const bustLabelEl = document.getElementById("bustLabel");
const bustEnabledEl = document.getElementById("bustEnabled");

const skinToneSwatchesEl = document.getElementById("skinToneSwatches");
const skinToneClearEl = document.getElementById("skinToneClear");

const currentModelPreviewEl = document.getElementById("currentModelPreview");
const currentModelImgEl = document.getElementById("currentModelImg");
const noModelPreviewEl = document.getElementById("noModelPreview");
const modelStaleWarningEl = document.getElementById("modelStaleWarning");
const generateModelOptionsBtn = document.getElementById("generateModelOptions");
const modelOptionsStatusEl = document.getElementById("modelOptionsStatus");
const modelOptionsGridEl = document.getElementById("modelOptionsGrid");

const CHEST_SIZES = ["N/A", "A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
let selectedChestSize = null; // one of CHEST_SIZES, or null

const SKIN_TONES = [
  { key: "fair", hex: "#F7DECE", label: "fair" },
  { key: "light", hex: "#F0C8A0", label: "light" },
  { key: "light-medium", hex: "#E0AC69", label: "light-medium" },
  { key: "medium", hex: "#C68642", label: "medium" },
  { key: "deep", hex: "#8D5524", label: "deep" },
  { key: "very-deep", hex: "#4B2E1E", label: "very deep" },
];

let selectedSkinTone = null; // one of SKIN_TONES[i].key, or null

const STORAGE_KEYS = [
  "anthropicApiKey",
  "claudeModel",
  "fashnApiKey",
  "falApiKey",
  "modelHeightInches",
  "modelHeightEnabled",
  "modelWeightLbs",
  "modelWeightEnabled",
  "modelSandbagEnabled",
  "modelSandbagPercent",
  "modelChestSize",
  "modelBustInches",
  "modelBustEnabled",
  "modelSkinToneKey",
];

function formatHeight(inches) {
  const ft = Math.floor(inches / 12);
  const rem = inches % 12;
  return `${ft}'${rem}"`;
}

function buildChestChips() {
  chestSizeChipsEl.innerHTML = "";
  for (const size of CHEST_SIZES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    btn.textContent = size;
    btn.dataset.size = size;
    btn.addEventListener("click", () => {
      selectedChestSize = selectedChestSize === size ? null : size;
      renderChestSelection();
    });
    chestSizeChipsEl.appendChild(btn);
  }
}

function renderChestSelection() {
  chestSizeChipsEl.querySelectorAll(".chip").forEach((el) => {
    el.classList.toggle("selected", el.dataset.size === selectedChestSize);
  });
}

function buildSwatches() {
  skinToneSwatchesEl.innerHTML = "";
  for (const tone of SKIN_TONES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "swatch";
    btn.style.background = tone.hex;
    btn.title = tone.label;
    btn.dataset.key = tone.key;
    btn.addEventListener("click", () => {
      selectedSkinTone = selectedSkinTone === tone.key ? null : tone.key;
      renderSwatchSelection();
    });
    skinToneSwatchesEl.appendChild(btn);
  }
}

function renderSwatchSelection() {
  skinToneSwatchesEl.querySelectorAll(".swatch").forEach((el) => {
    el.classList.toggle("selected", el.dataset.key === selectedSkinTone);
  });
}

heightRangeEl.addEventListener("input", () => {
  heightLabelEl.textContent = formatHeight(Number(heightRangeEl.value));
});
weightRangeEl.addEventListener("input", () => {
  weightLabelEl.textContent = `${weightRangeEl.value} lbs`;
});
heightEnabledEl.addEventListener("change", () => {
  heightRangeEl.disabled = !heightEnabledEl.checked;
});
weightEnabledEl.addEventListener("change", () => {
  weightRangeEl.disabled = !weightEnabledEl.checked;
});
sandbagPercentEl.addEventListener("input", () => {
  sandbagLabelEl.textContent = `+${sandbagPercentEl.value}%`;
});
sandbagEnabledEl.addEventListener("change", () => {
  sandbagPercentEl.disabled = !sandbagEnabledEl.checked;
});
bustRangeEl.addEventListener("input", () => {
  bustLabelEl.textContent = `${Number(bustRangeEl.value).toFixed(1)} in`;
});
bustEnabledEl.addEventListener("change", () => {
  bustRangeEl.disabled = !bustEnabledEl.checked;
});
skinToneClearEl.addEventListener("click", () => {
  selectedSkinTone = null;
  renderSwatchSelection();
});
chestSizeClearEl.addEventListener("click", () => {
  selectedChestSize = null;
  renderChestSelection();
});

async function load() {
  buildChestChips();
  buildSwatches();

  const stored = await chrome.storage.local.get(STORAGE_KEYS);

  anthropicKeyEl.value = stored.anthropicApiKey || "";
  claudeModelEl.value = stored.claudeModel || "claude-opus-5";
  fashnKeyEl.value = stored.fashnApiKey || "";
  falKeyEl.value = stored.falApiKey || "";

  const heightInches = stored.modelHeightInches || 66;
  heightRangeEl.value = heightInches;
  heightLabelEl.textContent = formatHeight(heightInches);
  heightEnabledEl.checked = !!stored.modelHeightEnabled;
  heightRangeEl.disabled = !heightEnabledEl.checked;

  const weightLbs = stored.modelWeightLbs || 190;
  weightRangeEl.value = weightLbs;
  weightLabelEl.textContent = `${weightLbs} lbs`;
  weightEnabledEl.checked = !!stored.modelWeightEnabled;
  weightRangeEl.disabled = !weightEnabledEl.checked;

  const sandbagPercent = stored.modelSandbagPercent ?? 50;
  sandbagPercentEl.value = sandbagPercent;
  sandbagLabelEl.textContent = `+${sandbagPercent}%`;
  sandbagEnabledEl.checked = !!stored.modelSandbagEnabled;
  sandbagPercentEl.disabled = !sandbagEnabledEl.checked;

  selectedChestSize = stored.modelChestSize || null;
  renderChestSelection();

  const bustInches = stored.modelBustInches || 36;
  bustRangeEl.value = bustInches;
  bustLabelEl.textContent = `${Number(bustInches).toFixed(1)} in`;
  bustEnabledEl.checked = !!stored.modelBustEnabled;
  bustRangeEl.disabled = !bustEnabledEl.checked;

  selectedSkinTone = stored.modelSkinToneKey || null;
  renderSwatchSelection();

  await renderSavedModelPreview();
}

/**
 * Builds the full settings object from the current form state — shared by
 * the Save button and "Generate 3 options" (which needs current values
 * persisted to chrome.storage before messaging background.js, since
 * getSettings() there reads from storage, not this page's live DOM).
 */
function buildSettingsPayload() {
  const heightInches = Number(heightRangeEl.value);
  const weightLbs = Number(weightRangeEl.value);
  const skinTone = SKIN_TONES.find((t) => t.key === selectedSkinTone);

  return {
    anthropicApiKey: anthropicKeyEl.value.trim(),
    claudeModel: claudeModelEl.value,
    fashnApiKey: fashnKeyEl.value.trim(),
    falApiKey: falKeyEl.value.trim(),

    // Raw values. modelWeightLbs/modelWeightEnabled + the sandbag settings
    // are what background.js reads directly to compute the (possibly
    // exaggerated) weight sent to Claude — the rest just restore this UI.
    modelHeightInches: heightInches,
    modelHeightEnabled: heightEnabledEl.checked,
    modelWeightLbs: weightLbs,
    modelWeightEnabled: weightEnabledEl.checked,
    modelSandbagEnabled: sandbagEnabledEl.checked,
    modelSandbagPercent: Number(sandbagPercentEl.value),
    modelChestSize: selectedChestSize,
    // Real bust/chest circumference (inches) — optional; background.js
    // falls back to a hardcoded cup-size benchmark estimate when this isn't
    // enabled (see CUP_SIZE_BUST_ESTIMATE_IN there). Only used for the
    // garment-width fit math, separate from modelChest below (the
    // qualitative "cup C" description used in the appearance prompt).
    modelBustInches: Number(bustRangeEl.value),
    modelBustEnabled: bustEnabledEl.checked,
    modelSkinToneKey: selectedSkinTone,

    // Derived display strings for the other fields — background.js reads
    // these directly (unlike weight, which it recomputes from the raw
    // fields above so the sandbag multiplier can apply).
    modelHeight: heightEnabledEl.checked ? formatHeight(heightInches) : "",
    modelChest: selectedChestSize
      ? (selectedChestSize === "N/A" ? "flat chest, no bust" : `cup ${selectedChestSize}`)
      : "",
    modelSkinTone: skinTone ? skinTone.label : "",
  };
}

/**
 * Mirrors background.js's computeAppearanceFingerprint() exactly (no shared
 * module system between the settings page and the service worker, so this
 * is intentionally duplicated in miniature) — must stay in sync with it, or
 * the "stale model photo" warning below will disagree with what
 * generateImage() actually decides at try-on time.
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

/**
 * Shows the saved model photo (if any) and whether it's stale relative to
 * the CURRENT form state — deliberately live (not just what was last
 * Saved), so dragging a slider updates the warning immediately rather than
 * only after clicking Save.
 */
async function renderSavedModelPreview() {
  const stored = await chrome.storage.local.get(["savedModelImageUrl", "savedModelSpecFingerprint"]);
  if (!stored.savedModelImageUrl) {
    currentModelPreviewEl.style.display = "none";
    noModelPreviewEl.style.display = "block";
    return;
  }
  currentModelImgEl.src = stored.savedModelImageUrl;
  currentModelPreviewEl.style.display = "flex";
  noModelPreviewEl.style.display = "none";
  const liveFingerprint = computeAppearanceFingerprint(buildSettingsPayload());
  modelStaleWarningEl.style.display = stored.savedModelSpecFingerprint === liveFingerprint ? "none" : "block";
}

saveBtn.addEventListener("click", async () => {
  await chrome.storage.local.set(buildSettingsPayload());

  statusEl.textContent = "Saved.";
  setTimeout(() => {
    statusEl.textContent = "";
  }, 2000);
  renderSavedModelPreview();
});

// Any appearance-affecting control changing should re-check staleness
// immediately, not just after Save — event delegation on body catches all
// of them (sliders, checkboxes, chips, swatches) without listing each one.
document.body.addEventListener("input", renderSavedModelPreview);
document.body.addEventListener("change", renderSavedModelPreview);

generateModelOptionsBtn.addEventListener("click", async () => {
  // Persist current form values first so background.js's getSettings()
  // (which reads chrome.storage, not this page's DOM) uses what's actually
  // configured right now, not whatever was last saved.
  await chrome.storage.local.set(buildSettingsPayload());

  generateModelOptionsBtn.disabled = true;
  generateModelOptionsBtn.textContent = "Generating… (~30–60s)";
  modelOptionsStatusEl.textContent = "";
  modelOptionsGridEl.style.display = "none";
  modelOptionsGridEl.innerHTML = "";

  try {
    const result = await chrome.runtime.sendMessage({ type: "GENERATE_MODEL_OPTIONS", count: 3 });
    if (!result || !result.ok) throw new Error((result && result.error) || "Unknown error");

    // Fingerprint the settings actually used to generate these candidates —
    // computed now (right after saving them) so it's guaranteed consistent
    // with what background.js used, not re-derived later from possibly-
    // changed form state.
    const fingerprint = computeAppearanceFingerprint(buildSettingsPayload());

    result.images.forEach((url, i) => {
      const card = document.createElement("div");
      card.className = "model-option-card";

      const img = document.createElement("img");
      img.className = "model-option-img";
      img.src = url;
      img.alt = `Model option ${i + 1}`;

      const useBtn = document.createElement("button");
      useBtn.type = "button";
      useBtn.className = "model-option-use-btn";
      useBtn.textContent = "Use this one";
      useBtn.addEventListener("click", async () => {
        await chrome.storage.local.set({
          savedModelImageUrl: url,
          savedModelSpecFingerprint: fingerprint,
        });
        modelOptionsStatusEl.textContent =
          "Saved — this photo will be reused for every try-on until your appearance settings change.";
        await renderSavedModelPreview();
      });

      card.appendChild(img);
      card.appendChild(useBtn);
      modelOptionsGridEl.appendChild(card);
    });
    modelOptionsGridEl.style.display = "grid";
    modelOptionsStatusEl.textContent = "Pick one below to save it as your model photo.";
  } catch (err) {
    modelOptionsStatusEl.textContent = `Error: ${String(err.message || err)}`;
  } finally {
    generateModelOptionsBtn.disabled = false;
    generateModelOptionsBtn.textContent = "Generate 3 options";
  }
});

load();
