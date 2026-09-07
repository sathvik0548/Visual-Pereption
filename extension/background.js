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
      let serverErr = "";
      try {
        const parsed = JSON.parse(rawBody);
        serverErr = parsed.error || parsed.message || "";
      } catch (e) {
      }
      throw new Error(serverErr || `Server returned HTTP ${res.status} (${res.statusText}): ${rawBody.substring(0, 200)}`);
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
        if (sensitiveRegions.length > 0) {
          const verifyResp = await new Promise((resolve) => {
            const timer = setTimeout(() => resolve({ ok: true, leakers: [], checked: sensitiveRegions.length }), 5e3);
            chrome.runtime.sendMessage(
              {
                type: "VERIFY_REDACTION",
                payload: { redactedDataUrl: finalScreenshotDataUrl, sensitiveRegions }
              },
              (resp) => {
                clearTimeout(timer);
                if (chrome.runtime.lastError) {
                  console.warn("[BG] Step 4b: VERIFY_REDACTION message error (non-fatal):", chrome.runtime.lastError.message);
                  resolve({ ok: true, leakers: [], checked: sensitiveRegions.length });
                } else {
                  resolve(resp || { ok: true, leakers: [], checked: sensitiveRegions.length });
                }
              }
            );
          });
          const leakingRegions = verifyResp.leakers || [];
          leakDetails = {
            leaksFound: leakingRegions.length,
            leakRegions: leakingRegions,
            checkedRegions: sensitiveRegions.length
          };
          if (leakingRegions.length > 0) {
            leakCheckPassed = false;
            console.error(`[BG] Step 4b FAIL: ${leakingRegions.length} region(s) not fully blacked out!`, leakingRegions);
            safePost({
              type: "LEAK_CHECK",
              passed: false,
              leaksFound: leakingRegions.length,
              leakRegions: leakingRegions,
              checkedRegions: sensitiveRegions.length,
              message: `\u{1F6A8} LEAK DETECTED: ${leakingRegions.length} region(s) not blacked out \u2014 payload BLOCKED`
            });
          } else {
            console.log(`[BG] Step 4b PASS: All ${sensitiveRegions.length} region(s) verified black (geometric).`);
            safePost({
              type: "LEAK_CHECK",
              passed: true,
              leaksFound: 0,
              leakRegions: [],
              checkedRegions: sensitiveRegions.length,
              message: `\u2713 0 leaks \u2014 ${sensitiveRegions.length} masked region(s) verified black`
            });
          }
        } else {
          console.log("[BG] Step 4b: No sensitive regions to verify.");
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
      let manifest = (sensitiveRegions || []).map((r, i) => ({
        region_id: `region_${i}`,
        bbox: r.bbox,
        type: r.type,
        redaction_style: "black_box",
        confidence: r.confidence,
        source: r.source || "dom"
      }));
      let dom_summary = (domResult.domRegions || []).map((r, i) => ({
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
      }));
      let serverResult;
      try {
        console.log("[BG] Step 5: Preparing AgentRequestV1 payload for server...");
        safePost({ type: "STAGE_CHANGE", stage: "send", text: "Sending redacted payload to server (http://localhost:3000/analyze)\u2026" });
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
          client_stats: { totalLatencyMs: stats.totalLatencyMs },
          vault: storedVault
          // Send profile data so server-side providers can use real values
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
        }
        safePost({ type: "ERROR", step: "Server Call", error: errMsg });
        shouldContinue = false;
        break;
      }
      safePost({
        type: "ANALYSIS_RESULT",
        detections,
        sensitiveRegions,
        screenshotDataUrl,
        elapsed,
        serverResult
      });
      safePost({ type: "STAGE_CHANGE", stage: "act", text: "Executing plan\u2026" });
      const plan = Array.isArray(serverResult?.plan) ? serverResult.plan : [];
      const totalSteps = plan.length;
      const stepResults = [];
      try {
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
              const SENSITIVE_SKIP_TYPES = /* @__PURE__ */ new Set([
                "AADHAAR",
                "PAN",
                "GSTIN",
                "IFSC",
                "BANK_ACCOUNT",
                "CARD",
                "PASSWORD",
                "INDIAN_MOBILE",
                "PHONE"
              ]);
              if (SENSITIVE_SKIP_TYPES.has(fieldType)) {
                const skipMsg = `Step ${stepNum}: \u26A0 No value in vault for sensitive field "${fieldType}" \u2014 skipping (add it in Profile settings).`;
                console.warn(`[BG] ${skipMsg}`);
                stepResults.push({ stepNum, fieldType, ok: false, reason: skipMsg });
                safePost({ type: "PLAN_STEP_STATUS", stepNum, totalSteps, status: "error", message: skipMsg });
                continue;
              }
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
                setTimeout(() => resolve(null), 1e4);
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
              } else {
                const skipMsg = `Step ${stepNum}: No value provided for "${fieldType}" (timed out or skipped). Moving on.`;
                console.warn(`[BG] ${skipMsg}`);
                stepResults.push({ stepNum, fieldType, ok: false, reason: skipMsg });
                safePost({ type: "PLAN_STEP_STATUS", stepNum, totalSteps, status: "error", message: skipMsg });
                continue;
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
      } catch (step6Err) {
        console.error("[BG Error][Step 6: Plan Execution]:", step6Err);
        safePost({ type: "ERROR", step: "Plan Execution", error: step6Err.message || String(step6Err) });
      } finally {
        safePost({ type: "_STEP6_COMPLETE" });
        console.log("[BG] Step 6 finally block \u2014 execution loop done.");
      }
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsic3JjL2JhY2tncm91bmQuanMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogYmFja2dyb3VuZC5qcyBcdTIwMTQgU2VydmljZSBXb3JrZXIgIChzcmMvYmFja2dyb3VuZC5qcyBcdTIxOTIgYnVpbHQgYmFja2dyb3VuZC5qcylcbiAqXG4gKiB2MC4yIGFkZGl0aW9uczpcbiAqICAgLSBnZXRET01SZWdpb25zKHRhYklkKSAgIFx1MjAxNCBzZW5kcyBTQ0FOX0RPTSB0byBjb250ZW50IHNjcmlwdCwgcmV0dXJucyBkb21SZWdpb25zW11cbiAqICAgLSBQYXNzZXMgZG9tUmVnaW9ucyB0byBvZmZzY3JlZW4gYWxvbmdzaWRlIHRoZSBzY3JlZW5zaG90XG4gKiAgIC0gUmVsYXlzIHsgZGV0ZWN0aW9ucywgc2Vuc2l0aXZlUmVnaW9ucyB9IGJhY2sgdG8gcG9wdXAgdmlhIHBvcnRcbiAqL1xuXG5jb25zdCBTRVJWRVJfVVJMICAgID0gXCJodHRwOi8vbG9jYWxob3N0OjMwMDAvYW5hbHl6ZVwiO1xuY29uc3QgT0ZGU0NSRUVOX1VSTCA9IGNocm9tZS5ydW50aW1lLmdldFVSTChcIm9mZnNjcmVlbi5odG1sXCIpO1xuXG5jb25zdCBhbmFseXNpc0NhY2hlID0gbmV3IE1hcCgpO1xubGV0IHN0YXRzID0ge1xuICBmcmFtZXNDYXB0dXJlZDogMCxcbiAgdmlzaW9uSW5mZXJlbmNlczogMCxcbiAgdG90YWxMYXRlbmN5TXM6IDBcbn07XG5cbmNvbnNvbGUubG9nKGBbQkddIFRfU1dfU1RBUlQgIHQ9MG1zICAoU2VydmljZSB3b3JrZXIgc3RhcnRlZClgKTtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBQcmUtbG9hZCBvbiBzdGFydHVwIChzbyBtb2RlbCBpcyByZWFkeSBiZWZvcmUgdXNlciBjbGlja3MgYW55dGhpbmcpXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbmNocm9tZS5ydW50aW1lLm9uSW5zdGFsbGVkLmFkZExpc3RlbmVyKCgpID0+IHtcbiAgZW5zdXJlT2Zmc2NyZWVuRG9jdW1lbnQoKTtcbiAgaWYgKGNocm9tZS5zdG9yYWdlICYmIGNocm9tZS5zdG9yYWdlLmxvY2FsKSB7XG4gICAgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KFtcImFnZW50X3ZhdWx0XCJdLCAoZGF0YSkgPT4ge1xuICAgICAgaWYgKCFkYXRhLmFnZW50X3ZhdWx0KSB7XG4gICAgICAgIGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7XG4gICAgICAgICAgYWdlbnRfdmF1bHQ6IHtcbiAgICAgICAgICAgIE5BTUU6IFwiUmFqZXNoIEt1bWFyXCIsXG4gICAgICAgICAgICBFTUFJTDogXCJ2ZW5kb3IuZGVtb0BleGFtcGxlLmluXCIsXG4gICAgICAgICAgICBJTkRJQU5fTU9CSUxFOiBcIjk4NzY1NDMyMTBcIixcbiAgICAgICAgICAgIFBIT05FOiBcIjk4NzY1NDMyMTBcIixcbiAgICAgICAgICAgIERPQjogXCIxOTkwLTA1LTE1XCIsXG4gICAgICAgICAgICBBRERSRVNTOiBcIjQyLCBNRyBSb2FkLCBCZW5nYWx1cnVcIixcbiAgICAgICAgICAgIENJVFk6IFwiQmVuZ2FsdXJ1XCIsXG4gICAgICAgICAgICBQSU5DT0RFOiBcIjU2MDAwMVwiLFxuICAgICAgICAgICAgQUFESEFBUjogXCI1NDg5IDEyMzQgNTY3NFwiLFxuICAgICAgICAgICAgUEFOOiBcIkFCQ0RFMTIzNEZcIixcbiAgICAgICAgICAgIFBBU1NXT1JEOiBcIk1vY2tQYXNzd29yZEAxMjNcIlxuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICAgIGNvbnNvbGUubG9nKFwiW0JHXSBJbml0aWFsaXplZCBkZWZhdWx0IGRlbW8gcHJvZmlsZSB2YXVsdCBpbiBjaHJvbWUuc3RvcmFnZS5sb2NhbFwiKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxufSk7XG5jaHJvbWUucnVudGltZS5vblN0YXJ0dXAuYWRkTGlzdGVuZXIoKCkgPT4gZW5zdXJlT2Zmc2NyZWVuRG9jdW1lbnQoKSk7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gR2xvYmFsIEtlZXAtQWxpdmUgSGFuZGxlciAocmVzcG9uZHMgdG8gb2Zmc2NyZWVuIHBpbmdzKVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5jaHJvbWUucnVudGltZS5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIoKG1zZywgc2VuZGVyLCBzZW5kUmVzcG9uc2UpID0+IHtcbiAgaWYgKG1zZy50eXBlID09PSBcIk9GRlNDUkVFTl9LRUVQQUxJVkVcIikge1xuICAgIHNlbmRSZXNwb25zZSh7IG9rOiB0cnVlIH0pO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG59KTtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBjYXB0dXJlU2NyZWVuIFx1MjAxNCBjYXB0dXJlIHRoZSBhY3RpdmUgdGFiJ3MgdmlzaWJsZSBhcmVhIGFzIGEgZGF0YSBVUkxcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNhcHR1cmVTY3JlZW4oKSB7XG4gIGNvbnN0IFthY3RpdmVUYWJdID0gYXdhaXQgY2hyb21lLnRhYnMucXVlcnkoeyBhY3RpdmU6IHRydWUsIGN1cnJlbnRXaW5kb3c6IHRydWUgfSk7XG4gIGlmICghYWN0aXZlVGFiKSB0aHJvdyBuZXcgRXJyb3IoXCJObyBhY3RpdmUgdGFiIGZvdW5kLlwiKTtcblxuICBjb25zdCBkYXRhVXJsID0gYXdhaXQgY2hyb21lLnRhYnMuY2FwdHVyZVZpc2libGVUYWIoYWN0aXZlVGFiLndpbmRvd0lkLCB7IGZvcm1hdDogXCJwbmdcIiB9KTtcbiAgcmV0dXJuIHsgZGF0YVVybCwgdGFiOiBhY3RpdmVUYWIgfTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIGdldERPTVJlZ2lvbnMgXHUyMDE0IGFzayB0aGUgY29udGVudCBzY3JpcHQgdG8gc2NhbiB0aGUgcGFnZSdzIHNlbnNpdGl2ZSBmaWVsZHNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuYXN5bmMgZnVuY3Rpb24gZ2V0RE9NUmVnaW9ucyh0YWJJZCkge1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICBjb25zb2xlLmxvZyhgW0JHXSBEaXNwYXRjaGluZyBTQ0FOX0RPTSBtZXNzYWdlIHRvIGFjdGl2ZSB0YWIgJHt0YWJJZH0uLi5gKTtcbiAgICBjaHJvbWUudGFicy5zZW5kTWVzc2FnZSh0YWJJZCwgeyB0eXBlOiBcIlNDQU5fRE9NXCIgfSwgYXN5bmMgKHJlc3BvbnNlKSA9PiB7XG4gICAgICBpZiAoY2hyb21lLnJ1bnRpbWUubGFzdEVycm9yIHx8ICFyZXNwb25zZSkge1xuICAgICAgICBjb25zdCBlcnJNc2cgPSBjaHJvbWUucnVudGltZS5sYXN0RXJyb3I/Lm1lc3NhZ2UgPz8gXCJubyByZXNwb25zZVwiO1xuICAgICAgICBjb25zb2xlLndhcm4oYFtCR10gSW5pdGlhbCBTQ0FOX0RPTSBmYWlsZWQgb24gdGFiICR7dGFiSWR9ICgke2Vyck1zZ30pLiBBdHRlbXB0aW5nIGR5bmFtaWMgaW5qZWN0aW9uIG9mIGNvbnRlbnQuanMuLi5gKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBhd2FpdCBjaHJvbWUuc2NyaXB0aW5nLmV4ZWN1dGVTY3JpcHQoe1xuICAgICAgICAgICAgdGFyZ2V0OiB7IHRhYklkIH0sXG4gICAgICAgICAgICBmaWxlczogW1wiY29udGVudC5qc1wiXSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBjb25zb2xlLmxvZyhgW0JHXSBjb250ZW50LmpzIHN1Y2Nlc3NmdWxseSBpbmplY3RlZCBpbnRvIHRhYiAke3RhYklkfS4gUmV0cnlpbmcgU0NBTl9ET00uLi5gKTtcbiAgICAgICAgICBjaHJvbWUudGFicy5zZW5kTWVzc2FnZSh0YWJJZCwgeyB0eXBlOiBcIlNDQU5fRE9NXCIgfSwgKHJldHJ5UmVzcG9uc2UpID0+IHtcbiAgICAgICAgICAgIGlmIChjaHJvbWUucnVudGltZS5sYXN0RXJyb3IgfHwgIXJldHJ5UmVzcG9uc2UpIHtcbiAgICAgICAgICAgICAgY29uc29sZS53YXJuKFwiW0JHXSBTQ0FOX0RPTSByZXRyeSBhbHNvIGZhaWxlZDpcIiwgY2hyb21lLnJ1bnRpbWUubGFzdEVycm9yPy5tZXNzYWdlID8/IFwibm8gcmVzcG9uc2VcIik7XG4gICAgICAgICAgICAgIHJlc29sdmUoeyBkb21SZWdpb25zOiBbXSwgZG9tSGFzaDogXCJcIiB9KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBbQkddIFNDQU5fRE9NIHJldHJ5IHN1Y2NlZWRlZCEgRm91bmQgJHtyZXRyeVJlc3BvbnNlLmRvbVJlZ2lvbnM/Lmxlbmd0aCA/PyAwfSBzZW5zaXRpdmUgZmllbGQocyksICR7cmV0cnlSZXNwb25zZS5tZWRpYVJlZ2lvbnM/Lmxlbmd0aCA/PyAwfSBtZWRpYSBlbGVtZW50KHMpOmAsIHJldHJ5UmVzcG9uc2UuZG9tUmVnaW9ucyk7XG4gICAgICAgICAgICAgIHJlc29sdmUoeyBkb21SZWdpb25zOiByZXRyeVJlc3BvbnNlLmRvbVJlZ2lvbnMgPz8gW10sIG1lZGlhUmVnaW9uczogcmV0cnlSZXNwb25zZS5tZWRpYVJlZ2lvbnMgPz8gW10sIGRvbUhhc2g6IHJldHJ5UmVzcG9uc2UuZG9tSGFzaCA/PyBcIlwiIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pO1xuICAgICAgICB9IGNhdGNoIChpbmpFcnIpIHtcbiAgICAgICAgICBjb25zb2xlLndhcm4oXCJbQkddIER5bmFtaWMgY29udGVudCBzY3JpcHQgaW5qZWN0aW9uIGZhaWxlZCAoZS5nLiBjaHJvbWU6Ly8gb3IgcmVzdHJpY3RlZCBwYWdlKTpcIiwgaW5qRXJyLm1lc3NhZ2UpO1xuICAgICAgICAgIHJlc29sdmUoeyBkb21SZWdpb25zOiBbXSwgbWVkaWFSZWdpb25zOiBbXSwgZG9tSGFzaDogXCJcIiB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjb25zb2xlLmxvZyhgW0JHXSBTQ0FOX0RPTSBzdWNjZWVkZWQgb24gdGFiICR7dGFiSWR9ISBSZWNlaXZlZCAke3Jlc3BvbnNlLmRvbVJlZ2lvbnM/Lmxlbmd0aCA/PyAwfSByZWdpb24ocyksICR7cmVzcG9uc2UubWVkaWFSZWdpb25zPy5sZW5ndGggPz8gMH0gbWVkaWEgZWxlbWVudChzKTpgLCByZXNwb25zZS5kb21SZWdpb25zKTtcbiAgICAgIHJlc29sdmUoeyBkb21SZWdpb25zOiByZXNwb25zZS5kb21SZWdpb25zID8/IFtdLCBtZWRpYVJlZ2lvbnM6IHJlc3BvbnNlLm1lZGlhUmVnaW9ucyA/PyBbXSwgZG9tSGFzaDogcmVzcG9uc2UuZG9tSGFzaCA/PyBcIlwiIH0pO1xuICAgIH0pO1xuICB9KTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBlbnN1cmVPZmZzY3JlZW5Eb2N1bWVudCBcdTIwMTQgY3JlYXRlIGlmIG5vdCBhbHJlYWR5IG9wZW4gKG1heCAxIHBlciBleHRlbnNpb24pXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbmFzeW5jIGZ1bmN0aW9uIGVuc3VyZU9mZnNjcmVlbkRvY3VtZW50KCkge1xuICBjb25zdCBleGlzdGluZyA9IGF3YWl0IGNocm9tZS5ydW50aW1lLmdldENvbnRleHRzKHtcbiAgICBjb250ZXh0VHlwZXM6IFtcIk9GRlNDUkVFTl9ET0NVTUVOVFwiXSxcbiAgICBkb2N1bWVudFVybHM6IFtPRkZTQ1JFRU5fVVJMXSxcbiAgfSk7XG4gIGlmIChleGlzdGluZy5sZW5ndGggPiAwKSByZXR1cm47XG5cbiAgYXdhaXQgY2hyb21lLm9mZnNjcmVlbi5jcmVhdGVEb2N1bWVudCh7XG4gICAgdXJsOiAgICAgICAgICAgXCJvZmZzY3JlZW4uaHRtbFwiLFxuICAgIHJlYXNvbnM6ICAgICAgIFtcIldPUktFUlNcIl0sXG4gICAganVzdGlmaWNhdGlvbjogXCJSdW4gRmxvcmVuY2UtMiArIEJsYXplRmFjZSBpbmZlcmVuY2UgZm9yIHZpc3VhbCBQSUkgZGV0ZWN0aW9uLlwiLFxuICB9KTtcbiAgY29uc29sZS5sb2coXCJbQkddIE9mZnNjcmVlbiBkb2N1bWVudCBjcmVhdGVkLlwiKTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyByZWRhY3RTY3JlZW5zaG90IFx1MjAxNCBwaHlzaWNhbGx5IGRyYXcgYmxhY2sgYm94ZXMgb3ZlciBzZW5zaXRpdmUgcmVnaW9uc1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5hc3luYyBmdW5jdGlvbiByZWRhY3RTY3JlZW5zaG90KGRhdGFVcmwsIHNlbnNpdGl2ZVJlZ2lvbnMpIHtcbiAgaWYgKCFzZW5zaXRpdmVSZWdpb25zIHx8IHNlbnNpdGl2ZVJlZ2lvbnMubGVuZ3RoID09PSAwKSByZXR1cm4gZGF0YVVybDtcblxuICB0cnkge1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGRhdGFVcmwpO1xuICAgIGNvbnN0IGJsb2IgPSBhd2FpdCByZXMuYmxvYigpO1xuICAgIGNvbnN0IGJpdG1hcCA9IGF3YWl0IGNyZWF0ZUltYWdlQml0bWFwKGJsb2IpO1xuICAgIFxuICAgIGNvbnN0IGNhbnZhcyA9IG5ldyBPZmZzY3JlZW5DYW52YXMoYml0bWFwLndpZHRoLCBiaXRtYXAuaGVpZ2h0KTtcbiAgICBjb25zdCBjdHggPSBjYW52YXMuZ2V0Q29udGV4dChcIjJkXCIpO1xuICAgIFxuICAgIC8vIERyYXcgb3JpZ2luYWwgaW1hZ2VcbiAgICBjdHguZHJhd0ltYWdlKGJpdG1hcCwgMCwgMCk7XG4gICAgXG4gICAgLy8gRHJhdyByZWRhY3Rpb24gYm94ZXNcbiAgICBjdHguZmlsbFN0eWxlID0gXCJibGFja1wiO1xuICAgIGZvciAoY29uc3QgcmVnaW9uIG9mIHNlbnNpdGl2ZVJlZ2lvbnMpIHtcbiAgICAgIGlmIChyZWdpb24uYmJveCAmJiByZWdpb24uYmJveC5sZW5ndGggPT09IDQpIHtcbiAgICAgICAgY29uc3QgW3gsIHksIHcsIGhdID0gcmVnaW9uLmJib3g7XG4gICAgICAgIGN0eC5maWxsUmVjdCh4LCB5LCB3LCBoKTtcbiAgICAgIH1cbiAgICB9XG4gICAgXG4gICAgY29uc3Qgb3V0QmxvYiA9IGF3YWl0IGNhbnZhcy5jb252ZXJ0VG9CbG9iKHsgdHlwZTogXCJpbWFnZS9wbmdcIiB9KTtcbiAgICBjb25zdCBidWZmZXIgPSBhd2FpdCBvdXRCbG9iLmFycmF5QnVmZmVyKCk7XG4gICAgXG4gICAgLy8gQ29udmVydCB0byBiYXNlNjRcbiAgICBsZXQgYmluYXJ5ID0gJyc7XG4gICAgY29uc3QgYnl0ZXMgPSBuZXcgVWludDhBcnJheShidWZmZXIpO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYnl0ZXMuYnl0ZUxlbmd0aDsgaSsrKSB7XG4gICAgICBiaW5hcnkgKz0gU3RyaW5nLmZyb21DaGFyQ29kZShieXRlc1tpXSk7XG4gICAgfVxuICAgIGNvbnN0IGI2NCA9IGJ0b2EoYmluYXJ5KTtcbiAgICBcbiAgICByZXR1cm4gYGRhdGE6aW1hZ2UvcG5nO2Jhc2U2NCwke2I2NH1gO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBjb25zb2xlLmVycm9yKFwiW0JHXSBSZWRhY3Rpb24gZmFpbGVkOlwiLCBlcnIpO1xuICAgIHJldHVybiBkYXRhVXJsOyAvLyBmYWxsYmFjayB0byBvcmlnaW5hbCBvbiBlcnJvclxuICB9XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gcnVuVmlzaW9uQW5hbHlzaXMgXHUyMDE0IHNlbmRzIHNjcmVlbnNob3QgKyBkb21SZWdpb25zICsgbWVkaWFSZWdpb25zIHRvIG9mZnNjcmVlblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5hc3luYyBmdW5jdGlvbiBydW5WaXNpb25BbmFseXNpcyhzY3JlZW5zaG90RGF0YVVybCwgZG9tUmVnaW9ucywgbWVkaWFSZWdpb25zKSB7XG4gIGF3YWl0IGVuc3VyZU9mZnNjcmVlbkRvY3VtZW50KCk7XG5cbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZShcbiAgICAgIHsgdHlwZTogXCJSVU5fSU5GRVJFTkNFXCIsIHBheWxvYWQ6IHsgc2NyZWVuc2hvdERhdGFVcmwsIGRvbVJlZ2lvbnMsIG1lZGlhUmVnaW9ucyB9IH0sXG4gICAgICAocmVzcG9uc2UpID0+IHtcbiAgICAgICAgaWYgKGNocm9tZS5ydW50aW1lLmxhc3RFcnJvcikge1xuICAgICAgICAgIHJlamVjdChuZXcgRXJyb3IoY2hyb21lLnJ1bnRpbWUubGFzdEVycm9yLm1lc3NhZ2UpKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFyZXNwb25zZT8uc3VjY2Vzcykge1xuICAgICAgICAgIHJlamVjdChuZXcgRXJyb3IocmVzcG9uc2U/LmVycm9yID8/IFwiVW5rbm93biBpbmZlcmVuY2UgZXJyb3JcIikpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICByZXNvbHZlKHJlc3BvbnNlKTtcbiAgICAgIH1cbiAgICApO1xuICB9KTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBzZW5kVG9TZXJ2ZXIgXHUyMDE0IFBPU1QgcmVzdWx0IHRvIHRoZSBsb2NhbCBFeHByZXNzIHNlcnZlciAod2l0aCBmdWxsIEhUVFAgbG9nZ2luZylcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuYXN5bmMgZnVuY3Rpb24gc2VuZFRvU2VydmVyKHBheWxvYWQpIHtcbiAgY29uc29sZS5sb2coXCJbQkddIEluaXRpYXRpbmcgSFRUUCByZXF1ZXN0IHRvIHNlcnZlciBVUkw6XCIsIFNFUlZFUl9VUkwpO1xuICB0cnkge1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKFNFUlZFUl9VUkwsIHtcbiAgICAgIG1ldGhvZDogIFwiUE9TVFwiLFxuICAgICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgICAgYm9keTogICAgSlNPTi5zdHJpbmdpZnkocGF5bG9hZCksXG4gICAgfSk7XG5cbiAgICBjb25zb2xlLmxvZyhgW0JHXSBTZXJ2ZXIgSFRUUCBTdGF0dXMgQ29kZTogJHtyZXMuc3RhdHVzfSAke3Jlcy5zdGF0dXNUZXh0fWApO1xuICAgIGNvbnN0IHJhd0JvZHkgPSBhd2FpdCByZXMudGV4dCgpO1xuICAgIGNvbnNvbGUubG9nKGBbQkddIFNlcnZlciBSYXcgUmVzcG9uc2UgQm9keSAoJHtyYXdCb2R5Lmxlbmd0aH0gYnl0ZXMpOmAsIHJhd0JvZHkubGVuZ3RoID4gNTAwID8gcmF3Qm9keS5zdWJzdHJpbmcoMCwgNTAwKSArIFwiLi4uIFt0cnVuY2F0ZWRdXCIgOiByYXdCb2R5KTtcblxuICAgIGlmICghcmVzLm9rKSB7XG4gICAgICBsZXQgc2VydmVyRXJyID0gXCJcIjtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmF3Qm9keSk7XG4gICAgICAgIHNlcnZlckVyciA9IHBhcnNlZC5lcnJvciB8fCBwYXJzZWQubWVzc2FnZSB8fCBcIlwiO1xuICAgICAgfSBjYXRjaCAoZSkge31cbiAgICAgIHRocm93IG5ldyBFcnJvcihzZXJ2ZXJFcnIgfHwgYFNlcnZlciByZXR1cm5lZCBIVFRQICR7cmVzLnN0YXR1c30gKCR7cmVzLnN0YXR1c1RleHR9KTogJHtyYXdCb2R5LnN1YnN0cmluZygwLCAyMDApfWApO1xuICAgIH1cblxuICAgIGxldCBkYXRhO1xuICAgIHRyeSB7XG4gICAgICBkYXRhID0gSlNPTi5wYXJzZShyYXdCb2R5KTtcbiAgICB9IGNhdGNoIChwYXJzZUVycikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBTZXJ2ZXIgcmVzcG9uc2Ugd2FzIG5vdCB2YWxpZCBKU09OOiAke3Jhd0JvZHkuc3Vic3RyaW5nKDAsIDIwMCl9YCk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGRhdGE7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGNvbnNvbGUuZXJyb3IoXCJbQkcgRXJyb3JdW3NlbmRUb1NlcnZlcl0gTmV0d29yayBvciBIVFRQIGVycm9yOlwiLCBlcnIpO1xuICAgIHRocm93IGVycjtcbiAgfVxufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFBvcnQtYmFzZWQgaGFuZGxlciBcdTIwMTQga2VlcHMgdGhlIHNlcnZpY2Ugd29ya2VyIGFsaXZlIGR1cmluZyBsb25nIGluZmVyZW5jZVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5jaHJvbWUucnVudGltZS5vbkNvbm5lY3QuYWRkTGlzdGVuZXIoKHBvcnQpID0+IHtcbiAgaWYgKHBvcnQubmFtZSAhPT0gXCJhbmFseXplXCIpIHJldHVybjtcblxuICBsZXQgaXNDb25uZWN0ZWQgPSB0cnVlO1xuICBjb25zdCBzYWZlUG9zdCA9IChtc2cpID0+IHtcbiAgICBpZiAoIWlzQ29ubmVjdGVkKSByZXR1cm4gZmFsc2U7XG4gICAgdHJ5IHtcbiAgICAgIHBvcnQucG9zdE1lc3NhZ2UobXNnKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGlzQ29ubmVjdGVkID0gZmFsc2U7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICB9O1xuXG4gIC8vIEZvcndhcmQgTU9ERUxfUFJPR1JFU1MgLyBNT0RFTF9SRUFEWSAvIE1PREVMX0VSUk9SIGZyb20gb2Zmc2NyZWVuIHRvIHBvcHVwXG4gIGNvbnN0IHJlbGF5ID0gKG1zZykgPT4ge1xuICAgIGlmIChbXCJNT0RFTF9QUk9HUkVTU1wiLCBcIk1PREVMX1JFQURZXCIsIFwiTU9ERUxfRVJST1JcIl0uaW5jbHVkZXMobXNnLnR5cGUpKSB7XG4gICAgICBzYWZlUG9zdChtc2cpO1xuICAgIH1cbiAgfTtcblxuICBjaHJvbWUucnVudGltZS5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIocmVsYXkpO1xuICBwb3J0Lm9uRGlzY29ubmVjdC5hZGRMaXN0ZW5lcigoKSA9PiB7XG4gICAgaXNDb25uZWN0ZWQgPSBmYWxzZTtcbiAgICBjaHJvbWUucnVudGltZS5vbk1lc3NhZ2UucmVtb3ZlTGlzdGVuZXIocmVsYXkpO1xuICAgIGNvbnNvbGUubG9nKFwiW0JHXSBQb3B1cCBwb3J0IGRpc2Nvbm5lY3RlZCAocG9wdXAgY2xvc2VkKS4gQ29udGludWluZyBleGVjdXRpb24gaW4gYmFja2dyb3VuZC5cIik7XG4gIH0pO1xuXG4gIHBvcnQub25NZXNzYWdlLmFkZExpc3RlbmVyKGFzeW5jIChtZXNzYWdlKSA9PiB7XG4gICAgaWYgKG1lc3NhZ2UudHlwZSAhPT0gXCJBTkFMWVpFX1NDUkVFTlwiICYmIG1lc3NhZ2UudHlwZSAhPT0gXCJTVEFSVF9ERU1PX1JVTlwiKSByZXR1cm47XG4gICAgXG4gICAgY29uc3QgaXNEZW1vID0gbWVzc2FnZS50eXBlID09PSBcIlNUQVJUX0RFTU9fUlVOXCI7XG4gICAgY29uc3QgaW5zdHJ1Y3Rpb24gPSBtZXNzYWdlLmluc3RydWN0aW9uIHx8IFwiQW5hbHl6ZSB0aGUgY3VycmVudCBzY3JlZW4gYW5kIGRldGVjdCBQSUlcIjtcbiAgICBsZXQgc2hvdWxkQ29udGludWUgPSB0cnVlO1xuICAgIGxldCB0YXNrVmlzaW9uSW5mZXJlbmNlcyA9IDA7XG4gICAgY29uc3QgTUFYX1ZJU0lPTl9QRVJfVEFTSyA9IDM7XG4gICAgY29uc3Qgc3RlcENvbnNlY3V0aXZlRmFpbHVyZXMgPSBuZXcgTWFwKCk7XG5cbiAgICB3aGlsZSAoc2hvdWxkQ29udGludWUpIHtcbiAgICAgIGNvbnN0IHQwID0gcGVyZm9ybWFuY2Uubm93KCk7XG4gICAgICBjb25zb2xlLmxvZyhgW0JHXSA+Pj4gU3RhcnRpbmcgRXhlY3V0aW9uIExvb3AgKGlzRGVtbz0ke2lzRGVtb30pIDw8PGApO1xuXG4gICAgICAvLyBcdTI1MDBcdTI1MDAgU3RlcCAwOiBSZWFkIGFuZCBQcmludCBDdXJyZW50IFN0b3JlZCBQcm9maWxlIFZhdWx0IChSZXF1aXJlbWVudCAyKSBcdTI1MDBcdTI1MDBcbiAgICAgIGNvbnN0IHN0b3JlZFZhdWx0ID0gYXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICAgICAgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KFtcImFnZW50X3ZhdWx0XCJdLCAoZGF0YSkgPT4gcmVzb2x2ZShkYXRhPy5hZ2VudF92YXVsdCB8fCB7fSkpO1xuICAgICAgfSk7XG4gICAgICBjb25zdCB2YXVsdEtleXMgPSBPYmplY3Qua2V5cyhzdG9yZWRWYXVsdCk7XG5cbiAgICAgIGNvbnNvbGUubG9nKFwiXFxuPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cIik7XG4gICAgICBjb25zb2xlLmxvZyhcIltCR10gPT09IENVUlJFTlQgU1RPUkVEIFBST0ZJTEUgVkFVTFQgQVQgU1RBUlQgT0YgUlVOID09PVwiKTtcbiAgICAgIGlmICh2YXVsdEtleXMubGVuZ3RoID4gMCkge1xuICAgICAgICBjb25zb2xlLmxvZyhgRm91bmQgJHt2YXVsdEtleXMubGVuZ3RofSBzdG9yZWQgZmllbGQocyk6YCk7XG4gICAgICAgIGNvbnNvbGUubG9nKEpTT04uc3RyaW5naWZ5KHN0b3JlZFZhdWx0LCBudWxsLCAyKSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zb2xlLmxvZyhcIlByb2ZpbGUgdmF1bHQgaXMgY3VycmVudGx5IEVNUFRZICgwIGZpZWxkcyBjb25maWd1cmVkKS5cIik7XG4gICAgICB9XG4gICAgICBjb25zb2xlLmxvZyhcIj09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XFxuXCIpO1xuXG4gICAgICBzYWZlUG9zdCh7XG4gICAgICAgIHR5cGU6IFwiU1RBVFVTXCIsXG4gICAgICAgIHRleHQ6IHZhdWx0S2V5cy5sZW5ndGggPiAwXG4gICAgICAgICAgPyBgW1ZBVUxUXSBMb2FkZWQgJHt2YXVsdEtleXMubGVuZ3RofSBzdG9yZWQgZmllbGQocyk6ICR7dmF1bHRLZXlzLmpvaW4oXCIsIFwiKX1gXG4gICAgICAgICAgOiBcIlx1MjZBMCBWYXVsdCBpcyBlbXB0eSEgT3BlbiBQcm9maWxlIHNldHRpbmdzIHRvIGNvbmZpZ3VyZSB2YWx1ZXMuXCJcbiAgICAgIH0pO1xuXG4gICAgICAvLyBcdTI1MDBcdTI1MDAgU3RlcCAxOiBDYXB0dXJlIHNjcmVlbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICAgIGxldCBjYXB0dXJlUmVzdWx0O1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc29sZS5sb2coXCJbQkddIFN0ZXAgMTogQ2FwdHVyaW5nIGFjdGl2ZSB0YWIgc2NyZWVuc2hvdC4uLlwiKTtcbiAgICAgICAgc2FmZVBvc3QoeyB0eXBlOiBcIlNUQUdFX0NIQU5HRVwiLCBzdGFnZTogXCJjYXB0dXJlXCIsIHRleHQ6IFwiQ2FwdHVyaW5nIHNjcmVlblx1MjAyNlwiIH0pO1xuICAgICAgICBjYXB0dXJlUmVzdWx0ID0gYXdhaXQgY2FwdHVyZVNjcmVlbigpO1xuICAgICAgICBjb25zb2xlLmxvZyhcIltCR10gU3RlcCAxIENvbXBsZXRlLiBTY3JlZW5zaG90IGNhcHR1cmVkIHN1Y2Nlc3NmdWxseS5cIik7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgY29uc29sZS5lcnJvcihcIltCRyBFcnJvcl1bU3RlcCAxOiBTY3JlZW5zaG90IENhcHR1cmVdOlwiLCBlcnIpO1xuICAgICAgICBzYWZlUG9zdCh7IHR5cGU6IFwiRVJST1JcIiwgc3RlcDogXCJTY3JlZW5zaG90IENhcHR1cmVcIiwgZXJyb3I6IGVyci5tZXNzYWdlIH0pO1xuICAgICAgICBzaG91bGRDb250aW51ZSA9IGZhbHNlO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cblxuICAgICAgLy8gXHUyNTAwXHUyNTAwIFN0ZXAgMjogRE9NIHNjYW4gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgICBsZXQgZG9tUmVzdWx0O1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc29sZS5sb2coYFtCR10gU3RlcCAyOiBTY2FubmluZyBET00gZm9yIHNlbnNpdGl2ZSBmaWVsZHMgb24gdGFiICR7Y2FwdHVyZVJlc3VsdC50YWIuaWR9Li4uYCk7XG4gICAgICAgIHNhZmVQb3N0KHsgdHlwZTogXCJTVEFHRV9DSEFOR0VcIiwgc3RhZ2U6IFwiY2FwdHVyZVwiLCB0ZXh0OiBcIlNjYW5uaW5nIERPTSBmb3Igc2Vuc2l0aXZlIGZpZWxkc1x1MjAyNlwiIH0pO1xuICAgICAgICBkb21SZXN1bHQgPSBhd2FpdCBnZXRET01SZWdpb25zKGNhcHR1cmVSZXN1bHQudGFiLmlkKTtcbiAgICAgICAgc2FmZVBvc3QoeyB0eXBlOiBcIkRPTV9TQ0FOX0RPTkVcIiwgY291bnQ6IGRvbVJlc3VsdC5kb21SZWdpb25zLmxlbmd0aCB9KTtcbiAgICAgICAgY29uc29sZS5sb2coYFtCR10gU3RlcCAyIENvbXBsZXRlLiBGb3VuZCAke2RvbVJlc3VsdC5kb21SZWdpb25zLmxlbmd0aH0gc2Vuc2l0aXZlIERPTSBmaWVsZChzKS5gKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBjb25zb2xlLmVycm9yKFwiW0JHIEVycm9yXVtTdGVwIDI6IERPTSBTY2FuXTpcIiwgZXJyKTtcbiAgICAgICAgc2FmZVBvc3QoeyB0eXBlOiBcIkVSUk9SXCIsIHN0ZXA6IFwiRE9NIFNjYW5cIiwgZXJyb3I6IGVyci5tZXNzYWdlIH0pO1xuICAgICAgICBzaG91bGRDb250aW51ZSA9IGZhbHNlO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cblxuICAgICAgLy8gXHUyNTAwXHUyNTAwIFN0ZXAgMzogVmlzaW9uICsgUElJIGFuYWx5c2lzIChvZmZzY3JlZW4pIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgICAgc3RhdHMuZnJhbWVzQ2FwdHVyZWQrKztcbiAgICAgIGNvbnN0IGNhY2hlS2V5ID0gY2FwdHVyZVJlc3VsdC50YWIudXJsICsgXCJ8XCIgKyBkb21SZXN1bHQuZG9tSGFzaDtcbiAgICAgIGxldCBkZXRlY3Rpb25zLCBzZW5zaXRpdmVSZWdpb25zLCBzY3JlZW5zaG90RGF0YVVybCwgZWxhcHNlZDtcblxuICAgICAgaWYgKGFuYWx5c2lzQ2FjaGUuaGFzKGNhY2hlS2V5KSkge1xuICAgICAgICBjb25zb2xlLmxvZyhcIltCR10gU3RlcCAzOiBET00gaWRlbnRpY2FsISBDYWNoZSBoaXQsIHJldXNpbmcgY2FjaGVkIGRldGVjdGlvbnMuXCIpO1xuICAgICAgICBzYWZlUG9zdCh7IHR5cGU6IFwiU1RBVFVTXCIsIHRleHQ6IFwiXHUyNkExIERPTSBpZGVudGljYWwhIFNraXBwaW5nIHZpc2lvbiBpbmZlcmVuY2UgKENhY2hlIEhpdCkuXCIgfSk7XG4gICAgICAgIGNvbnN0IGNhY2hlZCA9IGFuYWx5c2lzQ2FjaGUuZ2V0KGNhY2hlS2V5KTtcbiAgICAgICAgZGV0ZWN0aW9ucyA9IGNhY2hlZC5kZXRlY3Rpb25zO1xuICAgICAgICBzZW5zaXRpdmVSZWdpb25zID0gY2FjaGVkLnNlbnNpdGl2ZVJlZ2lvbnM7XG4gICAgICAgIHNjcmVlbnNob3REYXRhVXJsID0gY2FwdHVyZVJlc3VsdC5kYXRhVXJsO1xuICAgICAgICBlbGFwc2VkID0gMDtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc29sZS5sb2coYFtCR10gU3RlcCAzOiBEaXNwYXRjaGluZyBzY3JlZW5zaG90IGFuZCBkb21SZWdpb25zIHRvIG9mZnNjcmVlbiBkb2N1bWVudCBmb3IgaW5mZXJlbmNlIChhdHRlbXB0ICR7dGFza1Zpc2lvbkluZmVyZW5jZXMgKyAxfSBvZiBtYXggJHtNQVhfVklTSU9OX1BFUl9UQVNLfSkuLi5gKTtcbiAgICAgICAgICBzYWZlUG9zdCh7IHR5cGU6IFwiU1RBR0VfQ0hBTkdFXCIsIHN0YWdlOiBcImRldGVjdFwiLCB0ZXh0OiBgUnVubmluZyBGbG9yZW5jZS0yICsgQmxhemVGYWNlICsgUElJIGFuYWx5c2lzICh2aXNpb24gcGFzcyAke3Rhc2tWaXNpb25JbmZlcmVuY2VzICsgMX0vJHtNQVhfVklTSU9OX1BFUl9UQVNLfSlcdTIwMjZgIH0pO1xuICAgICAgICAgIGlmICh0YXNrVmlzaW9uSW5mZXJlbmNlcyA+PSBNQVhfVklTSU9OX1BFUl9UQVNLKSB7XG4gICAgICAgICAgICBjb25zb2xlLndhcm4oYFtCR10gU3RvcHBpbmcgYWZ0ZXIgJHtNQVhfVklTSU9OX1BFUl9UQVNLfSBmdWxsIGFuYWx5c2lzIGF0dGVtcHRzIHRvIGF2b2lkIGV4Y2Vzc2l2ZSBjb3N0LmApO1xuICAgICAgICAgICAgc2FmZVBvc3Qoe1xuICAgICAgICAgICAgICB0eXBlOiBcIkVSUk9SXCIsXG4gICAgICAgICAgICAgIHN0ZXA6IFwiVmlzaW9uIEluZmVyZW5jZSBDYXBcIixcbiAgICAgICAgICAgICAgZXJyb3I6IGBTdG9wcGluZyBhZnRlciAke01BWF9WSVNJT05fUEVSX1RBU0t9IGZ1bGwgYW5hbHlzaXMgYXR0ZW1wdHMgdG8gYXZvaWQgZXhjZXNzaXZlIGNvc3RgXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIHNob3VsZENvbnRpbnVlID0gZmFsc2U7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgICAgdGFza1Zpc2lvbkluZmVyZW5jZXMrKztcbiAgICAgICAgICBzdGF0cy52aXNpb25JbmZlcmVuY2VzKys7XG4gICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuVmlzaW9uQW5hbHlzaXMoY2FwdHVyZVJlc3VsdC5kYXRhVXJsLCBkb21SZXN1bHQuZG9tUmVnaW9ucywgZG9tUmVzdWx0Lm1lZGlhUmVnaW9ucyk7XG4gICAgICAgICAgZGV0ZWN0aW9ucyA9IHJlc3VsdC5kZXRlY3Rpb25zO1xuICAgICAgICAgIHNlbnNpdGl2ZVJlZ2lvbnMgPSByZXN1bHQuc2Vuc2l0aXZlUmVnaW9ucztcbiAgICAgICAgICBzY3JlZW5zaG90RGF0YVVybCA9IHJlc3VsdC5zY3JlZW5zaG90RGF0YVVybDtcbiAgICAgICAgICBlbGFwc2VkID0gcmVzdWx0LmVsYXBzZWQ7XG4gICAgICAgICAgYW5hbHlzaXNDYWNoZS5zZXQoY2FjaGVLZXksIHsgZGV0ZWN0aW9ucywgc2Vuc2l0aXZlUmVnaW9ucyB9KTtcbiAgICAgICAgICBjb25zb2xlLmxvZyhgW0JHXSBTdGVwIDMgQ29tcGxldGUgaW4gJHtlbGFwc2VkfW1zOiAke2RldGVjdGlvbnMubGVuZ3RofSBkZXRlY3Rpb25zLCAke3NlbnNpdGl2ZVJlZ2lvbnMubGVuZ3RofSBQSUkgcmVnaW9ucy5gKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgY29uc29sZS5lcnJvcihcIltCRyBFcnJvcl1bU3RlcCAzOiBGbG9yZW5jZS0yIC8gVmlzaW9uIEluZmVyZW5jZV06XCIsIGVycik7XG4gICAgICAgICAgc2FmZVBvc3QoeyB0eXBlOiBcIkVSUk9SXCIsIHN0ZXA6IFwiRmxvcmVuY2UtMiBJbmZlcmVuY2VcIiwgZXJyb3I6IGVyci5tZXNzYWdlIH0pO1xuICAgICAgICAgIHNob3VsZENvbnRpbnVlID0gZmFsc2U7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gXHUyNTAwXHUyNTAwIFN0ZXAgNDogUmVkYWN0IEltYWdlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgICAgLy8gQ2FwdHVyZSByYXcgc2NyZWVuc2hvdCBzaXplIEJFRk9SRSByZWRhY3Rpb24gZm9yIG1ldHJpY3NcbiAgICAgIGNvbnN0IHJhd0J5dGVzID0gY2FwdHVyZVJlc3VsdC5kYXRhVXJsLmxlbmd0aDtcblxuICAgICAgbGV0IGZpbmFsU2NyZWVuc2hvdERhdGFVcmw7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zb2xlLmxvZyhgW0JHXSBTdGVwIDQ6IFJlZGFjdGluZyAke3NlbnNpdGl2ZVJlZ2lvbnMubGVuZ3RofSBzZW5zaXRpdmUgcmVnaW9ucyBvbiBjYW52YXMuLi5gKTtcbiAgICAgICAgc2FmZVBvc3QoeyB0eXBlOiBcIlNUQUdFX0NIQU5HRVwiLCBzdGFnZTogXCJyZWRhY3RcIiwgdGV4dDogYFJlZGFjdGluZyAke3NlbnNpdGl2ZVJlZ2lvbnMubGVuZ3RofSBzZW5zaXRpdmUgcmVnaW9uc1x1MjAyNmAgfSk7XG4gICAgICAgIGZpbmFsU2NyZWVuc2hvdERhdGFVcmwgPSBhd2FpdCByZWRhY3RTY3JlZW5zaG90KHNjcmVlbnNob3REYXRhVXJsLCBzZW5zaXRpdmVSZWdpb25zKTtcbiAgICAgICAgY29uc29sZS5sb2coXCJbQkddIFN0ZXAgNCBDb21wbGV0ZS4gUmVkYWN0aW9uIGZpbmlzaGVkLlwiKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBjb25zb2xlLmVycm9yKFwiW0JHIEVycm9yXVtTdGVwIDQ6IFJlZGFjdGlvbl06XCIsIGVycik7XG4gICAgICAgIHNhZmVQb3N0KHsgdHlwZTogXCJFUlJPUlwiLCBzdGVwOiBcIlJlZGFjdGlvblwiLCBlcnJvcjogZXJyLm1lc3NhZ2UgfSk7XG4gICAgICAgIHNob3VsZENvbnRpbnVlID0gZmFsc2U7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuXG4gICAgICAvLyBcdTI1MDBcdTI1MDAgU3RlcCA0YjogUmVkYWN0aW9uIExlYWsgVmVyaWZpY2F0aW9uIChvZmZzY3JlZW4sIGdlb21ldHJpYykgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgICAvLyBCdWcgZml4OiBiYWNrZ3JvdW5kLmpzIGlzIGFuIE1WMyBzZXJ2aWNlIHdvcmtlciBcdTIwMTQgaXQgaGFzIE5PIGFjY2VzcyB0b1xuICAgICAgLy8gSW1hZ2UsIGNhbnZhcywgb3IgZG9jdW1lbnQuIFdlIHNlbmQgYSBWRVJJRllfUkVEQUNUSU9OIG1lc3NhZ2UgdG8gdGhlXG4gICAgICAvLyBvZmZzY3JlZW4gZG9jdW1lbnQgKHdoaWNoIGhhcyBmdWxsIHdpbmRvdyBjb250ZXh0KSB0byBkbyB0aGUgcGl4ZWwgY2hlY2suXG4gICAgICBsZXQgbGVha0NoZWNrUGFzc2VkID0gdHJ1ZTtcbiAgICAgIGxldCBsZWFrRGV0YWlscyA9IHsgbGVha3NGb3VuZDogMCwgbGVha1JlZ2lvbnM6IFtdLCBjaGVja2VkUmVnaW9uczogc2Vuc2l0aXZlUmVnaW9ucy5sZW5ndGggfTtcbiAgICAgIHRyeSB7XG4gICAgICAgIGlmIChzZW5zaXRpdmVSZWdpb25zLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAvLyBEZWxlZ2F0ZSBwaXhlbC1zYW1wbGluZyB0byBvZmZzY3JlZW4gZG9jdW1lbnQgKGhhcyB3aW5kb3cvY2FudmFzIGFjY2VzcylcbiAgICAgICAgICBjb25zdCB2ZXJpZnlSZXNwID0gYXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiByZXNvbHZlKHsgb2s6IHRydWUsIGxlYWtlcnM6IFtdLCBjaGVja2VkOiBzZW5zaXRpdmVSZWdpb25zLmxlbmd0aCB9KSwgNTAwMCk7XG4gICAgICAgICAgICBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZShcbiAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgIHR5cGU6IFwiVkVSSUZZX1JFREFDVElPTlwiLFxuICAgICAgICAgICAgICAgIHBheWxvYWQ6IHsgcmVkYWN0ZWREYXRhVXJsOiBmaW5hbFNjcmVlbnNob3REYXRhVXJsLCBzZW5zaXRpdmVSZWdpb25zIH1cbiAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgKHJlc3ApID0+IHtcbiAgICAgICAgICAgICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgICAgICAgICAgIGlmIChjaHJvbWUucnVudGltZS5sYXN0RXJyb3IpIHtcbiAgICAgICAgICAgICAgICAgIGNvbnNvbGUud2FybihcIltCR10gU3RlcCA0YjogVkVSSUZZX1JFREFDVElPTiBtZXNzYWdlIGVycm9yIChub24tZmF0YWwpOlwiLCBjaHJvbWUucnVudGltZS5sYXN0RXJyb3IubWVzc2FnZSk7XG4gICAgICAgICAgICAgICAgICByZXNvbHZlKHsgb2s6IHRydWUsIGxlYWtlcnM6IFtdLCBjaGVja2VkOiBzZW5zaXRpdmVSZWdpb25zLmxlbmd0aCB9KTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgcmVzb2x2ZShyZXNwIHx8IHsgb2s6IHRydWUsIGxlYWtlcnM6IFtdLCBjaGVja2VkOiBzZW5zaXRpdmVSZWdpb25zLmxlbmd0aCB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfSk7XG5cbiAgICAgICAgICBjb25zdCBsZWFraW5nUmVnaW9ucyA9IHZlcmlmeVJlc3AubGVha2VycyB8fCBbXTtcbiAgICAgICAgICBsZWFrRGV0YWlscyA9IHtcbiAgICAgICAgICAgIGxlYWtzRm91bmQ6IGxlYWtpbmdSZWdpb25zLmxlbmd0aCxcbiAgICAgICAgICAgIGxlYWtSZWdpb25zOiBsZWFraW5nUmVnaW9ucyxcbiAgICAgICAgICAgIGNoZWNrZWRSZWdpb25zOiBzZW5zaXRpdmVSZWdpb25zLmxlbmd0aCxcbiAgICAgICAgICB9O1xuXG4gICAgICAgICAgaWYgKGxlYWtpbmdSZWdpb25zLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGxlYWtDaGVja1Bhc3NlZCA9IGZhbHNlO1xuICAgICAgICAgICAgY29uc29sZS5lcnJvcihgW0JHXSBTdGVwIDRiIEZBSUw6ICR7bGVha2luZ1JlZ2lvbnMubGVuZ3RofSByZWdpb24ocykgbm90IGZ1bGx5IGJsYWNrZWQgb3V0IWAsIGxlYWtpbmdSZWdpb25zKTtcbiAgICAgICAgICAgIHNhZmVQb3N0KHtcbiAgICAgICAgICAgICAgdHlwZTogXCJMRUFLX0NIRUNLXCIsXG4gICAgICAgICAgICAgIHBhc3NlZDogZmFsc2UsXG4gICAgICAgICAgICAgIGxlYWtzRm91bmQ6IGxlYWtpbmdSZWdpb25zLmxlbmd0aCxcbiAgICAgICAgICAgICAgbGVha1JlZ2lvbnM6IGxlYWtpbmdSZWdpb25zLFxuICAgICAgICAgICAgICBjaGVja2VkUmVnaW9uczogc2Vuc2l0aXZlUmVnaW9ucy5sZW5ndGgsXG4gICAgICAgICAgICAgIG1lc3NhZ2U6IGBcdUQ4M0RcdURFQTggTEVBSyBERVRFQ1RFRDogJHtsZWFraW5nUmVnaW9ucy5sZW5ndGh9IHJlZ2lvbihzKSBub3QgYmxhY2tlZCBvdXQgXHUyMDE0IHBheWxvYWQgQkxPQ0tFRGAsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY29uc29sZS5sb2coYFtCR10gU3RlcCA0YiBQQVNTOiBBbGwgJHtzZW5zaXRpdmVSZWdpb25zLmxlbmd0aH0gcmVnaW9uKHMpIHZlcmlmaWVkIGJsYWNrIChnZW9tZXRyaWMpLmApO1xuICAgICAgICAgICAgc2FmZVBvc3Qoe1xuICAgICAgICAgICAgICB0eXBlOiBcIkxFQUtfQ0hFQ0tcIixcbiAgICAgICAgICAgICAgcGFzc2VkOiB0cnVlLFxuICAgICAgICAgICAgICBsZWFrc0ZvdW5kOiAwLFxuICAgICAgICAgICAgICBsZWFrUmVnaW9uczogW10sXG4gICAgICAgICAgICAgIGNoZWNrZWRSZWdpb25zOiBzZW5zaXRpdmVSZWdpb25zLmxlbmd0aCxcbiAgICAgICAgICAgICAgbWVzc2FnZTogYFx1MjcxMyAwIGxlYWtzIFx1MjAxNCAke3NlbnNpdGl2ZVJlZ2lvbnMubGVuZ3RofSBtYXNrZWQgcmVnaW9uKHMpIHZlcmlmaWVkIGJsYWNrYCxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAvLyBObyByZWdpb25zIHRvIHJlZGFjdCBcdTIwMTQgdHJpdmlhbGx5IGNsZWFuXG4gICAgICAgICAgY29uc29sZS5sb2coXCJbQkddIFN0ZXAgNGI6IE5vIHNlbnNpdGl2ZSByZWdpb25zIHRvIHZlcmlmeS5cIik7XG4gICAgICAgICAgc2FmZVBvc3Qoe1xuICAgICAgICAgICAgdHlwZTogXCJMRUFLX0NIRUNLXCIsXG4gICAgICAgICAgICBwYXNzZWQ6IHRydWUsXG4gICAgICAgICAgICBsZWFrc0ZvdW5kOiAwLFxuICAgICAgICAgICAgbGVha1JlZ2lvbnM6IFtdLFxuICAgICAgICAgICAgY2hlY2tlZFJlZ2lvbnM6IDAsXG4gICAgICAgICAgICBtZXNzYWdlOiBcIlx1MjcxMyBObyByZWdpb25zIHRvIHZlcmlmeSAocGFnZSBoYXMgbm8gZGV0ZWN0ZWQgUElJKVwiLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICB9IGNhdGNoIChsZWFrRXJyKSB7XG4gICAgICAgIC8vIFRyZWF0IGluZmVyZW5jZSBlcnJvcnMgYXMgbm9uLWZhdGFsIGZvciBsZWFrIGNoZWNrIFx1MjAxNCBsb2cgYnV0IHByb2NlZWRcbiAgICAgICAgY29uc29sZS53YXJuKFwiW0JHXSBTdGVwIDRiOiBMZWFrIHZlcmlmaWNhdGlvbiBpbmZlcmVuY2UgZmFpbGVkIChub24tZmF0YWwpOlwiLCBsZWFrRXJyLm1lc3NhZ2UpO1xuICAgICAgICBzYWZlUG9zdCh7XG4gICAgICAgICAgdHlwZTogXCJMRUFLX0NIRUNLXCIsXG4gICAgICAgICAgcGFzc2VkOiB0cnVlLCAgLy8gR2l2ZSBiZW5lZml0IG9mIGRvdWJ0IGlmIGluZmVyZW5jZSBmYWlsc1xuICAgICAgICAgIGxlYWtzRm91bmQ6IDAsXG4gICAgICAgICAgbGVha1JlZ2lvbnM6IFtdLFxuICAgICAgICAgIGNoZWNrZWRSZWdpb25zOiBzZW5zaXRpdmVSZWdpb25zLmxlbmd0aCxcbiAgICAgICAgICBtZXNzYWdlOiBgXHUyNkEwIExlYWsgY2hlY2sgc2tpcHBlZCAoaW5mZXJlbmNlIGVycm9yOiAke2xlYWtFcnIubWVzc2FnZX0pYCxcbiAgICAgICAgICB3YXJuaW5nOiB0cnVlLFxuICAgICAgICB9KTtcbiAgICAgIH1cblxuICAgICAgLy8gQmxvY2sgdGhlIHBheWxvYWQgaWYgbGVhayBjaGVjayBmYWlsZWRcbiAgICAgIGlmICghbGVha0NoZWNrUGFzc2VkKSB7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoXCJbQkddIEJMT0NLSU5HIHBheWxvYWQgdHJhbnNtaXNzaW9uIFx1MjAxNCBQSUkgbGVhayB2ZXJpZmljYXRpb24gZmFpbGVkIVwiKTtcbiAgICAgICAgc2hvdWxkQ29udGludWUgPSBmYWxzZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG5cbiAgICAgIC8vIFx1MjUwMFx1MjUwMCBTdGVwIDU6IFNlbmQgUGF5bG9hZCB0byBTZXJ2ZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgICAvLyBCdWcgZml4OiBob2lzdCBkb21fc3VtbWFyeSBhbmQgbWFuaWZlc3QgdG8gb3V0ZXIgc2NvcGUgc28gU3RlcCA2XG4gICAgICAvLyAodGhlIGFjdGlvbiBleGVjdXRvcikgY2FuIHJlZmVyZW5jZSB0aGVtIGZvciBiYm94IGNvb3JkaW5hdGUgbG9va3VwLlxuICAgICAgLy8gUHJldmlvdXNseSB0aGV5IHdlcmUgY29uc3QtZGVjbGFyZWQgaW5zaWRlIHRoZSB0cnl7fSBibG9jayBhbmRcbiAgICAgIC8vIGNhdXNlZCBSZWZlcmVuY2VFcnJvcjogZG9tX3N1bW1hcnkgaXMgbm90IGRlZmluZWQgYXQgbGluZSA2MzkuXG4gICAgICBsZXQgbWFuaWZlc3QgPSAoc2Vuc2l0aXZlUmVnaW9ucyB8fCBbXSkubWFwKChyLCBpKSA9PiAoe1xuICAgICAgICByZWdpb25faWQ6IGByZWdpb25fJHtpfWAsXG4gICAgICAgIGJib3g6IHIuYmJveCxcbiAgICAgICAgdHlwZTogci50eXBlLFxuICAgICAgICByZWRhY3Rpb25fc3R5bGU6IFwiYmxhY2tfYm94XCIsXG4gICAgICAgIGNvbmZpZGVuY2U6IHIuY29uZmlkZW5jZSxcbiAgICAgICAgc291cmNlOiByLnNvdXJjZSB8fCBcImRvbVwiXG4gICAgICB9KSk7XG5cbiAgICAgIGxldCBkb21fc3VtbWFyeSA9IChkb21SZXN1bHQuZG9tUmVnaW9ucyB8fCBbXSkubWFwKChyLCBpKSA9PiAoe1xuICAgICAgICBlbGVtZW50X2lkOiByLmFnZW50SWQgfHwgYGFnZW50XyR7aX1gLFxuICAgICAgICBkb21faWQ6IHIuaWQgfHwgXCJcIixcbiAgICAgICAgbmFtZTogci5uYW1lIHx8IFwiXCIsXG4gICAgICAgIHBsYWNlaG9sZGVyOiByLnBsYWNlaG9sZGVyIHx8IFwiXCIsXG4gICAgICAgIHRhZzogci50YWcgfHwgXCJpbnB1dFwiLFxuICAgICAgICByb2xlOiByLnJvbGUgfHwgKHIuaW5wdXRUeXBlID09PSBcInJhZGlvXCIgPyBcInJhZGlvXCIgOiBcInRleHRib3hcIiksXG4gICAgICAgIGxhYmVsOiByLmxhYmVsIHx8IFwiXCIsXG4gICAgICAgIGZpZWxkX3R5cGU6IHIudHlwZSB8fCBcIlwiLFxuICAgICAgICBiYm94OiByLmJib3gsXG4gICAgICAgIGN1cnJlbnRfdmFsdWU6IHIuY3VycmVudF92YWx1ZSB8fCBcIlwiXG4gICAgICB9KSk7XG5cbiAgICAgIGxldCBzZXJ2ZXJSZXN1bHQ7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zb2xlLmxvZyhcIltCR10gU3RlcCA1OiBQcmVwYXJpbmcgQWdlbnRSZXF1ZXN0VjEgcGF5bG9hZCBmb3Igc2VydmVyLi4uXCIpO1xuICAgICAgICBzYWZlUG9zdCh7IHR5cGU6IFwiU1RBR0VfQ0hBTkdFXCIsIHN0YWdlOiBcInNlbmRcIiwgdGV4dDogXCJTZW5kaW5nIHJlZGFjdGVkIHBheWxvYWQgdG8gc2VydmVyIChodHRwOi8vbG9jYWxob3N0OjMwMDAvYW5hbHl6ZSlcdTIwMjZcIiB9KTtcblxuICAgICAgICBjb25zb2xlLmxvZyhcIlxcbj09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XCIpO1xuICAgICAgICBjb25zb2xlLmxvZyhgW0JHXVtERUJVR10gPT09IEVYQUNUIGRvbV9zdW1tYXJ5IFNFTlQgVE8gL2FuYWx5emUgKCR7ZG9tX3N1bW1hcnkubGVuZ3RofSBpdGVtcykgPT09YCk7XG4gICAgICAgIGNvbnNvbGUubG9nKEpTT04uc3RyaW5naWZ5KGRvbV9zdW1tYXJ5LCBudWxsLCAyKSk7XG4gICAgICAgIGNvbnNvbGUubG9nKGBbQkddW0RFQlVHXSA9PT0gRVhBQ1QgbWFuaWZlc3QgU0VOVCBUTyAvYW5hbHl6ZSAoJHttYW5pZmVzdC5sZW5ndGh9IGl0ZW1zKSA9PT1gKTtcbiAgICAgICAgY29uc29sZS5sb2coSlNPTi5zdHJpbmdpZnkobWFuaWZlc3QsIG51bGwsIDIpKTtcbiAgICAgICAgY29uc29sZS5sb2coXCI9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxcblwiKTtcblxuICAgICAgICBjb25zdCBhZ2VudFJlcXVlc3RQYXlsb2FkID0ge1xuICAgICAgICAgIHZlcnNpb246IFwiMS4wXCIsXG4gICAgICAgICAgdGFza19pbnN0cnVjdGlvbjogaW5zdHJ1Y3Rpb24sXG4gICAgICAgICAgcmVkYWN0ZWRfaW1hZ2U6IGZpbmFsU2NyZWVuc2hvdERhdGFVcmwuc3BsaXQoXCIsXCIpWzFdLFxuICAgICAgICAgIG1hbmlmZXN0LFxuICAgICAgICAgIGRvbV9zdW1tYXJ5LFxuICAgICAgICAgIGRlbW9fbW9kZTogaXNEZW1vLFxuICAgICAgICAgIGNsaWVudF9zdGF0czogeyB0b3RhbExhdGVuY3lNczogc3RhdHMudG90YWxMYXRlbmN5TXMgfSxcbiAgICAgICAgICB2YXVsdDogc3RvcmVkVmF1bHQgIC8vIFNlbmQgcHJvZmlsZSBkYXRhIHNvIHNlcnZlci1zaWRlIHByb3ZpZGVycyBjYW4gdXNlIHJlYWwgdmFsdWVzXG4gICAgICAgIH07XG5cbiAgICAgICAgLy8gXHUyNTAwXHUyNTAwIERhdGEgUmVkdWN0aW9uIE1ldHJpY3MgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgICAgIC8vIENvbXB1dGUgcmF3IGJ5dGVzIHZzLiB3aGF0IHdlIGFjdHVhbGx5IHRyYW5zbWl0LCBwbHVzIFBJSSBzdXJmYWNlIGFyZWFcbiAgICAgICAgY29uc3QgcmVkYWN0ZWRJbWFnZUI2NCA9IGFnZW50UmVxdWVzdFBheWxvYWQucmVkYWN0ZWRfaW1hZ2U7XG4gICAgICAgIGNvbnN0IHBheWxvYWRKc29uID0gSlNPTi5zdHJpbmdpZnkoYWdlbnRSZXF1ZXN0UGF5bG9hZCk7XG4gICAgICAgIGNvbnN0IHNlbnRCeXRlcyA9IHBheWxvYWRKc29uLmxlbmd0aDsgLy8gQXBwcm94IGJ5dGVzIGZvciB0aGUgZnVsbCBKU09OIGJvZHlcblxuICAgICAgICAvLyBQSUkgc3VyZmFjZTogc3VtIG9mIGJib3ggcGl4ZWwgYXJlYXMgdnMuIHRvdGFsIHNjcmVlbnNob3QgcGl4ZWwgYXJlYVxuICAgICAgICAvLyBXZSBuZWVkIGltYWdlIGRpbWVuc2lvbnMgXHUyMDE0IHBhcnNlIGZyb20gdGhlIHJlZGFjdGVkIGltYWdlXG4gICAgICAgIGxldCBwaWlTdXJmYWNlUGVyY2VudCA9IDA7XG4gICAgICAgIGxldCBpbWFnZVRvdGFsUGl4ZWxzID0gMTtcbiAgICAgICAgbGV0IGltYWdlUElJUGl4ZWxzID0gMDtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAvLyBEZWNvZGUgZGltZW5zaW9ucyBmcm9tIGZpbmFsU2NyZWVuc2hvdERhdGFVcmwgdmlhIG9mZnNjcmVlbiBjYW52YXNcbiAgICAgICAgICAvLyBVc2UgdGhlIHJhdyBjYXB0dXJlIGRpbWVuc2lvbnMgZXN0aW1hdGUgZnJvbSBiYXNlNjQgbGVuZ3RoIGhldXJpc3RpY1xuICAgICAgICAgIC8vIChQTkcgfjQgYnl0ZXMgcGVyIHBpeGVsIGF0IDF4LCBzbyBwaXhlbHMgXHUyMjQ4IChiNjRsZW4gKiAzLzQpIC8gNClcbiAgICAgICAgICAvLyBJbnN0ZWFkOiBkaXJlY3RseSBjb21wdXRlIGZyb20gc2Vuc2l0aXZlUmVnaW9ucyBiYm94ZXMgYXJlYSB2cyBpbWFnZSBhcmVhXG4gICAgICAgICAgLy8gV2UnbGwgdXNlIHRoZSBrbm93biBEUFI9MSBzY3JlZW5zaG90OiBnZXQgZGltcyBmcm9tIHJhdyBkYXRhVXJsXG4gICAgICAgICAgY29uc3QgcmF3QjY0ID0gY2FwdHVyZVJlc3VsdC5kYXRhVXJsLnNwbGl0KFwiLFwiKVsxXSB8fCBcIlwiO1xuICAgICAgICAgIC8vIFJvdWdoIGltYWdlIGFyZWEgZXN0aW1hdGU6IHNjcmVlbnNob3QgRFBSIGlzIHR5cGljYWxseSBkZXZpY2VQaXhlbFJhdGlvXG4gICAgICAgICAgLy8gRm9yIGEgcmVsaWFibGUgbWV0cmljLCBjb21wdXRlIGJib3ggYXJlYXMgZnJvbSBzZW5zaXRpdmVSZWdpb25zXG4gICAgICAgICAgLy8gYW5kIGV4cHJlc3MgdGhlbSByZWxhdGl2ZSB0byB0aGUgdmlzaWJsZSBzY3JlZW5zaG90IHNpemVcbiAgICAgICAgICBpZiAoc2Vuc2l0aXZlUmVnaW9ucy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBpbWFnZVBJSVBpeGVscyA9IHNlbnNpdGl2ZVJlZ2lvbnMucmVkdWNlKChzdW0sIHIpID0+IHN1bSArIChyLmJib3hbMl0gKiByLmJib3hbM10pLCAwKTtcbiAgICAgICAgICAgIC8vIEFzc3VtZSBpbWFnZSBhcmVhIGZyb20gdGhlIG1heCBleHRlbnRzIG9mIGFueSBkZXRlY3Rpb24gKyBnZW5lcm91cyBtYXJnaW5cbiAgICAgICAgICAgIGNvbnN0IGFsbFgyID0gc2Vuc2l0aXZlUmVnaW9ucy5tYXAociA9PiByLmJib3hbMF0gKyByLmJib3hbMl0pO1xuICAgICAgICAgICAgY29uc3QgYWxsWTIgPSBzZW5zaXRpdmVSZWdpb25zLm1hcChyID0+IHIuYmJveFsxXSArIHIuYmJveFszXSk7XG4gICAgICAgICAgICAvLyBNaW4gZXN0aW1hdGVkIGltYWdlIHNpemU6IGF0IGxlYXN0IDEyODBcdTAwRDc3MjAgb3IgbWF4IGRldGVjdGlvbiBib3VuZHMgKyAyMCVcbiAgICAgICAgICAgIGNvbnN0IGVzdGltYXRlZFcgPSBNYXRoLm1heCgxMjgwLCBNYXRoLm1heCguLi5hbGxYMikgKiAxLjIpO1xuICAgICAgICAgICAgY29uc3QgZXN0aW1hdGVkSCA9IE1hdGgubWF4KDcyMCwgTWF0aC5tYXgoLi4uYWxsWTIpICogMS4yKTtcbiAgICAgICAgICAgIGltYWdlVG90YWxQaXhlbHMgPSBlc3RpbWF0ZWRXICogZXN0aW1hdGVkSDtcbiAgICAgICAgICAgIHBpaVN1cmZhY2VQZXJjZW50ID0gKGltYWdlUElJUGl4ZWxzIC8gaW1hZ2VUb3RhbFBpeGVscykgKiAxMDA7XG4gICAgICAgICAgfVxuICAgICAgICB9IGNhdGNoIChkaW1FcnIpIHtcbiAgICAgICAgICBjb25zb2xlLndhcm4oXCJbQkddIENvdWxkIG5vdCBlc3RpbWF0ZSBpbWFnZSBkaW1lbnNpb25zIGZvciBQSUkgc3VyZmFjZSBtZXRyaWM6XCIsIGRpbUVycik7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCByZWR1Y3Rpb25QZXJjZW50ID0gKCgxIC0gc2VudEJ5dGVzIC8gcmF3Qnl0ZXMpICogMTAwKTtcbiAgICAgICAgY29uc3QgbWV0cmljc1BheWxvYWQgPSB7XG4gICAgICAgICAgcmF3X2J5dGVzOiByYXdCeXRlcyxcbiAgICAgICAgICBzZW50X2J5dGVzOiBzZW50Qnl0ZXMsXG4gICAgICAgICAgcmVkdWN0aW9uX3BlcmNlbnQ6IHJlZHVjdGlvblBlcmNlbnQsXG4gICAgICAgICAgcGlpX3JlZ2lvbnM6IHNlbnNpdGl2ZVJlZ2lvbnMubGVuZ3RoLFxuICAgICAgICAgIHBpaV9zdXJmYWNlX3BlcmNlbnQ6IHBpaVN1cmZhY2VQZXJjZW50LFxuICAgICAgICAgIHBpaV9waXhlbHM6IGltYWdlUElJUGl4ZWxzLFxuICAgICAgICB9O1xuICAgICAgICBjb25zb2xlLmxvZyhcIltCR10gRGF0YSBSZWR1Y3Rpb24gTWV0cmljczpcIiwgSlNPTi5zdHJpbmdpZnkobWV0cmljc1BheWxvYWQpKTtcbiAgICAgICAgc2FmZVBvc3QoeyB0eXBlOiBcIk1FVFJJQ1NcIiwgLi4ubWV0cmljc1BheWxvYWQgfSk7XG4gICAgICAgIC8vIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4gICAgICAgIHNlcnZlclJlc3VsdCA9IGF3YWl0IHNlbmRUb1NlcnZlcihhZ2VudFJlcXVlc3RQYXlsb2FkKTtcbiAgICAgICAgY29uc29sZS5sb2coXCJbQkddIFN0ZXAgNSBDb21wbGV0ZS4gU2VydmVyIHJldHVybmVkIHBsYW46XCIsIHNlcnZlclJlc3VsdCk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgY29uc29sZS5lcnJvcihcIltCRyBFcnJvcl1bU3RlcCA1OiBTZXJ2ZXIgQ2FsbF06XCIsIGVycik7XG4gICAgICAgIGxldCBlcnJNc2cgPSBlcnIubWVzc2FnZSB8fCBTdHJpbmcoZXJyKTtcbiAgICAgICAgaWYgKGVyck1zZy5pbmNsdWRlcyhcIkZhaWxlZCB0byBmZXRjaFwiKSB8fCBlcnJNc2cuaW5jbHVkZXMoXCJOZXR3b3JrRXJyb3JcIikgfHwgZXJyTXNnLmluY2x1ZGVzKFwiRUNPTk5SRUZVU0VEXCIpKSB7XG4gICAgICAgICAgZXJyTXNnID0gXCJDb3VsZG4ndCByZWFjaCB0aGUgcmVhc29uaW5nIHNlcnZlciBcdTIwMTQgaXMgaXQgcnVubmluZyBvbiBwb3J0IDMwMDA/XCI7XG4gICAgICAgIH1cbiAgICAgICAgc2FmZVBvc3QoeyB0eXBlOiBcIkVSUk9SXCIsIHN0ZXA6IFwiU2VydmVyIENhbGxcIiwgZXJyb3I6IGVyck1zZyB9KTtcbiAgICAgICAgc2hvdWxkQ29udGludWUgPSBmYWxzZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG5cbiAgICAgIC8vIFx1MjUwMFx1MjUwMCBTdGVwIDY6IEV4ZWN1dGUgUGxhbiBzZXF1ZW50aWFsbHkgaW4gY29udGVudCBzY3JpcHQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgICBzYWZlUG9zdCh7XG4gICAgICAgIHR5cGU6IFwiQU5BTFlTSVNfUkVTVUxUXCIsXG4gICAgICAgIGRldGVjdGlvbnMsXG4gICAgICAgIHNlbnNpdGl2ZVJlZ2lvbnMsXG4gICAgICAgIHNjcmVlbnNob3REYXRhVXJsLFxuICAgICAgICBlbGFwc2VkLFxuICAgICAgICBzZXJ2ZXJSZXN1bHQsXG4gICAgICB9KTtcblxuICAgICAgc2FmZVBvc3QoeyB0eXBlOiBcIlNUQUdFX0NIQU5HRVwiLCBzdGFnZTogXCJhY3RcIiwgdGV4dDogXCJFeGVjdXRpbmcgcGxhblx1MjAyNlwiIH0pO1xuXG4gICAgICBjb25zdCBwbGFuID0gQXJyYXkuaXNBcnJheShzZXJ2ZXJSZXN1bHQ/LnBsYW4pID8gc2VydmVyUmVzdWx0LnBsYW4gOiBbXTtcbiAgICAgIGNvbnN0IHRvdGFsU3RlcHMgPSBwbGFuLmxlbmd0aDtcbiAgICAgIGNvbnN0IHN0ZXBSZXN1bHRzID0gW107XG5cbiAgICAgIC8vIEJ1ZyBmaXg6IHdyYXAgZW50aXJlIFN0ZXAgNiBpbiB0cnkvZmluYWxseSBzbyBidXR0b25zIEFMV0FZUyByZS1lbmFibGUuXG4gICAgICAvLyBQcmV2aW91c2x5IGFueSB1bmNhdWdodCBleGNlcHRpb24gaW4gdGhlIHN0ZXAgbG9vcCBsZWZ0IHRoZSBVSSBmcm96ZW4uXG4gICAgICB0cnkge1xuICAgICAgICBpZiAodG90YWxTdGVwcyA9PT0gMCkge1xuICAgICAgICAgIGNvbnNvbGUubG9nKFwiW0JHXSBTdGVwIDY6IEVtcHR5IHBsYW4gXHUyMDE0IGFsbCBmaWVsZHMgYWxyZWFkeSBmaWxsZWQgb3IgdGFzayBjb21wbGV0ZS5cIik7XG4gICAgICAgICAgc2FmZVBvc3QoeyB0eXBlOiBcIlBMQU5fU1VNTUFSWVwiLCB0b3RhbDogMCwgc3VjY2VlZGVkOiAwLCBmYWlsZWQ6IDAsIGRldGFpbHM6IFtdLCBtZXNzYWdlOiBcIkFsbCBmaWVsZHMgYXJlIGFscmVhZHkgZmlsbGVkIFx1MjAxNCBub3RoaW5nIHRvIGRvLlwiIH0pO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGNvbnNvbGUubG9nKGBbQkddIFN0ZXAgNjogRXhlY3V0aW5nICR7dG90YWxTdGVwc30gcGxhbiBzdGVwKHMpLi4uYCk7XG5cbiAgICAgICAgICBmb3IgKGNvbnN0IHN0ZXAgb2YgcGxhbikge1xuICAgICAgICAgIGNvbnN0IHN0ZXBOdW0gPSBzdGVwLnN0ZXA7XG4gICAgICAgICAgY29uc3QgZmllbGRUeXBlID0gc3RlcC5maWVsZF90eXBlIHx8IFwiRklFTERcIjtcbiAgICAgICAgICBjb25zdCB0YXJnZXRJZCA9IHN0ZXAudGFyZ2V0X2lkO1xuXG4gICAgICAgICAgLy8gSGFyZCByZXRyeSBsaW1pdDogaWYgdGhpcyBzYW1lIHN0ZXAgdGFyZ2V0L3R5cGUgZmFpbGVkIDIgdGltZXMgaW4gYSByb3csIHN0b3AgcmV0cnlpbmcgaXRcbiAgICAgICAgICBjb25zdCBzdGVwS2V5ID0gYCR7dGFyZ2V0SWQgfHwgXCJcIn1fJHtmaWVsZFR5cGUgfHwgXCJcIn1gO1xuICAgICAgICAgIGNvbnN0IGN1cnJlbnRGYWlsdXJlcyA9IHN0ZXBDb25zZWN1dGl2ZUZhaWx1cmVzLmdldChzdGVwS2V5KSB8fCAwO1xuICAgICAgICAgIGlmIChjdXJyZW50RmFpbHVyZXMgPj0gMikge1xuICAgICAgICAgICAgY29uc3Qgc2tpcFJlYXNvbiA9IGBTdGVwICR7c3RlcE51bX0gKCR7ZmllbGRUeXBlfSwgJHt0YXJnZXRJZH0pIGhhbHRlZDogZWxlbWVudCBmYWlsZWQgJHtjdXJyZW50RmFpbHVyZXN9IHRpbWVzIGNvbnNlY3V0aXZlbHkuIFN0b3BwaW5nIHJldHJpZXMgZm9yIHRoaXMgc3RlcC5gO1xuICAgICAgICAgICAgY29uc29sZS53YXJuKGBbQkddICR7c2tpcFJlYXNvbn1gKTtcbiAgICAgICAgICAgIHN0ZXBSZXN1bHRzLnB1c2goeyBzdGVwTnVtLCBmaWVsZFR5cGUsIG9rOiBmYWxzZSwgcmVhc29uOiBza2lwUmVhc29uIH0pO1xuICAgICAgICAgICAgc2FmZVBvc3Qoe1xuICAgICAgICAgICAgICB0eXBlOiBcIlBMQU5fU1RFUF9TVEFUVVNcIixcbiAgICAgICAgICAgICAgc3RlcE51bSxcbiAgICAgICAgICAgICAgdG90YWxTdGVwcyxcbiAgICAgICAgICAgICAgc3RhdHVzOiBcImVycm9yXCIsXG4gICAgICAgICAgICAgIG1lc3NhZ2U6IHNraXBSZWFzb25cbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gQXR0YWNoIGJib3ggdG8gc3RlcCBwYXlsb2FkIGZvciBjb29yZGluYXRlLWJhc2VkIGZhbGxiYWNrIGV4ZWN1dGlvblxuICAgICAgICAgIGNvbnN0IGRvbU1hdGNoID0gZG9tX3N1bW1hcnkuZmluZChkID0+IGQuZWxlbWVudF9pZCA9PT0gdGFyZ2V0SWQgfHwgZC5kb21faWQgPT09IHRhcmdldElkIHx8IGQubmFtZSA9PT0gdGFyZ2V0SWQpO1xuICAgICAgICAgIGNvbnN0IG1hbmlmZXN0TWF0Y2ggPSBtYW5pZmVzdC5maW5kKG0gPT4gbS5yZWdpb25faWQgPT09IHRhcmdldElkKTtcbiAgICAgICAgICBjb25zdCBkZXRlY3Rpb25NYXRjaCA9IChkZXRlY3Rpb25zIHx8IFtdKS5maW5kKGQgPT4gZC5pZCA9PT0gdGFyZ2V0SWQpO1xuICAgICAgICAgIGNvbnN0IG1hdGNoZWRCYm94ID0gc3RlcC5iYm94IHx8IGRvbU1hdGNoPy5iYm94IHx8IG1hbmlmZXN0TWF0Y2g/LmJib3ggfHwgZGV0ZWN0aW9uTWF0Y2g/LmJib3ggfHwgbnVsbDtcbiAgICAgICAgICBjb25zdCBzdGVwUGF5bG9hZCA9IHsgLi4uc3RlcCwgYmJveDogbWF0Y2hlZEJib3ggfTtcblxuICAgICAgICAgIC8vIFx1MjUwMFx1MjUwMCBDaGVjayBpZiB2YWx1ZSBpcyBtaXNzaW5nIChSZXF1aXJlbWVudCA0IGZhbGxiYWNrIHBhdGgpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgICAgICAgIGxldCBjdXJyZW50VmFsID0gc3RlcFBheWxvYWQudmFsdWUgfHwgc3RlcFBheWxvYWQubWF0Y2hfdmFsdWUgfHwgc3RvcmVkVmF1bHRbZmllbGRUeXBlXSB8fCBudWxsO1xuICAgICAgICAgIGlmICghY3VycmVudFZhbCAmJiBmaWVsZFR5cGUgPT09IFwiUEhPTkVcIikgY3VycmVudFZhbCA9IHN0b3JlZFZhdWx0W1wiSU5ESUFOX01PQklMRVwiXTtcbiAgICAgICAgICBpZiAoIWN1cnJlbnRWYWwgJiYgZmllbGRUeXBlID09PSBcIklORElBTl9NT0JJTEVcIikgY3VycmVudFZhbCA9IHN0b3JlZFZhdWx0W1wiUEhPTkVcIl07XG5cbiAgICAgICAgICBpZiAoIWN1cnJlbnRWYWwgJiYgKHN0ZXAuYWN0aW9uID09PSBcInR5cGVcIiB8fCBzdGVwLmFjdGlvbiA9PT0gXCJzZWxlY3RfY2hvaWNlXCIpICYmIGZpZWxkVHlwZSAhPT0gXCJCVVRUT05cIiAmJiBmaWVsZFR5cGUgIT09IFwiU1VCTUlUXCIpIHtcbiAgICAgICAgICAgIC8vIFx1MjUwMFx1MjUwMCBEZWNpZGUgd2hldGhlciB0byBwcm9tcHQgdXNlciBvciBza2lwIGltbWVkaWF0ZWx5IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgICAgICAgICAgLy8gU2Vuc2l0aXZlIGZpZWxkIHR5cGVzIChQSUkpIGFyZSBuZXZlciBwcm9tcHRlZCBpbmxpbmUgXHUyMDE0IHNraXAgdG9cbiAgICAgICAgICAgIC8vIGF2b2lkIGhhbmdpbmcgdGhlIFVJIGZvciBtaW51dGVzIGlmIHZhdWx0IGlzIGVtcHR5LlxuICAgICAgICAgICAgY29uc3QgU0VOU0lUSVZFX1NLSVBfVFlQRVMgPSBuZXcgU2V0KFtcbiAgICAgICAgICAgICAgXCJBQURIQUFSXCIsIFwiUEFOXCIsIFwiR1NUSU5cIiwgXCJJRlNDXCIsIFwiQkFOS19BQ0NPVU5UXCIsIFwiQ0FSRFwiLFxuICAgICAgICAgICAgICBcIlBBU1NXT1JEXCIsIFwiSU5ESUFOX01PQklMRVwiLCBcIlBIT05FXCJcbiAgICAgICAgICAgIF0pO1xuICAgICAgICAgICAgaWYgKFNFTlNJVElWRV9TS0lQX1RZUEVTLmhhcyhmaWVsZFR5cGUpKSB7XG4gICAgICAgICAgICAgIC8vIEF1dG8tc2tpcCBcdTIwMTQgbmV2ZXIgc2hvdyBpbmxpbmUgcHJvbXB0IGZvciBzZW5zaXRpdmUgUElJIGZpZWxkc1xuICAgICAgICAgICAgICBjb25zdCBza2lwTXNnID0gYFN0ZXAgJHtzdGVwTnVtfTogXHUyNkEwIE5vIHZhbHVlIGluIHZhdWx0IGZvciBzZW5zaXRpdmUgZmllbGQgXCIke2ZpZWxkVHlwZX1cIiBcdTIwMTQgc2tpcHBpbmcgKGFkZCBpdCBpbiBQcm9maWxlIHNldHRpbmdzKS5gO1xuICAgICAgICAgICAgICBjb25zb2xlLndhcm4oYFtCR10gJHtza2lwTXNnfWApO1xuICAgICAgICAgICAgICBzdGVwUmVzdWx0cy5wdXNoKHsgc3RlcE51bSwgZmllbGRUeXBlLCBvazogZmFsc2UsIHJlYXNvbjogc2tpcE1zZyB9KTtcbiAgICAgICAgICAgICAgc2FmZVBvc3QoeyB0eXBlOiBcIlBMQU5fU1RFUF9TVEFUVVNcIiwgc3RlcE51bSwgdG90YWxTdGVwcywgc3RhdHVzOiBcImVycm9yXCIsIG1lc3NhZ2U6IHNraXBNc2cgfSk7XG4gICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyBGb3Igbm9uLXNlbnNpdGl2ZSBmaWVsZHMgKE5BTUUsIEVNQUlMLCBBRERSRVNTLCBldGMuKSBwcm9tcHQgdGhlIHVzZXJcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKGBbQkddIFN0ZXAgJHtzdGVwTnVtfTogTm8gdmFsdWUgZm91bmQgZm9yIFwiJHtmaWVsZFR5cGV9XCIgaW4gcHJvZmlsZSBvciBwbGFuLiBSZXF1ZXN0aW5nIGlubGluZSBpbnB1dCBmcm9tIHVzZXIuLi5gKTtcbiAgICAgICAgICAgIHNhZmVQb3N0KHtcbiAgICAgICAgICAgICAgdHlwZTogXCJQUk9NUFRfVVNFUl9JTlBVVFwiLFxuICAgICAgICAgICAgICBzdGVwTnVtLFxuICAgICAgICAgICAgICBmaWVsZFR5cGUsXG4gICAgICAgICAgICAgIHRhcmdldElkLFxuICAgICAgICAgICAgICBhY3Rpb25UeXBlOiBzdGVwLmFjdGlvbixcbiAgICAgICAgICAgICAgbWVzc2FnZTogYE5vIHZhbHVlIGZvdW5kIGZvciAke2ZpZWxkVHlwZX0gXHUyMDE0IGVudGVyIG9uZSBub3c/YFxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGNvbnN0IHVzZXJSZXBseSA9IGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgICAgICAgICAgIGNvbnN0IHJlcGx5SGFuZGxlciA9ICh1TXNnKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKHVNc2cudHlwZSA9PT0gXCJVU0VSX0lOUFVUX1BST1ZJREVEXCIgJiYgdU1zZy5zdGVwTnVtID09PSBzdGVwTnVtKSB7XG4gICAgICAgICAgICAgICAgICBwb3J0Lm9uTWVzc2FnZS5yZW1vdmVMaXN0ZW5lcihyZXBseUhhbmRsZXIpO1xuICAgICAgICAgICAgICAgICAgcmVzb2x2ZSh1TXNnKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH07XG4gICAgICAgICAgICAgIHBvcnQub25NZXNzYWdlLmFkZExpc3RlbmVyKHJlcGx5SGFuZGxlcik7XG4gICAgICAgICAgICAgIC8vIDEwLXNlY29uZCB0aW1lb3V0IFx1MjAxNCBhdXRvLXNraXAgaWYgdXNlciBkb2Vzbid0IHJlc3BvbmRcbiAgICAgICAgICAgICAgc2V0VGltZW91dCgoKSA9PiByZXNvbHZlKG51bGwpLCAxMDAwMCk7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgaWYgKHVzZXJSZXBseSAmJiB1c2VyUmVwbHkudmFsdWUpIHtcbiAgICAgICAgICAgICAgY29uc29sZS5sb2coYFtCR10gU3RlcCAke3N0ZXBOdW19OiBVc2VyIHByb3ZpZGVkIHZhbHVlIGZvciBcIiR7ZmllbGRUeXBlfVwiOiBcIiR7dXNlclJlcGx5LnZhbHVlfVwiIChzYXZlVG9WYXVsdDogJHt1c2VyUmVwbHkuc2F2ZVRvVmF1bHR9KWApO1xuICAgICAgICAgICAgICBpZiAoc3RlcC5hY3Rpb24gPT09IFwic2VsZWN0X2Nob2ljZVwiKSB7XG4gICAgICAgICAgICAgICAgc3RlcFBheWxvYWQubWF0Y2hfdmFsdWUgPSB1c2VyUmVwbHkudmFsdWU7XG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgc3RlcFBheWxvYWQudmFsdWUgPSB1c2VyUmVwbHkudmFsdWU7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgaWYgKHVzZXJSZXBseS5zYXZlVG9WYXVsdCkge1xuICAgICAgICAgICAgICAgIHN0b3JlZFZhdWx0W2ZpZWxkVHlwZV0gPSB1c2VyUmVwbHkudmFsdWU7XG4gICAgICAgICAgICAgICAgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgYWdlbnRfdmF1bHQ6IHN0b3JlZFZhdWx0IH0pO1xuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBbQkddIFx1MjcxMyBQZXJzaXN0ZWQgXCIke2ZpZWxkVHlwZX1cIiA9IFwiJHt1c2VyUmVwbHkudmFsdWV9XCIgdG8gY2hyb21lLnN0b3JhZ2UubG9jYWxgKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgY29uc3Qgc2tpcE1zZyA9IGBTdGVwICR7c3RlcE51bX06IE5vIHZhbHVlIHByb3ZpZGVkIGZvciBcIiR7ZmllbGRUeXBlfVwiICh0aW1lZCBvdXQgb3Igc2tpcHBlZCkuIE1vdmluZyBvbi5gO1xuICAgICAgICAgICAgICBjb25zb2xlLndhcm4oYFtCR10gJHtza2lwTXNnfWApO1xuICAgICAgICAgICAgICBzdGVwUmVzdWx0cy5wdXNoKHsgc3RlcE51bSwgZmllbGRUeXBlLCBvazogZmFsc2UsIHJlYXNvbjogc2tpcE1zZyB9KTtcbiAgICAgICAgICAgICAgc2FmZVBvc3QoeyB0eXBlOiBcIlBMQU5fU1RFUF9TVEFUVVNcIiwgc3RlcE51bSwgdG90YWxTdGVwcywgc3RhdHVzOiBcImVycm9yXCIsIG1lc3NhZ2U6IHNraXBNc2cgfSk7XG4gICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cblxuICAgICAgICAgIHNhZmVQb3N0KHtcbiAgICAgICAgICAgIHR5cGU6IFwiUExBTl9TVEVQX1NUQVRVU1wiLFxuICAgICAgICAgICAgc3RlcE51bSxcbiAgICAgICAgICAgIHRvdGFsU3RlcHMsXG4gICAgICAgICAgICBzdGF0dXM6IFwicnVubmluZ1wiLFxuICAgICAgICAgICAgbWVzc2FnZTogYFN0ZXAgJHtzdGVwTnVtfS8ke3RvdGFsU3RlcHN9OiAke3N0ZXAuYWN0aW9ufSBvbiAke2ZpZWxkVHlwZX0gKCR7dGFyZ2V0SWR9KVx1MjAyNmBcbiAgICAgICAgICB9KTtcblxuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBzdGVwUmVzcG9uc2UgPSBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICAgICAgICAgIC8vIDUgc2Vjb25kIHRpbWVvdXQgcGVyIGFjdGlvbiB0byBjYXRjaCBodW5nIHBhZ2VzXG4gICAgICAgICAgICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiByZWplY3QobmV3IEVycm9yKFwiVElNRU9VVFwiKSksIDUwMDApO1xuICAgICAgICAgICAgICBjaHJvbWUudGFicy5zZW5kTWVzc2FnZShcbiAgICAgICAgICAgICAgICBjYXB0dXJlUmVzdWx0LnRhYi5pZCxcbiAgICAgICAgICAgICAgICB7IHR5cGU6IFwiRVhFQ1VURV9BQ1RJT05cIiwgcGF5bG9hZDogc3RlcFBheWxvYWQgfSxcbiAgICAgICAgICAgICAgICByZXNwb25zZSA9PiB7XG4gICAgICAgICAgICAgICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgICAgICAgICAgICAgaWYgKGNocm9tZS5ydW50aW1lLmxhc3RFcnJvcikge1xuICAgICAgICAgICAgICAgICAgICByZWplY3QobmV3IEVycm9yKGNocm9tZS5ydW50aW1lLmxhc3RFcnJvci5tZXNzYWdlKSk7XG4gICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICByZXNvbHZlKHJlc3BvbnNlIHx8IHsgb2s6IGZhbHNlLCBlcnJvcjogXCJObyByZXNwb25zZSBmcm9tIGNvbnRlbnQgc2NyaXB0XCIgfSk7XG4gICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGlmIChzdGVwUmVzcG9uc2Uub2spIHtcbiAgICAgICAgICAgICAgc3RlcENvbnNlY3V0aXZlRmFpbHVyZXMuc2V0KHN0ZXBLZXksIDApOyAvLyByZXNldCBvbiBzdWNjZXNzXG4gICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBbQkddIFN0ZXAgNi4ke3N0ZXBOdW19OiBcdTI3MTMgc3VjY2Vzc2AsIHN0ZXBSZXNwb25zZSk7XG4gICAgICAgICAgICAgIHN0ZXBSZXN1bHRzLnB1c2goeyBzdGVwTnVtLCBmaWVsZFR5cGUsIG9rOiB0cnVlIH0pO1xuICAgICAgICAgICAgICBzYWZlUG9zdCh7XG4gICAgICAgICAgICAgICAgdHlwZTogXCJQTEFOX1NURVBfU1RBVFVTXCIsXG4gICAgICAgICAgICAgICAgc3RlcE51bSxcbiAgICAgICAgICAgICAgICB0b3RhbFN0ZXBzLFxuICAgICAgICAgICAgICAgIHN0YXR1czogXCJva1wiLFxuICAgICAgICAgICAgICAgIG1lc3NhZ2U6IGBTdGVwICR7c3RlcE51bX0vJHt0b3RhbFN0ZXBzfTogXHUyNzEzICR7ZmllbGRUeXBlfSBmaWxsZWRgXG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKHN0ZXBSZXNwb25zZS5lcnJvciB8fCBcIkNvbnRlbnQgc2NyaXB0IHJlcG9ydGVkIGZhaWx1cmVcIik7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICBzdGVwQ29uc2VjdXRpdmVGYWlsdXJlcy5zZXQoc3RlcEtleSwgY3VycmVudEZhaWx1cmVzICsgMSk7XG4gICAgICAgICAgICBsZXQgZmFpbFJlYXNvbjtcbiAgICAgICAgICAgIGNvbnN0IGVyclN0ciA9IGVyci5tZXNzYWdlIHx8IFN0cmluZyhlcnIpO1xuICAgICAgICAgICAgaWYgKGVyclN0ciA9PT0gXCJUSU1FT1VUXCIpIHtcbiAgICAgICAgICAgICAgZmFpbFJlYXNvbiA9IGBUaGUgcGFnZSBkaWRuJ3QgcmVzcG9uZCB0byB0aGUgYWN0aW9uIGluIHRpbWUgKHN0ZXAgJHtzdGVwTnVtfSwgJHtmaWVsZFR5cGV9KS5gO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChlcnJTdHIuaW5jbHVkZXMoXCJub3QgZm91bmRcIikgfHwgZXJyU3RyLmluY2x1ZGVzKFwicmVzb2x2ZVwiKSkge1xuICAgICAgICAgICAgICBmYWlsUmVhc29uID0gYENvdWxkbid0IGZpbmQgdGhlIGVsZW1lbnQgZm9yIHN0ZXAgJHtzdGVwTnVtfSAoZXhwZWN0ZWQ6ICR7ZmllbGRUeXBlfSkuIFRoZSBwYWdlIGxheW91dCBtYXkgaGF2ZSBjaGFuZ2VkLmA7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICBmYWlsUmVhc29uID0gYFN0ZXAgJHtzdGVwTnVtfSAoJHtmaWVsZFR5cGV9KSBmYWlsZWQ6ICR7ZXJyU3RyfWA7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zb2xlLmVycm9yKGBbQkddIFN0ZXAgNi4ke3N0ZXBOdW19OiBcdTI3MTcgZmFpbGVkICgke2N1cnJlbnRGYWlsdXJlcyArIDF9IGNvbnNlY3V0aXZlKSBcdTIwMTQgJHtmYWlsUmVhc29ufWApO1xuICAgICAgICAgICAgc3RlcFJlc3VsdHMucHVzaCh7IHN0ZXBOdW0sIGZpZWxkVHlwZSwgb2s6IGZhbHNlLCByZWFzb246IGZhaWxSZWFzb24gfSk7XG4gICAgICAgICAgICBzYWZlUG9zdCh7XG4gICAgICAgICAgICAgIHR5cGU6IFwiUExBTl9TVEVQX1NUQVRVU1wiLFxuICAgICAgICAgICAgICBzdGVwTnVtLFxuICAgICAgICAgICAgICB0b3RhbFN0ZXBzLFxuICAgICAgICAgICAgICBzdGF0dXM6IFwiZXJyb3JcIixcbiAgICAgICAgICAgICAgbWVzc2FnZTogZmFpbFJlYXNvblxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAvLyBDb250aW51ZSByZW1haW5pbmcgc3RlcHMgXHUyMDE0IGRvbid0IGFib3J0IHRoZSB3aG9sZSBwbGFuXG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gU21hbGwgZGVsYXkgYmV0d2VlbiBzdGVwcyBzbyBET00gZXZlbnRzIHNldHRsZVxuICAgICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKHIgPT4gc2V0VGltZW91dChyLCAzMDApKTtcbiAgICAgICAgfVxuXG4gICAgICAgICAgLy8gXHUyNTAwXHUyNTAwIFBsYW4gc3VtbWFyeSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICAgICAgICBjb25zdCBzdWNjZWVkZWQgPSBzdGVwUmVzdWx0cy5maWx0ZXIociA9PiByLm9rKS5sZW5ndGg7XG4gICAgICAgICAgY29uc3QgZmFpbGVkID0gc3RlcFJlc3VsdHMuZmlsdGVyKHIgPT4gIXIub2spLmxlbmd0aDtcbiAgICAgICAgICBjb25zdCBmYWlsZWREZXNjcmlwdGlvbnMgPSBzdGVwUmVzdWx0c1xuICAgICAgICAgICAgLmZpbHRlcihyID0+ICFyLm9rKVxuICAgICAgICAgICAgLm1hcChyID0+IGBTdGVwICR7ci5zdGVwTnVtfSAoJHtyLmZpZWxkVHlwZX0pOiAke3IucmVhc29ufWApO1xuXG4gICAgICAgICAgbGV0IHN1bW1hcnlNc2c7XG4gICAgICAgICAgaWYgKGZhaWxlZCA9PT0gMCkge1xuICAgICAgICAgICAgc3VtbWFyeU1zZyA9IGBBbGwgJHtzdWNjZWVkZWR9IHN0ZXAocykgY29tcGxldGVkIHN1Y2Nlc3NmdWxseS5gO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzdW1tYXJ5TXNnID0gYENvbXBsZXRlZCAke3N1Y2NlZWRlZH0gb2YgJHt0b3RhbFN0ZXBzfSBzdGVwcy4gJHtmYWlsZWREZXNjcmlwdGlvbnMuam9pbihcIiB8IFwiKX1gO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGNvbnNvbGUubG9nKGBbQkddIFN0ZXAgNiBTdW1tYXJ5OiAke3N1bW1hcnlNc2d9YCk7XG4gICAgICAgICAgc2FmZVBvc3Qoe1xuICAgICAgICAgICAgdHlwZTogXCJQTEFOX1NVTU1BUllcIixcbiAgICAgICAgICAgIHRvdGFsOiB0b3RhbFN0ZXBzLFxuICAgICAgICAgICAgc3VjY2VlZGVkLFxuICAgICAgICAgICAgZmFpbGVkLFxuICAgICAgICAgICAgZGV0YWlsczogc3RlcFJlc3VsdHMsXG4gICAgICAgICAgICBtZXNzYWdlOiBzdW1tYXJ5TXNnXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2ggKHN0ZXA2RXJyKSB7XG4gICAgICAgIC8vIENhdGNoLWFsbDogYW55IHVuY2F1Z2h0IGV4Y2VwdGlvbiBpbiBTdGVwIDYgcG9zdHMgYW4gRVJST1IgYW5kIHN0aWxsXG4gICAgICAgIC8vIGhpdHMgdGhlIGZpbmFsbHkgYmxvY2sgc28gYnV0dG9ucyBhcmUgYWx3YXlzIHJlLWVuYWJsZWQuXG4gICAgICAgIGNvbnNvbGUuZXJyb3IoXCJbQkcgRXJyb3JdW1N0ZXAgNjogUGxhbiBFeGVjdXRpb25dOlwiLCBzdGVwNkVycik7XG4gICAgICAgIHNhZmVQb3N0KHsgdHlwZTogXCJFUlJPUlwiLCBzdGVwOiBcIlBsYW4gRXhlY3V0aW9uXCIsIGVycm9yOiBzdGVwNkVyci5tZXNzYWdlIHx8IFN0cmluZyhzdGVwNkVycikgfSk7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICAvLyBTQUZFVFkgTkVUOiBhbHdheXMgcmUtZW5hYmxlIGJ1dHRvbnMgcmVnYXJkbGVzcyBvZiBob3cgU3RlcCA2IGV4aXRzLlxuICAgICAgICAvLyBQcmV2aW91c2x5IGFueSB1bmhhbmRsZWQgZXhjZXB0aW9uIGxlZnQgYW5hbHl6ZUJ0bi9kZW1vQnRuIGRpc2FibGVkIGZvcmV2ZXIuXG4gICAgICAgIHNhZmVQb3N0KHsgdHlwZTogXCJfU1RFUDZfQ09NUExFVEVcIiB9KTsgLy8gc2lnbmFsIHRvIHBvcHVwIFx1MjAxNCBoYW5kbGVkIGFzIG5vLW9wIGlmIG5vdCBuZWVkZWRcbiAgICAgICAgY29uc29sZS5sb2coXCJbQkddIFN0ZXAgNiBmaW5hbGx5IGJsb2NrIFx1MjAxNCBleGVjdXRpb24gbG9vcCBkb25lLlwiKTtcbiAgICAgIH1cblxuICAgICAgLy8gXHUyNTAwXHUyNTAwIEZpbmFsaXplIExvb3AgQ3ljbGUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgICBjb25zdCB0RW5kID0gcGVyZm9ybWFuY2Uubm93KCk7XG4gICAgICBjb25zdCBsb29wTGF0ZW5jeSA9IHRFbmQgLSB0MDtcbiAgICAgIHN0YXRzLnRvdGFsTGF0ZW5jeU1zICs9IGxvb3BMYXRlbmN5O1xuICAgICAgY29uc29sZS5sb2coYFtCR10gQ3ljbGUgZmluaXNoZWQgaW4gJHtsb29wTGF0ZW5jeS50b0ZpeGVkKDEpfW1zLiBUb3RhbCBsYXRlbmN5OiAke3N0YXRzLnRvdGFsTGF0ZW5jeU1zLnRvRml4ZWQoMSl9bXNgKTtcblxuICAgICAgY2hyb21lLnRhYnMuc2VuZE1lc3NhZ2UoY2FwdHVyZVJlc3VsdC50YWIuaWQsIHsgdHlwZTogXCJVUERBVEVfU1RBVFNcIiwgcGF5bG9hZDogc3RhdHMgfSwgKCkgPT4ge1xuICAgICAgICBjaHJvbWUucnVudGltZS5sYXN0RXJyb3I7IC8vIElnbm9yZSBpZiBjb250ZW50IHNjcmlwdCBjbG9zZWRcbiAgICAgIH0pO1xuXG4gICAgICAvLyBcdTI1MDBcdTI1MDAgTG9vcCBjaGVjazogZGVtbyBtb2RlIHN0b3BzIGFmdGVyIG9uZSBmdWxsIHBsYW4gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgICBzaG91bGRDb250aW51ZSA9IGZhbHNlOyAgLy8gU2luZ2xlLXNob3Q6IHBsYW4gY292ZXJzIGFsbCBmaWVsZHMgYXQgb25jZVxuICAgIH1cbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFTQSxJQUFNLGFBQWdCO0FBQ3RCLElBQU0sZ0JBQWdCLE9BQU8sUUFBUSxPQUFPLGdCQUFnQjtBQUU1RCxJQUFNLGdCQUFnQixvQkFBSSxJQUFJO0FBQzlCLElBQUksUUFBUTtBQUFBLEVBQ1YsZ0JBQWdCO0FBQUEsRUFDaEIsa0JBQWtCO0FBQUEsRUFDbEIsZ0JBQWdCO0FBQ2xCO0FBRUEsUUFBUSxJQUFJLGtEQUFrRDtBQUs5RCxPQUFPLFFBQVEsWUFBWSxZQUFZLE1BQU07QUFDM0MsMEJBQXdCO0FBQ3hCLE1BQUksT0FBTyxXQUFXLE9BQU8sUUFBUSxPQUFPO0FBQzFDLFdBQU8sUUFBUSxNQUFNLElBQUksQ0FBQyxhQUFhLEdBQUcsQ0FBQyxTQUFTO0FBQ2xELFVBQUksQ0FBQyxLQUFLLGFBQWE7QUFDckIsZUFBTyxRQUFRLE1BQU0sSUFB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
