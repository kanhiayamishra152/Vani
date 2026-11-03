## Vani AI v1.0.1 — critical stability fix

This release fixes the **total UI freeze** reported on v1.0.0 (app locked up within ~5 s on a Poco M6 Plus 5G; Live Talk, Model Hub, Settings and the bottom navigation all became unresponsive).

### Root cause
The WebView event bus had two **synchronous self-recursion loops** that ran only on a real device (the browser preview skipped them, which is why they slipped through):
- `nav()` emitted `nav` while also listening to `nav` → infinite recursion on every tab switch and at boot.
- `applyStatus()` emitted `llm.status` while also listening to `llm.status` → infinite recursion whenever the native engine reported status.

Each recursion rebuilt the chat/hub DOM thousands of times and flooded the native bridge, wedging the main thread so no tap, scroll or navigation could be processed.

### Fixes
- Split command events from notification events (`nav` → `tab.changed`, `llm.status` → `llm.statusChanged`) so handlers can never re-trigger themselves.
- Added a **re-entrancy depth guard** to the event bus — any future runaway synchronous recursion is blocked instead of freezing the UI.
- Raised `#sheet-root` / `#modal-root` above the Live overlay so the **/anime command sheet is reachable during Live Talk** (it was previously hidden behind it).
- Hardened scroll containers (`touch-action: pan-y`, `overscroll-behavior: contain`) and the `[hidden]` rule (`pointer-events: none !important`).
- Live Talk opens **even with no model installed**, so the avatar and `/anime` gestures can be tested immediately.

### Verified with real interactive runtime tests
49 automated headless-Chromium checks (mocked Android bridge, **no model installed**) click every control and assert state transitions — not DOM existence:
- Boot responsive, zero recursion; 40 tab switches each < 1 ms (worst 0.50 ms) and still clickable/scrollable.
- Live Talk opens with no LLM, all **12 /anime commands** dispatch, red X closes and returns to Chat (overlay fully unmounted).
- Model Hub: 6 main + supplementary cards, every filter pill, quant picker, projector checkbox, plain **Download** (no upgrade gate) streaming live progress (42 %, 440.4 / 1048.7 MB, 5.0 MB/s), Pause → Resume, Cancel.
- Settings: scrollable, n_ctx 512–32768, threads 1–8, toggles, sliders, Prompt Studio.
- Header menu / Prompt Studio / New Chat all open on the first tap.

### Install
Download `vani-ai-1.0.1-release.apk`, enable "Install unknown apps", and sideload. First launch: open Model Hub, download a model (e.g. Qwen3.5-0.8B Q4_K_M), tap **Load Model**, then chat or start Live Talk.

> **One-time uninstall required:** v1.0.0 was signed with a one-time CI key that was never persisted, so it cannot be recovered. Android therefore refuses an in-place update from v1.0.0 → v1.0.1 (signature mismatch). **Uninstall v1.0.0 once, then install v1.0.1.** Your chats/models live in app storage and are removed by the uninstall; models can be re-downloaded. From v1.0.1 onward the signing key is persisted in the repository, so **future updates install cleanly in place**. (For stronger key hygiene you may later move the key into a `KEYSTORE_BASE64` Actions secret and remove it from the tree — the workflow already prefers the secret when present.)
