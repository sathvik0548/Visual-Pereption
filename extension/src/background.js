/**
 * background.js — Service Worker  (src/background.js → built background.js)
 *
 * v0.2 additions:
 *   - getDOMRegions(tabId)   — sends SCAN_DOM to content script, returns domRegions[]
 *   - Passes domRegions to offscreen alongside the screenshot
 *   - Relays { detections, sensitiveRegions } back to popup via port
 */

const SERVER_URL    = "http://localhost:3000/analyze";
const OFFSCREEN_URL = chrome.runtime.getURL("offscreen.html");

// ---------------------------------------------------------------------------
// captureScreen — capture the active tab's visible area as a data URL
// ---------------------------------------------------------------------------
export async function captureScreen() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab) throw new Error("No active tab found.");

  const dataUrl = await chrome.tabs.captureVisibleTab(activeTab.windowId, { format: "png" });
  return { dataUrl, tab: activeTab };
}

// ---------------------------------------------------------------------------
// getDOMRegions — ask the content script to scan the page's sensitive fields
// ---------------------------------------------------------------------------
async function getDOMRegions(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "SCAN_DOM" }, (response) => {
      if (chrome.runtime.lastError || !response) {
        // Content script not injected (e.g. on chrome:// pages) — not an error
        console.warn("[BG] DOM scan skipped:", chrome.runtime.lastError?.message ?? "no response");
        resolve([]);
        return;
      }
      const regions = response.domRegions ?? [];
      console.log(`[BG] DOM scan: ${regions.length} sensitive field(s).`);
      resolve(regions);
    });
  });
}

// ---------------------------------------------------------------------------
// ensureOffscreenDocument — create if not already open (max 1 per extension)
// ---------------------------------------------------------------------------
async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [OFFSCREEN_URL],
  });
  if (existing.length > 0) return;

  await chrome.offscreen.createDocument({
    url:           "offscreen.html",
    reasons:       ["WORKERS"],
    justification: "Run Florence-2 + BlazeFace inference for visual PII detection.",
  });
  console.log("[BG] Offscreen document created.");
}

// ---------------------------------------------------------------------------
// runVisionAnalysis — sends screenshot + domRegions to offscreen
// ---------------------------------------------------------------------------
async function runVisionAnalysis(screenshotDataUrl, domRegions) {
  await ensureOffscreenDocument();

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: "RUN_INFERENCE", payload: { screenshotDataUrl, domRegions } },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.success) {
          reject(new Error(response?.error ?? "Unknown inference error"));
          return;
        }
        resolve(response);
      }
    );
  });
}

// ---------------------------------------------------------------------------
// sendToServer — POST result to the local Express server (best-effort)
// ---------------------------------------------------------------------------
async function sendToServer(payload) {
  console.log("[BG] Sending to server:", SERVER_URL);
  try {
    const res  = await fetch(SERVER_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
    });
    const data = await res.json();
    console.log("[BG] Server response:", data);
    return data;
  } catch (err) {
    console.error("[BG] Server unreachable:", err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Port-based handler — keeps the service worker alive during long inference
// ---------------------------------------------------------------------------
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "analyze") return;

  port.onMessage.addListener(async (message) => {
    if (message.type !== "ANALYZE_SCREEN") return;

    try {
      // ── 1. Capture screen ─────────────────────────────────────────────
      port.postMessage({ type: "STATUS", text: "📸 Capturing screen…" });
      const { dataUrl, tab } = await captureScreen();

      // ── 2. DOM scan ───────────────────────────────────────────────────
      port.postMessage({ type: "STATUS", text: "🔍 Scanning DOM for sensitive fields…" });
      const domRegions = await getDOMRegions(tab.id);
      port.postMessage({ type: "DOM_SCAN_DONE", count: domRegions.length });

      // ── 3. Vision + PII analysis (in offscreen) ───────────────────────
      port.postMessage({
        type: "STATUS",
        text: `🧠 Running Florence-2 + BlazeFace + PII analysis…`,
      });

      const {
        detections,
        sensitiveRegions,
        screenshotDataUrl,
        elapsed,
      } = await runVisionAnalysis(dataUrl, domRegions);

      // ── 4. Log combined results ───────────────────────────────────────
      console.log(
        `[BG] Analysis complete in ${elapsed} ms.`,
        `\nVision detections: ${detections.length}`,
        `\nSensitive regions: ${sensitiveRegions.length}`,
      );

      // ── 5. POST to server (optional, best-effort) ─────────────────────
      const manifest = (sensitiveRegions || []).map((r, i) => ({
        region_id: `region_${i}`,
        bbox: r.bbox,
        type: r.type,
        redaction_style: "black_box", // Placeholder until physical redaction is fully implemented
        confidence: r.confidence
      }));

      const dom_summary = (domRegions || []).map((r, i) => ({
        element_id: `elem_${i}`,
        tag: "input", 
        role: "textbox",
        bbox: r.bbox
      }));

      const agentRequestPayload = {
        version: "1.0",
        task_instruction: "Analyze the current screen and detect PII", // Default placeholder task
        redacted_image: dataUrl.split(",")[1], // Using raw screenshot until physical redaction is implemented
        manifest,
        dom_summary
      };

      const serverResult = await sendToServer(agentRequestPayload);

      // ── 5b. Forward Action to Content Script ────────────────────────
      let executionStatus = { ok: true, message: "No action returned" };
      if (serverResult && serverResult.action && serverResult.action !== "done") {
        port.postMessage({ type: "STATUS", text: `⚡ Executing action: ${serverResult.action} on ${serverResult.target_id}...` });
        
        executionStatus = await new Promise(resolve => {
          chrome.tabs.sendMessage(tab.id, { type: "EXECUTE_ACTION", payload: serverResult }, response => {
            if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
            else resolve(response || { ok: false, error: "No response from content script" });
          });
        });
        console.log("[BG] Execution status:", executionStatus);
      }

      // ── 6. Send everything to popup ───────────────────────────────────
      port.postMessage({
        type: "ANALYSIS_RESULT",
        detections,
        sensitiveRegions,
        screenshotDataUrl,
        elapsed,
        serverResult,
      });
    } catch (err) {
      console.error("[BG] Analysis failed:", err);
      port.postMessage({ type: "ERROR", error: err.message });
    }
  });

  // Forward MODEL_PROGRESS / MODEL_READY / MODEL_ERROR from offscreen to popup
  const relay = (msg) => {
    if (["MODEL_PROGRESS", "MODEL_READY", "MODEL_ERROR"].includes(msg.type)) {
      port.postMessage(msg);
    }
  };
  chrome.runtime.onMessage.addListener(relay);
  port.onDisconnect.addListener(() => chrome.runtime.onMessage.removeListener(relay));
});

console.log("[BG] Service worker started (v0.2 — PII detection).");
