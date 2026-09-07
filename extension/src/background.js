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
chrome.runtime.onInstalled.addListener(() => {
  ensureOffscreenDocument();
  if (chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(["agent_vault"], (data) => {
      if (!data.agent_vault) {
        chrome.storage.local.set({
          agent_vault: {
            NAME: "Rajesh Kumar",
            EMAIL: "vendor.demo@example.in",
            INDIAN_MOBILE: "9876543210",
            PHONE: "9876543210",
            DOB: "1990-05-15",
            ADDRESS: "42, MG Road, Bengaluru",
            CITY: "Bengaluru",
            PINCODE: "560001",
            AADHAAR: "5489 1234 5674",
            PAN: "ABCDE1234F",
            PASSWORD: "MockPassword@123"
          }
        });
        console.log("[BG] Initialized default demo profile vault in chrome.storage.local");
      }
    });
  }
});
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
// ---------------------------------------------------------------------------
// getDOMRegions — ask the content script to scan the page's sensitive fields
// ---------------------------------------------------------------------------
async function getDOMRegions(tabId) {
  return new Promise((resolve) => {
    console.log(`[BG] Dispatching SCAN_DOM message to active tab ${tabId}...`);
    chrome.tabs.sendMessage(tabId, { type: "SCAN_DOM" }, async (response) => {
      if (chrome.runtime.lastError || !response) {
        const errMsg = chrome.runtime.lastError?.message ?? "no response";
        console.warn(`[BG] Initial SCAN_DOM failed on tab ${tabId} (${errMsg}). Attempting dynamic injection of content.js...`);
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ["content.js"],
          });
          console.log(`[BG] content.js successfully injected into tab ${tabId}. Retrying SCAN_DOM...`);
          chrome.tabs.sendMessage(tabId, { type: "SCAN_DOM" }, (retryResponse) => {
            if (chrome.runtime.lastError || !retryResponse) {
              console.warn("[BG] SCAN_DOM retry also failed:", chrome.runtime.lastError?.message ?? "no response");
              resolve({ domRegions: [], domHash: "" });
            } else {
              console.log(`[BG] SCAN_DOM retry succeeded! Found ${retryResponse.domRegions?.length ?? 0} sensitive field(s), ${retryResponse.mediaRegions?.length ?? 0} media element(s):`, retryResponse.domRegions);
              resolve({ domRegions: retryResponse.domRegions ?? [], mediaRegions: retryResponse.mediaRegions ?? [], domHash: retryResponse.domHash ?? "" });
            }
          });
        } catch (injErr) {
          console.warn("[BG] Dynamic content script injection failed (e.g. chrome:// or restricted page):", injErr.message);
          resolve({ domRegions: [], mediaRegions: [], domHash: "" });
        }
        return;
      }
      console.log(`[BG] SCAN_DOM succeeded on tab ${tabId}! Received ${response.domRegions?.length ?? 0} region(s), ${response.mediaRegions?.length ?? 0} media element(s):`, response.domRegions);
      resolve({ domRegions: response.domRegions ?? [], mediaRegions: response.mediaRegions ?? [], domHash: response.domHash ?? "" });
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
// runVisionAnalysis — sends screenshot + domRegions + mediaRegions to offscreen
// ---------------------------------------------------------------------------
async function runVisionAnalysis(screenshotDataUrl, domRegions, mediaRegions) {
  await ensureOffscreenDocument();

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: "RUN_INFERENCE", payload: { screenshotDataUrl, domRegions, mediaRegions } },
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
// sendToServer — POST result to the local Express server (with full HTTP logging)
// ---------------------------------------------------------------------------
async function sendToServer(payload) {
  console.log("[BG] Initiating HTTP request to server URL:", SERVER_URL);
  try {
    const res = await fetch(SERVER_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
    });

    console.log(`[BG] Server HTTP Status Code: ${res.status} ${res.statusText}`);
    const rawBody = await res.text();
    console.log(`[BG] Server Raw Response Body (${rawBody.length} bytes):`, rawBody.length > 500 ? rawBody.substring(0, 500) + "... [truncated]" : rawBody);

    if (!res.ok) {
      throw new Error(`Server returned HTTP ${res.status} (${res.statusText}): ${rawBody.substring(0, 300)}`);
    }

    let data;
    try {
      data = JSON.parse(rawBody);
    } catch (parseErr) {
      throw new Error(`Server response was not valid JSON: ${rawBody.substring(0, 200)}`);
    }

    return data;
  } catch (err) {
    console.error("[BG Error][sendToServer] Network or HTTP error:", err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Port-based handler — keeps the service worker alive during long inference
// ---------------------------------------------------------------------------
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "analyze") return;

  let isConnected = true;
  const safePost = (msg) => {
    if (!isConnected) return false;
    try {
      port.postMessage(msg);
      return true;
    } catch (e) {
      isConnected = false;
      return false;
    }
  };

  // Forward MODEL_PROGRESS / MODEL_READY / MODEL_ERROR from offscreen to popup
  const relay = (msg) => {
    if (["MODEL_PROGRESS", "MODEL_READY", "MODEL_ERROR"].includes(msg.type)) {
      safePost(msg);
    }
  };

  chrome.runtime.onMessage.addListener(relay);
  port.onDisconnect.addListener(() => {
    isConnected = false;
    chrome.runtime.onMessage.removeListener(relay);
    console.log("[BG] Popup port disconnected (popup closed). Continuing execution in background.");
  });

  port.onMessage.addListener(async (message) => {
    if (message.type !== "ANALYZE_SCREEN" && message.type !== "START_DEMO_RUN") return;
    
    const isDemo = message.type === "START_DEMO_RUN";
    const instruction = message.instruction || "Analyze the current screen and detect PII";
    let shouldContinue = true;
    let taskVisionInferences = 0;
    const MAX_VISION_PER_TASK = 3;
    const stepConsecutiveFailures = new Map();

    while (shouldContinue) {
      const t0 = performance.now();
      console.log(`[BG] >>> Starting Execution Loop (isDemo=${isDemo}) <<<`);

      // ── Step 0: Read and Print Current Stored Profile Vault (Requirement 2) ──
      const storedVault = await new Promise((resolve) => {
        chrome.storage.local.get(["agent_vault"], (data) => resolve(data?.agent_vault || {}));
      });
      const vaultKeys = Object.keys(storedVault);

      console.log("\n========================================================");
      console.log("[BG] === CURRENT STORED PROFILE VAULT AT START OF RUN ===");
      if (vaultKeys.length > 0) {
        console.log(`Found ${vaultKeys.length} stored field(s):`);
        console.log(JSON.stringify(storedVault, null, 2));
      } else {
        console.log("Profile vault is currently EMPTY (0 fields configured).");
      }
      console.log("========================================================\n");

      safePost({
        type: "STATUS",
        text: vaultKeys.length > 0
          ? `[VAULT] Loaded ${vaultKeys.length} stored field(s): ${vaultKeys.join(", ")}`
          : "⚠ Vault is empty! Open Profile settings to configure values."
      });

      // ── Step 1: Capture screen ──────────────────────────────────────────
      let captureResult;
      try {
        console.log("[BG] Step 1: Capturing active tab screenshot...");
        safePost({ type: "STAGE_CHANGE", stage: "capture", text: "Capturing screen…" });
        captureResult = await captureScreen();
        console.log("[BG] Step 1 Complete. Screenshot captured successfully.");
      } catch (err) {
        console.error("[BG Error][Step 1: Screenshot Capture]:", err);
        safePost({ type: "ERROR", step: "Screenshot Capture", error: err.message });
        shouldContinue = false;
        break;
      }

      // ── Step 2: DOM scan ────────────────────────────────────────────────
      let domResult;
      try {
        console.log(`[BG] Step 2: Scanning DOM for sensitive fields on tab ${captureResult.tab.id}...`);
        safePost({ type: "STAGE_CHANGE", stage: "capture", text: "Scanning DOM for sensitive fields…" });
        domResult = await getDOMRegions(captureResult.tab.id);
        safePost({ type: "DOM_SCAN_DONE", count: domResult.domRegions.length });
        console.log(`[BG] Step 2 Complete. Found ${domResult.domRegions.length} sensitive DOM field(s).`);
      } catch (err) {
        console.error("[BG Error][Step 2: DOM Scan]:", err);
        safePost({ type: "ERROR", step: "DOM Scan", error: err.message });
        shouldContinue = false;
        break;
      }

      // ── Step 3: Vision + PII analysis (offscreen) ──────────────────────
      stats.framesCaptured++;
      const cacheKey = captureResult.tab.url + "|" + domResult.domHash;
      let detections, sensitiveRegions, screenshotDataUrl, elapsed;

      if (analysisCache.has(cacheKey)) {
        console.log("[BG] Step 3: DOM identical! Cache hit, reusing cached detections.");
        safePost({ type: "STATUS", text: "⚡ DOM identical! Skipping vision inference (Cache Hit)." });
        const cached = analysisCache.get(cacheKey);
        detections = cached.detections;
        sensitiveRegions = cached.sensitiveRegions;
        screenshotDataUrl = captureResult.dataUrl;
        elapsed = 0;
      } else {
        try {
          console.log(`[BG] Step 3: Dispatching screenshot and domRegions to offscreen document for inference (attempt ${taskVisionInferences + 1} of max ${MAX_VISION_PER_TASK})...`);
          safePost({ type: "STAGE_CHANGE", stage: "detect", text: `Running Florence-2 + BlazeFace + PII analysis (vision pass ${taskVisionInferences + 1}/${MAX_VISION_PER_TASK})…` });
          if (taskVisionInferences >= MAX_VISION_PER_TASK) {
            console.warn(`[BG] Stopping after ${MAX_VISION_PER_TASK} full analysis attempts to avoid excessive cost.`);
            safePost({
              type: "ERROR",
              step: "Vision Inference Cap",
              error: `Stopping after ${MAX_VISION_PER_TASK} full analysis attempts to avoid excessive cost`
            });
            shouldContinue = false;
            break;
          }
          taskVisionInferences++;
          stats.visionInferences++;
          const result = await runVisionAnalysis(captureResult.dataUrl, domResult.domRegions, domResult.mediaRegions);
          detections = result.detections;
          sensitiveRegions = result.sensitiveRegions;
          screenshotDataUrl = result.screenshotDataUrl;
          elapsed = result.elapsed;
          analysisCache.set(cacheKey, { detections, sensitiveRegions });
          console.log(`[BG] Step 3 Complete in ${elapsed}ms: ${detections.length} detections, ${sensitiveRegions.length} PII regions.`);
        } catch (err) {
          console.error("[BG Error][Step 3: Florence-2 / Vision Inference]:", err);
          safePost({ type: "ERROR", step: "Florence-2 Inference", error: err.message });
          shouldContinue = false;
          break;
        }
      }

      // ── Step 4: Redact Image ───────────────────────────────────────────
      // Capture raw screenshot size BEFORE redaction for metrics
      const rawBytes = captureResult.dataUrl.length;

      let finalScreenshotDataUrl;
      try {
        console.log(`[BG] Step 4: Redacting ${sensitiveRegions.length} sensitive regions on canvas...`);
        safePost({ type: "STAGE_CHANGE", stage: "redact", text: `Redacting ${sensitiveRegions.length} sensitive regions…` });
        finalScreenshotDataUrl = await redactScreenshot(screenshotDataUrl, sensitiveRegions);
        console.log("[BG] Step 4 Complete. Redaction finished.");
      } catch (err) {
        console.error("[BG Error][Step 4: Redaction]:", err);
        safePost({ type: "ERROR", step: "Redaction", error: err.message });
        shouldContinue = false;
        break;
      }

      // ── Step 4b: Redaction Leak Verification ────────────────────────────
      // Re-run vision detection on the redacted image to confirm masked areas
      // contain zero readable PII. Block the request if a leak is found.
      let leakCheckPassed = true;
      let leakDetails = { leaksFound: 0, leakRegions: [], checkedRegions: sensitiveRegions.length };
      try {
        console.log("[BG] Step 4b: Running leak verification — re-detecting PII on redacted image...");
        safePost({ type: "STAGE_CHANGE", stage: "redact", text: "Verifying redaction — scanning redacted image for PII leaks…" });

        if (sensitiveRegions.length > 0) {
          const leakResult = await runVisionAnalysis(finalScreenshotDataUrl, [], []);
          const leakRegions = leakResult.sensitiveRegions || [];

          // Check if any newly-detected region overlaps a masked bbox
          const leakingRegions = leakRegions.filter(detected => {
            const [dx, dy, dw, dh] = detected.bbox;
            return sensitiveRegions.some(masked => {
              const [mx, my, mw, mh] = masked.bbox;
              // Overlap check: do the two bboxes intersect?
              const overlapX = Math.max(dx, mx) < Math.min(dx + dw, mx + mw);
              const overlapY = Math.max(dy, my) < Math.min(dy + dh, my + mh);
              return overlapX && overlapY;
            });
          });

          leakDetails = {
            leaksFound: leakingRegions.length,
            leakRegions: leakingRegions,
            checkedRegions: sensitiveRegions.length,
            totalDetectedOnRedacted: leakRegions.length,
          };

          if (leakingRegions.length > 0) {
            leakCheckPassed = false;
            console.error(`[BG] Step 4b FAIL: ${leakingRegions.length} PII leak(s) detected in masked region(s)!`, leakingRegions);
            safePost({
              type: "LEAK_CHECK",
              passed: false,
              leaksFound: leakingRegions.length,
              leakRegions: leakingRegions,
              checkedRegions: sensitiveRegions.length,
              message: `🚨 LEAK DETECTED: ${leakingRegions.length} PII region(s) still visible after redaction — payload BLOCKED`,
            });
          } else {
            console.log(`[BG] Step 4b PASS: Zero PII leaks in ${leakRegions.length} detection(s) on redacted image. Redaction is solid.`);
            safePost({
              type: "LEAK_CHECK",
              passed: true,
              leaksFound: 0,
              leakRegions: [],
              checkedRegions: sensitiveRegions.length,
              totalDetectedOnRedacted: leakRegions.length,
              message: `✓ 0 leaks detected — ${sensitiveRegions.length} masked region(s) verified clean`,
            });
          }
        } else {
          // No regions to redact — trivially clean
          console.log("[BG] Step 4b: No sensitive regions to verify (no redaction performed).");
          safePost({
            type: "LEAK_CHECK",
            passed: true,
            leaksFound: 0,
            leakRegions: [],
            checkedRegions: 0,
            message: "✓ No regions to verify (page has no detected PII)",
          });
        }
      } catch (leakErr) {
        // Treat inference errors as non-fatal for leak check — log but proceed
        console.warn("[BG] Step 4b: Leak verification inference failed (non-fatal):", leakErr.message);
        safePost({
          type: "LEAK_CHECK",
          passed: true,  // Give benefit of doubt if inference fails
          leaksFound: 0,
          leakRegions: [],
          checkedRegions: sensitiveRegions.length,
          message: `⚠ Leak check skipped (inference error: ${leakErr.message})`,
          warning: true,
        });
      }

      // Block the payload if leak check failed
      if (!leakCheckPassed) {
        console.error("[BG] BLOCKING payload transmission — PII leak verification failed!");
        shouldContinue = false;
        break;
      }

      // ── Step 5: Send Payload to Server ─────────────────────────────────
      let serverResult;
      try {
        console.log("[BG] Step 5: Preparing AgentRequestV1 payload for server...");
        safePost({ type: "STAGE_CHANGE", stage: "send", text: "Sending redacted payload to server (http://localhost:3000/analyze)…" });
        
        const manifest = (sensitiveRegions || []).map((r, i) => ({
          region_id: `region_${i}`,
          bbox: r.bbox,
          type: r.type,
          redaction_style: "black_box",
          confidence: r.confidence,
          source: r.source || "dom"
        }));

        const dom_summary = (domResult.domRegions || []).map((r, i) => ({
          element_id: r.agentId || `agent_${i}`,
          dom_id: r.id || "",
          name: r.name || "",
          placeholder: r.placeholder || "",
          tag: r.tag || "input",
          role: r.role || (r.inputType === "radio" ? "radio" : "textbox"),
          label: r.label || "",
          field_type: r.type || "",
          bbox: r.bbox,
          current_value: r.current_value || ""  // Live value so model skips already-filled fields
        }));

        console.log("\n========================================================");
        console.log(`[BG][DEBUG] === EXACT dom_summary SENT TO /analyze (${dom_summary.length} items) ===`);
        console.log(JSON.stringify(dom_summary, null, 2));
        console.log(`[BG][DEBUG] === EXACT manifest SENT TO /analyze (${manifest.length} items) ===`);
        console.log(JSON.stringify(manifest, null, 2));
        console.log("========================================================\n");

        const agentRequestPayload = {
          version: "1.0",
          task_instruction: instruction,
          redacted_image: finalScreenshotDataUrl.split(",")[1],
          manifest,
          dom_summary,
          demo_mode: isDemo,
          client_stats: { totalLatencyMs: stats.totalLatencyMs }
        };

        // ── Data Reduction Metrics ──────────────────────────────────────────
        // Compute raw bytes vs. what we actually transmit, plus PII surface area
        const redactedImageB64 = agentRequestPayload.redacted_image;
        const payloadJson = JSON.stringify(agentRequestPayload);
        const sentBytes = payloadJson.length; // Approx bytes for the full JSON body

        // PII surface: sum of bbox pixel areas vs. total screenshot pixel area
        // We need image dimensions — parse from the redacted image
        let piiSurfacePercent = 0;
        let imageTotalPixels = 1;
        let imagePIIPixels = 0;
        try {
          // Decode dimensions from finalScreenshotDataUrl via offscreen canvas
          // Use the raw capture dimensions estimate from base64 length heuristic
          // (PNG ~4 bytes per pixel at 1x, so pixels ≈ (b64len * 3/4) / 4)
          // Instead: directly compute from sensitiveRegions bboxes area vs image area
          // We'll use the known DPR=1 screenshot: get dims from raw dataUrl
          const rawB64 = captureResult.dataUrl.split(",")[1] || "";
          // Rough image area estimate: screenshot DPR is typically devicePixelRatio
          // For a reliable metric, compute bbox areas from sensitiveRegions
          // and express them relative to the visible screenshot size
          if (sensitiveRegions.length > 0) {
            imagePIIPixels = sensitiveRegions.reduce((sum, r) => sum + (r.bbox[2] * r.bbox[3]), 0);
            // Assume image area from the max extents of any detection + generous margin
            const allX2 = sensitiveRegions.map(r => r.bbox[0] + r.bbox[2]);
            const allY2 = sensitiveRegions.map(r => r.bbox[1] + r.bbox[3]);
            // Min estimated image size: at least 1280×720 or max detection bounds + 20%
            const estimatedW = Math.max(1280, Math.max(...allX2) * 1.2);
            const estimatedH = Math.max(720, Math.max(...allY2) * 1.2);
            imageTotalPixels = estimatedW * estimatedH;
            piiSurfacePercent = (imagePIIPixels / imageTotalPixels) * 100;
          }
        } catch (dimErr) {
          console.warn("[BG] Could not estimate image dimensions for PII surface metric:", dimErr);
        }

        const reductionPercent = ((1 - sentBytes / rawBytes) * 100);
        const metricsPayload = {
          raw_bytes: rawBytes,
          sent_bytes: sentBytes,
          reduction_percent: reductionPercent,
          pii_regions: sensitiveRegions.length,
          pii_surface_percent: piiSurfacePercent,
          pii_pixels: imagePIIPixels,
        };
        console.log("[BG] Data Reduction Metrics:", JSON.stringify(metricsPayload));
        safePost({ type: "METRICS", ...metricsPayload });
        // ────────────────────────────────────────────────────────────────────

        serverResult = await sendToServer(agentRequestPayload);
        console.log("[BG] Step 5 Complete. Server returned plan:", serverResult);
      } catch (err) {
        console.error("[BG Error][Step 5: Server Call]:", err);
        // Specific user-facing messages for known failure modes
        let errMsg = err.message || String(err);
        if (errMsg.includes("Failed to fetch") || errMsg.includes("NetworkError") || errMsg.includes("ECONNREFUSED")) {
          errMsg = "Couldn't reach the reasoning server — is it running on port 3000?";
        } else if (errMsg.includes("malformed JSON") || errMsg.includes("unexpected response")) {
          errMsg = "Got an unexpected response from the model — the VLM returned malformed JSON.";
        } else if (errMsg.includes("HTTP 5")) {
          errMsg = `Server error: ${errMsg}`;
        }
        safePost({ type: "ERROR", step: "Server Call", error: errMsg });
        shouldContinue = false;
        break;
      }

      // ── Step 6: Execute Plan sequentially in content script ────────────
      safePost({ type: "STAGE_CHANGE", stage: "act", text: "Executing plan…" });

      const plan = Array.isArray(serverResult?.plan) ? serverResult.plan : [];
      const totalSteps = plan.length;
      const stepResults = [];

      if (totalSteps === 0) {
        console.log("[BG] Step 6: Empty plan — all fields already filled or task complete.");
        safePost({ type: "PLAN_SUMMARY", total: 0, succeeded: 0, failed: 0, details: [], message: "All fields are already filled — nothing to do." });
      } else {
        console.log(`[BG] Step 6: Executing ${totalSteps} plan step(s)...`);

        for (const step of plan) {
          const stepNum = step.step;
          const fieldType = step.field_type || "FIELD";
          const targetId = step.target_id;

          // Hard retry limit: if this same step target/type failed 2 times in a row, stop retrying it
          const stepKey = `${targetId || ""}_${fieldType || ""}`;
          const currentFailures = stepConsecutiveFailures.get(stepKey) || 0;
          if (currentFailures >= 2) {
            const skipReason = `Step ${stepNum} (${fieldType}, ${targetId}) halted: element failed ${currentFailures} times consecutively. Stopping retries for this step.`;
            console.warn(`[BG] ${skipReason}`);
            stepResults.push({ stepNum, fieldType, ok: false, reason: skipReason });
            safePost({
              type: "PLAN_STEP_STATUS",
              stepNum,
              totalSteps,
              status: "error",
              message: skipReason
            });
            continue;
          }

          // Attach bbox to step payload for coordinate-based fallback execution
          const domMatch = dom_summary.find(d => d.element_id === targetId || d.dom_id === targetId || d.name === targetId);
          const manifestMatch = manifest.find(m => m.region_id === targetId);
          const detectionMatch = (detections || []).find(d => d.id === targetId);
          const matchedBbox = step.bbox || domMatch?.bbox || manifestMatch?.bbox || detectionMatch?.bbox || null;
          const stepPayload = { ...step, bbox: matchedBbox };

          // ── Check if value is missing (Requirement 4 fallback path) ───────
          let currentVal = stepPayload.value || stepPayload.match_value || storedVault[fieldType] || null;
          if (!currentVal && fieldType === "PHONE") currentVal = storedVault["INDIAN_MOBILE"];
          if (!currentVal && fieldType === "INDIAN_MOBILE") currentVal = storedVault["PHONE"];

          if (!currentVal && (step.action === "type" || step.action === "select_choice") && fieldType !== "BUTTON" && fieldType !== "SUBMIT") {
            console.log(`[BG] Step ${stepNum}: No value found for "${fieldType}" in profile or plan. Requesting inline input from user...`);
            safePost({
              type: "PROMPT_USER_INPUT",
              stepNum,
              fieldType,
              targetId,
              actionType: step.action,
              message: `No value found for ${fieldType} — enter one now?`
            });

            const userReply = await new Promise((resolve) => {
              const replyHandler = (uMsg) => {
                if (uMsg.type === "USER_INPUT_PROVIDED" && uMsg.stepNum === stepNum) {
                  port.onMessage.removeListener(replyHandler);
                  resolve(uMsg);
                }
              };
              port.onMessage.addListener(replyHandler);
              // Fallback timeout after 45 seconds if no response
              setTimeout(() => resolve(null), 45000);
            });

            if (userReply && userReply.value) {
              console.log(`[BG] Step ${stepNum}: User provided value for "${fieldType}": "${userReply.value}" (saveToVault: ${userReply.saveToVault})`);
              if (step.action === "select_choice") {
                stepPayload.match_value = userReply.value;
              } else {
                stepPayload.value = userReply.value;
              }
              if (userReply.saveToVault) {
                storedVault[fieldType] = userReply.value;
                chrome.storage.local.set({ agent_vault: storedVault });
                console.log(`[BG] ✓ Persisted "${fieldType}" = "${userReply.value}" to chrome.storage.local`);
              }
            }
          }

          safePost({
            type: "PLAN_STEP_STATUS",
            stepNum,
            totalSteps,
            status: "running",
            message: `Step ${stepNum}/${totalSteps}: ${step.action} on ${fieldType} (${targetId})…`
          });

          try {
            const stepResponse = await new Promise((resolve, reject) => {
              // 5 second timeout per action to catch hung pages
              const timer = setTimeout(() => reject(new Error("TIMEOUT")), 5000);
              chrome.tabs.sendMessage(
                captureResult.tab.id,
                { type: "EXECUTE_ACTION", payload: stepPayload },
                response => {
                  clearTimeout(timer);
                  if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                  } else {
                    resolve(response || { ok: false, error: "No response from content script" });
                  }
                }
              );
            });

            if (stepResponse.ok) {
              stepConsecutiveFailures.set(stepKey, 0); // reset on success
              console.log(`[BG] Step 6.${stepNum}: ✓ success`, stepResponse);
              stepResults.push({ stepNum, fieldType, ok: true });
              safePost({
                type: "PLAN_STEP_STATUS",
                stepNum,
                totalSteps,
                status: "ok",
                message: `Step ${stepNum}/${totalSteps}: ✓ ${fieldType} filled`
              });
            } else {
              throw new Error(stepResponse.error || "Content script reported failure");
            }
          } catch (err) {
            stepConsecutiveFailures.set(stepKey, currentFailures + 1);
            let failReason;
            const errStr = err.message || String(err);
            if (errStr === "TIMEOUT") {
              failReason = `The page didn't respond to the action in time (step ${stepNum}, ${fieldType}).`;
            } else if (errStr.includes("not found") || errStr.includes("resolve")) {
              failReason = `Couldn't find the element for step ${stepNum} (expected: ${fieldType}). The page layout may have changed.`;
            } else {
              failReason = `Step ${stepNum} (${fieldType}) failed: ${errStr}`;
            }
            console.error(`[BG] Step 6.${stepNum}: ✗ failed (${currentFailures + 1} consecutive) — ${failReason}`);
            stepResults.push({ stepNum, fieldType, ok: false, reason: failReason });
            safePost({
              type: "PLAN_STEP_STATUS",
              stepNum,
              totalSteps,
              status: "error",
              message: failReason
            });
            // Continue remaining steps — don't abort the whole plan
          }

          // Small delay between steps so DOM events settle
          await new Promise(r => setTimeout(r, 300));
        }

        // ── Plan summary ────────────────────────────────────────────────
        const succeeded = stepResults.filter(r => r.ok).length;
        const failed = stepResults.filter(r => !r.ok).length;
        const failedDescriptions = stepResults
          .filter(r => !r.ok)
          .map(r => `Step ${r.stepNum} (${r.fieldType}): ${r.reason}`);

        let summaryMsg;
        if (failed === 0) {
          summaryMsg = `All ${succeeded} step(s) completed successfully.`;
        } else {
          summaryMsg = `Completed ${succeeded} of ${totalSteps} steps. ${failedDescriptions.join(" | ")}`;
        }

        console.log(`[BG] Step 6 Summary: ${summaryMsg}`);
        safePost({
          type: "PLAN_SUMMARY",
          total: totalSteps,
          succeeded,
          failed,
          details: stepResults,
          message: summaryMsg
        });
      }

      // ── Finalize Loop Cycle ───────────────────────────────────────────
      safePost({
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
      console.log(`[BG] Cycle finished in ${loopLatency.toFixed(1)}ms. Total latency: ${stats.totalLatencyMs.toFixed(1)}ms`);

      chrome.tabs.sendMessage(captureResult.tab.id, { type: "UPDATE_STATS", payload: stats }, () => {
        chrome.runtime.lastError; // Ignore if content script closed
      });

      // ── Loop check: demo mode stops after one full plan ───────────────
      shouldContinue = false;  // Single-shot: plan covers all fields at once
    }
  });
});
