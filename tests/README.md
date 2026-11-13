# Tests

Run everything (no API keys, no network, no cost — all network calls are stubbed):

```bash
npm test
```

| File | What it covers |
|---|---|
| `test_logic.js` | Parsing scraped text, hem/width math, severity tiers, fingerprint, `parseClaudeJson` |
| `test_pipeline.js` | Prompt sent to Claude, the FLUX → Try-On → Edit flow, model-photo caching, error fallbacks, message routing |
| `test_parity.js` | `options.js` and `background.js` compute the same appearance fingerprint (they're duplicated code) |
| `test_truncation.js` | A reply cut off by `max_tokens` errors instead of sending broken JSON to FLUX |
| `harness.js` | Loads the real `background.js` in a Node `vm` with stubbed `chrome`/`fetch` |

## Browser checks (not automated yet)

`content.js` and `options.js` need a real DOM. `build-fixtures.js` and `build-options-fixture.js`
write self-contained pages into `tests/fixtures-generated/` (git-ignored) with the real script inlined
and `chrome.runtime` stubbed. Serve that folder over localhost (the browser pane won't run scripts on
`file://`), open a fixture, click the button, and check:

- main image, thumbnail, hidden duplicate and a late-loading duplicate all swap; the "recommended" decoy doesn't; `<picture>` `<source>`s are removed
- the `<a href>` "Size Guide" link is not followed, the collapsed "Fit & Sizing" accordion is opened and scraped
- warning scenario: every copy is blurred, the card covers the **largest** copy (not the first in DOM order) and follows scrolling, "Show anyway" clears it, a regeneration without a warning clears a stale one
- settings page: Save writes every key `background.js` reads; "Use this one" saves a photo + fingerprint; changing weight marks it stale, changing bust doesn't
