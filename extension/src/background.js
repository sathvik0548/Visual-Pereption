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

const analysisCache = new Map();
let stats = {
  framesCaptured: 0,
  visionInferences: 0,
  totalLatencyMs: 0
};

console.log(`[BG] T_SW_START  t=0ms  (Service worker started)`);

// ---------------------------------------------------------------------------
// Pre-load on startup (so model is ready before user clicks anything)
// ---------------------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => ensureOffscreenDocument());
chrome.runtime.onStartup.addListener(() => ensureOffscreenDocument());

// ---------------------------------------------------------------------------
// Global Keep-Alive Handler (responds to offscreen pings)
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "OFFSCREEN_KEEPALIVE") {
    sendResponse({ ok: true });
    return true;
  }
});

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
        resolve({ domRegions: [], domHash: "" });
        return;
      }
      resolve({ domRegions: response.domRegions ?? [], domHash: response.domHash ?? "" });
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
// redactScreenshot — physically draw black boxes over sensitive regions
// ---------------------------------------------------------------------------
async function redactScreenshot(dataUrl, sensitiveRegions) {
  if (!sensitiveRegions || sensitiveRegions.length === 0) return dataUrl;

  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);
    
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    
    // Draw original image
    ctx.drawImage(bitmap, 0, 0);
    
    // Draw redaction boxes
    ctx.fillStyle = "black";
    for (const region of sensitiveRegions) {
      if (region.bbox && region.bbox.length === 4) {
        const [x, y, w, h] = region.bbox;
        ctx.fillRect(x, y, w, h);
      }
    }
    
    const outBlob = await canvas.convertToBlob({ type: "image/png" });
    const buffer = await outBlob.arrayBuffer();
    
    // Convert to base64
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const b64 = btoa(binary);
    
    return `data:image/png;base64,${b64}`;
  } catch (err) {
    console.error("[BG] Redaction failed:", err);
    return dataUrl; // fallback to original on error
  }
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
    if (message.type !== "ANALYZE_SCREEN" && message.type !== "START_DEMO_RUN") return;
    
    const isDemo = message.type === "START_DEMO_RUN";
    const instruction = message.instruction || "Analyze the current screen and detect PII";
    let shouldContinue = true;

    while (shouldContinue) {
      try {
        const t0 = performance.now();
        console.log(`[BG] T_FIRST_INFERENCE_START  t=0ms`);

        // ── 1. Capture screen ─────────────────────────────────────────────
        port.postMessage({ type: "STATUS", text: "📸 Capturing screen…" });
        const { dataUrl, tab } = await captureScreen();

        // ── 2. DOM scan ───────────────────────────────────────────────────
        port.postMessage({ type: "STATUS", text: "🔍 Scanning DOM for sensitive fields…" });
        const { domRegions, domHash } = await getDOMRegions(tab.id);
        port.postMessage({ type: "DOM_SCAN_DONE", count: domRegions.length });

        // ── 3. Vision + PII analysis (in offscreen) ───────────────────────
        stats.framesCaptured++;
        const cacheKey = tab.url + "|" + domHash;
        
        let detections, sensitiveRegions, screenshotDataUrl, elapsed;
        
        if (analysisCache.has(cacheKey)) {
          port.postMessage({ type: "STATUS", text: "⚡ DOM identical! Skipping vision inference (Cache Hit)." });
          const cached = analysisCache.get(cacheKey);
          detections = cached.detections;
          sensitiveRegions = cached.sensitiveRegions;
          screenshotDataUrl = dataUrl;
          elapsed = 0;
        } else {
          port.postMessage({
            type: "STATUS",
            text: `🧠 Running Florence-2 + BlazeFace + PII analysis…`,
          });
          
          stats.visionInferences++;
          const result = await runVisionAnalysis(dataUrl, domRegions);
          detections = result.detections;
          sensitiveRegions = result.sensitiveRegions;
          screenshotDataUrl = result.screenshotDataUrl;
          elapsed = result.elapsed;
          
          analysisCache.set(cacheKey, { detections, sensitiveRegions });
        }

        // ── 4. Log combined results ───────────────────────────────────────
        console.log(
          `[BG] Analysis complete in ${elapsed} ms.`,
          `\nVision detections: ${detections.length}`,
          `\nSensitive regions: ${sensitiveRegions.length}`,
        );

        // ── 5. Redact Image & POST to server ──────────────────────────────
        port.postMessage({ type: "STATUS", text: `🛡️ Redacting sensitive regions...` });
        const finalScreenshotDataUrl = await redactScreenshot(screenshotDataUrl, sensitiveRegions);

        const manifest = (sensitiveRegions || []).map((r, i) => ({
          region_id: `region_${i}`,
          bbox: r.bbox,
          type: r.type,
          redaction_style: "black_box",
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
          task_instruction: instruction,
          redacted_image: finalScreenshotDataUrl.split(",")[1],
          manifest,
          dom_summary,
          demo_mode: isDemo,
          client_stats: { totalLatencyMs: stats.totalLatencyMs }
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
        
        const tEnd = performance.now();
        const loopLatency = tEnd - t0;
        stats.totalLatencyMs += loopLatency;
        console.log(`[BG] T_FIRST_INFERENCE_END  elapsed=${loopLatency.toFixed(1)}ms`);

        chrome.tabs.sendMessage(tab.id, { type: "UPDATE_STATS", payload: stats }, () => {
          // ignore errors if content script closed
          chrome.runtime.lastError;
        });

        // ── Loop check for Demo mode ─────────────────────────────────────
        if (isDemo && serverResult && serverResult.action !== "done" && executionStatus.ok) {
          port.postMessage({ type: "STATUS", text: "🔄 Demo Mode: Waiting 1s before next cycle..." });
          await new Promise(r => setTimeout(r, 1000));
        } else {
          shouldContinue = false;
        }

      } catch (err) {
        console.error("[BG] Analysis failed:", err);
        port.postMessage({ type: "ERROR", error: err.message });
        shouldContinue = false;
      }
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
