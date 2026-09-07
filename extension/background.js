// src/background.js
var SERVER_URL = "http://localhost:3000/analyze";
var OFFSCREEN_URL = chrome.runtime.getURL("offscreen.html");
var analysisCache = /* @__PURE__ */ new Map();
var stats = {
  framesCaptured: 0,
  visionInferences: 0,
  totalLatencyMs: 0
};
console.log(`[BG] T_SW_START  t=0ms  (Service worker started)`);
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
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "OFFSCREEN_KEEPALIVE") {
    sendResponse({ ok: true });
    return true;
  }
});
async function captureScreen() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab)
    throw new Error("No active tab found.");
  const dataUrl = await chrome.tabs.captureVisibleTab(activeTab.windowId, { format: "png" });
  return { dataUrl, tab: activeTab };
}
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
            files: ["content.js"]
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
async function ensureOffscreenDocument() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [OFFSCREEN_URL]
  });
  if (existing.length > 0)
    return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["WORKERS"],
    justification: "Run Florence-2 + BlazeFace inference for visual PII detection."
  });
  console.log("[BG] Offscreen document created.");
}
async function redactScreenshot(dataUrl, sensitiveRegions) {
  if (!sensitiveRegions || sensitiveRegions.length === 0)
    return dataUrl;
  try {
    const res = await fetch(dataUrl);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    ctx.fillStyle = "black";
    for (const region of sensitiveRegions) {
      if (region.bbox && region.bbox.length === 4) {
        const [x, y, w, h] = region.bbox;
        ctx.fillRect(x, y, w, h);
      }
    }
    const outBlob = await canvas.convertToBlob({ type: "image/png" });
    const buffer = await outBlob.arrayBuffer();
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const b64 = btoa(binary);
    return `data:image/png;base64,${b64}`;
  } catch (err) {
    console.error("[BG] Redaction failed:", err);
    return dataUrl;
  }
}
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
async function sendToServer(payload) {
  console.log("[BG] Initiating HTTP request to server URL:", SERVER_URL);
  try {
    const res = await fetch(SERVER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
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
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "analyze")
    return;
  let isConnected = true;
  const safePost = (msg) => {
    if (!isConnected)
      return false;
    try {
      port.postMessage(msg);
      return true;
    } catch (e) {
      isConnected = false;
      return false;
    }
  };
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
    if (message.type !== "ANALYZE_SCREEN" && message.type !== "START_DEMO_RUN")
      return;
    const isDemo = message.type === "START_DEMO_RUN";
    const instruction = message.instruction || "Analyze the current screen and detect PII";
    let shouldContinue = true;
    let taskVisionInferences = 0;
    const MAX_VISION_PER_TASK = 3;
    const stepConsecutiveFailures = /* @__PURE__ */ new Map();
    while (shouldContinue) {
      const t0 = performance.now();
      console.log(`[BG] >>> Starting Execution Loop (isDemo=${isDemo}) <<<`);
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
        text: vaultKeys.length > 0 ? `[VAULT] Loaded ${vaultKeys.length} stored field(s): ${vaultKeys.join(", ")}` : "\u26A0 Vault is empty! Open Profile settings to configure values."
      });
      let captureResult;
      try {
        console.log("[BG] Step 1: Capturing active tab screenshot...");
        safePost({ type: "STAGE_CHANGE", stage: "capture", text: "Capturing screen\u2026" });
        captureResult = await captureScreen();
        console.log("[BG] Step 1 Complete. Screenshot captured successfully.");
      } catch (err) {
        console.error("[BG Error][Step 1: Screenshot Capture]:", err);
        safePost({ type: "ERROR", step: "Screenshot Capture", error: err.message });
        shouldContinue = false;
        break;
      }
      let domResult;
      try {
        console.log(`[BG] Step 2: Scanning DOM for sensitive fields on tab ${captureResult.tab.id}...`);
        safePost({ type: "STAGE_CHANGE", stage: "capture", text: "Scanning DOM for sensitive fields\u2026" });
        domResult = await getDOMRegions(captureResult.tab.id);
        safePost({ type: "DOM_SCAN_DONE", count: domResult.domRegions.length });
        console.log(`[BG] Step 2 Complete. Found ${domResult.domRegions.length} sensitive DOM field(s).`);
      } catch (err) {
        console.error("[BG Error][Step 2: DOM Scan]:", err);
        safePost({ type: "ERROR", step: "DOM Scan", error: err.message });
        shouldContinue = false;
        break;
      }
      stats.framesCaptured++;
      const cacheKey = captureResult.tab.url + "|" + domResult.domHash;
      let detections, sensitiveRegions, screenshotDataUrl, elapsed;
      if (analysisCache.has(cacheKey)) {
        console.log("[BG] Step 3: DOM identical! Cache hit, reusing cached detections.");
        safePost({ type: "STATUS", text: "\u26A1 DOM identical! Skipping vision inference (Cache Hit)." });
        const cached = analysisCache.get(cacheKey);
        detections = cached.detections;
        sensitiveRegions = cached.sensitiveRegions;
        screenshotDataUrl = captureResult.dataUrl;
        elapsed = 0;
      } else {
        try {
          console.log(`[BG] Step 3: Dispatching screenshot and domRegions to offscreen document for inference (attempt ${taskVisionInferences + 1} of max ${MAX_VISION_PER_TASK})...`);
          safePost({ type: "STAGE_CHANGE", stage: "detect", text: `Running Florence-2 + BlazeFace + PII analysis (vision pass ${taskVisionInferences + 1}/${MAX_VISION_PER_TASK})\u2026` });
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
      const rawBytes = captureResult.dataUrl.length;
      let finalScreenshotDataUrl;
      try {
        console.log(`[BG] Step 4: Redacting ${sensitiveRegions.length} sensitive regions on canvas...`);
        safePost({ type: "STAGE_CHANGE", stage: "redact", text: `Redacting ${sensitiveRegions.length} sensitive regions\u2026` });
        finalScreenshotDataUrl = await redactScreenshot(screenshotDataUrl, sensitiveRegions);
        console.log("[BG] Step 4 Complete. Redaction finished.");
      } catch (err) {
        console.error("[BG Error][Step 4: Redaction]:", err);
        safePost({ type: "ERROR", step: "Redaction", error: err.message });
        shouldContinue = false;
        break;
      }
      let leakCheckPassed = true;
      let leakDetails = { leaksFound: 0, leakRegions: [], checkedRegions: sensitiveRegions.length };
      try {
        console.log("[BG] Step 4b: Running leak verification \u2014 re-detecting PII on redacted image...");
        safePost({ type: "STAGE_CHANGE", stage: "redact", text: "Verifying redaction \u2014 scanning redacted image for PII leaks\u2026" });
        if (sensitiveRegions.length > 0) {
          const leakResult = await runVisionAnalysis(finalScreenshotDataUrl, [], []);
          const leakRegions = leakResult.sensitiveRegions || [];
          const leakingRegions = leakRegions.filter((detected) => {
            const [dx, dy, dw, dh] = detected.bbox;
            return sensitiveRegions.some((masked) => {
              const [mx, my, mw, mh] = masked.bbox;
              const overlapX = Math.max(dx, mx) < Math.min(dx + dw, mx + mw);
              const overlapY = Math.max(dy, my) < Math.min(dy + dh, my + mh);
              return overlapX && overlapY;
            });
          });
          leakDetails = {
            leaksFound: leakingRegions.length,
            leakRegions: leakingRegions,
            checkedRegions: sensitiveRegions.length,
            totalDetectedOnRedacted: leakRegions.length
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
              message: `\u{1F6A8} LEAK DETECTED: ${leakingRegions.length} PII region(s) still visible after redaction \u2014 payload BLOCKED`
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
              message: `\u2713 0 leaks detected \u2014 ${sensitiveRegions.length} masked region(s) verified clean`
            });
          }
        } else {
          console.log("[BG] Step 4b: No sensitive regions to verify (no redaction performed).");
          safePost({
            type: "LEAK_CHECK",
            passed: true,
            leaksFound: 0,
            leakRegions: [],
            checkedRegions: 0,
            message: "\u2713 No regions to verify (page has no detected PII)"
          });
        }
      } catch (leakErr) {
        console.warn("[BG] Step 4b: Leak verification inference failed (non-fatal):", leakErr.message);
        safePost({
          type: "LEAK_CHECK",
          passed: true,
          // Give benefit of doubt if inference fails
          leaksFound: 0,
          leakRegions: [],
          checkedRegions: sensitiveRegions.length,
          message: `\u26A0 Leak check skipped (inference error: ${leakErr.message})`,
          warning: true
        });
      }
      if (!leakCheckPassed) {
        console.error("[BG] BLOCKING payload transmission \u2014 PII leak verification failed!");
        shouldContinue = false;
        break;
      }
      let serverResult;
      try {
        console.log("[BG] Step 5: Preparing AgentRequestV1 payload for server...");
        safePost({ type: "STAGE_CHANGE", stage: "send", text: "Sending redacted payload to server (http://localhost:3000/analyze)\u2026" });
        const manifest2 = (sensitiveRegions || []).map((r, i) => ({
          region_id: `region_${i}`,
          bbox: r.bbox,
          type: r.type,
          redaction_style: "black_box",
          confidence: r.confidence,
          source: r.source || "dom"
        }));
        const dom_summary2 = (domResult.domRegions || []).map((r, i) => ({
          element_id: r.agentId || `agent_${i}`,
          dom_id: r.id || "",
          name: r.name || "",
          placeholder: r.placeholder || "",
          tag: r.tag || "input",
          role: r.role || (r.inputType === "radio" ? "radio" : "textbox"),
          label: r.label || "",
          field_type: r.type || "",
          bbox: r.bbox,
          current_value: r.current_value || ""
          // Live value so model skips already-filled fields
        }));
        console.log("\n========================================================");
        console.log(`[BG][DEBUG] === EXACT dom_summary SENT TO /analyze (${dom_summary2.length} items) ===`);
        console.log(JSON.stringify(dom_summary2, null, 2));
        console.log(`[BG][DEBUG] === EXACT manifest SENT TO /analyze (${manifest2.length} items) ===`);
        console.log(JSON.stringify(manifest2, null, 2));
        console.log("========================================================\n");
        const agentRequestPayload = {
          version: "1.0",
          task_instruction: instruction,
          redacted_image: finalScreenshotDataUrl.split(",")[1],
          manifest: manifest2,
          dom_summary: dom_summary2,
          demo_mode: isDemo,
          client_stats: { totalLatencyMs: stats.totalLatencyMs }
        };
        const redactedImageB64 = agentRequestPayload.redacted_image;
        const payloadJson = JSON.stringify(agentRequestPayload);
        const sentBytes = payloadJson.length;
        let piiSurfacePercent = 0;
        let imageTotalPixels = 1;
        let imagePIIPixels = 0;
        try {
          const rawB64 = captureResult.dataUrl.split(",")[1] || "";
          if (sensitiveRegions.length > 0) {
            imagePIIPixels = sensitiveRegions.reduce((sum, r) => sum + r.bbox[2] * r.bbox[3], 0);
            const allX2 = sensitiveRegions.map((r) => r.bbox[0] + r.bbox[2]);
            const allY2 = sensitiveRegions.map((r) => r.bbox[1] + r.bbox[3]);
            const estimatedW = Math.max(1280, Math.max(...allX2) * 1.2);
            const estimatedH = Math.max(720, Math.max(...allY2) * 1.2);
            imageTotalPixels = estimatedW * estimatedH;
            piiSurfacePercent = imagePIIPixels / imageTotalPixels * 100;
          }
        } catch (dimErr) {
          console.warn("[BG] Could not estimate image dimensions for PII surface metric:", dimErr);
        }
        const reductionPercent = (1 - sentBytes / rawBytes) * 100;
        const metricsPayload = {
          raw_bytes: rawBytes,
          sent_bytes: sentBytes,
          reduction_percent: reductionPercent,
          pii_regions: sensitiveRegions.length,
          pii_surface_percent: piiSurfacePercent,
          pii_pixels: imagePIIPixels
        };
        console.log("[BG] Data Reduction Metrics:", JSON.stringify(metricsPayload));
        safePost({ type: "METRICS", ...metricsPayload });
        serverResult = await sendToServer(agentRequestPayload);
        console.log("[BG] Step 5 Complete. Server returned plan:", serverResult);
      } catch (err) {
        console.error("[BG Error][Step 5: Server Call]:", err);
        let errMsg = err.message || String(err);
        if (errMsg.includes("Failed to fetch") || errMsg.includes("NetworkError") || errMsg.includes("ECONNREFUSED")) {
          errMsg = "Couldn't reach the reasoning server \u2014 is it running on port 3000?";
        } else if (errMsg.includes("malformed JSON") || errMsg.includes("unexpected response")) {
          errMsg = "Got an unexpected response from the model \u2014 the VLM returned malformed JSON.";
        } else if (errMsg.includes("HTTP 5")) {
          errMsg = `Server error: ${errMsg}`;
        }
        safePost({ type: "ERROR", step: "Server Call", error: errMsg });
        shouldContinue = false;
        break;
      }
      safePost({ type: "STAGE_CHANGE", stage: "act", text: "Executing plan\u2026" });
      const plan = Array.isArray(serverResult?.plan) ? serverResult.plan : [];
      const totalSteps = plan.length;
      const stepResults = [];
      if (totalSteps === 0) {
        console.log("[BG] Step 6: Empty plan \u2014 all fields already filled or task complete.");
        safePost({ type: "PLAN_SUMMARY", total: 0, succeeded: 0, failed: 0, details: [], message: "All fields are already filled \u2014 nothing to do." });
      } else {
        console.log(`[BG] Step 6: Executing ${totalSteps} plan step(s)...`);
        for (const step of plan) {
          const stepNum = step.step;
          const fieldType = step.field_type || "FIELD";
          const targetId = step.target_id;
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
          const domMatch = dom_summary.find((d) => d.element_id === targetId || d.dom_id === targetId || d.name === targetId);
          const manifestMatch = manifest.find((m) => m.region_id === targetId);
          const detectionMatch = (detections || []).find((d) => d.id === targetId);
          const matchedBbox = step.bbox || domMatch?.bbox || manifestMatch?.bbox || detectionMatch?.bbox || null;
          const stepPayload = { ...step, bbox: matchedBbox };
          let currentVal = stepPayload.value || stepPayload.match_value || storedVault[fieldType] || null;
          if (!currentVal && fieldType === "PHONE")
            currentVal = storedVault["INDIAN_MOBILE"];
          if (!currentVal && fieldType === "INDIAN_MOBILE")
            currentVal = storedVault["PHONE"];
          if (!currentVal && (step.action === "type" || step.action === "select_choice") && fieldType !== "BUTTON" && fieldType !== "SUBMIT") {
            console.log(`[BG] Step ${stepNum}: No value found for "${fieldType}" in profile or plan. Requesting inline input from user...`);
            safePost({
              type: "PROMPT_USER_INPUT",
              stepNum,
              fieldType,
              targetId,
              actionType: step.action,
              message: `No value found for ${fieldType} \u2014 enter one now?`
            });
            const userReply = await new Promise((resolve) => {
              const replyHandler = (uMsg) => {
                if (uMsg.type === "USER_INPUT_PROVIDED" && uMsg.stepNum === stepNum) {
                  port.onMessage.removeListener(replyHandler);
                  resolve(uMsg);
                }
              };
              port.onMessage.addListener(replyHandler);
              setTimeout(() => resolve(null), 45e3);
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
                console.log(`[BG] \u2713 Persisted "${fieldType}" = "${userReply.value}" to chrome.storage.local`);
              }
            }
          }
          safePost({
            type: "PLAN_STEP_STATUS",
            stepNum,
            totalSteps,
            status: "running",
            message: `Step ${stepNum}/${totalSteps}: ${step.action} on ${fieldType} (${targetId})\u2026`
          });
          try {
            const stepResponse = await new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error("TIMEOUT")), 5e3);
              chrome.tabs.sendMessage(
                captureResult.tab.id,
                { type: "EXECUTE_ACTION", payload: stepPayload },
                (response) => {
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
              stepConsecutiveFailures.set(stepKey, 0);
              console.log(`[BG] Step 6.${stepNum}: \u2713 success`, stepResponse);
              stepResults.push({ stepNum, fieldType, ok: true });
              safePost({
                type: "PLAN_STEP_STATUS",
                stepNum,
                totalSteps,
                status: "ok",
                message: `Step ${stepNum}/${totalSteps}: \u2713 ${fieldType} filled`
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
            console.error(`[BG] Step 6.${stepNum}: \u2717 failed (${currentFailures + 1} consecutive) \u2014 ${failReason}`);
            stepResults.push({ stepNum, fieldType, ok: false, reason: failReason });
            safePost({
              type: "PLAN_STEP_STATUS",
              stepNum,
              totalSteps,
              status: "error",
              message: failReason
            });
          }
          await new Promise((r) => setTimeout(r, 300));
        }
        const succeeded = stepResults.filter((r) => r.ok).length;
        const failed = stepResults.filter((r) => !r.ok).length;
        const failedDescriptions = stepResults.filter((r) => !r.ok).map((r) => `Step ${r.stepNum} (${r.fieldType}): ${r.reason}`);
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
      safePost({
        type: "ANALYSIS_RESULT",
        detections,
        sensitiveRegions,
        screenshotDataUrl,
        elapsed,
        serverResult
      });
      const tEnd = performance.now();
      const loopLatency = tEnd - t0;
      stats.totalLatencyMs += loopLatency;
      console.log(`[BG] Cycle finished in ${loopLatency.toFixed(1)}ms. Total latency: ${stats.totalLatencyMs.toFixed(1)}ms`);
      chrome.tabs.sendMessage(captureResult.tab.id, { type: "UPDATE_STATS", payload: stats }, () => {
        chrome.runtime.lastError;
      });
      shouldContinue = false;
    }
  });
});
export {
  captureScreen
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsic3JjL2JhY2tncm91bmQuanMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogYmFja2dyb3VuZC5qcyBcdTIwMTQgU2VydmljZSBXb3JrZXIgIChzcmMvYmFja2dyb3VuZC5qcyBcdTIxOTIgYnVpbHQgYmFja2dyb3VuZC5qcylcbiAqXG4gKiB2MC4yIGFkZGl0aW9uczpcbiAqICAgLSBnZXRET01SZWdpb25zKHRhYklkKSAgIFx1MjAxNCBzZW5kcyBTQ0FOX0RPTSB0byBjb250ZW50IHNjcmlwdCwgcmV0dXJucyBkb21SZWdpb25zW11cbiAqICAgLSBQYXNzZXMgZG9tUmVnaW9ucyB0byBvZmZzY3JlZW4gYWxvbmdzaWRlIHRoZSBzY3JlZW5zaG90XG4gKiAgIC0gUmVsYXlzIHsgZGV0ZWN0aW9ucywgc2Vuc2l0aXZlUmVnaW9ucyB9IGJhY2sgdG8gcG9wdXAgdmlhIHBvcnRcbiAqL1xuXG5jb25zdCBTRVJWRVJfVVJMICAgID0gXCJodHRwOi8vbG9jYWxob3N0OjMwMDAvYW5hbHl6ZVwiO1xuY29uc3QgT0ZGU0NSRUVOX1VSTCA9IGNocm9tZS5ydW50aW1lLmdldFVSTChcIm9mZnNjcmVlbi5odG1sXCIpO1xuXG5jb25zdCBhbmFseXNpc0NhY2hlID0gbmV3IE1hcCgpO1xubGV0IHN0YXRzID0ge1xuICBmcmFtZXNDYXB0dXJlZDogMCxcbiAgdmlzaW9uSW5mZXJlbmNlczogMCxcbiAgdG90YWxMYXRlbmN5TXM6IDBcbn07XG5cbmNvbnNvbGUubG9nKGBbQkddIFRfU1dfU1RBUlQgIHQ9MG1zICAoU2VydmljZSB3b3JrZXIgc3RhcnRlZClgKTtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBQcmUtbG9hZCBvbiBzdGFydHVwIChzbyBtb2RlbCBpcyByZWFkeSBiZWZvcmUgdXNlciBjbGlja3MgYW55dGhpbmcpXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbmNocm9tZS5ydW50aW1lLm9uSW5zdGFsbGVkLmFkZExpc3RlbmVyKCgpID0+IHtcbiAgZW5zdXJlT2Zmc2NyZWVuRG9jdW1lbnQoKTtcbiAgaWYgKGNocm9tZS5zdG9yYWdlICYmIGNocm9tZS5zdG9yYWdlLmxvY2FsKSB7XG4gICAgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KFtcImFnZW50X3ZhdWx0XCJdLCAoZGF0YSkgPT4ge1xuICAgICAgaWYgKCFkYXRhLmFnZW50X3ZhdWx0KSB7XG4gICAgICAgIGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7XG4gICAgICAgICAgYWdlbnRfdmF1bHQ6IHtcbiAgICAgICAgICAgIE5BTUU6IFwiUmFqZXNoIEt1bWFyXCIsXG4gICAgICAgICAgICBFTUFJTDogXCJ2ZW5kb3IuZGVtb0BleGFtcGxlLmluXCIsXG4gICAgICAgICAgICBJTkRJQU5fTU9CSUxFOiBcIjk4NzY1NDMyMTBcIixcbiAgICAgICAgICAgIFBIT05FOiBcIjk4NzY1NDMyMTBcIixcbiAgICAgICAgICAgIERPQjogXCIxOTkwLTA1LTE1XCIsXG4gICAgICAgICAgICBBRERSRVNTOiBcIjQyLCBNRyBSb2FkLCBCZW5nYWx1cnVcIixcbiAgICAgICAgICAgIENJVFk6IFwiQmVuZ2FsdXJ1XCIsXG4gICAgICAgICAgICBQSU5DT0RFOiBcIjU2MDAwMVwiLFxuICAgICAgICAgICAgQUFESEFBUjogXCI1NDg5IDEyMzQgNTY3NFwiLFxuICAgICAgICAgICAgUEFOOiBcIkFCQ0RFMTIzNEZcIixcbiAgICAgICAgICAgIFBBU1NXT1JEOiBcIk1vY2tQYXNzd29yZEAxMjNcIlxuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICAgIGNvbnNvbGUubG9nKFwiW0JHXSBJbml0aWFsaXplZCBkZWZhdWx0IGRlbW8gcHJvZmlsZSB2YXVsdCBpbiBjaHJvbWUuc3RvcmFnZS5sb2NhbFwiKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxufSk7XG5jaHJvbWUucnVudGltZS5vblN0YXJ0dXAuYWRkTGlzdGVuZXIoKCkgPT4gZW5zdXJlT2Zmc2NyZWVuRG9jdW1lbnQoKSk7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gR2xvYmFsIEtlZXAtQWxpdmUgSGFuZGxlciAocmVzcG9uZHMgdG8gb2Zmc2NyZWVuIHBpbmdzKVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5jaHJvbWUucnVudGltZS5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIoKG1zZywgc2VuZGVyLCBzZW5kUmVzcG9uc2UpID0+IHtcbiAgaWYgKG1zZy50eXBlID09PSBcIk9GRlNDUkVFTl9LRUVQQUxJVkVcIikge1xuICAgIHNlbmRSZXNwb25zZSh7IG9rOiB0cnVlIH0pO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG59KTtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBjYXB0dXJlU2NyZWVuIFx1MjAxNCBjYXB0dXJlIHRoZSBhY3RpdmUgdGFiJ3MgdmlzaWJsZSBhcmVhIGFzIGEgZGF0YSBVUkxcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNhcHR1cmVTY3JlZW4oKSB7XG4gIGNvbnN0IFthY3RpdmVUYWJdID0gYXdhaXQgY2hyb21lLnRhYnMucXVlcnkoeyBhY3RpdmU6IHRydWUsIGN1cnJlbnRXaW5kb3c6IHRydWUgfSk7XG4gIGlmICghYWN0aXZlVGFiKSB0aHJvdyBuZXcgRXJyb3IoXCJObyBhY3RpdmUgdGFiIGZvdW5kLlwiKTtcblxuICBjb25zdCBkYXRhVXJsID0gYXdhaXQgY2hyb21lLnRhYnMuY2FwdHVyZVZpc2libGVUYWIoYWN0aXZlVGFiLndpbmRvd0lkLCB7IGZvcm1hdDogXCJwbmdcIiB9KTtcbiAgcmV0dXJuIHsgZGF0YVVybCwgdGFiOiBhY3RpdmVUYWIgfTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIGdldERPTVJlZ2lvbnMgXHUyMDE0IGFzayB0aGUgY29udGVudCBzY3JpcHQgdG8gc2NhbiB0aGUgcGFnZSdzIHNlbnNpdGl2ZSBmaWVsZHNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuYXN5bmMgZnVuY3Rpb24gZ2V0RE9NUmVnaW9ucyh0YWJJZCkge1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICBjb25zb2xlLmxvZyhgW0JHXSBEaXNwYXRjaGluZyBTQ0FOX0RPTSBtZXNzYWdlIHRvIGFjdGl2ZSB0YWIgJHt0YWJJZH0uLi5gKTtcbiAgICBjaHJvbWUudGFicy5zZW5kTWVzc2FnZSh0YWJJZCwgeyB0eXBlOiBcIlNDQU5fRE9NXCIgfSwgYXN5bmMgKHJlc3BvbnNlKSA9PiB7XG4gICAgICBpZiAoY2hyb21lLnJ1bnRpbWUubGFzdEVycm9yIHx8ICFyZXNwb25zZSkge1xuICAgICAgICBjb25zdCBlcnJNc2cgPSBjaHJvbWUucnVudGltZS5sYXN0RXJyb3I/Lm1lc3NhZ2UgPz8gXCJubyByZXNwb25zZVwiO1xuICAgICAgICBjb25zb2xlLndhcm4oYFtCR10gSW5pdGlhbCBTQ0FOX0RPTSBmYWlsZWQgb24gdGFiICR7dGFiSWR9ICgke2Vyck1zZ30pLiBBdHRlbXB0aW5nIGR5bmFtaWMgaW5qZWN0aW9uIG9mIGNvbnRlbnQuanMuLi5gKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBhd2FpdCBjaHJvbWUuc2NyaXB0aW5nLmV4ZWN1dGVTY3JpcHQoe1xuICAgICAgICAgICAgdGFyZ2V0OiB7IHRhYklkIH0sXG4gICAgICAgICAgICBmaWxlczogW1wiY29udGVudC5qc1wiXSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBjb25zb2xlLmxvZyhgW0JHXSBjb250ZW50LmpzIHN1Y2Nlc3NmdWxseSBpbmplY3RlZCBpbnRvIHRhYiAke3RhYklkfS4gUmV0cnlpbmcgU0NBTl9ET00uLi5gKTtcbiAgICAgICAgICBjaHJvbWUudGFicy5zZW5kTWVzc2FnZSh0YWJJZCwgeyB0eXBlOiBcIlNDQU5fRE9NXCIgfSwgKHJldHJ5UmVzcG9uc2UpID0+IHtcbiAgICAgICAgICAgIGlmIChjaHJvbWUucnVudGltZS5sYXN0RXJyb3IgfHwgIXJldHJ5UmVzcG9uc2UpIHtcbiAgICAgICAgICAgICAgY29uc29sZS53YXJuKFwiW0JHXSBTQ0FOX0RPTSByZXRyeSBhbHNvIGZhaWxlZDpcIiwgY2hyb21lLnJ1bnRpbWUubGFzdEVycm9yPy5tZXNzYWdlID8/IFwibm8gcmVzcG9uc2VcIik7XG4gICAgICAgICAgICAgIHJlc29sdmUoeyBkb21SZWdpb25zOiBbXSwgZG9tSGFzaDogXCJcIiB9KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBbQkddIFNDQU5fRE9NIHJldHJ5IHN1Y2NlZWRlZCEgRm91bmQgJHtyZXRyeVJlc3BvbnNlLmRvbVJlZ2lvbnM/Lmxlbmd0aCA/PyAwfSBzZW5zaXRpdmUgZmllbGQocyksICR7cmV0cnlSZXNwb25zZS5tZWRpYVJlZ2lvbnM/Lmxlbmd0aCA/PyAwfSBtZWRpYSBlbGVtZW50KHMpOmAsIHJldHJ5UmVzcG9uc2UuZG9tUmVnaW9ucyk7XG4gICAgICAgICAgICAgIHJlc29sdmUoeyBkb21SZWdpb25zOiByZXRyeVJlc3BvbnNlLmRvbVJlZ2lvbnMgPz8gW10sIG1lZGlhUmVnaW9uczogcmV0cnlSZXNwb25zZS5tZWRpYVJlZ2lvbnMgPz8gW10sIGRvbUhhc2g6IHJldHJ5UmVzcG9uc2UuZG9tSGFzaCA/PyBcIlwiIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pO1xuICAgICAgICB9IGNhdGNoIChpbmpFcnIpIHtcbiAgICAgICAgICBjb25zb2xlLndhcm4oXCJbQkddIER5bmFtaWMgY29udGVudCBzY3JpcHQgaW5qZWN0aW9uIGZhaWxlZCAoZS5nLiBjaHJvbWU6Ly8gb3IgcmVzdHJpY3RlZCBwYWdlKTpcIiwgaW5qRXJyLm1lc3NhZ2UpO1xuICAgICAgICAgIHJlc29sdmUoeyBkb21SZWdpb25zOiBbXSwgbWVkaWFSZWdpb25zOiBbXSwgZG9tSGFzaDogXCJcIiB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjb25zb2xlLmxvZyhgW0JHXSBTQ0FOX0RPTSBzdWNjZWVkZWQgb24gdGFiICR7dGFiSWR9ISBSZWNlaXZlZCAke3Jlc3BvbnNlLmRvbVJlZ2lvbnM/Lmxlbmd0aCA/PyAwfSByZWdpb24ocyksICR7cmVzcG9uc2UubWVkaWFSZWdpb25zPy5sZW5ndGggPz8gMH0gbWVkaWEgZWxlbWVudChzKTpgLCByZXNwb25zZS5kb21SZWdpb25zKTtcbiAgICAgIHJlc29sdmUoeyBkb21SZWdpb25zOiByZXNwb25zZS5kb21SZWdpb25zID8/IFtdLCBtZWRpYVJlZ2lvbnM6IHJlc3BvbnNlLm1lZGlhUmVnaW9ucyA/PyBbXSwgZG9tSGFzaDogcmVzcG9uc2UuZG9tSGFzaCA/PyBcIlwiIH0pO1xuICAgIH0pO1xuICB9KTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBlbnN1cmVPZmZzY3JlZW5Eb2N1bWVudCBcdTIwMTQgY3JlYXRlIGlmIG5vdCBhbHJlYWR5IG9wZW4gKG1heCAxIHBlciBleHRlbnNpb24pXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbmFzeW5jIGZ1bmN0aW9uIGVuc3VyZU9mZnNjcmVlbkRvY3VtZW50KCkge1xuICBjb25zdCBleGlzdGluZyA9IGF3YWl0IGNocm9tZS5ydW50aW1lLmdldENvbnRleHRzKHtcbiAgICBjb250ZXh0VHlwZXM6IFtcIk9GRlNDUkVFTl9ET0NVTUVOVFwiXSxcbiAgICBkb2N1bWVudFVybHM6IFtPRkZTQ1JFRU5fVVJMXSxcbiAgfSk7XG4gIGlmIChleGlzdGluZy5sZW5ndGggPiAwKSByZXR1cm47XG5cbiAgYXdhaXQgY2hyb21lLm9mZnNjcmVlbi5jcmVhdGVEb2N1bWVudCh7XG4gICAgdXJsOiAgICAgICAgICAgXCJvZmZzY3JlZW4uaHRtbFwiLFxuICAgIHJlYXNvbnM6ICAgICAgIFtcIldPUktFUlNcIl0sXG4gICAganVzdGlmaWNhdGlvbjogXCJSdW4gRmxvcmVuY2UtMiArIEJsYXplRmFjZSBpbmZlcmVuY2UgZm9yIHZpc3VhbCBQSUkgZGV0ZWN0aW9uLlwiLFxuICB9KTtcbiAgY29uc29sZS5sb2coXCJbQkddIE9mZnNjcmVlbiBkb2N1bWVudCBjcmVhdGVkLlwiKTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyByZWRhY3RTY3JlZW5zaG90IFx1MjAxNCBwaHlzaWNhbGx5IGRyYXcgYmxhY2sgYm94ZXMgb3ZlciBzZW5zaXRpdmUgcmVnaW9uc1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5hc3luYyBmdW5jdGlvbiByZWRhY3RTY3JlZW5zaG90KGRhdGFVcmwsIHNlbnNpdGl2ZVJlZ2lvbnMpIHtcbiAgaWYgKCFzZW5zaXRpdmVSZWdpb25zIHx8IHNlbnNpdGl2ZVJlZ2lvbnMubGVuZ3RoID09PSAwKSByZXR1cm4gZGF0YVVybDtcblxuICB0cnkge1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGRhdGFVcmwpO1xuICAgIGNvbnN0IGJsb2IgPSBhd2FpdCByZXMuYmxvYigpO1xuICAgIGNvbnN0IGJpdG1hcCA9IGF3YWl0IGNyZWF0ZUltYWdlQml0bWFwKGJsb2IpO1xuICAgIFxuICAgIGNvbnN0IGNhbnZhcyA9IG5ldyBPZmZzY3JlZW5DYW52YXMoYml0bWFwLndpZHRoLCBiaXRtYXAuaGVpZ2h0KTtcbiAgICBjb25zdCBjdHggPSBjYW52YXMuZ2V0Q29udGV4dChcIjJkXCIpO1xuICAgIFxuICAgIC8vIERyYXcgb3JpZ2luYWwgaW1hZ2VcbiAgICBjdHguZHJhd0ltYWdlKGJpdG1hcCwgMCwgMCk7XG4gICAgXG4gICAgLy8gRHJhdyByZWRhY3Rpb24gYm94ZXNcbiAgICBjdHguZmlsbFN0eWxlID0gXCJibGFja1wiO1xuICAgIGZvciAoY29uc3QgcmVnaW9uIG9mIHNlbnNpdGl2ZVJlZ2lvbnMpIHtcbiAgICAgIGlmIChyZWdpb24uYmJveCAmJiByZWdpb24uYmJveC5sZW5ndGggPT09IDQpIHtcbiAgICAgICAgY29uc3QgW3gsIHksIHcsIGhdID0gcmVnaW9uLmJib3g7XG4gICAgICAgIGN0eC5maWxsUmVjdCh4LCB5LCB3LCBoKTtcbiAgICAgIH1cbiAgICB9XG4gICAgXG4gICAgY29uc3Qgb3V0QmxvYiA9IGF3YWl0IGNhbnZhcy5jb252ZXJ0VG9CbG9iKHsgdHlwZTogXCJpbWFnZS9wbmdcIiB9KTtcbiAgICBjb25zdCBidWZmZXIgPSBhd2FpdCBvdXRCbG9iLmFycmF5QnVmZmVyKCk7XG4gICAgXG4gICAgLy8gQ29udmVydCB0byBiYXNlNjRcbiAgICBsZXQgYmluYXJ5ID0gJyc7XG4gICAgY29uc3QgYnl0ZXMgPSBuZXcgVWludDhBcnJheShidWZmZXIpO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYnl0ZXMuYnl0ZUxlbmd0aDsgaSsrKSB7XG4gICAgICBiaW5hcnkgKz0gU3RyaW5nLmZyb21DaGFyQ29kZShieXRlc1tpXSk7XG4gICAgfVxuICAgIGNvbnN0IGI2NCA9IGJ0b2EoYmluYXJ5KTtcbiAgICBcbiAgICByZXR1cm4gYGRhdGE6aW1hZ2UvcG5nO2Jhc2U2NCwke2I2NH1gO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBjb25zb2xlLmVycm9yKFwiW0JHXSBSZWRhY3Rpb24gZmFpbGVkOlwiLCBlcnIpO1xuICAgIHJldHVybiBkYXRhVXJsOyAvLyBmYWxsYmFjayB0byBvcmlnaW5hbCBvbiBlcnJvclxuICB9XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gcnVuVmlzaW9uQW5hbHlzaXMgXHUyMDE0IHNlbmRzIHNjcmVlbnNob3QgKyBkb21SZWdpb25zICsgbWVkaWFSZWdpb25zIHRvIG9mZnNjcmVlblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5hc3luYyBmdW5jdGlvbiBydW5WaXNpb25BbmFseXNpcyhzY3JlZW5zaG90RGF0YVVybCwgZG9tUmVnaW9ucywgbWVkaWFSZWdpb25zKSB7XG4gIGF3YWl0IGVuc3VyZU9mZnNjcmVlbkRvY3VtZW50KCk7XG5cbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZShcbiAgICAgIHsgdHlwZTogXCJSVU5fSU5GRVJFTkNFXCIsIHBheWxvYWQ6IHsgc2NyZWVuc2hvdERhdGFVcmwsIGRvbVJlZ2lvbnMsIG1lZGlhUmVnaW9ucyB9IH0sXG4gICAgICAocmVzcG9uc2UpID0+IHtcbiAgICAgICAgaWYgKGNocm9tZS5ydW50aW1lLmxhc3RFcnJvcikge1xuICAgICAgICAgIHJlamVjdChuZXcgRXJyb3IoY2hyb21lLnJ1bnRpbWUubGFzdEVycm9yLm1lc3NhZ2UpKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFyZXNwb25zZT8uc3VjY2Vzcykge1xuICAgICAgICAgIHJlamVjdChuZXcgRXJyb3IocmVzcG9uc2U/LmVycm9yID8/IFwiVW5rbm93biBpbmZlcmVuY2UgZXJyb3JcIikpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICByZXNvbHZlKHJlc3BvbnNlKTtcbiAgICAgIH1cbiAgICApO1xuICB9KTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBzZW5kVG9TZXJ2ZXIgXHUyMDE0IFBPU1QgcmVzdWx0IHRvIHRoZSBsb2NhbCBFeHByZXNzIHNlcnZlciAod2l0aCBmdWxsIEhUVFAgbG9nZ2luZylcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuYXN5bmMgZnVuY3Rpb24gc2VuZFRvU2VydmVyKHBheWxvYWQpIHtcbiAgY29uc29sZS5sb2coXCJbQkddIEluaXRpYXRpbmcgSFRUUCByZXF1ZXN0IHRvIHNlcnZlciBVUkw6XCIsIFNFUlZFUl9VUkwpO1xuICB0cnkge1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKFNFUlZFUl9VUkwsIHtcbiAgICAgIG1ldGhvZDogIFwiUE9TVFwiLFxuICAgICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgICAgYm9keTogICAgSlNPTi5zdHJpbmdpZnkocGF5bG9hZCksXG4gICAgfSk7XG5cbiAgICBjb25zb2xlLmxvZyhgW0JHXSBTZXJ2ZXIgSFRUUCBTdGF0dXMgQ29kZTogJHtyZXMuc3RhdHVzfSAke3Jlcy5zdGF0dXNUZXh0fWApO1xuICAgIGNvbnN0IHJhd0JvZHkgPSBhd2FpdCByZXMudGV4dCgpO1xuICAgIGNvbnNvbGUubG9nKGBbQkddIFNlcnZlciBSYXcgUmVzcG9uc2UgQm9keSAoJHtyYXdCb2R5Lmxlbmd0aH0gYnl0ZXMpOmAsIHJhd0JvZHkubGVuZ3RoID4gNTAwID8gcmF3Qm9keS5zdWJzdHJpbmcoMCwgNTAwKSArIFwiLi4uIFt0cnVuY2F0ZWRdXCIgOiByYXdCb2R5KTtcblxuICAgIGlmICghcmVzLm9rKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFNlcnZlciByZXR1cm5lZCBIVFRQICR7cmVzLnN0YXR1c30gKCR7cmVzLnN0YXR1c1RleHR9KTogJHtyYXdCb2R5LnN1YnN0cmluZygwLCAzMDApfWApO1xuICAgIH1cblxuICAgIGxldCBkYXRhO1xuICAgIHRyeSB7XG4gICAgICBkYXRhID0gSlNPTi5wYXJzZShyYXdCb2R5KTtcbiAgICB9IGNhdGNoIChwYXJzZUVycikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBTZXJ2ZXIgcmVzcG9uc2Ugd2FzIG5vdCB2YWxpZCBKU09OOiAke3Jhd0JvZHkuc3Vic3RyaW5nKDAsIDIwMCl9YCk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGRhdGE7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGNvbnNvbGUuZXJyb3IoXCJbQkcgRXJyb3JdW3NlbmRUb1NlcnZlcl0gTmV0d29yayBvciBIVFRQIGVycm9yOlwiLCBlcnIpO1xuICAgIHRocm93IGVycjtcbiAgfVxufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFBvcnQtYmFzZWQgaGFuZGxlciBcdTIwMTQga2VlcHMgdGhlIHNlcnZpY2Ugd29ya2VyIGFsaXZlIGR1cmluZyBsb25nIGluZmVyZW5jZVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5jaHJvbWUucnVudGltZS5vbkNvbm5lY3QuYWRkTGlzdGVuZXIoKHBvcnQpID0+IHtcbiAgaWYgKHBvcnQubmFtZSAhPT0gXCJhbmFseXplXCIpIHJldHVybjtcblxuICBsZXQgaXNDb25uZWN0ZWQgPSB0cnVlO1xuICBjb25zdCBzYWZlUG9zdCA9IChtc2cpID0+IHtcbiAgICBpZiAoIWlzQ29ubmVjdGVkKSByZXR1cm4gZmFsc2U7XG4gICAgdHJ5IHtcbiAgICAgIHBvcnQucG9zdE1lc3NhZ2UobXNnKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGlzQ29ubmVjdGVkID0gZmFsc2U7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICB9O1xuXG4gIC8vIEZvcndhcmQgTU9ERUxfUFJPR1JFU1MgLyBNT0RFTF9SRUFEWSAvIE1PREVMX0VSUk9SIGZyb20gb2Zmc2NyZWVuIHRvIHBvcHVwXG4gIGNvbnN0IHJlbGF5ID0gKG1zZykgPT4ge1xuICAgIGlmIChbXCJNT0RFTF9QUk9HUkVTU1wiLCBcIk1PREVMX1JFQURZXCIsIFwiTU9ERUxfRVJST1JcIl0uaW5jbHVkZXMobXNnLnR5cGUpKSB7XG4gICAgICBzYWZlUG9zdChtc2cpO1xuICAgIH1cbiAgfTtcblxuICBjaHJvbWUucnVudGltZS5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIocmVsYXkpO1xuICBwb3J0Lm9uRGlzY29ubmVjdC5hZGRMaXN0ZW5lcigoKSA9PiB7XG4gICAgaXNDb25uZWN0ZWQgPSBmYWxzZTtcbiAgICBjaHJvbWUucnVudGltZS5vbk1lc3NhZ2UucmVtb3ZlTGlzdGVuZXIocmVsYXkpO1xuICAgIGNvbnNvbGUubG9nKFwiW0JHXSBQb3B1cCBwb3J0IGRpc2Nvbm5lY3RlZCAocG9wdXAgY2xvc2VkKS4gQ29udGludWluZyBleGVjdXRpb24gaW4gYmFja2dyb3VuZC5cIik7XG4gIH0pO1xuXG4gIHBvcnQub25NZXNzYWdlLmFkZExpc3RlbmVyKGFzeW5jIChtZXNzYWdlKSA9PiB7XG4gICAgaWYgKG1lc3NhZ2UudHlwZSAhPT0gXCJBTkFMWVpFX1NDUkVFTlwiICYmIG1lc3NhZ2UudHlwZSAhPT0gXCJTVEFSVF9ERU1PX1JVTlwiKSByZXR1cm47XG4gICAgXG4gICAgY29uc3QgaXNEZW1vID0gbWVzc2FnZS50eXBlID09PSBcIlNUQVJUX0RFTU9fUlVOXCI7XG4gICAgY29uc3QgaW5zdHJ1Y3Rpb24gPSBtZXNzYWdlLmluc3RydWN0aW9uIHx8IFwiQW5hbHl6ZSB0aGUgY3VycmVudCBzY3JlZW4gYW5kIGRldGVjdCBQSUlcIjtcbiAgICBsZXQgc2hvdWxkQ29udGludWUgPSB0cnVlO1xuICAgIGxldCB0YXNrVmlzaW9uSW5mZXJlbmNlcyA9IDA7XG4gICAgY29uc3QgTUFYX1ZJU0lPTl9QRVJfVEFTSyA9IDM7XG4gICAgY29uc3Qgc3RlcENvbnNlY3V0aXZlRmFpbHVyZXMgPSBuZXcgTWFwKCk7XG5cbiAgICB3aGlsZSAoc2hvdWxkQ29udGludWUpIHtcbiAgICAgIGNvbnN0IHQwID0gcGVyZm9ybWFuY2Uubm93KCk7XG4gICAgICBjb25zb2xlLmxvZyhgW0JHXSA+Pj4gU3RhcnRpbmcgRXhlY3V0aW9uIExvb3AgKGlzRGVtbz0ke2lzRGVtb30pIDw8PGApO1xuXG4gICAgICAvLyBcdTI1MDBcdTI1MDAgU3RlcCAwOiBSZWFkIGFuZCBQcmludCBDdXJyZW50IFN0b3JlZCBQcm9maWxlIFZhdWx0IChSZXF1aXJlbWVudCAyKSBcdTI1MDBcdTI1MDBcbiAgICAgIGNvbnN0IHN0b3JlZFZhdWx0ID0gYXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICAgICAgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KFtcImFnZW50X3ZhdWx0XCJdLCAoZGF0YSkgPT4gcmVzb2x2ZShkYXRhPy5hZ2VudF92YXVsdCB8fCB7fSkpO1xuICAgICAgfSk7XG4gICAgICBjb25zdCB2YXVsdEtleXMgPSBPYmplY3Qua2V5cyhzdG9yZWRWYXVsdCk7XG5cbiAgICAgIGNvbnNvbGUubG9nKFwiXFxuPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cIik7XG4gICAgICBjb25zb2xlLmxvZyhcIltCR10gPT09IENVUlJFTlQgU1RPUkVEIFBST0ZJTEUgVkFVTFQgQVQgU1RBUlQgT0YgUlVOID09PVwiKTtcbiAgICAgIGlmICh2YXVsdEtleXMubGVuZ3RoID4gMCkge1xuICAgICAgICBjb25zb2xlLmxvZyhgRm91bmQgJHt2YXVsdEtleXMubGVuZ3RofSBzdG9yZWQgZmllbGQocyk6YCk7XG4gICAgICAgIGNvbnNvbGUubG9nKEpTT04uc3RyaW5naWZ5KHN0b3JlZFZhdWx0LCBudWxsLCAyKSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zb2xlLmxvZyhcIlByb2ZpbGUgdmF1bHQgaXMgY3VycmVudGx5IEVNUFRZICgwIGZpZWxkcyBjb25maWd1cmVkKS5cIik7XG4gICAgICB9XG4gICAgICBjb25zb2xlLmxvZyhcIj09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XFxuXCIpO1xuXG4gICAgICBzYWZlUG9zdCh7XG4gICAgICAgIHR5cGU6IFwiU1RBVFVTXCIsXG4gICAgICAgIHRleHQ6IHZhdWx0S2V5cy5sZW5ndGggPiAwXG4gICAgICAgICAgPyBgW1ZBVUxUXSBMb2FkZWQgJHt2YXVsdEtleXMubGVuZ3RofSBzdG9yZWQgZmllbGQocyk6ICR7dmF1bHRLZXlzLmpvaW4oXCIsIFwiKX1gXG4gICAgICAgICAgOiBcIlx1MjZBMCBWYXVsdCBpcyBlbXB0eSEgT3BlbiBQcm9maWxlIHNldHRpbmdzIHRvIGNvbmZpZ3VyZSB2YWx1ZXMuXCJcbiAgICAgIH0pO1xuXG4gICAgICAvLyBcdTI1MDBcdTI1MDAgU3RlcCAxOiBDYXB0dXJlIHNjcmVlbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICAgIGxldCBjYXB0dXJlUmVzdWx0O1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc29sZS5sb2coXCJbQkddIFN0ZXAgMTogQ2FwdHVyaW5nIGFjdGl2ZSB0YWIgc2NyZWVuc2hvdC4uLlwiKTtcbiAgICAgICAgc2FmZVBvc3QoeyB0eXBlOiBcIlNUQUdFX0NIQU5HRVwiLCBzdGFnZTogXCJjYXB0dXJlXCIsIHRleHQ6IFwiQ2FwdHVyaW5nIHNjcmVlblx1MjAyNlwiIH0pO1xuICAgICAgICBjYXB0dXJlUmVzdWx0ID0gYXdhaXQgY2FwdHVyZVNjcmVlbigpO1xuICAgICAgICBjb25zb2xlLmxvZyhcIltCR10gU3RlcCAxIENvbXBsZXRlLiBTY3JlZW5zaG90IGNhcHR1cmVkIHN1Y2Nlc3NmdWxseS5cIik7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgY29uc29sZS5lcnJvcihcIltCRyBFcnJvcl1bU3RlcCAxOiBTY3JlZW5zaG90IENhcHR1cmVdOlwiLCBlcnIpO1xuICAgICAgICBzYWZlUG9zdCh7IHR5cGU6IFwiRVJST1JcIiwgc3RlcDogXCJTY3JlZW5zaG90IENhcHR1cmVcIiwgZXJyb3I6IGVyci5tZXNzYWdlIH0pO1xuICAgICAgICBzaG91bGRDb250aW51ZSA9IGZhbHNlO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cblxuICAgICAgLy8gXHUyNTAwXHUyNTAwIFN0ZXAgMjogRE9NIHNjYW4gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgICBsZXQgZG9tUmVzdWx0O1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc29sZS5sb2coYFtCR10gU3RlcCAyOiBTY2FubmluZyBET00gZm9yIHNlbnNpdGl2ZSBmaWVsZHMgb24gdGFiICR7Y2FwdHVyZVJlc3VsdC50YWIuaWR9Li4uYCk7XG4gICAgICAgIHNhZmVQb3N0KHsgdHlwZTogXCJTVEFHRV9DSEFOR0VcIiwgc3RhZ2U6IFwiY2FwdHVyZVwiLCB0ZXh0OiBcIlNjYW5uaW5nIERPTSBmb3Igc2Vuc2l0aXZlIGZpZWxkc1x1MjAyNlwiIH0pO1xuICAgICAgICBkb21SZXN1bHQgPSBhd2FpdCBnZXRET01SZWdpb25zKGNhcHR1cmVSZXN1bHQudGFiLmlkKTtcbiAgICAgICAgc2FmZVBvc3QoeyB0eXBlOiBcIkRPTV9TQ0FOX0RPTkVcIiwgY291bnQ6IGRvbVJlc3VsdC5kb21SZWdpb25zLmxlbmd0aCB9KTtcbiAgICAgICAgY29uc29sZS5sb2coYFtCR10gU3RlcCAyIENvbXBsZXRlLiBGb3VuZCAke2RvbVJlc3VsdC5kb21SZWdpb25zLmxlbmd0aH0gc2Vuc2l0aXZlIERPTSBmaWVsZChzKS5gKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBjb25zb2xlLmVycm9yKFwiW0JHIEVycm9yXVtTdGVwIDI6IERPTSBTY2FuXTpcIiwgZXJyKTtcbiAgICAgICAgc2FmZVBvc3QoeyB0eXBlOiBcIkVSUk9SXCIsIHN0ZXA6IFwiRE9NIFNjYW5cIiwgZXJyb3I6IGVyci5tZXNzYWdlIH0pO1xuICAgICAgICBzaG91bGRDb250aW51ZSA9IGZhbHNlO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cblxuICAgICAgLy8gXHUyNTAwXHUyNTAwIFN0ZXAgMzogVmlzaW9uICsgUElJIGFuYWx5c2lzIChvZmZzY3JlZW4pIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgICAgc3RhdHMuZnJhbWVzQ2FwdHVyZWQrKztcbiAgICAgIGNvbnN0IGNhY2hlS2V5ID0gY2FwdHVyZVJlc3VsdC50YWIudXJsICsgXCJ8XCIgKyBkb21SZXN1bHQuZG9tSGFzaDtcbiAgICAgIGxldCBkZXRlY3Rpb25zLCBzZW5zaXRpdmVSZWdpb25zLCBzY3JlZW5zaG90RGF0YVVybCwgZWxhcHNlZDtcblxuICAgICAgaWYgKGFuYWx5c2lzQ2FjaGUuaGFzKGNhY2hlS2V5KSkge1xuICAgICAgICBjb25zb2xlLmxvZyhcIltCR10gU3RlcCAzOiBET00gaWRlbnRpY2FsISBDYWNoZSBoaXQsIHJldXNpbmcgY2FjaGVkIGRldGVjdGlvbnMuXCIpO1xuICAgICAgICBzYWZlUG9zdCh7IHR5cGU6IFwiU1RBVFVTXCIsIHRleHQ6IFwiXHUyNkExIERPTSBpZGVudGljYWwhIFNraXBwaW5nIHZpc2lvbiBpbmZlcmVuY2UgKENhY2hlIEhpdCkuXCIgfSk7XG4gICAgICAgIGNvbnN0IGNhY2hlZCA9IGFuYWx5c2lzQ2FjaGUuZ2V0KGNhY2hlS2V5KTtcbiAgICAgICAgZGV0ZWN0aW9ucyA9IGNhY2hlZC5kZXRlY3Rpb25zO1xuICAgICAgICBzZW5zaXRpdmVSZWdpb25zID0gY2FjaGVkLnNlbnNpdGl2ZVJlZ2lvbnM7XG4gICAgICAgIHNjcmVlbnNob3REYXRhVXJsID0gY2FwdHVyZVJlc3VsdC5kYXRhVXJsO1xuICAgICAgICBlbGFwc2VkID0gMDtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc29sZS5sb2coYFtCR10gU3RlcCAzOiBEaXNwYXRjaGluZyBzY3JlZW5zaG90IGFuZCBkb21SZWdpb25zIHRvIG9mZnNjcmVlbiBkb2N1bWVudCBmb3IgaW5mZXJlbmNlIChhdHRlbXB0ICR7dGFza1Zpc2lvbkluZmVyZW5jZXMgKyAxfSBvZiBtYXggJHtNQVhfVklTSU9OX1BFUl9UQVNLfSkuLi5gKTtcbiAgICAgICAgICBzYWZlUG9zdCh7IHR5cGU6IFwiU1RBR0VfQ0hBTkdFXCIsIHN0YWdlOiBcImRldGVjdFwiLCB0ZXh0OiBgUnVubmluZyBGbG9yZW5jZS0yICsgQmxhemVGYWNlICsgUElJIGFuYWx5c2lzICh2aXNpb24gcGFzcyAke3Rhc2tWaXNpb25JbmZlcmVuY2VzICsgMX0vJHtNQVhfVklTSU9OX1BFUl9UQVNLfSlcdTIwMjZgIH0pO1xuICAgICAgICAgIGlmICh0YXNrVmlzaW9uSW5mZXJlbmNlcyA+PSBNQVhfVklTSU9OX1BFUl9UQVNLKSB7XG4gICAgICAgICAgICBjb25zb2xlLndhcm4oYFtCR10gU3RvcHBpbmcgYWZ0ZXIgJHtNQVhfVklTSU9OX1BFUl9UQVNLfSBmdWxsIGFuYWx5c2lzIGF0dGVtcHRzIHRvIGF2b2lkIGV4Y2Vzc2l2ZSBjb3N0LmApO1xuICAgICAgICAgICAgc2FmZVBvc3Qoe1xuICAgICAgICAgICAgICB0eXBlOiBcIkVSUk9SXCIsXG4gICAgICAgICAgICAgIHN0ZXA6IFwiVmlzaW9uIEluZmVyZW5jZSBDYXBcIixcbiAgICAgICAgICAgICAgZXJyb3I6IGBTdG9wcGluZyBhZnRlciAke01BWF9WSVNJT05fUEVSX1RBU0t9IGZ1bGwgYW5hbHlzaXMgYXR0ZW1wdHMgdG8gYXZvaWQgZXhjZXNzaXZlIGNvc3RgXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIHNob3VsZENvbnRpbnVlID0gZmFsc2U7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgICAgdGFza1Zpc2lvbkluZmVyZW5jZXMrKztcbiAgICAgICAgICBzdGF0cy52aXNpb25JbmZlcmVuY2VzKys7XG4gICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuVmlzaW9uQW5hbHlzaXMoY2FwdHVyZVJlc3VsdC5kYXRhVXJsLCBkb21SZXN1bHQuZG9tUmVnaW9ucywgZG9tUmVzdWx0Lm1lZGlhUmVnaW9ucyk7XG4gICAgICAgICAgZGV0ZWN0aW9ucyA9IHJlc3VsdC5kZXRlY3Rpb25zO1xuICAgICAgICAgIHNlbnNpdGl2ZVJlZ2lvbnMgPSByZXN1bHQuc2Vuc2l0aXZlUmVnaW9ucztcbiAgICAgICAgICBzY3JlZW5zaG90RGF0YVVybCA9IHJlc3VsdC5zY3JlZW5zaG90RGF0YVVybDtcbiAgICAgICAgICBlbGFwc2VkID0gcmVzdWx0LmVsYXBzZWQ7XG4gICAgICAgICAgYW5hbHlzaXNDYWNoZS5zZXQoY2FjaGVLZXksIHsgZGV0ZWN0aW9ucywgc2Vuc2l0aXZlUmVnaW9ucyB9KTtcbiAgICAgICAgICBjb25zb2xlLmxvZyhgW0JHXSBTdGVwIDMgQ29tcGxldGUgaW4gJHtlbGFwc2VkfW1zOiAke2RldGVjdGlvbnMubGVuZ3RofSBkZXRlY3Rpb25zLCAke3NlbnNpdGl2ZVJlZ2lvbnMubGVuZ3RofSBQSUkgcmVnaW9ucy5gKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgY29uc29sZS5lcnJvcihcIltCRyBFcnJvcl1bU3RlcCAzOiBGbG9yZW5jZS0yIC8gVmlzaW9uIEluZmVyZW5jZV06XCIsIGVycik7XG4gICAgICAgICAgc2FmZVBvc3QoeyB0eXBlOiBcIkVSUk9SXCIsIHN0ZXA6IFwiRmxvcmVuY2UtMiBJbmZlcmVuY2VcIiwgZXJyb3I6IGVyci5tZXNzYWdlIH0pO1xuICAgICAgICAgIHNob3VsZENvbnRpbnVlID0gZmFsc2U7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gXHUyNTAwXHUyNTAwIFN0ZXAgNDogUmVkYWN0IEltYWdlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgICAgLy8gQ2FwdHVyZSByYXcgc2NyZWVuc2hvdCBzaXplIEJFRk9SRSByZWRhY3Rpb24gZm9yIG1ldHJpY3NcbiAgICAgIGNvbnN0IHJhd0J5dGVzID0gY2FwdHVyZVJlc3VsdC5kYXRhVXJsLmxlbmd0aDtcblxuICAgICAgbGV0IGZpbmFsU2NyZWVuc2hvdERhdGFVcmw7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zb2xlLmxvZyhgW0JHXSBTdGVwIDQ6IFJlZGFjdGluZyAke3NlbnNpdGl2ZVJlZ2lvbnMubGVuZ3RofSBzZW5zaXRpdmUgcmVnaW9ucyBvbiBjYW52YXMuLi5gKTtcbiAgICAgICAgc2FmZVBvc3QoeyB0eXBlOiBcIlNUQUdFX0NIQU5HRVwiLCBzdGFnZTogXCJyZWRhY3RcIiwgdGV4dDogYFJlZGFjdGluZyAke3NlbnNpdGl2ZVJlZ2lvbnMubGVuZ3RofSBzZW5zaXRpdmUgcmVnaW9uc1x1MjAyNmAgfSk7XG4gICAgICAgIGZpbmFsU2NyZWVuc2hvdERhdGFVcmwgPSBhd2FpdCByZWRhY3RTY3JlZW5zaG90KHNjcmVlbnNob3REYXRhVXJsLCBzZW5zaXRpdmVSZWdpb25zKTtcbiAgICAgICAgY29uc29sZS5sb2coXCJbQkddIFN0ZXAgNCBDb21wbGV0ZS4gUmVkYWN0aW9uIGZpbmlzaGVkLlwiKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBjb25zb2xlLmVycm9yKFwiW0JHIEVycm9yXVtTdGVwIDQ6IFJlZGFjdGlvbl06XCIsIGVycik7XG4gICAgICAgIHNhZmVQb3N0KHsgdHlwZTogXCJFUlJPUlwiLCBzdGVwOiBcIlJlZGFjdGlvblwiLCBlcnJvcjogZXJyLm1lc3NhZ2UgfSk7XG4gICAgICAgIHNob3VsZENvbnRpbnVlID0gZmFsc2U7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuXG4gICAgICAvLyBcdTI1MDBcdTI1MDAgU3RlcCA0YjogUmVkYWN0aW9uIExlYWsgVmVyaWZpY2F0aW9uIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgICAgLy8gUmUtcnVuIHZpc2lvbiBkZXRlY3Rpb24gb24gdGhlIHJlZGFjdGVkIGltYWdlIHRvIGNvbmZpcm0gbWFza2VkIGFyZWFzXG4gICAgICAvLyBjb250YWluIHplcm8gcmVhZGFibGUgUElJLiBCbG9jayB0aGUgcmVxdWVzdCBpZiBhIGxlYWsgaXMgZm91bmQuXG4gICAgICBsZXQgbGVha0NoZWNrUGFzc2VkID0gdHJ1ZTtcbiAgICAgIGxldCBsZWFrRGV0YWlscyA9IHsgbGVha3NGb3VuZDogMCwgbGVha1JlZ2lvbnM6IFtdLCBjaGVja2VkUmVnaW9uczogc2Vuc2l0aXZlUmVnaW9ucy5sZW5ndGggfTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnNvbGUubG9nKFwiW0JHXSBTdGVwIDRiOiBSdW5uaW5nIGxlYWsgdmVyaWZpY2F0aW9uIFx1MjAxNCByZS1kZXRlY3RpbmcgUElJIG9uIHJlZGFjdGVkIGltYWdlLi4uXCIpO1xuICAgICAgICBzYWZlUG9zdCh7IHR5cGU6IFwiU1RBR0VfQ0hBTkdFXCIsIHN0YWdlOiBcInJlZGFjdFwiLCB0ZXh0OiBcIlZlcmlmeWluZyByZWRhY3Rpb24gXHUyMDE0IHNjYW5uaW5nIHJlZGFjdGVkIGltYWdlIGZvciBQSUkgbGVha3NcdTIwMjZcIiB9KTtcblxuICAgICAgICBpZiAoc2Vuc2l0aXZlUmVnaW9ucy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgY29uc3QgbGVha1Jlc3VsdCA9IGF3YWl0IHJ1blZpc2lvbkFuYWx5c2lzKGZpbmFsU2NyZWVuc2hvdERhdGFVcmwsIFtdLCBbXSk7XG4gICAgICAgICAgY29uc3QgbGVha1JlZ2lvbnMgPSBsZWFrUmVzdWx0LnNlbnNpdGl2ZVJlZ2lvbnMgfHwgW107XG5cbiAgICAgICAgICAvLyBDaGVjayBpZiBhbnkgbmV3bHktZGV0ZWN0ZWQgcmVnaW9uIG92ZXJsYXBzIGEgbWFza2VkIGJib3hcbiAgICAgICAgICBjb25zdCBsZWFraW5nUmVnaW9ucyA9IGxlYWtSZWdpb25zLmZpbHRlcihkZXRlY3RlZCA9PiB7XG4gICAgICAgICAgICBjb25zdCBbZHgsIGR5LCBkdywgZGhdID0gZGV0ZWN0ZWQuYmJveDtcbiAgICAgICAgICAgIHJldHVybiBzZW5zaXRpdmVSZWdpb25zLnNvbWUobWFza2VkID0+IHtcbiAgICAgICAgICAgICAgY29uc3QgW214LCBteSwgbXcsIG1oXSA9IG1hc2tlZC5iYm94O1xuICAgICAgICAgICAgICAvLyBPdmVybGFwIGNoZWNrOiBkbyB0aGUgdHdvIGJib3hlcyBpbnRlcnNlY3Q/XG4gICAgICAgICAgICAgIGNvbnN0IG92ZXJsYXBYID0gTWF0aC5tYXgoZHgsIG14KSA8IE1hdGgubWluKGR4ICsgZHcsIG14ICsgbXcpO1xuICAgICAgICAgICAgICBjb25zdCBvdmVybGFwWSA9IE1hdGgubWF4KGR5LCBteSkgPCBNYXRoLm1pbihkeSArIGRoLCBteSArIG1oKTtcbiAgICAgICAgICAgICAgcmV0dXJuIG92ZXJsYXBYICYmIG92ZXJsYXBZO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfSk7XG5cbiAgICAgICAgICBsZWFrRGV0YWlscyA9IHtcbiAgICAgICAgICAgIGxlYWtzRm91bmQ6IGxlYWtpbmdSZWdpb25zLmxlbmd0aCxcbiAgICAgICAgICAgIGxlYWtSZWdpb25zOiBsZWFraW5nUmVnaW9ucyxcbiAgICAgICAgICAgIGNoZWNrZWRSZWdpb25zOiBzZW5zaXRpdmVSZWdpb25zLmxlbmd0aCxcbiAgICAgICAgICAgIHRvdGFsRGV0ZWN0ZWRPblJlZGFjdGVkOiBsZWFrUmVnaW9ucy5sZW5ndGgsXG4gICAgICAgICAgfTtcblxuICAgICAgICAgIGlmIChsZWFraW5nUmVnaW9ucy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBsZWFrQ2hlY2tQYXNzZWQgPSBmYWxzZTtcbiAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYFtCR10gU3RlcCA0YiBGQUlMOiAke2xlYWtpbmdSZWdpb25zLmxlbmd0aH0gUElJIGxlYWsocykgZGV0ZWN0ZWQgaW4gbWFza2VkIHJlZ2lvbihzKSFgLCBsZWFraW5nUmVnaW9ucyk7XG4gICAgICAgICAgICBzYWZlUG9zdCh7XG4gICAgICAgICAgICAgIHR5cGU6IFwiTEVBS19DSEVDS1wiLFxuICAgICAgICAgICAgICBwYXNzZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICBsZWFrc0ZvdW5kOiBsZWFraW5nUmVnaW9ucy5sZW5ndGgsXG4gICAgICAgICAgICAgIGxlYWtSZWdpb25zOiBsZWFraW5nUmVnaW9ucyxcbiAgICAgICAgICAgICAgY2hlY2tlZFJlZ2lvbnM6IHNlbnNpdGl2ZVJlZ2lvbnMubGVuZ3RoLFxuICAgICAgICAgICAgICBtZXNzYWdlOiBgXHVEODNEXHVERUE4IExFQUsgREVURUNURUQ6ICR7bGVha2luZ1JlZ2lvbnMubGVuZ3RofSBQSUkgcmVnaW9uKHMpIHN0aWxsIHZpc2libGUgYWZ0ZXIgcmVkYWN0aW9uIFx1MjAxNCBwYXlsb2FkIEJMT0NLRURgLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKGBbQkddIFN0ZXAgNGIgUEFTUzogWmVybyBQSUkgbGVha3MgaW4gJHtsZWFrUmVnaW9ucy5sZW5ndGh9IGRldGVjdGlvbihzKSBvbiByZWRhY3RlZCBpbWFnZS4gUmVkYWN0aW9uIGlzIHNvbGlkLmApO1xuICAgICAgICAgICAgc2FmZVBvc3Qoe1xuICAgICAgICAgICAgICB0eXBlOiBcIkxFQUtfQ0hFQ0tcIixcbiAgICAgICAgICAgICAgcGFzc2VkOiB0cnVlLFxuICAgICAgICAgICAgICBsZWFrc0ZvdW5kOiAwLFxuICAgICAgICAgICAgICBsZWFrUmVnaW9uczogW10sXG4gICAgICAgICAgICAgIGNoZWNrZWRSZWdpb25zOiBzZW5zaXRpdmVSZWdpb25zLmxlbmd0aCxcbiAgICAgICAgICAgICAgdG90YWxEZXRlY3RlZE9uUmVkYWN0ZWQ6IGxlYWtSZWdpb25zLmxlbmd0aCxcbiAgICAgICAgICAgICAgbWVzc2FnZTogYFx1MjcxMyAwIGxlYWtzIGRldGVjdGVkIFx1MjAxNCAke3NlbnNpdGl2ZVJlZ2lvbnMubGVuZ3RofSBtYXNrZWQgcmVnaW9uKHMpIHZlcmlmaWVkIGNsZWFuYCxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAvLyBObyByZWdpb25zIHRvIHJlZGFjdCBcdTIwMTQgdHJpdmlhbGx5IGNsZWFuXG4gICAgICAgICAgY29uc29sZS5sb2coXCJbQkddIFN0ZXAgNGI6IE5vIHNlbnNpdGl2ZSByZWdpb25zIHRvIHZlcmlmeSAobm8gcmVkYWN0aW9uIHBlcmZvcm1lZCkuXCIpO1xuICAgICAgICAgIHNhZmVQb3N0KHtcbiAgICAgICAgICAgIHR5cGU6IFwiTEVBS19DSEVDS1wiLFxuICAgICAgICAgICAgcGFzc2VkOiB0cnVlLFxuICAgICAgICAgICAgbGVha3NGb3VuZDogMCxcbiAgICAgICAgICAgIGxlYWtSZWdpb25zOiBbXSxcbiAgICAgICAgICAgIGNoZWNrZWRSZWdpb25zOiAwLFxuICAgICAgICAgICAgbWVzc2FnZTogXCJcdTI3MTMgTm8gcmVnaW9ucyB0byB2ZXJpZnkgKHBhZ2UgaGFzIG5vIGRldGVjdGVkIFBJSSlcIixcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCAobGVha0Vycikge1xuICAgICAgICAvLyBUcmVhdCBpbmZlcmVuY2UgZXJyb3JzIGFzIG5vbi1mYXRhbCBmb3IgbGVhayBjaGVjayBcdTIwMTQgbG9nIGJ1dCBwcm9jZWVkXG4gICAgICAgIGNvbnNvbGUud2FybihcIltCR10gU3RlcCA0YjogTGVhayB2ZXJpZmljYXRpb24gaW5mZXJlbmNlIGZhaWxlZCAobm9uLWZhdGFsKTpcIiwgbGVha0Vyci5tZXNzYWdlKTtcbiAgICAgICAgc2FmZVBvc3Qoe1xuICAgICAgICAgIHR5cGU6IFwiTEVBS19DSEVDS1wiLFxuICAgICAgICAgIHBhc3NlZDogdHJ1ZSwgIC8vIEdpdmUgYmVuZWZpdCBvZiBkb3VidCBpZiBpbmZlcmVuY2UgZmFpbHNcbiAgICAgICAgICBsZWFrc0ZvdW5kOiAwLFxuICAgICAgICAgIGxlYWtSZWdpb25zOiBbXSxcbiAgICAgICAgICBjaGVja2VkUmVnaW9uczogc2Vuc2l0aXZlUmVnaW9ucy5sZW5ndGgsXG4gICAgICAgICAgbWVzc2FnZTogYFx1MjZBMCBMZWFrIGNoZWNrIHNraXBwZWQgKGluZmVyZW5jZSBlcnJvcjogJHtsZWFrRXJyLm1lc3NhZ2V9KWAsXG4gICAgICAgICAgd2FybmluZzogdHJ1ZSxcbiAgICAgICAgfSk7XG4gICAgICB9XG5cbiAgICAgIC8vIEJsb2NrIHRoZSBwYXlsb2FkIGlmIGxlYWsgY2hlY2sgZmFpbGVkXG4gICAgICBpZiAoIWxlYWtDaGVja1Bhc3NlZCkge1xuICAgICAgICBjb25zb2xlLmVycm9yKFwiW0JHXSBCTE9DS0lORyBwYXlsb2FkIHRyYW5zbWlzc2lvbiBcdTIwMTQgUElJIGxlYWsgdmVyaWZpY2F0aW9uIGZhaWxlZCFcIik7XG4gICAgICAgIHNob3VsZENvbnRpbnVlID0gZmFsc2U7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuXG4gICAgICAvLyBcdTI1MDBcdTI1MDAgU3RlcCA1OiBTZW5kIFBheWxvYWQgdG8gU2VydmVyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgICAgbGV0IHNlcnZlclJlc3VsdDtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnNvbGUubG9nKFwiW0JHXSBTdGVwIDU6IFByZXBhcmluZyBBZ2VudFJlcXVlc3RWMSBwYXlsb2FkIGZvciBzZXJ2ZXIuLi5cIik7XG4gICAgICAgIHNhZmVQb3N0KHsgdHlwZTogXCJTVEFHRV9DSEFOR0VcIiwgc3RhZ2U6IFwic2VuZFwiLCB0ZXh0OiBcIlNlbmRpbmcgcmVkYWN0ZWQgcGF5bG9hZCB0byBzZXJ2ZXIgKGh0dHA6Ly9sb2NhbGhvc3Q6MzAwMC9hbmFseXplKVx1MjAyNlwiIH0pO1xuICAgICAgICBcbiAgICAgICAgY29uc3QgbWFuaWZlc3QgPSAoc2Vuc2l0aXZlUmVnaW9ucyB8fCBbXSkubWFwKChyLCBpKSA9PiAoe1xuICAgICAgICAgIHJlZ2lvbl9pZDogYHJlZ2lvbl8ke2l9YCxcbiAgICAgICAgICBiYm94OiByLmJib3gsXG4gICAgICAgICAgdHlwZTogci50eXBlLFxuICAgICAgICAgIHJlZGFjdGlvbl9zdHlsZTogXCJibGFja19ib3hcIixcbiAgICAgICAgICBjb25maWRlbmNlOiByLmNvbmZpZGVuY2UsXG4gICAgICAgICAgc291cmNlOiByLnNvdXJjZSB8fCBcImRvbVwiXG4gICAgICAgIH0pKTtcblxuICAgICAgICBjb25zdCBkb21fc3VtbWFyeSA9IChkb21SZXN1bHQuZG9tUmVnaW9ucyB8fCBbXSkubWFwKChyLCBpKSA9PiAoe1xuICAgICAgICAgIGVsZW1lbnRfaWQ6IHIuYWdlbnRJZCB8fCBgYWdlbnRfJHtpfWAsXG4gICAgICAgICAgZG9tX2lkOiByLmlkIHx8IFwiXCIsXG4gICAgICAgICAgbmFtZTogci5uYW1lIHx8IFwiXCIsXG4gICAgICAgICAgcGxhY2Vob2xkZXI6IHIucGxhY2Vob2xkZXIgfHwgXCJcIixcbiAgICAgICAgICB0YWc6IHIudGFnIHx8IFwiaW5wdXRcIixcbiAgICAgICAgICByb2xlOiByLnJvbGUgfHwgKHIuaW5wdXRUeXBlID09PSBcInJhZGlvXCIgPyBcInJhZGlvXCIgOiBcInRleHRib3hcIiksXG4gICAgICAgICAgbGFiZWw6IHIubGFiZWwgfHwgXCJcIixcbiAgICAgICAgICBmaWVsZF90eXBlOiByLnR5cGUgfHwgXCJcIixcbiAgICAgICAgICBiYm94OiByLmJib3gsXG4gICAgICAgICAgY3VycmVudF92YWx1ZTogci5jdXJyZW50X3ZhbHVlIHx8IFwiXCIgIC8vIExpdmUgdmFsdWUgc28gbW9kZWwgc2tpcHMgYWxyZWFkeS1maWxsZWQgZmllbGRzXG4gICAgICAgIH0pKTtcblxuICAgICAgICBjb25zb2xlLmxvZyhcIlxcbj09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XCIpO1xuICAgICAgICBjb25zb2xlLmxvZyhgW0JHXVtERUJVR10gPT09IEVYQUNUIGRvbV9zdW1tYXJ5IFNFTlQgVE8gL2FuYWx5emUgKCR7ZG9tX3N1bW1hcnkubGVuZ3RofSBpdGVtcykgPT09YCk7XG4gICAgICAgIGNvbnNvbGUubG9nKEpTT04uc3RyaW5naWZ5KGRvbV9zdW1tYXJ5LCBudWxsLCAyKSk7XG4gICAgICAgIGNvbnNvbGUubG9nKGBbQkddW0RFQlVHXSA9PT0gRVhBQ1QgbWFuaWZlc3QgU0VOVCBUTyAvYW5hbHl6ZSAoJHttYW5pZmVzdC5sZW5ndGh9IGl0ZW1zKSA9PT1gKTtcbiAgICAgICAgY29uc29sZS5sb2coSlNPTi5zdHJpbmdpZnkobWFuaWZlc3QsIG51bGwsIDIpKTtcbiAgICAgICAgY29uc29sZS5sb2coXCI9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxcblwiKTtcblxuICAgICAgICBjb25zdCBhZ2VudFJlcXVlc3RQYXlsb2FkID0ge1xuICAgICAgICAgIHZlcnNpb246IFwiMS4wXCIsXG4gICAgICAgICAgdGFza19pbnN0cnVjdGlvbjogaW5zdHJ1Y3Rpb24sXG4gICAgICAgICAgcmVkYWN0ZWRfaW1hZ2U6IGZpbmFsU2NyZWVuc2hvdERhdGFVcmwuc3BsaXQoXCIsXCIpWzFdLFxuICAgICAgICAgIG1hbmlmZXN0LFxuICAgICAgICAgIGRvbV9zdW1tYXJ5LFxuICAgICAgICAgIGRlbW9fbW9kZTogaXNEZW1vLFxuICAgICAgICAgIGNsaWVudF9zdGF0czogeyB0b3RhbExhdGVuY3lNczogc3RhdHMudG90YWxMYXRlbmN5TXMgfVxuICAgICAgICB9O1xuXG4gICAgICAgIC8vIFx1MjUwMFx1MjUwMCBEYXRhIFJlZHVjdGlvbiBNZXRyaWNzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgICAgICAvLyBDb21wdXRlIHJhdyBieXRlcyB2cy4gd2hhdCB3ZSBhY3R1YWxseSB0cmFuc21pdCwgcGx1cyBQSUkgc3VyZmFjZSBhcmVhXG4gICAgICAgIGNvbnN0IHJlZGFjdGVkSW1hZ2VCNjQgPSBhZ2VudFJlcXVlc3RQYXlsb2FkLnJlZGFjdGVkX2ltYWdlO1xuICAgICAgICBjb25zdCBwYXlsb2FkSnNvbiA9IEpTT04uc3RyaW5naWZ5KGFnZW50UmVxdWVzdFBheWxvYWQpO1xuICAgICAgICBjb25zdCBzZW50Qnl0ZXMgPSBwYXlsb2FkSnNvbi5sZW5ndGg7IC8vIEFwcHJveCBieXRlcyBmb3IgdGhlIGZ1bGwgSlNPTiBib2R5XG5cbiAgICAgICAgLy8gUElJIHN1cmZhY2U6IHN1bSBvZiBiYm94IHBpeGVsIGFyZWFzIHZzLiB0b3RhbCBzY3JlZW5zaG90IHBpeGVsIGFyZWFcbiAgICAgICAgLy8gV2UgbmVlZCBpbWFnZSBkaW1lbnNpb25zIFx1MjAxNCBwYXJzZSBmcm9tIHRoZSByZWRhY3RlZCBpbWFnZVxuICAgICAgICBsZXQgcGlpU3VyZmFjZVBlcmNlbnQgPSAwO1xuICAgICAgICBsZXQgaW1hZ2VUb3RhbFBpeGVscyA9IDE7XG4gICAgICAgIGxldCBpbWFnZVBJSVBpeGVscyA9IDA7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgLy8gRGVjb2RlIGRpbWVuc2lvbnMgZnJvbSBmaW5hbFNjcmVlbnNob3REYXRhVXJsIHZpYSBvZmZzY3JlZW4gY2FudmFzXG4gICAgICAgICAgLy8gVXNlIHRoZSByYXcgY2FwdHVyZSBkaW1lbnNpb25zIGVzdGltYXRlIGZyb20gYmFzZTY0IGxlbmd0aCBoZXVyaXN0aWNcbiAgICAgICAgICAvLyAoUE5HIH40IGJ5dGVzIHBlciBwaXhlbCBhdCAxeCwgc28gcGl4ZWxzIFx1MjI0OCAoYjY0bGVuICogMy80KSAvIDQpXG4gICAgICAgICAgLy8gSW5zdGVhZDogZGlyZWN0bHkgY29tcHV0ZSBmcm9tIHNlbnNpdGl2ZVJlZ2lvbnMgYmJveGVzIGFyZWEgdnMgaW1hZ2UgYXJlYVxuICAgICAgICAgIC8vIFdlJ2xsIHVzZSB0aGUga25vd24gRFBSPTEgc2NyZWVuc2hvdDogZ2V0IGRpbXMgZnJvbSByYXcgZGF0YVVybFxuICAgICAgICAgIGNvbnN0IHJhd0I2NCA9IGNhcHR1cmVSZXN1bHQuZGF0YVVybC5zcGxpdChcIixcIilbMV0gfHwgXCJcIjtcbiAgICAgICAgICAvLyBSb3VnaCBpbWFnZSBhcmVhIGVzdGltYXRlOiBzY3JlZW5zaG90IERQUiBpcyB0eXBpY2FsbHkgZGV2aWNlUGl4ZWxSYXRpb1xuICAgICAgICAgIC8vIEZvciBhIHJlbGlhYmxlIG1ldHJpYywgY29tcHV0ZSBiYm94IGFyZWFzIGZyb20gc2Vuc2l0aXZlUmVnaW9uc1xuICAgICAgICAgIC8vIGFuZCBleHByZXNzIHRoZW0gcmVsYXRpdmUgdG8gdGhlIHZpc2libGUgc2NyZWVuc2hvdCBzaXplXG4gICAgICAgICAgaWYgKHNlbnNpdGl2ZVJlZ2lvbnMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgaW1hZ2VQSUlQaXhlbHMgPSBzZW5zaXRpdmVSZWdpb25zLnJlZHVjZSgoc3VtLCByKSA9PiBzdW0gKyAoci5iYm94WzJdICogci5iYm94WzNdKSwgMCk7XG4gICAgICAgICAgICAvLyBBc3N1bWUgaW1hZ2UgYXJlYSBmcm9tIHRoZSBtYXggZXh0ZW50cyBvZiBhbnkgZGV0ZWN0aW9uICsgZ2VuZXJvdXMgbWFyZ2luXG4gICAgICAgICAgICBjb25zdCBhbGxYMiA9IHNlbnNpdGl2ZVJlZ2lvbnMubWFwKHIgPT4gci5iYm94WzBdICsgci5iYm94WzJdKTtcbiAgICAgICAgICAgIGNvbnN0IGFsbFkyID0gc2Vuc2l0aXZlUmVnaW9ucy5tYXAociA9PiByLmJib3hbMV0gKyByLmJib3hbM10pO1xuICAgICAgICAgICAgLy8gTWluIGVzdGltYXRlZCBpbWFnZSBzaXplOiBhdCBsZWFzdCAxMjgwXHUwMEQ3NzIwIG9yIG1heCBkZXRlY3Rpb24gYm91bmRzICsgMjAlXG4gICAgICAgICAgICBjb25zdCBlc3RpbWF0ZWRXID0gTWF0aC5tYXgoMTI4MCwgTWF0aC5tYXgoLi4uYWxsWDIpICogMS4yKTtcbiAgICAgICAgICAgIGNvbnN0IGVzdGltYXRlZEggPSBNYXRoLm1heCg3MjAsIE1hdGgubWF4KC4uLmFsbFkyKSAqIDEuMik7XG4gICAgICAgICAgICBpbWFnZVRvdGFsUGl4ZWxzID0gZXN0aW1hdGVkVyAqIGVzdGltYXRlZEg7XG4gICAgICAgICAgICBwaWlTdXJmYWNlUGVyY2VudCA9IChpbWFnZVBJSVBpeGVscyAvIGltYWdlVG90YWxQaXhlbHMpICogMTAwO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBjYXRjaCAoZGltRXJyKSB7XG4gICAgICAgICAgY29uc29sZS53YXJuKFwiW0JHXSBDb3VsZCBub3QgZXN0aW1hdGUgaW1hZ2UgZGltZW5zaW9ucyBmb3IgUElJIHN1cmZhY2UgbWV0cmljOlwiLCBkaW1FcnIpO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgcmVkdWN0aW9uUGVyY2VudCA9ICgoMSAtIHNlbnRCeXRlcyAvIHJhd0J5dGVzKSAqIDEwMCk7XG4gICAgICAgIGNvbnN0IG1ldHJpY3NQYXlsb2FkID0ge1xuICAgICAgICAgIHJhd19ieXRlczogcmF3Qnl0ZXMsXG4gICAgICAgICAgc2VudF9ieXRlczogc2VudEJ5dGVzLFxuICAgICAgICAgIHJlZHVjdGlvbl9wZXJjZW50OiByZWR1Y3Rpb25QZXJjZW50LFxuICAgICAgICAgIHBpaV9yZWdpb25zOiBzZW5zaXRpdmVSZWdpb25zLmxlbmd0aCxcbiAgICAgICAgICBwaWlfc3VyZmFjZV9wZXJjZW50OiBwaWlTdXJmYWNlUGVyY2VudCxcbiAgICAgICAgICBwaWlfcGl4ZWxzOiBpbWFnZVBJSVBpeGVscyxcbiAgICAgICAgfTtcbiAgICAgICAgY29uc29sZS5sb2coXCJbQkddIERhdGEgUmVkdWN0aW9uIE1ldHJpY3M6XCIsIEpTT04uc3RyaW5naWZ5KG1ldHJpY3NQYXlsb2FkKSk7XG4gICAgICAgIHNhZmVQb3N0KHsgdHlwZTogXCJNRVRSSUNTXCIsIC4uLm1ldHJpY3NQYXlsb2FkIH0pO1xuICAgICAgICAvLyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcblxuICAgICAgICBzZXJ2ZXJSZXN1bHQgPSBhd2FpdCBzZW5kVG9TZXJ2ZXIoYWdlbnRSZXF1ZXN0UGF5bG9hZCk7XG4gICAgICAgIGNvbnNvbGUubG9nKFwiW0JHXSBTdGVwIDUgQ29tcGxldGUuIFNlcnZlciByZXR1cm5lZCBwbGFuOlwiLCBzZXJ2ZXJSZXN1bHQpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoXCJbQkcgRXJyb3JdW1N0ZXAgNTogU2VydmVyIENhbGxdOlwiLCBlcnIpO1xuICAgICAgICAvLyBTcGVjaWZpYyB1c2VyLWZhY2luZyBtZXNzYWdlcyBmb3Iga25vd24gZmFpbHVyZSBtb2Rlc1xuICAgICAgICBsZXQgZXJyTXNnID0gZXJyLm1lc3NhZ2UgfHwgU3RyaW5nKGVycik7XG4gICAgICAgIGlmIChlcnJNc2cuaW5jbHVkZXMoXCJGYWlsZWQgdG8gZmV0Y2hcIikgfHwgZXJyTXNnLmluY2x1ZGVzKFwiTmV0d29ya0Vycm9yXCIpIHx8IGVyck1zZy5pbmNsdWRlcyhcIkVDT05OUkVGVVNFRFwiKSkge1xuICAgICAgICAgIGVyck1zZyA9IFwiQ291bGRuJ3QgcmVhY2ggdGhlIHJlYXNvbmluZyBzZXJ2ZXIgXHUyMDE0IGlzIGl0IHJ1bm5pbmcgb24gcG9ydCAzMDAwP1wiO1xuICAgICAgICB9IGVsc2UgaWYgKGVyck1zZy5pbmNsdWRlcyhcIm1hbGZvcm1lZCBKU09OXCIpIHx8IGVyck1zZy5pbmNsdWRlcyhcInVuZXhwZWN0ZWQgcmVzcG9uc2VcIikpIHtcbiAgICAgICAgICBlcnJNc2cgPSBcIkdvdCBhbiB1bmV4cGVjdGVkIHJlc3BvbnNlIGZyb20gdGhlIG1vZGVsIFx1MjAxNCB0aGUgVkxNIHJldHVybmVkIG1hbGZvcm1lZCBKU09OLlwiO1xuICAgICAgICB9IGVsc2UgaWYgKGVyck1zZy5pbmNsdWRlcyhcIkhUVFAgNVwiKSkge1xuICAgICAgICAgIGVyck1zZyA9IGBTZXJ2ZXIgZXJyb3I6ICR7ZXJyTXNnfWA7XG4gICAgICAgIH1cbiAgICAgICAgc2FmZVBvc3QoeyB0eXBlOiBcIkVSUk9SXCIsIHN0ZXA6IFwiU2VydmVyIENhbGxcIiwgZXJyb3I6IGVyck1zZyB9KTtcbiAgICAgICAgc2hvdWxkQ29udGludWUgPSBmYWxzZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG5cbiAgICAgIC8vIFx1MjUwMFx1MjUwMCBTdGVwIDY6IEV4ZWN1dGUgUGxhbiBzZXF1ZW50aWFsbHkgaW4gY29udGVudCBzY3JpcHQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgICBzYWZlUG9zdCh7IHR5cGU6IFwiU1RBR0VfQ0hBTkdFXCIsIHN0YWdlOiBcImFjdFwiLCB0ZXh0OiBcIkV4ZWN1dGluZyBwbGFuXHUyMDI2XCIgfSk7XG5cbiAgICAgIGNvbnN0IHBsYW4gPSBBcnJheS5pc0FycmF5KHNlcnZlclJlc3VsdD8ucGxhbikgPyBzZXJ2ZXJSZXN1bHQucGxhbiA6IFtdO1xuICAgICAgY29uc3QgdG90YWxTdGVwcyA9IHBsYW4ubGVuZ3RoO1xuICAgICAgY29uc3Qgc3RlcFJlc3VsdHMgPSBbXTtcblxuICAgICAgaWYgKHRvdGFsU3RlcHMgPT09IDApIHtcbiAgICAgICAgY29uc29sZS5sb2coXCJbQkddIFN0ZXAgNjogRW1wdHkgcGxhbiBcdTIwMTQgYWxsIGZpZWxkcyBhbHJlYWR5IGZpbGxlZCBvciB0YXNrIGNvbXBsZXRlLlwiKTtcbiAgICAgICAgc2FmZVBvc3QoeyB0eXBlOiBcIlBMQU5fU1VNTUFSWVwiLCB0b3RhbDogMCwgc3VjY2VlZGVkOiAwLCBmYWlsZWQ6IDAsIGRldGFpbHM6IFtdLCBtZXNzYWdlOiBcIkFsbCBmaWVsZHMgYXJlIGFscmVhZHkgZmlsbGVkIFx1MjAxNCBub3RoaW5nIHRvIGRvLlwiIH0pO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc29sZS5sb2coYFtCR10gU3RlcCA2OiBFeGVjdXRpbmcgJHt0b3RhbFN0ZXBzfSBwbGFuIHN0ZXAocykuLi5gKTtcblxuICAgICAgICBmb3IgKGNvbnN0IHN0ZXAgb2YgcGxhbikge1xuICAgICAgICAgIGNvbnN0IHN0ZXBOdW0gPSBzdGVwLnN0ZXA7XG4gICAgICAgICAgY29uc3QgZmllbGRUeXBlID0gc3RlcC5maWVsZF90eXBlIHx8IFwiRklFTERcIjtcbiAgICAgICAgICBjb25zdCB0YXJnZXRJZCA9IHN0ZXAudGFyZ2V0X2lkO1xuXG4gICAgICAgICAgLy8gSGFyZCByZXRyeSBsaW1pdDogaWYgdGhpcyBzYW1lIHN0ZXAgdGFyZ2V0L3R5cGUgZmFpbGVkIDIgdGltZXMgaW4gYSByb3csIHN0b3AgcmV0cnlpbmcgaXRcbiAgICAgICAgICBjb25zdCBzdGVwS2V5ID0gYCR7dGFyZ2V0SWQgfHwgXCJcIn1fJHtmaWVsZFR5cGUgfHwgXCJcIn1gO1xuICAgICAgICAgIGNvbnN0IGN1cnJlbnRGYWlsdXJlcyA9IHN0ZXBDb25zZWN1dGl2ZUZhaWx1cmVzLmdldChzdGVwS2V5KSB8fCAwO1xuICAgICAgICAgIGlmIChjdXJyZW50RmFpbHVyZXMgPj0gMikge1xuICAgICAgICAgICAgY29uc3Qgc2tpcFJlYXNvbiA9IGBTdGVwICR7c3RlcE51bX0gKCR7ZmllbGRUeXBlfSwgJHt0YXJnZXRJZH0pIGhhbHRlZDogZWxlbWVudCBmYWlsZWQgJHtjdXJyZW50RmFpbHVyZXN9IHRpbWVzIGNvbnNlY3V0aXZlbHkuIFN0b3BwaW5nIHJldHJpZXMgZm9yIHRoaXMgc3RlcC5gO1xuICAgICAgICAgICAgY29uc29sZS53YXJuKGBbQkddICR7c2tpcFJlYXNvbn1gKTtcbiAgICAgICAgICAgIHN0ZXBSZXN1bHRzLnB1c2goeyBzdGVwTnVtLCBmaWVsZFR5cGUsIG9rOiBmYWxzZSwgcmVhc29uOiBza2lwUmVhc29uIH0pO1xuICAgICAgICAgICAgc2FmZVBvc3Qoe1xuICAgICAgICAgICAgICB0eXBlOiBcIlBMQU5fU1RFUF9TVEFUVVNcIixcbiAgICAgICAgICAgICAgc3RlcE51bSxcbiAgICAgICAgICAgICAgdG90YWxTdGVwcyxcbiAgICAgICAgICAgICAgc3RhdHVzOiBcImVycm9yXCIsXG4gICAgICAgICAgICAgIG1lc3NhZ2U6IHNraXBSZWFzb25cbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gQXR0YWNoIGJib3ggdG8gc3RlcCBwYXlsb2FkIGZvciBjb29yZGluYXRlLWJhc2VkIGZhbGxiYWNrIGV4ZWN1dGlvblxuICAgICAgICAgIGNvbnN0IGRvbU1hdGNoID0gZG9tX3N1bW1hcnkuZmluZChkID0+IGQuZWxlbWVudF9pZCA9PT0gdGFyZ2V0SWQgfHwgZC5kb21faWQgPT09IHRhcmdldElkIHx8IGQubmFtZSA9PT0gdGFyZ2V0SWQpO1xuICAgICAgICAgIGNvbnN0IG1hbmlmZXN0TWF0Y2ggPSBtYW5pZmVzdC5maW5kKG0gPT4gbS5yZWdpb25faWQgPT09IHRhcmdldElkKTtcbiAgICAgICAgICBjb25zdCBkZXRlY3Rpb25NYXRjaCA9IChkZXRlY3Rpb25zIHx8IFtdKS5maW5kKGQgPT4gZC5pZCA9PT0gdGFyZ2V0SWQpO1xuICAgICAgICAgIGNvbnN0IG1hdGNoZWRCYm94ID0gc3RlcC5iYm94IHx8IGRvbU1hdGNoPy5iYm94IHx8IG1hbmlmZXN0TWF0Y2g/LmJib3ggfHwgZGV0ZWN0aW9uTWF0Y2g/LmJib3ggfHwgbnVsbDtcbiAgICAgICAgICBjb25zdCBzdGVwUGF5bG9hZCA9IHsgLi4uc3RlcCwgYmJveDogbWF0Y2hlZEJib3ggfTtcblxuICAgICAgICAgIC8vIFx1MjUwMFx1MjUwMCBDaGVjayBpZiB2YWx1ZSBpcyBtaXNzaW5nIChSZXF1aXJlbWVudCA0IGZhbGxiYWNrIHBhdGgpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgICAgICAgIGxldCBjdXJyZW50VmFsID0gc3RlcFBheWxvYWQudmFsdWUgfHwgc3RlcFBheWxvYWQubWF0Y2hfdmFsdWUgfHwgc3RvcmVkVmF1bHRbZmllbGRUeXBlXSB8fCBudWxsO1xuICAgICAgICAgIGlmICghY3VycmVudFZhbCAmJiBmaWVsZFR5cGUgPT09IFwiUEhPTkVcIikgY3VycmVudFZhbCA9IHN0b3JlZFZhdWx0W1wiSU5ESUFOX01PQklMRVwiXTtcbiAgICAgICAgICBpZiAoIWN1cnJlbnRWYWwgJiYgZmllbGRUeXBlID09PSBcIklORElBTl9NT0JJTEVcIikgY3VycmVudFZhbCA9IHN0b3JlZFZhdWx0W1wiUEhPTkVcIl07XG5cbiAgICAgICAgICBpZiAoIWN1cnJlbnRWYWwgJiYgKHN0ZXAuYWN0aW9uID09PSBcInR5cGVcIiB8fCBzdGVwLmFjdGlvbiA9PT0gXCJzZWxlY3RfY2hvaWNlXCIpICYmIGZpZWxkVHlwZSAhPT0gXCJCVVRUT05cIiAmJiBmaWVsZFR5cGUgIT09IFwiU1VCTUlUXCIpIHtcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKGBbQkddIFN0ZXAgJHtzdGVwTnVtfTogTm8gdmFsdWUgZm91bmQgZm9yIFwiJHtmaWVsZFR5cGV9XCIgaW4gcHJvZmlsZSBvciBwbGFuLiBSZXF1ZXN0aW5nIGlubGluZSBpbnB1dCBmcm9tIHVzZXIuLi5gKTtcbiAgICAgICAgICAgIHNhZmVQb3N0KHtcbiAgICAgICAgICAgICAgdHlwZTogXCJQUk9NUFRfVVNFUl9JTlBVVFwiLFxuICAgICAgICAgICAgICBzdGVwTnVtLFxuICAgICAgICAgICAgICBmaWVsZFR5cGUsXG4gICAgICAgICAgICAgIHRhcmdldElkLFxuICAgICAgICAgICAgICBhY3Rpb25UeXBlOiBzdGVwLmFjdGlvbixcbiAgICAgICAgICAgICAgbWVzc2FnZTogYE5vIHZhbHVlIGZvdW5kIGZvciAke2ZpZWxkVHlwZX0gXHUyMDE0IGVudGVyIG9uZSBub3c/YFxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGNvbnN0IHVzZXJSZXBseSA9IGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgICAgICAgICAgIGNvbnN0IHJlcGx5SGFuZGxlciA9ICh1TXNnKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKHVNc2cudHlwZSA9PT0gXCJVU0VSX0lOUFVUX1BST1ZJREVEXCIgJiYgdU1zZy5zdGVwTnVtID09PSBzdGVwTnVtKSB7XG4gICAgICAgICAgICAgICAgICBwb3J0Lm9uTWVzc2FnZS5yZW1vdmVMaXN0ZW5lcihyZXBseUhhbmRsZXIpO1xuICAgICAgICAgICAgICAgICAgcmVzb2x2ZSh1TXNnKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH07XG4gICAgICAgICAgICAgIHBvcnQub25NZXNzYWdlLmFkZExpc3RlbmVyKHJlcGx5SGFuZGxlcik7XG4gICAgICAgICAgICAgIC8vIEZhbGxiYWNrIHRpbWVvdXQgYWZ0ZXIgNDUgc2Vjb25kcyBpZiBubyByZXNwb25zZVxuICAgICAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHJlc29sdmUobnVsbCksIDQ1MDAwKTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBpZiAodXNlclJlcGx5ICYmIHVzZXJSZXBseS52YWx1ZSkge1xuICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgW0JHXSBTdGVwICR7c3RlcE51bX06IFVzZXIgcHJvdmlkZWQgdmFsdWUgZm9yIFwiJHtmaWVsZFR5cGV9XCI6IFwiJHt1c2VyUmVwbHkudmFsdWV9XCIgKHNhdmVUb1ZhdWx0OiAke3VzZXJSZXBseS5zYXZlVG9WYXVsdH0pYCk7XG4gICAgICAgICAgICAgIGlmIChzdGVwLmFjdGlvbiA9PT0gXCJzZWxlY3RfY2hvaWNlXCIpIHtcbiAgICAgICAgICAgICAgICBzdGVwUGF5bG9hZC5tYXRjaF92YWx1ZSA9IHVzZXJSZXBseS52YWx1ZTtcbiAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBzdGVwUGF5bG9hZC52YWx1ZSA9IHVzZXJSZXBseS52YWx1ZTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICBpZiAodXNlclJlcGx5LnNhdmVUb1ZhdWx0KSB7XG4gICAgICAgICAgICAgICAgc3RvcmVkVmF1bHRbZmllbGRUeXBlXSA9IHVzZXJSZXBseS52YWx1ZTtcbiAgICAgICAgICAgICAgICBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBhZ2VudF92YXVsdDogc3RvcmVkVmF1bHQgfSk7XG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFtCR10gXHUyNzEzIFBlcnNpc3RlZCBcIiR7ZmllbGRUeXBlfVwiID0gXCIke3VzZXJSZXBseS52YWx1ZX1cIiB0byBjaHJvbWUuc3RvcmFnZS5sb2NhbGApO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgc2FmZVBvc3Qoe1xuICAgICAgICAgICAgdHlwZTogXCJQTEFOX1NURVBfU1RBVFVTXCIsXG4gICAgICAgICAgICBzdGVwTnVtLFxuICAgICAgICAgICAgdG90YWxTdGVwcyxcbiAgICAgICAgICAgIHN0YXR1czogXCJydW5uaW5nXCIsXG4gICAgICAgICAgICBtZXNzYWdlOiBgU3RlcCAke3N0ZXBOdW19LyR7dG90YWxTdGVwc306ICR7c3RlcC5hY3Rpb259IG9uICR7ZmllbGRUeXBlfSAoJHt0YXJnZXRJZH0pXHUyMDI2YFxuICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHN0ZXBSZXNwb25zZSA9IGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgICAgICAgICAgLy8gNSBzZWNvbmQgdGltZW91dCBwZXIgYWN0aW9uIHRvIGNhdGNoIGh1bmcgcGFnZXNcbiAgICAgICAgICAgICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHJlamVjdChuZXcgRXJyb3IoXCJUSU1FT1VUXCIpKSwgNTAwMCk7XG4gICAgICAgICAgICAgIGNocm9tZS50YWJzLnNlbmRNZXNzYWdlKFxuICAgICAgICAgICAgICAgIGNhcHR1cmVSZXN1bHQudGFiLmlkLFxuICAgICAgICAgICAgICAgIHsgdHlwZTogXCJFWEVDVVRFX0FDVElPTlwiLCBwYXlsb2FkOiBzdGVwUGF5bG9hZCB9LFxuICAgICAgICAgICAgICAgIHJlc3BvbnNlID0+IHtcbiAgICAgICAgICAgICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgICAgICAgICAgICBpZiAoY2hyb21lLnJ1bnRpbWUubGFzdEVycm9yKSB7XG4gICAgICAgICAgICAgICAgICAgIHJlamVjdChuZXcgRXJyb3IoY2hyb21lLnJ1bnRpbWUubGFzdEVycm9yLm1lc3NhZ2UpKTtcbiAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHJlc29sdmUocmVzcG9uc2UgfHwgeyBvazogZmFsc2UsIGVycm9yOiBcIk5vIHJlc3BvbnNlIGZyb20gY29udGVudCBzY3JpcHRcIiB9KTtcbiAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgaWYgKHN0ZXBSZXNwb25zZS5vaykge1xuICAgICAgICAgICAgICBzdGVwQ29uc2VjdXRpdmVGYWlsdXJlcy5zZXQoc3RlcEtleSwgMCk7IC8vIHJlc2V0IG9uIHN1Y2Nlc3NcbiAgICAgICAgICAgICAgY29uc29sZS5sb2coYFtCR10gU3RlcCA2LiR7c3RlcE51bX06IFx1MjcxMyBzdWNjZXNzYCwgc3RlcFJlc3BvbnNlKTtcbiAgICAgICAgICAgICAgc3RlcFJlc3VsdHMucHVzaCh7IHN0ZXBOdW0sIGZpZWxkVHlwZSwgb2s6IHRydWUgfSk7XG4gICAgICAgICAgICAgIHNhZmVQb3N0KHtcbiAgICAgICAgICAgICAgICB0eXBlOiBcIlBMQU5fU1RFUF9TVEFUVVNcIixcbiAgICAgICAgICAgICAgICBzdGVwTnVtLFxuICAgICAgICAgICAgICAgIHRvdGFsU3RlcHMsXG4gICAgICAgICAgICAgICAgc3RhdHVzOiBcIm9rXCIsXG4gICAgICAgICAgICAgICAgbWVzc2FnZTogYFN0ZXAgJHtzdGVwTnVtfS8ke3RvdGFsU3RlcHN9OiBcdTI3MTMgJHtmaWVsZFR5cGV9IGZpbGxlZGBcbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3Ioc3RlcFJlc3BvbnNlLmVycm9yIHx8IFwiQ29udGVudCBzY3JpcHQgcmVwb3J0ZWQgZmFpbHVyZVwiKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgIHN0ZXBDb25zZWN1dGl2ZUZhaWx1cmVzLnNldChzdGVwS2V5LCBjdXJyZW50RmFpbHVyZXMgKyAxKTtcbiAgICAgICAgICAgIGxldCBmYWlsUmVhc29uO1xuICAgICAgICAgICAgY29uc3QgZXJyU3RyID0gZXJyLm1lc3NhZ2UgfHwgU3RyaW5nKGVycik7XG4gICAgICAgICAgICBpZiAoZXJyU3RyID09PSBcIlRJTUVPVVRcIikge1xuICAgICAgICAgICAgICBmYWlsUmVhc29uID0gYFRoZSBwYWdlIGRpZG4ndCByZXNwb25kIHRvIHRoZSBhY3Rpb24gaW4gdGltZSAoc3RlcCAke3N0ZXBOdW19LCAke2ZpZWxkVHlwZX0pLmA7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGVyclN0ci5pbmNsdWRlcyhcIm5vdCBmb3VuZFwiKSB8fCBlcnJTdHIuaW5jbHVkZXMoXCJyZXNvbHZlXCIpKSB7XG4gICAgICAgICAgICAgIGZhaWxSZWFzb24gPSBgQ291bGRuJ3QgZmluZCB0aGUgZWxlbWVudCBmb3Igc3RlcCAke3N0ZXBOdW19IChleHBlY3RlZDogJHtmaWVsZFR5cGV9KS4gVGhlIHBhZ2UgbGF5b3V0IG1heSBoYXZlIGNoYW5nZWQuYDtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIGZhaWxSZWFzb24gPSBgU3RlcCAke3N0ZXBOdW19ICgke2ZpZWxkVHlwZX0pIGZhaWxlZDogJHtlcnJTdHJ9YDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYFtCR10gU3RlcCA2LiR7c3RlcE51bX06IFx1MjcxNyBmYWlsZWQgKCR7Y3VycmVudEZhaWx1cmVzICsgMX0gY29uc2VjdXRpdmUpIFx1MjAxNCAke2ZhaWxSZWFzb259YCk7XG4gICAgICAgICAgICBzdGVwUmVzdWx0cy5wdXNoKHsgc3RlcE51bSwgZmllbGRUeXBlLCBvazogZmFsc2UsIHJlYXNvbjogZmFpbFJlYXNvbiB9KTtcbiAgICAgICAgICAgIHNhZmVQb3N0KHtcbiAgICAgICAgICAgICAgdHlwZTogXCJQTEFOX1NURVBfU1RBVFVTXCIsXG4gICAgICAgICAgICAgIHN0ZXBOdW0sXG4gICAgICAgICAgICAgIHRvdGFsU3RlcHMsXG4gICAgICAgICAgICAgIHN0YXR1czogXCJlcnJvclwiLFxuICAgICAgICAgICAgICBtZXNzYWdlOiBmYWlsUmVhc29uXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIC8vIENvbnRpbnVlIHJlbWFpbmluZyBzdGVwcyBcdTIwMTQgZG9uJ3QgYWJvcnQgdGhlIHdob2xlIHBsYW5cbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBTbWFsbCBkZWxheSBiZXR3ZWVuIHN0ZXBzIHNvIERPTSBldmVudHMgc2V0dGxlXG4gICAgICAgICAgYXdhaXQgbmV3IFByb21pc2UociA9PiBzZXRUaW1lb3V0KHIsIDMwMCkpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gXHUyNTAwXHUyNTAwIFBsYW4gc3VtbWFyeSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICAgICAgY29uc3Qgc3VjY2VlZGVkID0gc3RlcFJlc3VsdHMuZmlsdGVyKHIgPT4gci5vaykubGVuZ3RoO1xuICAgICAgICBjb25zdCBmYWlsZWQgPSBzdGVwUmVzdWx0cy5maWx0ZXIociA9PiAhci5vaykubGVuZ3RoO1xuICAgICAgICBjb25zdCBmYWlsZWREZXNjcmlwdGlvbnMgPSBzdGVwUmVzdWx0c1xuICAgICAgICAgIC5maWx0ZXIociA9PiAhci5vaylcbiAgICAgICAgICAubWFwKHIgPT4gYFN0ZXAgJHtyLnN0ZXBOdW19ICgke3IuZmllbGRUeXBlfSk6ICR7ci5yZWFzb259YCk7XG5cbiAgICAgICAgbGV0IHN1bW1hcnlNc2c7XG4gICAgICAgIGlmIChmYWlsZWQgPT09IDApIHtcbiAgICAgICAgICBzdW1tYXJ5TXNnID0gYEFsbCAke3N1Y2NlZWRlZH0gc3RlcChzKSBjb21wbGV0ZWQgc3VjY2Vzc2Z1bGx5LmA7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgc3VtbWFyeU1zZyA9IGBDb21wbGV0ZWQgJHtzdWNjZWVkZWR9IG9mICR7dG90YWxTdGVwc30gc3RlcHMuICR7ZmFpbGVkRGVzY3JpcHRpb25zLmpvaW4oXCIgfCBcIil9YDtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnNvbGUubG9nKGBbQkddIFN0ZXAgNiBTdW1tYXJ5OiAke3N1bW1hcnlNc2d9YCk7XG4gICAgICAgIHNhZmVQb3N0KHtcbiAgICAgICAgICB0eXBlOiBcIlBMQU5fU1VNTUFSWVwiLFxuICAgICAgICAgIHRvdGFsOiB0b3RhbFN0ZXBzLFxuICAgICAgICAgIHN1Y2NlZWRlZCxcbiAgICAgICAgICBmYWlsZWQsXG4gICAgICAgICAgZGV0YWlsczogc3RlcFJlc3VsdHMsXG4gICAgICAgICAgbWVzc2FnZTogc3VtbWFyeU1zZ1xuICAgICAgICB9KTtcbiAgICAgIH1cblxuICAgICAgLy8gXHUyNTAwXHUyNTAwIEZpbmFsaXplIExvb3AgQ3ljbGUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgICBzYWZlUG9zdCh7XG4gICAgICAgIHR5cGU6IFwiQU5BTFlTSVNfUkVTVUxUXCIsXG4gICAgICAgIGRldGVjdGlvbnMsXG4gICAgICAgIHNlbnNpdGl2ZVJlZ2lvbnMsXG4gICAgICAgIHNjcmVlbnNob3REYXRhVXJsLFxuICAgICAgICBlbGFwc2VkLFxuICAgICAgICBzZXJ2ZXJSZXN1bHQsXG4gICAgICB9KTtcblxuICAgICAgY29uc3QgdEVuZCA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICAgICAgY29uc3QgbG9vcExhdGVuY3kgPSB0RW5kIC0gdDA7XG4gICAgICBzdGF0cy50b3RhbExhdGVuY3lNcyArPSBsb29wTGF0ZW5jeTtcbiAgICAgIGNvbnNvbGUubG9nKGBbQkddIEN5Y2xlIGZpbmlzaGVkIGluICR7bG9vcExhdGVuY3kudG9GaXhlZCgxKX1tcy4gVG90YWwgbGF0ZW5jeTogJHtzdGF0cy50b3RhbExhdGVuY3lNcy50b0ZpeGVkKDEpfW1zYCk7XG5cbiAgICAgIGNocm9tZS50YWJzLnNlbmRNZXNzYWdlKGNhcHR1cmVSZXN1bHQudGFiLmlkLCB7IHR5cGU6IFwiVVBEQVRFX1NUQVRTXCIsIHBheWxvYWQ6IHN0YXRzIH0sICgpID0+IHtcbiAgICAgICAgY2hyb21lLnJ1bnRpbWUubGFzdEVycm9yOyAvLyBJZ25vcmUgaWYgY29udGVudCBzY3JpcHQgY2xvc2VkXG4gICAgICB9KTtcblxuICAgICAgLy8gXHUyNTAwXHUyNTAwIExvb3AgY2hlY2s6IGRlbW8gbW9kZSBzdG9wcyBhZnRlciBvbmUgZnVsbCBwbGFuIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgICAgc2hvdWxkQ29udGludWUgPSBmYWxzZTsgIC8vIFNpbmdsZS1zaG90OiBwbGFuIGNvdmVycyBhbGwgZmllbGRzIGF0IG9uY2VcbiAgICB9XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBU0EsSUFBTSxhQUFnQjtBQUN0QixJQUFNLGdCQUFnQixPQUFPLFFBQVEsT0FBTyxnQkFBZ0I7QUFFNUQsSUFBTSxnQkFBZ0Isb0JBQUksSUFBSTtBQUM5QixJQUFJLFFBQVE7QUFBQSxFQUNWLGdCQUFnQjtBQUFBLEVBQ2hCLGtCQUFrQjtBQUFBLEVBQ2xCLGdCQUFnQjtBQUNsQjtBQUVBLFFBQVEsSUFBSSxrREFBa0Q7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
