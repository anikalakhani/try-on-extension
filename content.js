// content.js — runs on every page. Detects shopping pages, injects the
// floating button, and on click runs the full pipeline automatically
// (prompt -> image -> replace on page). After that, the button becomes
// "Customize my try-on" — hovering it reveals prompt editing and
// regenerate controls.

(function () {
  const BUTTON_ID = "fitforme-launch-button";
  const PANEL_ID = "fitforme-panel";
  const LOADING_ID = "fitforme-loading-overlay";
  const LOADING_TEXT_ID = "fitforme-loading-text";
  const TARGET_IMG_ATTR = "data-fitforme-target";
  const SIZE_WARNING_ID = "fitforme-size-warning-overlay";
  const SIZE_WARNING_BLUR_CLASS = "fitforme-size-warning-blurred";

  // Holds everything about the current try-on so the hover panel's
  // "regenerate" actions can act on it without re-scraping the page.
  let session = null; // { garmentImageUrl, targetImageEl, prompt, modelImageUrl, finalImageUrl, sizeWarning }
  let hoverPanelEl = null;
  let hoverHideTimer = null;
  // { overlayEl, blurredEls, reposition } while a size-warning blur is
  // active, else null — see applySizeWarning/clearSizeWarning.
  let sizeWarningState = null;

  init();

  function init() {
    if (!detectShoppingPage()) return;
    injectButton();
  }

  // ---------- Shopping-page detection ----------

  function detectShoppingPage() {
    let score = 0;

    // Structured data: schema.org Product
    const ldJsonScripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of ldJsonScripts) {
      try {
        const data = JSON.parse(script.textContent);
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          const type = item && item["@type"];
          if (type === "Product" || (Array.isArray(type) && type.includes("Product"))) {
            score += 3;
          }
        }
      } catch (_) {
        // ignore malformed JSON-LD
      }
    }

    // og:type meta
    const ogType = document.querySelector('meta[property="og:type"]');
    if (ogType && /product/i.test(ogType.content || "")) score += 2;

    // "Add to cart / bag" affordance
    const addToCartRegex = /add to (cart|bag)|add-to-cart|buy now/i;
    const clickable = document.querySelectorAll('button, a, input[type="submit"]');
    for (const el of clickable) {
      const text = (el.innerText || el.value || "").trim();
      if (addToCartRegex.test(text)) {
        score += 2;
        break;
      }
    }

    // Price-looking text somewhere on the page
    if (/[$£€]\s?\d+(\.\d{2})?/.test(document.body.innerText || "")) score += 1;

    return score >= 3;
  }

  // ---------- Button + panel UI ----------

  function injectButton() {
    if (document.getElementById(BUTTON_ID)) return;

    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.className = "fitforme-button";
    button.type = "button";
    button.textContent = "✨ Try This On";
    button.addEventListener("click", onButtonClick);
    attachHoverHandlers(button);

    document.documentElement.appendChild(button);
  }

  function setButtonText(text) {
    const button = document.getElementById(BUTTON_ID);
    if (button) button.textContent = text;
  }

  // ---------- Loading overlay ----------
  // A centered, non-blocking "cute" status card shown during the wait — the
  // button keeps showing the same status text too (not replaced), this just
  // makes the wait more visible/fun since it can run ~30-90s.

  function showLoadingOverlay(initialText) {
    hideLoadingOverlay();

    const overlay = document.createElement("div");
    overlay.id = LOADING_ID;
    overlay.className = "fitforme-loading-overlay";

    const card = document.createElement("div");
    card.className = "fitforme-loading-card";

    const spinner = document.createElement("div");
    spinner.className = "fitforme-loading-spinner";
    const spinnerEmoji = document.createElement("div");
    spinnerEmoji.className = "fitforme-loading-spinner-emoji";
    spinnerEmoji.textContent = "✨";
    spinner.appendChild(spinnerEmoji);

    const text = document.createElement("div");
    text.id = LOADING_TEXT_ID;
    text.className = "fitforme-loading-text";
    text.textContent = initialText || "Working on it…";

    card.appendChild(spinner);
    card.appendChild(text);
    overlay.appendChild(card);
    document.documentElement.appendChild(overlay);
  }

  function updateLoadingOverlay(text) {
    const el = document.getElementById(LOADING_TEXT_ID);
    if (el) el.textContent = text;
  }

  function hideLoadingOverlay() {
    const existing = document.getElementById(LOADING_ID);
    if (existing) existing.remove();
  }

  /** Reports a status string to wherever it's needed — button, overlay, or both. */
  function makeReporter(...sinks) {
    return (text) => sinks.forEach((sink) => sink && sink(text));
  }

  // ---------- Size warning (extreme garment-vs-body width mismatch) ----------
  // Shown when background.js's width math (see computeWidthShift /
  // describeWidthEffect) flags the mismatch as "extreme" — the generated
  // image gets blurred with a warning until the user explicitly confirms
  // they still want to see it, rather than silently showing a try-on for a
  // size that plausibly won't fit at all.

  /**
   * Blurs every currently-known copy of the generated image and shows one
   * warning card positioned over the primary (largest/first-matched) one.
   * `els` should be every element FASHN's replacement actually touched —
   * late-loading stragglers get blurred too via the extraApply callback
   * threaded through replaceImageOnPage/sweepStragglerMatches, not just
   * whatever existed at the moment of the initial swap.
   */
  function applySizeWarning(els, sizeWarning) {
    clearSizeWarning();
    if (!els || !els.length || !sizeWarning) return;

    els.forEach((el) => el.classList.add(SIZE_WARNING_BLUR_CLASS));

    const primary = els[0];
    const overlay = document.createElement("div");
    overlay.id = SIZE_WARNING_ID;
    overlay.className = "fitforme-size-warning-overlay";

    const card = document.createElement("div");
    card.className = "fitforme-size-warning-card";

    const text = document.createElement("div");
    text.className = "fitforme-size-warning-text";
    text.textContent = sizeWarning.tooLoose
      ? "It looks like this item runs large for your measurements — this size may not fit the way it's shown here. Would you still like to view the generated image?"
      : "It appears like this clothing item doesn't come in your size — it may be too small based on your measurements. Would you still like to view the generated image?";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "fitforme-size-warning-button";
    btn.textContent = "Show anyway";
    btn.addEventListener("click", clearSizeWarning);

    card.appendChild(text);
    card.appendChild(btn);
    overlay.appendChild(card);
    document.documentElement.appendChild(overlay);

    const reposition = () => {
      const rect = primary.getBoundingClientRect();
      overlay.style.top = `${rect.top}px`;
      overlay.style.left = `${rect.left}px`;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;
      // The blurred image can move (page re-layout, other content loading
      // in) or disappear (SPA navigation away from the product) — treat a
      // vanished primary element as "nothing left to warn about."
      if (!document.contains(primary)) clearSizeWarning();
    };
    reposition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);

    sizeWarningState = { overlayEl: overlay, blurredEls: els, reposition };
  }

  /** Adds newly-found duplicate elements to an already-active blur (called from the sweep). */
  function extendSizeWarning(el) {
    if (!sizeWarningState) return;
    el.classList.add(SIZE_WARNING_BLUR_CLASS);
    sizeWarningState.blurredEls.push(el);
  }

  function clearSizeWarning() {
    if (!sizeWarningState) {
      // Best-effort cleanup even with no tracked state — e.g. after a page
      // re-render replaced the elements out from under us.
      document.querySelectorAll(`.${SIZE_WARNING_BLUR_CLASS}`).forEach((el) => el.classList.remove(SIZE_WARNING_BLUR_CLASS));
      const stray = document.getElementById(SIZE_WARNING_ID);
      if (stray) stray.remove();
      return;
    }
    sizeWarningState.blurredEls.forEach((el) => el.classList.remove(SIZE_WARNING_BLUR_CLASS));
    sizeWarningState.overlayEl.remove();
    window.removeEventListener("scroll", sizeWarningState.reposition, true);
    window.removeEventListener("resize", sizeWarningState.reposition);
    sizeWarningState = null;
  }

  /**
   * Runs the whole pipeline end-to-end on click: write the prompt, generate
   * the image, and replace it on the page automatically. Once done, the
   * button becomes "Customize my try-on ▾" — hovering it reveals the same
   * edit/regenerate controls that used to require a click to reach.
   */
  async function onButtonClick() {
    const button = document.getElementById(BUTTON_ID);
    if (!button || button.disabled) return;
    button.disabled = true;

    const report = makeReporter(setButtonText, updateLoadingOverlay);
    showLoadingOverlay("Writing prompt…");
    report("Writing prompt…");

    const productData = await scrapeProductData();
    highlightTargetImage(productData.targetImageEl);
    const garmentImageUrl = getImageUrl(productData.targetImageEl);

    session = {
      garmentImageUrl,
      // Tracks whatever URL is actually on the page right now — starts out
      // the same as garmentImageUrl, but advances after every successful
      // replace so later regenerations can still find their target even
      // though the original garment URL is long gone from the page by then.
      currentPageImageUrl: garmentImageUrl,
      targetImageEl: productData.targetImageEl,
      prompt: "",
      // Standalone instruction for FASHN's Edit step (runs after Try-On) to
      // correct hem/neckline placement using the model's actual height —
      // null unless the page had garment measurements + a height is set.
      fitEditPrompt: null,
      // Set when background.js's width math flags an extreme garment-vs-
      // body mismatch — { tooLoose, easeIn, easeCm } or null. Drives the
      // blur-until-confirmed warning in runGenerateAndReplace.
      sizeWarning: null,
      modelImageUrl: null,
      finalImageUrl: null,
      lastStatus: "",
    };

    try {
      const promptResult = await sendMessage({
        type: "GENERATE_PROMPT",
        productData: serializeProductData(productData),
      });
      if (!promptResult.ok) throw new Error(promptResult.error);
      session.prompt = promptResult.prompt;
      session.fitEditPrompt = promptResult.fitEditPrompt || null;
      session.sizeWarning = promptResult.sizeWarning || null;
      // Claude's explicit shorter/taller-vs-reference conclusion, logged so
      // it's easy to check whether the actual fitEditPrompt/imagePrompt
      // stayed consistent with it, or silently reversed direction — a
      // failure mode confirmed live once already.
      if (promptResult.fitReasoning) {
        console.log("[Fit For Me] Fit reasoning:", promptResult.fitReasoning);
      }
    } catch (err) {
      hideLoadingOverlay();
      button.disabled = false;
      button.textContent = "✨ Try This On";
      alert(`Couldn't write a prompt: ${String(err.message || err)}`);
      return;
    }

    const outcome = await runGenerateAndReplace({ onStatus: report });
    session.lastStatus = outcome.ok ? "" : `Error: ${outcome.error}`;

    hideLoadingOverlay();
    button.disabled = false;
    button.textContent = "Customize my try-on ▾";
    buildHoverPanel();
  }

  /**
   * Generates the image from session.prompt and, if successful, replaces it
   * on the page immediately — used both by the initial auto-run and by the
   * hover panel's "Regenerate image" action. Reports progress via onStatus.
   */
  async function runGenerateAndReplace({ onStatus } = {}) {
    const report = onStatus || (() => {});
    // Whether this reuses a saved model photo (skipping the FLUX call
    // entirely) or generates a fresh one isn't known until background.js
    // resolves it, so this stays deliberately noncommittal about which —
    // the reused-model path is meaningfully faster in practice.
    report(
      session.fitEditPrompt
        ? "Preparing your model, trying on the garment, and adjusting fit — can take ~15–90s…"
        : "Preparing your model + trying on the garment — can take ~10–60s…"
    );
    try {
      const result = await sendMessage({
        type: "GENERATE_IMAGE",
        prompt: session.prompt,
        garmentImageUrl: session.garmentImageUrl,
        fitEditPrompt: session.fitEditPrompt,
      });
      if (!result.ok) throw new Error(result.error);

      session.modelImageUrl = result.modelImageUrl || null;
      session.tryonImageUrl = result.tryonImageUrl || null;
      session.finalImageUrl = result.finalImageUrl || null;
      // Not shown in the panel UI (removed per earlier feedback), but logged
      // here so body-type/fit fidelity issues can be isolated to a specific
      // pipeline stage: FLUX model (before garment) -> FASHN Try-On (garment
      // applied, before fit correction) -> FASHN Edit (final, after fit
      // correction, only runs when fitEditPrompt is set).
      console.log(
        result.usedCachedModel
          ? "[Fit For Me] Reused saved model photo (no fal.ai call this run):"
          : "[Fit For Me] FLUX model image (before garment):",
        session.modelImageUrl
      );
      console.log("[Fit For Me] FASHN Try-On image (garment applied, before fit correction):", session.tryonImageUrl);
      console.log("[Fit For Me] Final image (after fit correction, if any):", session.finalImageUrl);
      if (session.sizeWarning) {
        console.log("[Fit For Me] Size warning:", session.sizeWarning);
      }

      report("Replacing image on page…");
      const searchUrls = [session.currentPageImageUrl, session.garmentImageUrl];
      // A previous run's blur/warning (if any) is stale the moment a new
      // image starts replacing the page — clear it before applying the new
      // one's own warning (or lack of one) below.
      clearSizeWarning();
      const extraApply = session.sizeWarning ? (el) => extendSizeWarning(el) : null;
      const { didReplace, matchedEl, matchedEls } = replaceImageOnPage(
        session.targetImageEl,
        session.finalImageUrl,
        searchUrls,
        extraApply
      );
      if (didReplace) {
        session.currentPageImageUrl = session.finalImageUrl;
        if (matchedEl) session.targetImageEl = matchedEl;
        if (session.sizeWarning) applySizeWarning(matchedEls, session.sizeWarning);
      }
      report(didReplace ? "Done — replaced on page." : "Generated, but couldn't find the image to replace on the page.");
      return { ok: true };
    } catch (err) {
      const message = String(err.message || err);
      report(`Error: ${message}`);
      return { ok: false, error: message };
    }
  }

  function getImageUrl(imgEl) {
    if (!imgEl) return null;
    return imgEl.currentSrc || imgEl.src || null;
  }

  function normalizeImageUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      return parsed.origin + parsed.pathname; // ignore query string (width/version params)
    } catch (_) {
      return url;
    }
  }

  /**
   * Finds every currently-rendered <img> whose src/currentSrc matches any of
   * the given URLs (exact match first, falling back to origin+pathname so
   * CDN width/version query-string variants still match). Accepts a single
   * URL or an array — searching for several candidates at once matters here:
   * after the first replace, the page no longer shows the *original* garment
   * URL anywhere, so a second regenerate has to also match whatever URL is
   * currently displayed, or it finds nothing and falls back to a much less
   * reliable heuristic re-scan.
   */
  function findAllImagesByUrl(urlOrUrls) {
    const urls = (Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls]).filter(Boolean);
    if (!urls.length) return [];
    const imgs = Array.from(document.querySelectorAll("img"));
    const exact = imgs.filter((img) => urls.includes(img.src) || urls.includes(img.currentSrc));
    if (exact.length) return exact;
    const normalized = urls.map(normalizeImageUrl);
    return imgs.filter((img) => normalized.includes(normalizeImageUrl(img.currentSrc || img.src)));
  }

  /**
   * Sets an <img>'s src to the replacement URL. If the <img> is inside a
   * <picture> element, the browser resolves from sibling <source> elements
   * FIRST (format negotiation for AVIF/WebP) and only falls back to the
   * <img>'s own src if none match — confirmed live on a site using this
   * pattern: changing only the <img> silently did nothing, because a
   * <source> sibling still pointed at the original image and kept winning.
   * Stripping those <source> siblings makes the <img> src actually take over.
   */
  function applyImageReplacement(el, newUrl) {
    const picture = el.closest("picture");
    if (picture) {
      picture.querySelectorAll("source").forEach((source) => source.remove());
    }
    el.removeAttribute("srcset");
    el.removeAttribute("sizes");
    el.src = newUrl;
  }

  /**
   * Some sites render the same product photo in multiple separate <img>
   * elements at different sizes (thumbnail rail, mobile/desktop duplicates,
   * etc.) — and not all of them exist in the DOM at the exact moment we
   * replace, they load in a second or two later. Confirmed live: the element
   * we change stays changed (no framework "fighting" us), but duplicates
   * that appear shortly after still show the original photo, so the page as
   * a whole looks unchanged. This re-scans for a few seconds after the
   * initial replace and catches any stragglers still carrying one of the
   * candidate URLs.
   */
  function sweepStragglerMatches(searchUrls, newUrl, { intervalMs = 500, durationMs = 4000, extraApply } = {}) {
    const start = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - start > durationMs) {
        clearInterval(timer);
        return;
      }
      findAllImagesByUrl(searchUrls).forEach((el) => {
        applyImageReplacement(el, newUrl);
        // Lets callers (the size-warning blur) react to late-loading
        // duplicates too, not just whatever was on the page at replace
        // time — otherwise a straggler that loads in a second later would
        // show the un-blurred, un-warned image right next to a blurred one.
        if (extraApply) extraApply(el);
      });
    }, intervalMs);
  }

  /**
   * Swaps the page's product image(s) to point at the generated image.
   *
   * Re-running "biggest visible image" at replace time turned out to be
   * unreliable on pages with lazy-loaded galleries — the pool of loaded
   * candidates grows over time, so a fresh heuristic scan can land on a
   * different (but still large & visible) photo than the one actually used.
   * Anchoring by URL instead is much more stable — but on a *second* replace
   * (regenerate), the original garment URL is long gone from the page (it
   * now shows the first generated image), so `searchUrls` must include both
   * the original garment URL and whatever was last successfully displayed.
   * Returns the element(s) actually matched, so the caller can update its
   * "currently displayed" pointer for the next regenerate.
   */
  function replaceImageOnPage(imgEl, newUrl, searchUrls, extraApply) {
    const isUsable = (el) => {
      if (!el || !document.contains(el)) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const applyTo = (el) => {
      applyImageReplacement(el, newUrl);
      if (extraApply) extraApply(el);
    };

    let matched = [];
    let scrollTarget = null;

    // Largest rendered copy first. findAllImagesByUrl returns matches in DOM
    // order, and on most shops the thumbnail rail comes BEFORE the main image
    // in the DOM — so "first match" was routinely a ~80px thumbnail. That is
    // the element we scroll to, hand back as matchedEl (stored as
    // session.targetImageEl), and anchor the size-warning card over. Confirmed
    // in a fixture test: the warning card was squeezed into the thumbnail's
    // 80x120 box instead of covering the main product photo.
    const renderedArea = (el) => {
      const r = el.getBoundingClientRect();
      return r.width * r.height;
    };
    const urlMatches = findAllImagesByUrl(searchUrls)
      .filter(isUsable)
      .sort((a, b) => renderedArea(b) - renderedArea(a));
    if (urlMatches.length) {
      urlMatches.forEach(applyTo);
      matched = urlMatches;
      scrollTarget = urlMatches[0];
    } else {
      // Fall back to the original element, then a fresh heuristic scan, only
      // if no element on the page still carries any candidate URL at all.
      const target = isUsable(imgEl) ? imgEl : findMainProductImage();
      if (isUsable(target)) {
        applyTo(target);
        matched = [target];
        scrollTarget = target;
      }
    }

    if (scrollTarget) scrollTarget.scrollIntoView({ behavior: "smooth", block: "center" });
    sweepStragglerMatches(searchUrls, newUrl, { extraApply });
    return { didReplace: matched.length > 0, matchedEl: matched[0] || null, matchedEls: matched };
  }

  /**
   * Keeps the panel open while the mouse is over the button OR the panel,
   * with a short grace delay so moving the cursor from one to the other
   * doesn't cause a flicker-close in between.
   */
  function attachHoverHandlers(el) {
    el.addEventListener("mouseenter", showHoverPanel);
    el.addEventListener("mouseleave", scheduleHideHoverPanel);
  }

  function showHoverPanel() {
    if (hoverHideTimer) {
      clearTimeout(hoverHideTimer);
      hoverHideTimer = null;
    }
    if (hoverPanelEl) hoverPanelEl.style.display = "block";
  }

  function scheduleHideHoverPanel() {
    if (hoverHideTimer) clearTimeout(hoverHideTimer);
    hoverHideTimer = setTimeout(() => {
      if (hoverPanelEl) hoverPanelEl.style.display = "none";
    }, 250);
  }

  /**
   * Builds the "customize" panel once a try-on has run. Hidden by default —
   * shown on hovering the button (see attachHoverHandlers) rather than on
   * click, since the button itself now triggers the full auto-run pipeline.
   */
  function buildHoverPanel() {
    const existing = document.getElementById(PANEL_ID);
    if (existing) existing.remove();

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.className = "fitforme-panel";
    panel.style.display = "none";
    attachHoverHandlers(panel);

    const header = document.createElement("div");
    header.className = "fitforme-panel-header";
    header.innerHTML = `<span>Fit For Me — Customize</span>`;

    const body = document.createElement("div");
    body.className = "fitforme-panel-body";

    const status = document.createElement("div");
    status.className = "fitforme-status";
    status.textContent = session.lastStatus || "";
    body.appendChild(status);

    const label = document.createElement("label");
    label.className = "fitforme-label";
    label.textContent = "Prompt (edit freely, then regenerate the image)";
    body.appendChild(label);

    const textarea = document.createElement("textarea");
    textarea.className = "fitforme-textarea";
    textarea.value = session.prompt;
    textarea.rows = 8;
    textarea.addEventListener("input", () => {
      session.prompt = textarea.value;
    });
    body.appendChild(textarea);

    // Only shown when there's actually a fit-correction prompt to edit (the
    // page had garment measurements + a model height is set) — most product
    // pages won't have this, so an always-visible empty field would mostly
    // just be clutter.
    const fitEditLabel = document.createElement("label");
    fitEditLabel.className = "fitforme-label";
    fitEditLabel.textContent = "Garment fit correction (sent to FASHN after the garment is applied, to fix hem/neckline placement)";
    fitEditLabel.style.display = session.fitEditPrompt ? "block" : "none";
    body.appendChild(fitEditLabel);

    const fitEditTextarea = document.createElement("textarea");
    fitEditTextarea.className = "fitforme-textarea";
    fitEditTextarea.value = session.fitEditPrompt || "";
    fitEditTextarea.rows = 4;
    fitEditTextarea.style.display = session.fitEditPrompt ? "block" : "none";
    fitEditTextarea.addEventListener("input", () => {
      session.fitEditPrompt = fitEditTextarea.value || null;
    });
    body.appendChild(fitEditTextarea);

    const actions = document.createElement("div");
    actions.className = "fitforme-actions";

    const regenPromptBtn = document.createElement("button");
    regenPromptBtn.className = "fitforme-secondary-button";
    regenPromptBtn.type = "button";
    regenPromptBtn.textContent = "Regenerate prompt";
    regenPromptBtn.addEventListener("click", async () => {
      regenPromptBtn.disabled = true;
      regenPromptBtn.textContent = "Regenerating…";
      status.textContent = "";
      const productData = await scrapeProductData();
      try {
        const result = await sendMessage({ type: "GENERATE_PROMPT", productData: serializeProductData(productData) });
        if (!result.ok) throw new Error(result.error);
        session.prompt = result.prompt;
        session.fitEditPrompt = result.fitEditPrompt || null;
        session.sizeWarning = result.sizeWarning || null;
        textarea.value = result.prompt;
        fitEditTextarea.value = session.fitEditPrompt || "";
        fitEditTextarea.style.display = session.fitEditPrompt ? "block" : "none";
        fitEditLabel.style.display = session.fitEditPrompt ? "block" : "none";
        if (result.fitReasoning) {
          console.log("[Fit For Me] Fit reasoning:", result.fitReasoning);
        }
        status.textContent = "Prompt updated — click \"Regenerate image\" to use it.";
      } catch (err) {
        status.textContent = `Error: ${String(err.message || err)}`;
      } finally {
        regenPromptBtn.disabled = false;
        regenPromptBtn.textContent = "Regenerate prompt";
      }
    });

    const regenImageBtn = document.createElement("button");
    regenImageBtn.className = "fitforme-primary-button";
    regenImageBtn.type = "button";
    regenImageBtn.textContent = "Regenerate image";
    regenImageBtn.addEventListener("click", async () => {
      regenImageBtn.disabled = true;
      session.prompt = textarea.value;
      session.fitEditPrompt = fitEditTextarea.value || null;
      const report = makeReporter((text) => {
        status.textContent = text;
      }, updateLoadingOverlay);
      showLoadingOverlay("Regenerating…");
      await runGenerateAndReplace({ onStatus: report });
      hideLoadingOverlay();
      regenImageBtn.disabled = false;
    });

    actions.appendChild(regenPromptBtn);
    actions.appendChild(regenImageBtn);
    body.appendChild(actions);

    const settingsBtn = document.createElement("button");
    settingsBtn.className = "fitforme-secondary-button fitforme-full-width";
    settingsBtn.type = "button";
    settingsBtn.textContent = "Change my image settings";
    settingsBtn.addEventListener("click", () => {
      sendMessage({ type: "OPEN_OPTIONS" }).catch(() => {});
    });
    body.appendChild(settingsBtn);

    const note = document.createElement("div");
    note.className = "fitforme-note";
    note.textContent =
      "Regenerating uses your FASHN + fal.ai credits and automatically replaces the image on the page — local to this browser tab only (refresh to undo it).";
    body.appendChild(note);

    panel.appendChild(header);
    panel.appendChild(body);
    document.documentElement.appendChild(panel);
    hoverPanelEl = panel;
  }

  // ---------- Scraping ----------

  async function scrapeProductData() {
    const title = getProductTitle();
    const detailsText = getDetailsText();
    const targetImageEl = findMainProductImage();
    // Best-effort: some sites hide garment measurements / reference-model
    // info behind a "Size Guide" / "Measurements" / "Find My Size" tab that
    // isn't in the DOM's visible text until clicked.
    await tryExpandMeasurementsSection();
    const measurementsText = getMeasurementsText();
    return { title, detailsText, measurementsText, targetImageEl };
  }

  function serializeProductData(productData) {
    // Strip DOM references before sending across the messaging boundary.
    return {
      title: productData.title,
      detailsText: productData.detailsText,
      measurementsText: productData.measurementsText,
    };
  }

  function getProductTitle() {
    const ogTitle = document.querySelector('meta[property="og:title"]');
    if (ogTitle && ogTitle.content) return ogTitle.content.trim();

    const h1 = document.querySelector("h1");
    if (h1 && h1.innerText) return h1.innerText.trim();

    return document.title || "";
  }

  function getDetailsText() {
    // Look for material/measurement keywords anywhere in the body text and
    // return the surrounding lines. Capped to keep the API call cheap.
    const keywords = [
      "material", "fabric", "composition", "% cotton", "% polyester",
      "% elastane", "% nylon", "% wool", "% silk", "% linen", "% viscose",
      "measurement", "length:", "bust:", "waist:", "chest:", "inseam:",
    ];
    const bodyText = document.body.innerText || "";
    const lines = bodyText.split("\n").map((l) => l.trim()).filter(Boolean);

    const matched = [];
    for (const line of lines) {
      const lower = line.toLowerCase();
      if (keywords.some((kw) => lower.includes(kw))) {
        matched.push(line);
      }
      if (matched.length >= 12) break;
    }
    return matched.join(" | ").slice(0, 2000);
  }

  const MEASUREMENTS_TRIGGER_REGEX = /size guide|size chart|measurements?|find my size|fit guide|sizing info|fit\s*&?\s*sizing|\bsizing\b/i;

  /**
   * Some sites (e.g. peppermayo.com) only put garment measurements and the
   * reference model's height/size ("model is 177cm, wearing a size 6") into
   * the DOM once a "Size Guide" / "Measurements" tab or accordion is opened —
   * plain innerText scraping misses them entirely otherwise. Best-effort:
   * finds every short, clearly-labeled clickable element matching that intent
   * and clicks each one (not just the first) — confirmed live that some
   * pages have BOTH a generic nav "Size Guide" link (opens a size-conversion
   * chart with no real measurements) AND a separate product-specific "Fit &
   * Sizing" accordion (has the actual bust/waist/hem numbers + model info),
   * so stopping at the first match can miss the one that actually matters.
   * Silently no-ops if nothing matches or a click throws — this must never
   * block the rest of the pipeline.
   */
  async function tryExpandMeasurementsSection() {
    const clickable = Array.from(
      document.querySelectorAll('button, a, [role="tab"], [role="button"], summary')
    );
    const triggers = clickable.filter((el) => {
      const text = (el.innerText || el.textContent || "").trim();
      if (text.length === 0 || text.length >= 40 || !MEASUREMENTS_TRIGGER_REGEX.test(text)) return false;
      // Some sites use a real navigation link for this ("Size Guide" -> a
      // separate /pages/sizing page) alongside a same-page JS trigger for
      // the same label — confirmed live that clicking the link navigates
      // away from the product page entirely, losing the scrape. Only click
      // elements that stay on the page: non-<a> elements, or <a> tags whose
      // href is empty/"#"/javascript: (JS-driven, not real navigation).
      if (el.tagName === "A") {
        const href = (el.getAttribute("href") || "").trim();
        if (href && href !== "#" && !href.startsWith("javascript:")) return false;
      }
      return true;
    });
    if (!triggers.length) return;
    for (const trigger of triggers.slice(0, 5)) {
      try {
        trigger.click();
      } catch (_) {
        // Clicking is best-effort only — never let it block scraping.
      }
    }
    await sleep(400); // let whatever tabs/accordions/modals actually render
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  const MEASUREMENT_LINE_KEYWORDS = [
    "bust:", "waist:", "hem:", "hip:", "sleeve:", "shoulder:", "inseam:",
    "garment measurement", "flat measurement", "model is", "model wears",
    "wearing a size", "she is wearing", "model height", "our model is",
    // Qualitative fit descriptions — no hard numbers, so they can't feed
    // computeHemShift/computeWidthShift, but they're still real signal
    // about the intended silhouette that was previously falling through
    // entirely on sites that don't publish garment measurements at all
    // (confirmed live on gap.com: "Fit: Classic. A straight & easy fit.
    // Slightly cropped, hits above the hip." matched none of the keywords
    // above and was silently dropped, right next to a line that did match).
    "fit:", "regular fit", "relaxed fit", "oversized fit", "slim fit",
    "loose fit", "classic fit", "tailored fit", "boxy fit", "cropped fit",
    "easy fit", "true to size", "runs small", "runs large", "hits above",
    "hits below", "hits at", "cropped", "oversized", "relaxed",
  ];

  /**
   * Grabs lines mentioning garment measurements (bust/waist/hem/length) or
   * the reference model's own height + size ("model is 177cm, wearing a size
   * AU 6") — fed to Claude so it can reason about where hems/necklines will
   * actually land on a model of a *different* height than the one in the
   * original product photo, instead of assuming identical proportions.
   * Call after tryExpandMeasurementsSection() so tab-gated content is
   * included when present. Separate from getDetailsText() (which targets
   * fabric/material composition) since this is scraped for a different
   * purpose and the two keyword sets would otherwise dilute each other.
   */
  function getMeasurementsText() {
    const bodyText = document.body.innerText || "";
    const lines = bodyText.split("\n").map((l) => l.trim()).filter(Boolean);
    const numericUnitRegex = /\b\d+(\.\d+)?\s?(cm|in|")\b/i;

    const matched = [];
    for (const line of lines) {
      const lower = line.toLowerCase();
      if (MEASUREMENT_LINE_KEYWORDS.some((kw) => lower.includes(kw)) || numericUnitRegex.test(line)) {
        matched.push(line);
      }
      if (matched.length >= 20) break;
    }
    return matched.join(" | ").slice(0, 2500);
  }

  const NON_PRODUCT_ANCESTOR_HINTS = [
    "recommend", "related", "upsell", "cross-sell", "you-may", "also-like",
    "footer", "header", "nav", "cart-drawer", "review", "carousel-thumb",
  ];

  function isLikelyOutsideMainProduct(el) {
    let node = el;
    let depth = 0;
    while (node && depth < 8) {
      const cls = (node.className && node.className.toString) ? node.className.toString().toLowerCase() : "";
      const id = (node.id || "").toLowerCase();
      if (NON_PRODUCT_ANCESTOR_HINTS.some((hint) => cls.includes(hint) || id.includes(hint))) {
        return true;
      }
      node = node.parentElement;
      depth += 1;
    }
    return false;
  }

  /**
   * Picks the main product image by what's actually rendered on screen right
   * now, not just an element's natural pixel dimensions — a page can have
   * hundreds of <img> tags (carousels, recommendations, hidden slides) whose
   * naturalWidth/Height is large but whose rendered size is 0x0. Sorting by
   * rendered area and preferring the topmost tie naturally favors the hero
   * product image over thumbnails and unrelated sections.
   */
  function findMainProductImage() {
    const candidates = Array.from(document.querySelectorAll("img"))
      .filter((img) => {
        const rect = img.getBoundingClientRect();
        return (
          rect.width > 150 &&
          rect.height > 150 &&
          img.naturalWidth > 150 &&
          !isLikelyOutsideMainProduct(img)
        );
      })
      .map((img) => ({ img, rect: img.getBoundingClientRect() }));

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => {
      const areaDiff = b.rect.width * b.rect.height - a.rect.width * a.rect.height;
      if (Math.abs(areaDiff) > 5000) return areaDiff;
      return a.rect.top - b.rect.top; // tie-break: prefer the topmost
    });

    return candidates[0].img;
  }

  function highlightTargetImage(imgEl) {
    document.querySelectorAll(`[${TARGET_IMG_ATTR}]`).forEach((el) => {
      el.removeAttribute(TARGET_IMG_ATTR);
      el.classList.remove("fitforme-target-image");
    });
    if (imgEl) {
      imgEl.setAttribute(TARGET_IMG_ATTR, "true");
      imgEl.classList.add("fitforme-target-image");
    }
  }

  // ---------- Messaging ----------

  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      // If the extension was reloaded (chrome://extensions) since this page
      // loaded, this content script is orphaned — chrome.runtime is gone or
      // throws on use. Refreshing the page re-injects a live content script.
      if (!chrome.runtime || !chrome.runtime.id) {
        reject(new Error("Extension was reloaded — refresh this page and try again."));
        return;
      }
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(response);
        });
      } catch (err) {
        reject(new Error("Extension was reloaded — refresh this page and try again."));
      }
    });
  }
})();
