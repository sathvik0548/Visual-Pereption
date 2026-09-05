# Privacy-Preserving Browser Agent — Hackathon Prototype

> **v0.2** — adds local visual perception via Florence-2 (WebGPU / WASM).

A two-part scaffold: a **Chrome/Firefox extension** that captures the active tab screenshot and a **local Node.js server** that will eventually call a Vision-Language Model (VLM) to decide what action to take next.

```
Visual Perception/
├── README.md
├── extension/
│   ├── manifest.json            ← MV3 + offscreen + HF host perms + wasm-unsafe-eval CSP
│   ├── src/
│   │   ├── vision.js            ← Florence-2: WebGPU/WASM detection, loadModel, analyzeImage
│   │   ├── background.js        ← captureScreen, offscreen lifecycle, port handler
│   │   ├── offscreen.js         ← model warm-start, RUN_INFERENCE handler
│   │   └── popup.js             ← port client, canvas overlay renderer
│   ├── background.js            ← ⬆ BUILT from src/ (do not edit directly)
│   ├── offscreen.js             ← ⬆ BUILT
│   ├── popup.js                 ← ⬆ BUILT
│   ├── offscreen.html           ← hidden page that hosts Florence-2 model
│   ├── popup.html               ← popup UI with debug canvas
│   ├── content.js               ← injected into all pages (DOM action stub)
│   ├── wasm/                    ← ONNX Runtime WASM files (copied by build)
│   ├── build.js                 ← esbuild bundler script
│   └── package.json             ← @huggingface/transformers + esbuild
└── server/
    ├── package.json
    └── server.js                ← POST /analyze stub + VLM TODO block
```

---

## 1 · Build the Extension (required for v0.2)

The extension now bundles `@huggingface/transformers` (Florence-2) via esbuild.
**Run once** before loading the extension, and after any source changes:

```bash
cd extension
npm install       # install @huggingface/transformers + esbuild
npm run build     # bundle src/ → root JS files, copy ONNX RT WASM to wasm/
```

Expected output:
```
[Build] Copied 30 ONNX RT files → wasm/
  offscreen.js    6.3mb
  background.js  14.8kb
  popup.js       14.1kb
⚡ Done in ~100ms
```

> **Tip:** `npm run watch` rebuilds automatically whenever you edit `src/`.

---

## 2 · Start the Server

```bash
cd server && npm start
```

---

## 3 · Load the Extension in Chrome



```bash
cd server
npm install          # installs express + cors
npm start            # node server.js
# or for auto-reload:
npm run dev          # nodemon server.js
```

You should see:

```
🚀  Browser Agent Server running on http://localhost:3000
    POST http://localhost:3000/analyze
    GET  http://localhost:3000/health
```

Verify it's alive:

```bash
curl http://localhost:3000/health
# → {"status":"ok"}
```

---

## 2 · Load the Extension in Chrome

1. Open Chrome and go to **`chrome://extensions`**
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **"Load unpacked"**
4. Select the **`extension/`** folder (the one containing `manifest.json`)
5. The "Browser Agent" extension will appear in the list

> **Tip:** Pin it to the toolbar by clicking the puzzle-piece icon → pin "Browser Agent".

---

## 3 · Try It Out

1. Make sure the server is running (`npm start` in `/server`)
2. Navigate to any webpage in Chrome
3. Click the **Browser Agent** extension icon → popup opens
4. Click **"Analyze Screen"**
5. The popup will show:  
   `✅ Action: "click"  |  Target: "placeholder"`
6. Open the **background service worker console** for full logs:  
   `chrome://extensions` → "Browser Agent" → **"Service worker"** → Inspect

---

## 4 · Firefox Compatibility Notes

Manifest V3 support in Firefox is partial (as of mid-2025):

| Feature | Chrome | Firefox |
|---|---|---|
| `service_worker` background | ✅ | ✅ (v109+) |
| `tabs.captureVisibleTab` | ✅ | ✅ |
| `scripting` permission | ✅ | ✅ (v101+) |
| MV3 `action` API | ✅ | ✅ |

To load in Firefox:
1. Go to **`about:debugging`** → "This Firefox"
2. Click **"Load Temporary Add-on…"**
3. Select `extension/manifest.json`

---

## 5 · Data Flow

```
[Popup click]
    │
    ▼
popup.js  ──── chrome.runtime.sendMessage({type:"ANALYZE_SCREEN"}) ────►
                                                                    background.js
                                                              (service worker)
                                                                    │
                                                    chrome.tabs.captureVisibleTab()
                                                                    │
                                                          base64 PNG screenshot
                                                                    │
                                                          POST /analyze → localhost:3000
                                                                    │
                                                              server.js
                                                      (stub → future VLM call)
                                                                    │
                                                     { action, target_id } response
                                                                    │
                                                              background.js logs it
                                                                    │
                                                          sendResponse back to popup
                                                                    │
                                                              popup.js displays result
```

---

## 6 · Next Steps (VLM Integration)

The `server.js` file contains a `TODO` block with two integration paths:

- **Local / private**: [Ollama](https://ollama.ai/) + LLaVA (`ollama pull llava`)
- **Cloud fallback**: OpenAI GPT-4o Vision API

Swap out the stub response in `POST /analyze` with a real VLM call, parse the model's output into `{ action, target_id }`, and the rest of the pipeline already works end-to-end.

---

## 7 · Permissions Rationale

| Permission | Why |
|---|---|
| `activeTab` | Required to identify which tab is being analyzed |
| `scripting` | Future: inject action scripts without declaring content scripts statically |
| `tabs` | Required by `captureVisibleTab` |
| `host_permissions: localhost:3000` | Required for `fetch()` from a service worker to a local server |
