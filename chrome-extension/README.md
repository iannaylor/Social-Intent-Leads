# Social Intent Comment Queue — Chrome extension

Side-panel Chrome extension that pairs with the backend in the parent
directory. See `../SETUP.md` for full setup instructions (backend deploy
+ loading this extension + first-run configuration).

Quick version:

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
2. Click the extension icon on any `linkedin.com` page to open the side panel.
3. Open **Settings** (gear icon) and fill in **Your name** (exactly as it appears on LinkedIn — required before reply-detection or notification-scanning will do anything), plus the backend URL and your API key.

No secrets are baked into this code — the backend URL and API key are
entered per-install via Settings and stored in `chrome.storage.local`.
