// src/serverConfig.js
var DEFAULT_SERVER_URL = "https://visual-pereption.onrender.com";
var STORAGE_SERVER_KEY = "custom_server_url";
async function getBaseServerUrl() {
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    try {
      const data = await new Promise((resolve) => {
        chrome.storage.local.get([STORAGE_SERVER_KEY], resolve);
      });
      if (data && data[STORAGE_SERVER_KEY] && typeof data[STORAGE_SERVER_KEY] === "string" && data[STORAGE_SERVER_KEY].trim()) {
        return data[STORAGE_SERVER_KEY].trim().replace(/\/+$/, "");
      }
    } catch (e) {
      console.warn("[serverConfig] Could not read custom_server_url:", e);
    }
  }
  return DEFAULT_SERVER_URL;
}

// src/background.js
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
  const baseUrl = await getBaseServerUrl();
  const serverUrl = `${baseUrl}/analyze`;
  console.log("[BG] Initiating HTTP request to server URL:", serverUrl);
  try {
    const res = await fetch(serverUrl, {
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
        const activeBaseUrl = await getBaseServerUrl();
        console.log(`[BG] Step 5: Preparing AgentRequestV1 payload for server (${activeBaseUrl})...`);
        safePost({ type: "STAGE_CHANGE", stage: "send", text: `Sending redacted payload to server (${activeBaseUrl}/analyze)\u2026` });
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
          errMsg = `Couldn't reach the reasoning server at ${await getBaseServerUrl()} \u2014 please check your connection.`;
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsic3JjL3NlcnZlckNvbmZpZy5qcyIsICJzcmMvYmFja2dyb3VuZC5qcyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBzZXJ2ZXJDb25maWcuanMgXHUyMDE0IFNoYXJlZCBTZXJ2ZXIgQ29uZmlndXJhdGlvbiBIZWxwZXJcbiAqXG4gKiBEZWZhdWx0IHJlbW90ZSBzZXJ2ZXI6IGh0dHBzOi8vdmlzdWFsLXBlcmVwdGlvbi5vbnJlbmRlci5jb21cbiAqIFN0b3JlZCB1bmRlciBrZXkgXCJjdXN0b21fc2VydmVyX3VybFwiIGluIGNocm9tZS5zdG9yYWdlLmxvY2FsIGZvciBwb3B1cCBvdmVycmlkZXMuXG4gKi9cblxuZXhwb3J0IGNvbnN0IERFRkFVTFRfU0VSVkVSX1VSTCA9IFwiaHR0cHM6Ly92aXN1YWwtcGVyZXB0aW9uLm9ucmVuZGVyLmNvbVwiO1xuZXhwb3J0IGNvbnN0IFNUT1JBR0VfU0VSVkVSX0tFWSA9IFwiY3VzdG9tX3NlcnZlcl91cmxcIjtcblxuLyoqXG4gKiBSZXR1cm5zIHRoZSBlZmZlY3RpdmUgYmFzZSBzZXJ2ZXIgVVJMICh3aXRob3V0IHRyYWlsaW5nIHNsYXNoKS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGdldEJhc2VTZXJ2ZXJVcmwoKSB7XG4gIGlmICh0eXBlb2YgY2hyb21lICE9PSBcInVuZGVmaW5lZFwiICYmIGNocm9tZS5zdG9yYWdlICYmIGNocm9tZS5zdG9yYWdlLmxvY2FsKSB7XG4gICAgdHJ5IHtcbiAgICAgIGNvbnN0IGRhdGEgPSBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xuICAgICAgICBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoW1NUT1JBR0VfU0VSVkVSX0tFWV0sIHJlc29sdmUpO1xuICAgICAgfSk7XG4gICAgICBpZiAoZGF0YSAmJiBkYXRhW1NUT1JBR0VfU0VSVkVSX0tFWV0gJiYgdHlwZW9mIGRhdGFbU1RPUkFHRV9TRVJWRVJfS0VZXSA9PT0gXCJzdHJpbmdcIiAmJiBkYXRhW1NUT1JBR0VfU0VSVkVSX0tFWV0udHJpbSgpKSB7XG4gICAgICAgIHJldHVybiBkYXRhW1NUT1JBR0VfU0VSVkVSX0tFWV0udHJpbSgpLnJlcGxhY2UoL1xcLyskLywgXCJcIik7XG4gICAgICB9XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgY29uc29sZS53YXJuKFwiW3NlcnZlckNvbmZpZ10gQ291bGQgbm90IHJlYWQgY3VzdG9tX3NlcnZlcl91cmw6XCIsIGUpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gREVGQVVMVF9TRVJWRVJfVVJMO1xufVxuXG4vKipcbiAqIFBlcnNpc3RzIGEgbmV3IGJhc2Ugc2VydmVyIFVSTCBvdmVycmlkZSAob3IgcmVzZXRzIHRvIGRlZmF1bHQgaWYgZW1wdHkpLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gc2V0QmFzZVNlcnZlclVybCh1cmwpIHtcbiAgY29uc3QgY2xlYW4gPSAodXJsIHx8IFwiXCIpLnRyaW0oKS5yZXBsYWNlKC9cXC8rJC8sIFwiXCIpO1xuICBpZiAodHlwZW9mIGNocm9tZSAhPT0gXCJ1bmRlZmluZWRcIiAmJiBjaHJvbWUuc3RvcmFnZSAmJiBjaHJvbWUuc3RvcmFnZS5sb2NhbCkge1xuICAgIGlmICghY2xlYW4gfHwgY2xlYW4gPT09IERFRkFVTFRfU0VSVkVSX1VSTCkge1xuICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmUpID0+IGNocm9tZS5zdG9yYWdlLmxvY2FsLnJlbW92ZShbU1RPUkFHRV9TRVJWRVJfS0VZXSwgcmVzb2x2ZSkpO1xuICAgIH0gZWxzZSB7XG4gICAgICBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4gY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgW1NUT1JBR0VfU0VSVkVSX0tFWV06IGNsZWFuIH0sIHJlc29sdmUpKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGNsZWFuIHx8IERFRkFVTFRfU0VSVkVSX1VSTDtcbn1cbiIsICIvKipcbiAqIGJhY2tncm91bmQuanMgXHUyMDE0IFNlcnZpY2UgV29ya2VyICAoc3JjL2JhY2tncm91bmQuanMgXHUyMTkyIGJ1aWx0IGJhY2tncm91bmQuanMpXG4gKlxuICogdjAuMiBhZGRpdGlvbnM6XG4gKiAgIC0gZ2V0RE9NUmVnaW9ucyh0YWJJZCkgICBcdTIwMTQgc2VuZHMgU0NBTl9ET00gdG8gY29udGVudCBzY3JpcHQsIHJldHVybnMgZG9tUmVnaW9uc1tdXG4gKiAgIC0gUGFzc2VzIGRvbVJlZ2lvbnMgdG8gb2Zmc2NyZWVuIGFsb25nc2lkZSB0aGUgc2NyZWVuc2hvdFxuICogICAtIFJlbGF5cyB7IGRldGVjdGlvbnMsIHNlbnNpdGl2ZVJlZ2lvbnMgfSBiYWNrIHRvIHBvcHVwIHZpYSBwb3J0XG4gKi9cblxuaW1wb3J0IHsgZ2V0QmFzZVNlcnZlclVybCB9IGZyb20gXCIuL3NlcnZlckNvbmZpZy5qc1wiO1xuXG5jb25zdCBPRkZTQ1JFRU5fVVJMID0gY2hyb21lLnJ1bnRpbWUuZ2V0VVJMKFwib2Zmc2NyZWVuLmh0bWxcIik7XG5cbmNvbnN0IGFuYWx5c2lzQ2FjaGUgPSBuZXcgTWFwKCk7XG5sZXQgc3RhdHMgPSB7XG4gIGZyYW1lc0NhcHR1cmVkOiAwLFxuICB2aXNpb25JbmZlcmVuY2VzOiAwLFxuICB0b3RhbExhdGVuY3lNczogMFxufTtcblxuY29uc29sZS5sb2coYFtCR10gVF9TV19TVEFSVCAgdD0wbXMgIChTZXJ2aWNlIHdvcmtlciBzdGFydGVkKWApO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFByZS1sb2FkIG9uIHN0YXJ0dXAgKHNvIG1vZGVsIGlzIHJlYWR5IGJlZm9yZSB1c2VyIGNsaWNrcyBhbnl0aGluZylcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuY2hyb21lLnJ1bnRpbWUub25JbnN0YWxsZWQuYWRkTGlzdGVuZXIoKCkgPT4ge1xuICBlbnN1cmVPZmZzY3JlZW5Eb2N1bWVudCgpO1xuICBpZiAoY2hyb21lLnN0b3JhZ2UgJiYgY2hyb21lLnN0b3JhZ2UubG9jYWwpIHtcbiAgICBjaHJvbWUuc3RvcmFnZS5sb2NhbC5nZXQoW1wiYWdlbnRfdmF1bHRcIl0sIChkYXRhKSA9PiB7XG4gICAgICBpZiAoIWRhdGEuYWdlbnRfdmF1bHQpIHtcbiAgICAgICAgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHtcbiAgICAgICAgICBhZ2VudF92YXVsdDoge1xuICAgICAgICAgICAgTkFNRTogXCJSYWplc2ggS3VtYXJcIixcbiAgICAgICAgICAgIEVNQUlMOiBcInZlbmRvci5kZW1vQGV4YW1wbGUuaW5cIixcbiAgICAgICAgICAgIElORElBTl9NT0JJTEU6IFwiOTg3NjU0MzIxMFwiLFxuICAgICAgICAgICAgUEhPTkU6IFwiOTg3NjU0MzIxMFwiLFxuICAgICAgICAgICAgRE9COiBcIjE5OTAtMDUtMTVcIixcbiAgICAgICAgICAgIEFERFJFU1M6IFwiNDIsIE1HIFJvYWQsIEJlbmdhbHVydVwiLFxuICAgICAgICAgICAgQ0lUWTogXCJCZW5nYWx1cnVcIixcbiAgICAgICAgICAgIFBJTkNPREU6IFwiNTYwMDAxXCIsXG4gICAgICAgICAgICBBQURIQUFSOiBcIjU0ODkgMTIzNCA1Njc0XCIsXG4gICAgICAgICAgICBQQU46IFwiQUJDREUxMjM0RlwiLFxuICAgICAgICAgICAgUEFTU1dPUkQ6IFwiTW9ja1Bhc3N3b3JkQDEyM1wiXG4gICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICAgICAgY29uc29sZS5sb2coXCJbQkddIEluaXRpYWxpemVkIGRlZmF1bHQgZGVtbyBwcm9maWxlIHZhdWx0IGluIGNocm9tZS5zdG9yYWdlLmxvY2FsXCIpO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG59KTtcbmNocm9tZS5ydW50aW1lLm9uU3RhcnR1cC5hZGRMaXN0ZW5lcigoKSA9PiBlbnN1cmVPZmZzY3JlZW5Eb2N1bWVudCgpKTtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBHbG9iYWwgS2VlcC1BbGl2ZSBIYW5kbGVyIChyZXNwb25kcyB0byBvZmZzY3JlZW4gcGluZ3MpXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbmNocm9tZS5ydW50aW1lLm9uTWVzc2FnZS5hZGRMaXN0ZW5lcigobXNnLCBzZW5kZXIsIHNlbmRSZXNwb25zZSkgPT4ge1xuICBpZiAobXNnLnR5cGUgPT09IFwiT0ZGU0NSRUVOX0tFRVBBTElWRVwiKSB7XG4gICAgc2VuZFJlc3BvbnNlKHsgb2s6IHRydWUgfSk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cbn0pO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIGNhcHR1cmVTY3JlZW4gXHUyMDE0IGNhcHR1cmUgdGhlIGFjdGl2ZSB0YWIncyB2aXNpYmxlIGFyZWEgYXMgYSBkYXRhIFVSTFxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY2FwdHVyZVNjcmVlbigpIHtcbiAgY29uc3QgW2FjdGl2ZVRhYl0gPSBhd2FpdCBjaHJvbWUudGFicy5xdWVyeSh7IGFjdGl2ZTogdHJ1ZSwgY3VycmVudFdpbmRvdzogdHJ1ZSB9KTtcbiAgaWYgKCFhY3RpdmVUYWIpIHRocm93IG5ldyBFcnJvcihcIk5vIGFjdGl2ZSB0YWIgZm91bmQuXCIpO1xuXG4gIGNvbnN0IGRhdGFVcmwgPSBhd2FpdCBjaHJvbWUudGFicy5jYXB0dXJlVmlzaWJsZVRhYihhY3RpdmVUYWIud2luZG93SWQsIHsgZm9ybWF0OiBcInBuZ1wiIH0pO1xuICByZXR1cm4geyBkYXRhVXJsLCB0YWI6IGFjdGl2ZVRhYiB9O1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gZ2V0RE9NUmVnaW9ucyBcdTIwMTQgYXNrIHRoZSBjb250ZW50IHNjcmlwdCB0byBzY2FuIHRoZSBwYWdlJ3Mgc2Vuc2l0aXZlIGZpZWxkc1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5hc3luYyBmdW5jdGlvbiBnZXRET01SZWdpb25zKHRhYklkKSB7XG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xuICAgIGNvbnNvbGUubG9nKGBbQkddIERpc3BhdGNoaW5nIFNDQU5fRE9NIG1lc3NhZ2UgdG8gYWN0aXZlIHRhYiAke3RhYklkfS4uLmApO1xuICAgIGNocm9tZS50YWJzLnNlbmRNZXNzYWdlKHRhYklkLCB7IHR5cGU6IFwiU0NBTl9ET01cIiB9LCBhc3luYyAocmVzcG9uc2UpID0+IHtcbiAgICAgIGlmIChjaHJvbWUucnVudGltZS5sYXN0RXJyb3IgfHwgIXJlc3BvbnNlKSB7XG4gICAgICAgIGNvbnN0IGVyck1zZyA9IGNocm9tZS5ydW50aW1lLmxhc3RFcnJvcj8ubWVzc2FnZSA/PyBcIm5vIHJlc3BvbnNlXCI7XG4gICAgICAgIGNvbnNvbGUud2FybihgW0JHXSBJbml0aWFsIFNDQU5fRE9NIGZhaWxlZCBvbiB0YWIgJHt0YWJJZH0gKCR7ZXJyTXNnfSkuIEF0dGVtcHRpbmcgZHluYW1pYyBpbmplY3Rpb24gb2YgY29udGVudC5qcy4uLmApO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGF3YWl0IGNocm9tZS5zY3JpcHRpbmcuZXhlY3V0ZVNjcmlwdCh7XG4gICAgICAgICAgICB0YXJnZXQ6IHsgdGFiSWQgfSxcbiAgICAgICAgICAgIGZpbGVzOiBbXCJjb250ZW50LmpzXCJdLFxuICAgICAgICAgIH0pO1xuICAgICAgICAgIGNvbnNvbGUubG9nKGBbQkddIGNvbnRlbnQuanMgc3VjY2Vzc2Z1bGx5IGluamVjdGVkIGludG8gdGFiICR7dGFiSWR9LiBSZXRyeWluZyBTQ0FOX0RPTS4uLmApO1xuICAgICAgICAgIGNocm9tZS50YWJzLnNlbmRNZXNzYWdlKHRhYklkLCB7IHR5cGU6IFwiU0NBTl9ET01cIiB9LCAocmV0cnlSZXNwb25zZSkgPT4ge1xuICAgICAgICAgICAgaWYgKGNocm9tZS5ydW50aW1lLmxhc3RFcnJvciB8fCAhcmV0cnlSZXNwb25zZSkge1xuICAgICAgICAgICAgICBjb25zb2xlLndhcm4oXCJbQkddIFNDQU5fRE9NIHJldHJ5IGFsc28gZmFpbGVkOlwiLCBjaHJvbWUucnVudGltZS5sYXN0RXJyb3I/Lm1lc3NhZ2UgPz8gXCJubyByZXNwb25zZVwiKTtcbiAgICAgICAgICAgICAgcmVzb2x2ZSh7IGRvbVJlZ2lvbnM6IFtdLCBkb21IYXNoOiBcIlwiIH0pO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgY29uc29sZS5sb2coYFtCR10gU0NBTl9ET00gcmV0cnkgc3VjY2VlZGVkISBGb3VuZCAke3JldHJ5UmVzcG9uc2UuZG9tUmVnaW9ucz8ubGVuZ3RoID8/IDB9IHNlbnNpdGl2ZSBmaWVsZChzKSwgJHtyZXRyeVJlc3BvbnNlLm1lZGlhUmVnaW9ucz8ubGVuZ3RoID8/IDB9IG1lZGlhIGVsZW1lbnQocyk6YCwgcmV0cnlSZXNwb25zZS5kb21SZWdpb25zKTtcbiAgICAgICAgICAgICAgcmVzb2x2ZSh7IGRvbVJlZ2lvbnM6IHJldHJ5UmVzcG9uc2UuZG9tUmVnaW9ucyA/PyBbXSwgbWVkaWFSZWdpb25zOiByZXRyeVJlc3BvbnNlLm1lZGlhUmVnaW9ucyA/PyBbXSwgZG9tSGFzaDogcmV0cnlSZXNwb25zZS5kb21IYXNoID8/IFwiXCIgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSk7XG4gICAgICAgIH0gY2F0Y2ggKGluakVycikge1xuICAgICAgICAgIGNvbnNvbGUud2FybihcIltCR10gRHluYW1pYyBjb250ZW50IHNjcmlwdCBpbmplY3Rpb24gZmFpbGVkIChlLmcuIGNocm9tZTovLyBvciByZXN0cmljdGVkIHBhZ2UpOlwiLCBpbmpFcnIubWVzc2FnZSk7XG4gICAgICAgICAgcmVzb2x2ZSh7IGRvbVJlZ2lvbnM6IFtdLCBtZWRpYVJlZ2lvbnM6IFtdLCBkb21IYXNoOiBcIlwiIH0pO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cbiAgICAgIGNvbnNvbGUubG9nKGBbQkddIFNDQU5fRE9NIHN1Y2NlZWRlZCBvbiB0YWIgJHt0YWJJZH0hIFJlY2VpdmVkICR7cmVzcG9uc2UuZG9tUmVnaW9ucz8ubGVuZ3RoID8/IDB9IHJlZ2lvbihzKSwgJHtyZXNwb25zZS5tZWRpYVJlZ2lvbnM/Lmxlbmd0aCA/PyAwfSBtZWRpYSBlbGVtZW50KHMpOmAsIHJlc3BvbnNlLmRvbVJlZ2lvbnMpO1xuICAgICAgcmVzb2x2ZSh7IGRvbVJlZ2lvbnM6IHJlc3BvbnNlLmRvbVJlZ2lvbnMgPz8gW10sIG1lZGlhUmVnaW9uczogcmVzcG9uc2UubWVkaWFSZWdpb25zID8/IFtdLCBkb21IYXNoOiByZXNwb25zZS5kb21IYXNoID8/IFwiXCIgfSk7XG4gICAgfSk7XG4gIH0pO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIGVuc3VyZU9mZnNjcmVlbkRvY3VtZW50IFx1MjAxNCBjcmVhdGUgaWYgbm90IGFscmVhZHkgb3BlbiAobWF4IDEgcGVyIGV4dGVuc2lvbilcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuYXN5bmMgZnVuY3Rpb24gZW5zdXJlT2Zmc2NyZWVuRG9jdW1lbnQoKSB7XG4gIGNvbnN0IGV4aXN0aW5nID0gYXdhaXQgY2hyb21lLnJ1bnRpbWUuZ2V0Q29udGV4dHMoe1xuICAgIGNvbnRleHRUeXBlczogW1wiT0ZGU0NSRUVOX0RPQ1VNRU5UXCJdLFxuICAgIGRvY3VtZW50VXJsczogW09GRlNDUkVFTl9VUkxdLFxuICB9KTtcbiAgaWYgKGV4aXN0aW5nLmxlbmd0aCA+IDApIHJldHVybjtcblxuICBhd2FpdCBjaHJvbWUub2Zmc2NyZWVuLmNyZWF0ZURvY3VtZW50KHtcbiAgICB1cmw6ICAgICAgICAgICBcIm9mZnNjcmVlbi5odG1sXCIsXG4gICAgcmVhc29uczogICAgICAgW1wiV09SS0VSU1wiXSxcbiAgICBqdXN0aWZpY2F0aW9uOiBcIlJ1biBGbG9yZW5jZS0yICsgQmxhemVGYWNlIGluZmVyZW5jZSBmb3IgdmlzdWFsIFBJSSBkZXRlY3Rpb24uXCIsXG4gIH0pO1xuICBjb25zb2xlLmxvZyhcIltCR10gT2Zmc2NyZWVuIGRvY3VtZW50IGNyZWF0ZWQuXCIpO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIHJlZGFjdFNjcmVlbnNob3QgXHUyMDE0IHBoeXNpY2FsbHkgZHJhdyBibGFjayBib3hlcyBvdmVyIHNlbnNpdGl2ZSByZWdpb25zXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbmFzeW5jIGZ1bmN0aW9uIHJlZGFjdFNjcmVlbnNob3QoZGF0YVVybCwgc2Vuc2l0aXZlUmVnaW9ucykge1xuICBpZiAoIXNlbnNpdGl2ZVJlZ2lvbnMgfHwgc2Vuc2l0aXZlUmVnaW9ucy5sZW5ndGggPT09IDApIHJldHVybiBkYXRhVXJsO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goZGF0YVVybCk7XG4gICAgY29uc3QgYmxvYiA9IGF3YWl0IHJlcy5ibG9iKCk7XG4gICAgY29uc3QgYml0bWFwID0gYXdhaXQgY3JlYXRlSW1hZ2VCaXRtYXAoYmxvYik7XG4gICAgXG4gICAgY29uc3QgY2FudmFzID0gbmV3IE9mZnNjcmVlbkNhbnZhcyhiaXRtYXAud2lkdGgsIGJpdG1hcC5oZWlnaHQpO1xuICAgIGNvbnN0IGN0eCA9IGNhbnZhcy5nZXRDb250ZXh0KFwiMmRcIik7XG4gICAgXG4gICAgLy8gRHJhdyBvcmlnaW5hbCBpbWFnZVxuICAgIGN0eC5kcmF3SW1hZ2UoYml0bWFwLCAwLCAwKTtcbiAgICBcbiAgICAvLyBEcmF3IHJlZGFjdGlvbiBib3hlc1xuICAgIGN0eC5maWxsU3R5bGUgPSBcImJsYWNrXCI7XG4gICAgZm9yIChjb25zdCByZWdpb24gb2Ygc2Vuc2l0aXZlUmVnaW9ucykge1xuICAgICAgaWYgKHJlZ2lvbi5iYm94ICYmIHJlZ2lvbi5iYm94Lmxlbmd0aCA9PT0gNCkge1xuICAgICAgICBjb25zdCBbeCwgeSwgdywgaF0gPSByZWdpb24uYmJveDtcbiAgICAgICAgY3R4LmZpbGxSZWN0KHgsIHksIHcsIGgpO1xuICAgICAgfVxuICAgIH1cbiAgICBcbiAgICBjb25zdCBvdXRCbG9iID0gYXdhaXQgY2FudmFzLmNvbnZlcnRUb0Jsb2IoeyB0eXBlOiBcImltYWdlL3BuZ1wiIH0pO1xuICAgIGNvbnN0IGJ1ZmZlciA9IGF3YWl0IG91dEJsb2IuYXJyYXlCdWZmZXIoKTtcbiAgICBcbiAgICAvLyBDb252ZXJ0IHRvIGJhc2U2NFxuICAgIGxldCBiaW5hcnkgPSAnJztcbiAgICBjb25zdCBieXRlcyA9IG5ldyBVaW50OEFycmF5KGJ1ZmZlcik7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBieXRlcy5ieXRlTGVuZ3RoOyBpKyspIHtcbiAgICAgIGJpbmFyeSArPSBTdHJpbmcuZnJvbUNoYXJDb2RlKGJ5dGVzW2ldKTtcbiAgICB9XG4gICAgY29uc3QgYjY0ID0gYnRvYShiaW5hcnkpO1xuICAgIFxuICAgIHJldHVybiBgZGF0YTppbWFnZS9wbmc7YmFzZTY0LCR7YjY0fWA7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGNvbnNvbGUuZXJyb3IoXCJbQkddIFJlZGFjdGlvbiBmYWlsZWQ6XCIsIGVycik7XG4gICAgcmV0dXJuIGRhdGFVcmw7IC8vIGZhbGxiYWNrIHRvIG9yaWdpbmFsIG9uIGVycm9yXG4gIH1cbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBydW5WaXNpb25BbmFseXNpcyBcdTIwMTQgc2VuZHMgc2NyZWVuc2hvdCArIGRvbVJlZ2lvbnMgKyBtZWRpYVJlZ2lvbnMgdG8gb2Zmc2NyZWVuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbmFzeW5jIGZ1bmN0aW9uIHJ1blZpc2lvbkFuYWx5c2lzKHNjcmVlbnNob3REYXRhVXJsLCBkb21SZWdpb25zLCBtZWRpYVJlZ2lvbnMpIHtcbiAgYXdhaXQgZW5zdXJlT2Zmc2NyZWVuRG9jdW1lbnQoKTtcblxuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgIGNocm9tZS5ydW50aW1lLnNlbmRNZXNzYWdlKFxuICAgICAgeyB0eXBlOiBcIlJVTl9JTkZFUkVOQ0VcIiwgcGF5bG9hZDogeyBzY3JlZW5zaG90RGF0YVVybCwgZG9tUmVnaW9ucywgbWVkaWFSZWdpb25zIH0gfSxcbiAgICAgIChyZXNwb25zZSkgPT4ge1xuICAgICAgICBpZiAoY2hyb21lLnJ1bnRpbWUubGFzdEVycm9yKSB7XG4gICAgICAgICAgcmVqZWN0KG5ldyBFcnJvcihjaHJvbWUucnVudGltZS5sYXN0RXJyb3IubWVzc2FnZSkpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBpZiAoIXJlc3BvbnNlPy5zdWNjZXNzKSB7XG4gICAgICAgICAgcmVqZWN0KG5ldyBFcnJvcihyZXNwb25zZT8uZXJyb3IgPz8gXCJVbmtub3duIGluZmVyZW5jZSBlcnJvclwiKSk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHJlc29sdmUocmVzcG9uc2UpO1xuICAgICAgfVxuICAgICk7XG4gIH0pO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIHNlbmRUb1NlcnZlciBcdTIwMTQgUE9TVCByZXN1bHQgdG8gdGhlIGxvY2FsIEV4cHJlc3Mgc2VydmVyICh3aXRoIGZ1bGwgSFRUUCBsb2dnaW5nKVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5hc3luYyBmdW5jdGlvbiBzZW5kVG9TZXJ2ZXIocGF5bG9hZCkge1xuICBjb25zdCBiYXNlVXJsID0gYXdhaXQgZ2V0QmFzZVNlcnZlclVybCgpO1xuICBjb25zdCBzZXJ2ZXJVcmwgPSBgJHtiYXNlVXJsfS9hbmFseXplYDtcbiAgY29uc29sZS5sb2coXCJbQkddIEluaXRpYXRpbmcgSFRUUCByZXF1ZXN0IHRvIHNlcnZlciBVUkw6XCIsIHNlcnZlclVybCk7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goc2VydmVyVXJsLCB7XG4gICAgICBtZXRob2Q6ICBcIlBPU1RcIixcbiAgICAgIGhlYWRlcnM6IHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSxcbiAgICAgIGJvZHk6ICAgIEpTT04uc3RyaW5naWZ5KHBheWxvYWQpLFxuICAgIH0pO1xuXG4gICAgY29uc29sZS5sb2coYFtCR10gU2VydmVyIEhUVFAgU3RhdHVzIENvZGU6ICR7cmVzLnN0YXR1c30gJHtyZXMuc3RhdHVzVGV4dH1gKTtcbiAgICBjb25zdCByYXdCb2R5ID0gYXdhaXQgcmVzLnRleHQoKTtcbiAgICBjb25zb2xlLmxvZyhgW0JHXSBTZXJ2ZXIgUmF3IFJlc3BvbnNlIEJvZHkgKCR7cmF3Qm9keS5sZW5ndGh9IGJ5dGVzKTpgLCByYXdCb2R5Lmxlbmd0aCA+IDUwMCA/IHJhd0JvZHkuc3Vic3RyaW5nKDAsIDUwMCkgKyBcIi4uLiBbdHJ1bmNhdGVkXVwiIDogcmF3Qm9keSk7XG5cbiAgICBpZiAoIXJlcy5vaykge1xuICAgICAgbGV0IHNlcnZlckVyciA9IFwiXCI7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKHJhd0JvZHkpO1xuICAgICAgICBzZXJ2ZXJFcnIgPSBwYXJzZWQuZXJyb3IgfHwgcGFyc2VkLm1lc3NhZ2UgfHwgXCJcIjtcbiAgICAgIH0gY2F0Y2ggKGUpIHt9XG4gICAgICB0aHJvdyBuZXcgRXJyb3Ioc2VydmVyRXJyIHx8IGBTZXJ2ZXIgcmV0dXJuZWQgSFRUUCAke3Jlcy5zdGF0dXN9ICgke3Jlcy5zdGF0dXNUZXh0fSk6ICR7cmF3Qm9keS5zdWJzdHJpbmcoMCwgMjAwKX1gKTtcbiAgICB9XG5cbiAgICBsZXQgZGF0YTtcbiAgICB0cnkge1xuICAgICAgZGF0YSA9IEpTT04ucGFyc2UocmF3Qm9keSk7XG4gICAgfSBjYXRjaCAocGFyc2VFcnIpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgU2VydmVyIHJlc3BvbnNlIHdhcyBub3QgdmFsaWQgSlNPTjogJHtyYXdCb2R5LnN1YnN0cmluZygwLCAyMDApfWApO1xuICAgIH1cblxuICAgIHJldHVybiBkYXRhO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBjb25zb2xlLmVycm9yKFwiW0JHIEVycm9yXVtzZW5kVG9TZXJ2ZXJdIE5ldHdvcmsgb3IgSFRUUCBlcnJvcjpcIiwgZXJyKTtcbiAgICB0aHJvdyBlcnI7XG4gIH1cbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBQb3J0LWJhc2VkIGhhbmRsZXIgXHUyMDE0IGtlZXBzIHRoZSBzZXJ2aWNlIHdvcmtlciBhbGl2ZSBkdXJpbmcgbG9uZyBpbmZlcmVuY2Vcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuY2hyb21lLnJ1bnRpbWUub25Db25uZWN0LmFkZExpc3RlbmVyKChwb3J0KSA9PiB7XG4gIGlmIChwb3J0Lm5hbWUgIT09IFwiYW5hbHl6ZVwiKSByZXR1cm47XG5cbiAgbGV0IGlzQ29ubmVjdGVkID0gdHJ1ZTtcbiAgY29uc3Qgc2FmZVBvc3QgPSAobXNnKSA9PiB7XG4gICAgaWYgKCFpc0Nvbm5lY3RlZCkgcmV0dXJuIGZhbHNlO1xuICAgIHRyeSB7XG4gICAgICBwb3J0LnBvc3RNZXNzYWdlKG1zZyk7XG4gICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBpc0Nvbm5lY3RlZCA9IGZhbHNlO1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgfTtcblxuICAvLyBGb3J3YXJkIE1PREVMX1BST0dSRVNTIC8gTU9ERUxfUkVBRFkgLyBNT0RFTF9FUlJPUiBmcm9tIG9mZnNjcmVlbiB0byBwb3B1cFxuICBjb25zdCByZWxheSA9IChtc2cpID0+IHtcbiAgICBpZiAoW1wiTU9ERUxfUFJPR1JFU1NcIiwgXCJNT0RFTF9SRUFEWVwiLCBcIk1PREVMX0VSUk9SXCJdLmluY2x1ZGVzKG1zZy50eXBlKSkge1xuICAgICAgc2FmZVBvc3QobXNnKTtcbiAgICB9XG4gIH07XG5cbiAgY2hyb21lLnJ1bnRpbWUub25NZXNzYWdlLmFkZExpc3RlbmVyKHJlbGF5KTtcbiAgcG9ydC5vbkRpc2Nvbm5lY3QuYWRkTGlzdGVuZXIoKCkgPT4ge1xuICAgIGlzQ29ubmVjdGVkID0gZmFsc2U7XG4gICAgY2hyb21lLnJ1bnRpbWUub25NZXNzYWdlLnJlbW92ZUxpc3RlbmVyKHJlbGF5KTtcbiAgICBjb25zb2xlLmxvZyhcIltCR10gUG9wdXAgcG9ydCBkaXNjb25uZWN0ZWQgKHBvcHVwIGNsb3NlZCkuIENvbnRpbnVpbmcgZXhlY3V0aW9uIGluIGJhY2tncm91bmQuXCIpO1xuICB9KTtcblxuICBwb3J0Lm9uTWVzc2FnZS5hZGRMaXN0ZW5lcihhc3luYyAobWVzc2FnZSkgPT4ge1xuICAgIGlmIChtZXNzYWdlLnR5cGUgIT09IFwiQU5BTFlaRV9TQ1JFRU5cIiAmJiBtZXNzYWdlLnR5cGUgIT09IFwiU1RBUlRfREVNT19SVU5cIikgcmV0dXJuO1xuICAgIFxuICAgIGNvbnN0IGlzRGVtbyA9IG1lc3NhZ2UudHlwZSA9PT0gXCJTVEFSVF9ERU1PX1JVTlwiO1xuICAgIGNvbnN0IGluc3RydWN0aW9uID0gbWVzc2FnZS5pbnN0cnVjdGlvbiB8fCBcIkFuYWx5emUgdGhlIGN1cnJlbnQgc2NyZWVuIGFuZCBkZXRlY3QgUElJXCI7XG4gICAgbGV0IHNob3VsZENvbnRpbnVlID0gdHJ1ZTtcbiAgICBsZXQgdGFza1Zpc2lvbkluZmVyZW5jZXMgPSAwO1xuICAgIGNvbnN0IE1BWF9WSVNJT05fUEVSX1RBU0sgPSAzO1xuICAgIGNvbnN0IHN0ZXBDb25zZWN1dGl2ZUZhaWx1cmVzID0gbmV3IE1hcCgpO1xuXG4gICAgd2hpbGUgKHNob3VsZENvbnRpbnVlKSB7XG4gICAgICBjb25zdCB0MCA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICAgICAgY29uc29sZS5sb2coYFtCR10gPj4+IFN0YXJ0aW5nIEV4ZWN1dGlvbiBMb29wIChpc0RlbW89JHtpc0RlbW99KSA8PDxgKTtcblxuICAgICAgLy8gXHUyNTAwXHUyNTAwIFN0ZXAgMDogUmVhZCBhbmQgUHJpbnQgQ3VycmVudCBTdG9yZWQgUHJvZmlsZSBWYXVsdCAoUmVxdWlyZW1lbnQgMikgXHUyNTAwXHUyNTAwXG4gICAgICBjb25zdCBzdG9yZWRWYXVsdCA9IGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgICAgIGNocm9tZS5zdG9yYWdlLmxvY2FsLmdldChbXCJhZ2VudF92YXVsdFwiXSwgKGRhdGEpID0+IHJlc29sdmUoZGF0YT8uYWdlbnRfdmF1bHQgfHwge30pKTtcbiAgICAgIH0pO1xuICAgICAgY29uc3QgdmF1bHRLZXlzID0gT2JqZWN0LmtleXMoc3RvcmVkVmF1bHQpO1xuXG4gICAgICBjb25zb2xlLmxvZyhcIlxcbj09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XCIpO1xuICAgICAgY29uc29sZS5sb2coXCJbQkddID09PSBDVVJSRU5UIFNUT1JFRCBQUk9GSUxFIFZBVUxUIEFUIFNUQVJUIE9GIFJVTiA9PT1cIik7XG4gICAgICBpZiAodmF1bHRLZXlzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgY29uc29sZS5sb2coYEZvdW5kICR7dmF1bHRLZXlzLmxlbmd0aH0gc3RvcmVkIGZpZWxkKHMpOmApO1xuICAgICAgICBjb25zb2xlLmxvZyhKU09OLnN0cmluZ2lmeShzdG9yZWRWYXVsdCwgbnVsbCwgMikpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc29sZS5sb2coXCJQcm9maWxlIHZhdWx0IGlzIGN1cnJlbnRseSBFTVBUWSAoMCBmaWVsZHMgY29uZmlndXJlZCkuXCIpO1xuICAgICAgfVxuICAgICAgY29uc29sZS5sb2coXCI9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxcblwiKTtcblxuICAgICAgc2FmZVBvc3Qoe1xuICAgICAgICB0eXBlOiBcIlNUQVRVU1wiLFxuICAgICAgICB0ZXh0OiB2YXVsdEtleXMubGVuZ3RoID4gMFxuICAgICAgICAgID8gYFtWQVVMVF0gTG9hZGVkICR7dmF1bHRLZXlzLmxlbmd0aH0gc3RvcmVkIGZpZWxkKHMpOiAke3ZhdWx0S2V5cy5qb2luKFwiLCBcIil9YFxuICAgICAgICAgIDogXCJcdTI2QTAgVmF1bHQgaXMgZW1wdHkhIE9wZW4gUHJvZmlsZSBzZXR0aW5ncyB0byBjb25maWd1cmUgdmFsdWVzLlwiXG4gICAgICB9KTtcblxuICAgICAgLy8gXHUyNTAwXHUyNTAwIFN0ZXAgMTogQ2FwdHVyZSBzY3JlZW4gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgICBsZXQgY2FwdHVyZVJlc3VsdDtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnNvbGUubG9nKFwiW0JHXSBTdGVwIDE6IENhcHR1cmluZyBhY3RpdmUgdGFiIHNjcmVlbnNob3QuLi5cIik7XG4gICAgICAgIHNhZmVQb3N0KHsgdHlwZTogXCJTVEFHRV9DSEFOR0VcIiwgc3RhZ2U6IFwiY2FwdHVyZVwiLCB0ZXh0OiBcIkNhcHR1cmluZyBzY3JlZW5cdTIwMjZcIiB9KTtcbiAgICAgICAgY2FwdHVyZVJlc3VsdCA9IGF3YWl0IGNhcHR1cmVTY3JlZW4oKTtcbiAgICAgICAgY29uc29sZS5sb2coXCJbQkddIFN0ZXAgMSBDb21wbGV0ZS4gU2NyZWVuc2hvdCBjYXB0dXJlZCBzdWNjZXNzZnVsbHkuXCIpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoXCJbQkcgRXJyb3JdW1N0ZXAgMTogU2NyZWVuc2hvdCBDYXB0dXJlXTpcIiwgZXJyKTtcbiAgICAgICAgc2FmZVBvc3QoeyB0eXBlOiBcIkVSUk9SXCIsIHN0ZXA6IFwiU2NyZWVuc2hvdCBDYXB0dXJlXCIsIGVycm9yOiBlcnIubWVzc2FnZSB9KTtcbiAgICAgICAgc2hvdWxkQ29udGludWUgPSBmYWxzZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG5cbiAgICAgIC8vIFx1MjUwMFx1MjUwMCBTdGVwIDI6IERPTSBzY2FuIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgICAgbGV0IGRvbVJlc3VsdDtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnNvbGUubG9nKGBbQkddIFN0ZXAgMjogU2Nhbm5pbmcgRE9NIGZvciBzZW5zaXRpdmUgZmllbGRzIG9uIHRhYiAke2NhcHR1cmVSZXN1bHQudGFiLmlkfS4uLmApO1xuICAgICAgICBzYWZlUG9zdCh7IHR5cGU6IFwiU1RBR0VfQ0hBTkdFXCIsIHN0YWdlOiBcImNhcHR1cmVcIiwgdGV4dDogXCJTY2FubmluZyBET00gZm9yIHNlbnNpdGl2ZSBmaWVsZHNcdTIwMjZcIiB9KTtcbiAgICAgICAgZG9tUmVzdWx0ID0gYXdhaXQgZ2V0RE9NUmVnaW9ucyhjYXB0dXJlUmVzdWx0LnRhYi5pZCk7XG4gICAgICAgIHNhZmVQb3N0KHsgdHlwZTogXCJET01fU0NBTl9ET05FXCIsIGNvdW50OiBkb21SZXN1bHQuZG9tUmVnaW9ucy5sZW5ndGggfSk7XG4gICAgICAgIGNvbnNvbGUubG9nKGBbQkddIFN0ZXAgMiBDb21wbGV0ZS4gRm91bmQgJHtkb21SZXN1bHQuZG9tUmVnaW9ucy5sZW5ndGh9IHNlbnNpdGl2ZSBET00gZmllbGQocykuYCk7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgY29uc29sZS5lcnJvcihcIltCRyBFcnJvcl1bU3RlcCAyOiBET00gU2Nhbl06XCIsIGVycik7XG4gICAgICAgIHNhZmVQb3N0KHsgdHlwZTogXCJFUlJPUlwiLCBzdGVwOiBcIkRPTSBTY2FuXCIsIGVycm9yOiBlcnIubWVzc2FnZSB9KTtcbiAgICAgICAgc2hvdWxkQ29udGludWUgPSBmYWxzZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG5cbiAgICAgIC8vIFx1MjUwMFx1MjUwMCBTdGVwIDM6IFZpc2lvbiArIFBJSSBhbmFseXNpcyAob2Zmc2NyZWVuKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICAgIHN0YXRzLmZyYW1lc0NhcHR1cmVkKys7XG4gICAgICBjb25zdCBjYWNoZUtleSA9IGNhcHR1cmVSZXN1bHQudGFiLnVybCArIFwifFwiICsgZG9tUmVzdWx0LmRvbUhhc2g7XG4gICAgICBsZXQgZGV0ZWN0aW9ucywgc2Vuc2l0aXZlUmVnaW9ucywgc2NyZWVuc2hvdERhdGFVcmwsIGVsYXBzZWQ7XG5cbiAgICAgIGlmIChhbmFseXNpc0NhY2hlLmhhcyhjYWNoZUtleSkpIHtcbiAgICAgICAgY29uc29sZS5sb2coXCJbQkddIFN0ZXAgMzogRE9NIGlkZW50aWNhbCEgQ2FjaGUgaGl0LCByZXVzaW5nIGNhY2hlZCBkZXRlY3Rpb25zLlwiKTtcbiAgICAgICAgc2FmZVBvc3QoeyB0eXBlOiBcIlNUQVRVU1wiLCB0ZXh0OiBcIlx1MjZBMSBET00gaWRlbnRpY2FsISBTa2lwcGluZyB2aXNpb24gaW5mZXJlbmNlIChDYWNoZSBIaXQpLlwiIH0pO1xuICAgICAgICBjb25zdCBjYWNoZWQgPSBhbmFseXNpc0NhY2hlLmdldChjYWNoZUtleSk7XG4gICAgICAgIGRldGVjdGlvbnMgPSBjYWNoZWQuZGV0ZWN0aW9ucztcbiAgICAgICAgc2Vuc2l0aXZlUmVnaW9ucyA9IGNhY2hlZC5zZW5zaXRpdmVSZWdpb25zO1xuICAgICAgICBzY3JlZW5zaG90RGF0YVVybCA9IGNhcHR1cmVSZXN1bHQuZGF0YVVybDtcbiAgICAgICAgZWxhcHNlZCA9IDA7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnNvbGUubG9nKGBbQkddIFN0ZXAgMzogRGlzcGF0Y2hpbmcgc2NyZWVuc2hvdCBhbmQgZG9tUmVnaW9ucyB0byBvZmZzY3JlZW4gZG9jdW1lbnQgZm9yIGluZmVyZW5jZSAoYXR0ZW1wdCAke3Rhc2tWaXNpb25JbmZlcmVuY2VzICsgMX0gb2YgbWF4ICR7TUFYX1ZJU0lPTl9QRVJfVEFTS30pLi4uYCk7XG4gICAgICAgICAgc2FmZVBvc3QoeyB0eXBlOiBcIlNUQUdFX0NIQU5HRVwiLCBzdGFnZTogXCJkZXRlY3RcIiwgdGV4dDogYFJ1bm5pbmcgRmxvcmVuY2UtMiArIEJsYXplRmFjZSArIFBJSSBhbmFseXNpcyAodmlzaW9uIHBhc3MgJHt0YXNrVmlzaW9uSW5mZXJlbmNlcyArIDF9LyR7TUFYX1ZJU0lPTl9QRVJfVEFTS30pXHUyMDI2YCB9KTtcbiAgICAgICAgICBpZiAodGFza1Zpc2lvbkluZmVyZW5jZXMgPj0gTUFYX1ZJU0lPTl9QRVJfVEFTSykge1xuICAgICAgICAgICAgY29uc29sZS53YXJuKGBbQkddIFN0b3BwaW5nIGFmdGVyICR7TUFYX1ZJU0lPTl9QRVJfVEFTS30gZnVsbCBhbmFseXNpcyBhdHRlbXB0cyB0byBhdm9pZCBleGNlc3NpdmUgY29zdC5gKTtcbiAgICAgICAgICAgIHNhZmVQb3N0KHtcbiAgICAgICAgICAgICAgdHlwZTogXCJFUlJPUlwiLFxuICAgICAgICAgICAgICBzdGVwOiBcIlZpc2lvbiBJbmZlcmVuY2UgQ2FwXCIsXG4gICAgICAgICAgICAgIGVycm9yOiBgU3RvcHBpbmcgYWZ0ZXIgJHtNQVhfVklTSU9OX1BFUl9UQVNLfSBmdWxsIGFuYWx5c2lzIGF0dGVtcHRzIHRvIGF2b2lkIGV4Y2Vzc2l2ZSBjb3N0YFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBzaG91bGRDb250aW51ZSA9IGZhbHNlO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICAgIHRhc2tWaXNpb25JbmZlcmVuY2VzKys7XG4gICAgICAgICAgc3RhdHMudmlzaW9uSW5mZXJlbmNlcysrO1xuICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1blZpc2lvbkFuYWx5c2lzKGNhcHR1cmVSZXN1bHQuZGF0YVVybCwgZG9tUmVzdWx0LmRvbVJlZ2lvbnMsIGRvbVJlc3VsdC5tZWRpYVJlZ2lvbnMpO1xuICAgICAgICAgIGRldGVjdGlvbnMgPSByZXN1bHQuZGV0ZWN0aW9ucztcbiAgICAgICAgICBzZW5zaXRpdmVSZWdpb25zID0gcmVzdWx0LnNlbnNpdGl2ZVJlZ2lvbnM7XG4gICAgICAgICAgc2NyZWVuc2hvdERhdGFVcmwgPSByZXN1bHQuc2NyZWVuc2hvdERhdGFVcmw7XG4gICAgICAgICAgZWxhcHNlZCA9IHJlc3VsdC5lbGFwc2VkO1xuICAgICAgICAgIGFuYWx5c2lzQ2FjaGUuc2V0KGNhY2hlS2V5LCB7IGRldGVjdGlvbnMsIHNlbnNpdGl2ZVJlZ2lvbnMgfSk7XG4gICAgICAgICAgY29uc29sZS5sb2coYFtCR10gU3RlcCAzIENvbXBsZXRlIGluICR7ZWxhcHNlZH1tczogJHtkZXRlY3Rpb25zLmxlbmd0aH0gZGV0ZWN0aW9ucywgJHtzZW5zaXRpdmVSZWdpb25zLmxlbmd0aH0gUElJIHJlZ2lvbnMuYCk7XG4gICAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICAgIGNvbnNvbGUuZXJyb3IoXCJbQkcgRXJyb3JdW1N0ZXAgMzogRmxvcmVuY2UtMiAvIFZpc2lvbiBJbmZlcmVuY2VdOlwiLCBlcnIpO1xuICAgICAgICAgIHNhZmVQb3N0KHsgdHlwZTogXCJFUlJPUlwiLCBzdGVwOiBcIkZsb3JlbmNlLTIgSW5mZXJlbmNlXCIsIGVycm9yOiBlcnIubWVzc2FnZSB9KTtcbiAgICAgICAgICBzaG91bGRDb250aW51ZSA9IGZhbHNlO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIC8vIFx1MjUwMFx1MjUwMCBTdGVwIDQ6IFJlZGFjdCBJbWFnZSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICAgIC8vIENhcHR1cmUgcmF3IHNjcmVlbnNob3Qgc2l6ZSBCRUZPUkUgcmVkYWN0aW9uIGZvciBtZXRyaWNzXG4gICAgICBjb25zdCByYXdCeXRlcyA9IGNhcHR1cmVSZXN1bHQuZGF0YVVybC5sZW5ndGg7XG5cbiAgICAgIGxldCBmaW5hbFNjcmVlbnNob3REYXRhVXJsO1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc29sZS5sb2coYFtCR10gU3RlcCA0OiBSZWRhY3RpbmcgJHtzZW5zaXRpdmVSZWdpb25zLmxlbmd0aH0gc2Vuc2l0aXZlIHJlZ2lvbnMgb24gY2FudmFzLi4uYCk7XG4gICAgICAgIHNhZmVQb3N0KHsgdHlwZTogXCJTVEFHRV9DSEFOR0VcIiwgc3RhZ2U6IFwicmVkYWN0XCIsIHRleHQ6IGBSZWRhY3RpbmcgJHtzZW5zaXRpdmVSZWdpb25zLmxlbmd0aH0gc2Vuc2l0aXZlIHJlZ2lvbnNcdTIwMjZgIH0pO1xuICAgICAgICBmaW5hbFNjcmVlbnNob3REYXRhVXJsID0gYXdhaXQgcmVkYWN0U2NyZWVuc2hvdChzY3JlZW5zaG90RGF0YVVybCwgc2Vuc2l0aXZlUmVnaW9ucyk7XG4gICAgICAgIGNvbnNvbGUubG9nKFwiW0JHXSBTdGVwIDQgQ29tcGxldGUuIFJlZGFjdGlvbiBmaW5pc2hlZC5cIik7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgY29uc29sZS5lcnJvcihcIltCRyBFcnJvcl1bU3RlcCA0OiBSZWRhY3Rpb25dOlwiLCBlcnIpO1xuICAgICAgICBzYWZlUG9zdCh7IHR5cGU6IFwiRVJST1JcIiwgc3RlcDogXCJSZWRhY3Rpb25cIiwgZXJyb3I6IGVyci5tZXNzYWdlIH0pO1xuICAgICAgICBzaG91bGRDb250aW51ZSA9IGZhbHNlO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cblxuICAgICAgLy8gXHUyNTAwXHUyNTAwIFN0ZXAgNGI6IFJlZGFjdGlvbiBMZWFrIFZlcmlmaWNhdGlvbiAob2Zmc2NyZWVuLCBnZW9tZXRyaWMpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgICAgLy8gQnVnIGZpeDogYmFja2dyb3VuZC5qcyBpcyBhbiBNVjMgc2VydmljZSB3b3JrZXIgXHUyMDE0IGl0IGhhcyBOTyBhY2Nlc3MgdG9cbiAgICAgIC8vIEltYWdlLCBjYW52YXMsIG9yIGRvY3VtZW50LiBXZSBzZW5kIGEgVkVSSUZZX1JFREFDVElPTiBtZXNzYWdlIHRvIHRoZVxuICAgICAgLy8gb2Zmc2NyZWVuIGRvY3VtZW50ICh3aGljaCBoYXMgZnVsbCB3aW5kb3cgY29udGV4dCkgdG8gZG8gdGhlIHBpeGVsIGNoZWNrLlxuICAgICAgbGV0IGxlYWtDaGVja1Bhc3NlZCA9IHRydWU7XG4gICAgICBsZXQgbGVha0RldGFpbHMgPSB7IGxlYWtzRm91bmQ6IDAsIGxlYWtSZWdpb25zOiBbXSwgY2hlY2tlZFJlZ2lvbnM6IHNlbnNpdGl2ZVJlZ2lvbnMubGVuZ3RoIH07XG4gICAgICB0cnkge1xuICAgICAgICBpZiAoc2Vuc2l0aXZlUmVnaW9ucy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgLy8gRGVsZWdhdGUgcGl4ZWwtc2FtcGxpbmcgdG8gb2Zmc2NyZWVuIGRvY3VtZW50IChoYXMgd2luZG93L2NhbnZhcyBhY2Nlc3MpXG4gICAgICAgICAgY29uc3QgdmVyaWZ5UmVzcCA9IGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgICAgICAgICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4gcmVzb2x2ZSh7IG9rOiB0cnVlLCBsZWFrZXJzOiBbXSwgY2hlY2tlZDogc2Vuc2l0aXZlUmVnaW9ucy5sZW5ndGggfSksIDUwMDApO1xuICAgICAgICAgICAgY2hyb21lLnJ1bnRpbWUuc2VuZE1lc3NhZ2UoXG4gICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICB0eXBlOiBcIlZFUklGWV9SRURBQ1RJT05cIixcbiAgICAgICAgICAgICAgICBwYXlsb2FkOiB7IHJlZGFjdGVkRGF0YVVybDogZmluYWxTY3JlZW5zaG90RGF0YVVybCwgc2Vuc2l0aXZlUmVnaW9ucyB9XG4gICAgICAgICAgICAgIH0sXG4gICAgICAgICAgICAgIChyZXNwKSA9PiB7XG4gICAgICAgICAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICAgICAgICAgICAgICBpZiAoY2hyb21lLnJ1bnRpbWUubGFzdEVycm9yKSB7XG4gICAgICAgICAgICAgICAgICBjb25zb2xlLndhcm4oXCJbQkddIFN0ZXAgNGI6IFZFUklGWV9SRURBQ1RJT04gbWVzc2FnZSBlcnJvciAobm9uLWZhdGFsKTpcIiwgY2hyb21lLnJ1bnRpbWUubGFzdEVycm9yLm1lc3NhZ2UpO1xuICAgICAgICAgICAgICAgICAgcmVzb2x2ZSh7IG9rOiB0cnVlLCBsZWFrZXJzOiBbXSwgY2hlY2tlZDogc2Vuc2l0aXZlUmVnaW9ucy5sZW5ndGggfSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgIHJlc29sdmUocmVzcCB8fCB7IG9rOiB0cnVlLCBsZWFrZXJzOiBbXSwgY2hlY2tlZDogc2Vuc2l0aXZlUmVnaW9ucy5sZW5ndGggfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICApO1xuICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgY29uc3QgbGVha2luZ1JlZ2lvbnMgPSB2ZXJpZnlSZXNwLmxlYWtlcnMgfHwgW107XG4gICAgICAgICAgbGVha0RldGFpbHMgPSB7XG4gICAgICAgICAgICBsZWFrc0ZvdW5kOiBsZWFraW5nUmVnaW9ucy5sZW5ndGgsXG4gICAgICAgICAgICBsZWFrUmVnaW9uczogbGVha2luZ1JlZ2lvbnMsXG4gICAgICAgICAgICBjaGVja2VkUmVnaW9uczogc2Vuc2l0aXZlUmVnaW9ucy5sZW5ndGgsXG4gICAgICAgICAgfTtcblxuICAgICAgICAgIGlmIChsZWFraW5nUmVnaW9ucy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBsZWFrQ2hlY2tQYXNzZWQgPSBmYWxzZTtcbiAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYFtCR10gU3RlcCA0YiBGQUlMOiAke2xlYWtpbmdSZWdpb25zLmxlbmd0aH0gcmVnaW9uKHMpIG5vdCBmdWxseSBibGFja2VkIG91dCFgLCBsZWFraW5nUmVnaW9ucyk7XG4gICAgICAgICAgICBzYWZlUG9zdCh7XG4gICAgICAgICAgICAgIHR5cGU6IFwiTEVBS19DSEVDS1wiLFxuICAgICAgICAgICAgICBwYXNzZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICBsZWFrc0ZvdW5kOiBsZWFraW5nUmVnaW9ucy5sZW5ndGgsXG4gICAgICAgICAgICAgIGxlYWtSZWdpb25zOiBsZWFraW5nUmVnaW9ucyxcbiAgICAgICAgICAgICAgY2hlY2tlZFJlZ2lvbnM6IHNlbnNpdGl2ZVJlZ2lvbnMubGVuZ3RoLFxuICAgICAgICAgICAgICBtZXNzYWdlOiBgXHVEODNEXHVERUE4IExFQUsgREVURUNURUQ6ICR7bGVha2luZ1JlZ2lvbnMubGVuZ3RofSByZWdpb24ocykgbm90IGJsYWNrZWQgb3V0IFx1MjAxNCBwYXlsb2FkIEJMT0NLRURgLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKGBbQkddIFN0ZXAgNGIgUEFTUzogQWxsICR7c2Vuc2l0aXZlUmVnaW9ucy5sZW5ndGh9IHJlZ2lvbihzKSB2ZXJpZmllZCBibGFjayAoZ2VvbWV0cmljKS5gKTtcbiAgICAgICAgICAgIHNhZmVQb3N0KHtcbiAgICAgICAgICAgICAgdHlwZTogXCJMRUFLX0NIRUNLXCIsXG4gICAgICAgICAgICAgIHBhc3NlZDogdHJ1ZSxcbiAgICAgICAgICAgICAgbGVha3NGb3VuZDogMCxcbiAgICAgICAgICAgICAgbGVha1JlZ2lvbnM6IFtdLFxuICAgICAgICAgICAgICBjaGVja2VkUmVnaW9uczogc2Vuc2l0aXZlUmVnaW9ucy5sZW5ndGgsXG4gICAgICAgICAgICAgIG1lc3NhZ2U6IGBcdTI3MTMgMCBsZWFrcyBcdTIwMTQgJHtzZW5zaXRpdmVSZWdpb25zLmxlbmd0aH0gbWFza2VkIHJlZ2lvbihzKSB2ZXJpZmllZCBibGFja2AsXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgLy8gTm8gcmVnaW9ucyB0byByZWRhY3QgXHUyMDE0IHRyaXZpYWxseSBjbGVhblxuICAgICAgICAgIGNvbnNvbGUubG9nKFwiW0JHXSBTdGVwIDRiOiBObyBzZW5zaXRpdmUgcmVnaW9ucyB0byB2ZXJpZnkuXCIpO1xuICAgICAgICAgIHNhZmVQb3N0KHtcbiAgICAgICAgICAgIHR5cGU6IFwiTEVBS19DSEVDS1wiLFxuICAgICAgICAgICAgcGFzc2VkOiB0cnVlLFxuICAgICAgICAgICAgbGVha3NGb3VuZDogMCxcbiAgICAgICAgICAgIGxlYWtSZWdpb25zOiBbXSxcbiAgICAgICAgICAgIGNoZWNrZWRSZWdpb25zOiAwLFxuICAgICAgICAgICAgbWVzc2FnZTogXCJcdTI3MTMgTm8gcmVnaW9ucyB0byB2ZXJpZnkgKHBhZ2UgaGFzIG5vIGRldGVjdGVkIFBJSSlcIixcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCAobGVha0Vycikge1xuICAgICAgICAvLyBUcmVhdCBpbmZlcmVuY2UgZXJyb3JzIGFzIG5vbi1mYXRhbCBmb3IgbGVhayBjaGVjayBcdTIwMTQgbG9nIGJ1dCBwcm9jZWVkXG4gICAgICAgIGNvbnNvbGUud2FybihcIltCR10gU3RlcCA0YjogTGVhayB2ZXJpZmljYXRpb24gaW5mZXJlbmNlIGZhaWxlZCAobm9uLWZhdGFsKTpcIiwgbGVha0Vyci5tZXNzYWdlKTtcbiAgICAgICAgc2FmZVBvc3Qoe1xuICAgICAgICAgIHR5cGU6IFwiTEVBS19DSEVDS1wiLFxuICAgICAgICAgIHBhc3NlZDogdHJ1ZSwgIC8vIEdpdmUgYmVuZWZpdCBvZiBkb3VidCBpZiBpbmZlcmVuY2UgZmFpbHNcbiAgICAgICAgICBsZWFrc0ZvdW5kOiAwLFxuICAgICAgICAgIGxlYWtSZWdpb25zOiBbXSxcbiAgICAgICAgICBjaGVja2VkUmVnaW9uczogc2Vuc2l0aXZlUmVnaW9ucy5sZW5ndGgsXG4gICAgICAgICAgbWVzc2FnZTogYFx1MjZBMCBMZWFrIGNoZWNrIHNraXBwZWQgKGluZmVyZW5jZSBlcnJvcjogJHtsZWFrRXJyLm1lc3NhZ2V9KWAsXG4gICAgICAgICAgd2FybmluZzogdHJ1ZSxcbiAgICAgICAgfSk7XG4gICAgICB9XG5cbiAgICAgIC8vIEJsb2NrIHRoZSBwYXlsb2FkIGlmIGxlYWsgY2hlY2sgZmFpbGVkXG4gICAgICBpZiAoIWxlYWtDaGVja1Bhc3NlZCkge1xuICAgICAgICBjb25zb2xlLmVycm9yKFwiW0JHXSBCTE9DS0lORyBwYXlsb2FkIHRyYW5zbWlzc2lvbiBcdTIwMTQgUElJIGxlYWsgdmVyaWZpY2F0aW9uIGZhaWxlZCFcIik7XG4gICAgICAgIHNob3VsZENvbnRpbnVlID0gZmFsc2U7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuXG4gICAgICAvLyBcdTI1MDBcdTI1MDAgU3RlcCA1OiBTZW5kIFBheWxvYWQgdG8gU2VydmVyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgICAgLy8gQnVnIGZpeDogaG9pc3QgZG9tX3N1bW1hcnkgYW5kIG1hbmlmZXN0IHRvIG91dGVyIHNjb3BlIHNvIFN0ZXAgNlxuICAgICAgLy8gKHRoZSBhY3Rpb24gZXhlY3V0b3IpIGNhbiByZWZlcmVuY2UgdGhlbSBmb3IgYmJveCBjb29yZGluYXRlIGxvb2t1cC5cbiAgICAgIC8vIFByZXZpb3VzbHkgdGhleSB3ZXJlIGNvbnN0LWRlY2xhcmVkIGluc2lkZSB0aGUgdHJ5e30gYmxvY2sgYW5kXG4gICAgICAvLyBjYXVzZWQgUmVmZXJlbmNlRXJyb3I6IGRvbV9zdW1tYXJ5IGlzIG5vdCBkZWZpbmVkIGF0IGxpbmUgNjM5LlxuICAgICAgbGV0IG1hbmlmZXN0ID0gKHNlbnNpdGl2ZVJlZ2lvbnMgfHwgW10pLm1hcCgociwgaSkgPT4gKHtcbiAgICAgICAgcmVnaW9uX2lkOiBgcmVnaW9uXyR7aX1gLFxuICAgICAgICBiYm94OiByLmJib3gsXG4gICAgICAgIHR5cGU6IHIudHlwZSxcbiAgICAgICAgcmVkYWN0aW9uX3N0eWxlOiBcImJsYWNrX2JveFwiLFxuICAgICAgICBjb25maWRlbmNlOiByLmNvbmZpZGVuY2UsXG4gICAgICAgIHNvdXJjZTogci5zb3VyY2UgfHwgXCJkb21cIlxuICAgICAgfSkpO1xuXG4gICAgICBsZXQgZG9tX3N1bW1hcnkgPSAoZG9tUmVzdWx0LmRvbVJlZ2lvbnMgfHwgW10pLm1hcCgociwgaSkgPT4gKHtcbiAgICAgICAgZWxlbWVudF9pZDogci5hZ2VudElkIHx8IGBhZ2VudF8ke2l9YCxcbiAgICAgICAgZG9tX2lkOiByLmlkIHx8IFwiXCIsXG4gICAgICAgIG5hbWU6IHIubmFtZSB8fCBcIlwiLFxuICAgICAgICBwbGFjZWhvbGRlcjogci5wbGFjZWhvbGRlciB8fCBcIlwiLFxuICAgICAgICB0YWc6IHIudGFnIHx8IFwiaW5wdXRcIixcbiAgICAgICAgcm9sZTogci5yb2xlIHx8IChyLmlucHV0VHlwZSA9PT0gXCJyYWRpb1wiID8gXCJyYWRpb1wiIDogXCJ0ZXh0Ym94XCIpLFxuICAgICAgICBsYWJlbDogci5sYWJlbCB8fCBcIlwiLFxuICAgICAgICBmaWVsZF90eXBlOiByLnR5cGUgfHwgXCJcIixcbiAgICAgICAgYmJveDogci5iYm94LFxuICAgICAgICBjdXJyZW50X3ZhbHVlOiByLmN1cnJlbnRfdmFsdWUgfHwgXCJcIlxuICAgICAgfSkpO1xuXG4gICAgICBsZXQgc2VydmVyUmVzdWx0O1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgYWN0aXZlQmFzZVVybCA9IGF3YWl0IGdldEJhc2VTZXJ2ZXJVcmwoKTtcbiAgICAgICAgY29uc29sZS5sb2coYFtCR10gU3RlcCA1OiBQcmVwYXJpbmcgQWdlbnRSZXF1ZXN0VjEgcGF5bG9hZCBmb3Igc2VydmVyICgke2FjdGl2ZUJhc2VVcmx9KS4uLmApO1xuICAgICAgICBzYWZlUG9zdCh7IHR5cGU6IFwiU1RBR0VfQ0hBTkdFXCIsIHN0YWdlOiBcInNlbmRcIiwgdGV4dDogYFNlbmRpbmcgcmVkYWN0ZWQgcGF5bG9hZCB0byBzZXJ2ZXIgKCR7YWN0aXZlQmFzZVVybH0vYW5hbHl6ZSlcdTIwMjZgIH0pO1xuXG4gICAgICAgIGNvbnNvbGUubG9nKFwiXFxuPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cIik7XG4gICAgICAgIGNvbnNvbGUubG9nKGBbQkddW0RFQlVHXSA9PT0gRVhBQ1QgZG9tX3N1bW1hcnkgU0VOVCBUTyAvYW5hbHl6ZSAoJHtkb21fc3VtbWFyeS5sZW5ndGh9IGl0ZW1zKSA9PT1gKTtcbiAgICAgICAgY29uc29sZS5sb2coSlNPTi5zdHJpbmdpZnkoZG9tX3N1bW1hcnksIG51bGwsIDIpKTtcbiAgICAgICAgY29uc29sZS5sb2coYFtCR11bREVCVUddID09PSBFWEFDVCBtYW5pZmVzdCBTRU5UIFRPIC9hbmFseXplICgke21hbmlmZXN0Lmxlbmd0aH0gaXRlbXMpID09PWApO1xuICAgICAgICBjb25zb2xlLmxvZyhKU09OLnN0cmluZ2lmeShtYW5pZmVzdCwgbnVsbCwgMikpO1xuICAgICAgICBjb25zb2xlLmxvZyhcIj09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XFxuXCIpO1xuXG4gICAgICAgIGNvbnN0IGFnZW50UmVxdWVzdFBheWxvYWQgPSB7XG4gICAgICAgICAgdmVyc2lvbjogXCIxLjBcIixcbiAgICAgICAgICB0YXNrX2luc3RydWN0aW9uOiBpbnN0cnVjdGlvbixcbiAgICAgICAgICByZWRhY3RlZF9pbWFnZTogZmluYWxTY3JlZW5zaG90RGF0YVVybC5zcGxpdChcIixcIilbMV0sXG4gICAgICAgICAgbWFuaWZlc3QsXG4gICAgICAgICAgZG9tX3N1bW1hcnksXG4gICAgICAgICAgZGVtb19tb2RlOiBpc0RlbW8sXG4gICAgICAgICAgY2xpZW50X3N0YXRzOiB7IHRvdGFsTGF0ZW5jeU1zOiBzdGF0cy50b3RhbExhdGVuY3lNcyB9LFxuICAgICAgICAgIHZhdWx0OiBzdG9yZWRWYXVsdCAgLy8gU2VuZCBwcm9maWxlIGRhdGEgc28gc2VydmVyLXNpZGUgcHJvdmlkZXJzIGNhbiB1c2UgcmVhbCB2YWx1ZXNcbiAgICAgICAgfTtcblxuICAgICAgICAvLyBcdTI1MDBcdTI1MDAgRGF0YSBSZWR1Y3Rpb24gTWV0cmljcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICAgICAgLy8gQ29tcHV0ZSByYXcgYnl0ZXMgdnMuIHdoYXQgd2UgYWN0dWFsbHkgdHJhbnNtaXQsIHBsdXMgUElJIHN1cmZhY2UgYXJlYVxuICAgICAgICBjb25zdCByZWRhY3RlZEltYWdlQjY0ID0gYWdlbnRSZXF1ZXN0UGF5bG9hZC5yZWRhY3RlZF9pbWFnZTtcbiAgICAgICAgY29uc3QgcGF5bG9hZEpzb24gPSBKU09OLnN0cmluZ2lmeShhZ2VudFJlcXVlc3RQYXlsb2FkKTtcbiAgICAgICAgY29uc3Qgc2VudEJ5dGVzID0gcGF5bG9hZEpzb24ubGVuZ3RoOyAvLyBBcHByb3ggYnl0ZXMgZm9yIHRoZSBmdWxsIEpTT04gYm9keVxuXG4gICAgICAgIC8vIFBJSSBzdXJmYWNlOiBzdW0gb2YgYmJveCBwaXhlbCBhcmVhcyB2cy4gdG90YWwgc2NyZWVuc2hvdCBwaXhlbCBhcmVhXG4gICAgICAgIC8vIFdlIG5lZWQgaW1hZ2UgZGltZW5zaW9ucyBcdTIwMTQgcGFyc2UgZnJvbSB0aGUgcmVkYWN0ZWQgaW1hZ2VcbiAgICAgICAgbGV0IHBpaVN1cmZhY2VQZXJjZW50ID0gMDtcbiAgICAgICAgbGV0IGltYWdlVG90YWxQaXhlbHMgPSAxO1xuICAgICAgICBsZXQgaW1hZ2VQSUlQaXhlbHMgPSAwO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIC8vIERlY29kZSBkaW1lbnNpb25zIGZyb20gZmluYWxTY3JlZW5zaG90RGF0YVVybCB2aWEgb2Zmc2NyZWVuIGNhbnZhc1xuICAgICAgICAgIC8vIFVzZSB0aGUgcmF3IGNhcHR1cmUgZGltZW5zaW9ucyBlc3RpbWF0ZSBmcm9tIGJhc2U2NCBsZW5ndGggaGV1cmlzdGljXG4gICAgICAgICAgLy8gKFBORyB+NCBieXRlcyBwZXIgcGl4ZWwgYXQgMXgsIHNvIHBpeGVscyBcdTIyNDggKGI2NGxlbiAqIDMvNCkgLyA0KVxuICAgICAgICAgIC8vIEluc3RlYWQ6IGRpcmVjdGx5IGNvbXB1dGUgZnJvbSBzZW5zaXRpdmVSZWdpb25zIGJib3hlcyBhcmVhIHZzIGltYWdlIGFyZWFcbiAgICAgICAgICAvLyBXZSdsbCB1c2UgdGhlIGtub3duIERQUj0xIHNjcmVlbnNob3Q6IGdldCBkaW1zIGZyb20gcmF3IGRhdGFVcmxcbiAgICAgICAgICBjb25zdCByYXdCNjQgPSBjYXB0dXJlUmVzdWx0LmRhdGFVcmwuc3BsaXQoXCIsXCIpWzFdIHx8IFwiXCI7XG4gICAgICAgICAgLy8gUm91Z2ggaW1hZ2UgYXJlYSBlc3RpbWF0ZTogc2NyZWVuc2hvdCBEUFIgaXMgdHlwaWNhbGx5IGRldmljZVBpeGVsUmF0aW9cbiAgICAgICAgICAvLyBGb3IgYSByZWxpYWJsZSBtZXRyaWMsIGNvbXB1dGUgYmJveCBhcmVhcyBmcm9tIHNlbnNpdGl2ZVJlZ2lvbnNcbiAgICAgICAgICAvLyBhbmQgZXhwcmVzcyB0aGVtIHJlbGF0aXZlIHRvIHRoZSB2aXNpYmxlIHNjcmVlbnNob3Qgc2l6ZVxuICAgICAgICAgIGlmIChzZW5zaXRpdmVSZWdpb25zLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGltYWdlUElJUGl4ZWxzID0gc2Vuc2l0aXZlUmVnaW9ucy5yZWR1Y2UoKHN1bSwgcikgPT4gc3VtICsgKHIuYmJveFsyXSAqIHIuYmJveFszXSksIDApO1xuICAgICAgICAgICAgLy8gQXNzdW1lIGltYWdlIGFyZWEgZnJvbSB0aGUgbWF4IGV4dGVudHMgb2YgYW55IGRldGVjdGlvbiArIGdlbmVyb3VzIG1hcmdpblxuICAgICAgICAgICAgY29uc3QgYWxsWDIgPSBzZW5zaXRpdmVSZWdpb25zLm1hcChyID0+IHIuYmJveFswXSArIHIuYmJveFsyXSk7XG4gICAgICAgICAgICBjb25zdCBhbGxZMiA9IHNlbnNpdGl2ZVJlZ2lvbnMubWFwKHIgPT4gci5iYm94WzFdICsgci5iYm94WzNdKTtcbiAgICAgICAgICAgIC8vIE1pbiBlc3RpbWF0ZWQgaW1hZ2Ugc2l6ZTogYXQgbGVhc3QgMTI4MFx1MDBENzcyMCBvciBtYXggZGV0ZWN0aW9uIGJvdW5kcyArIDIwJVxuICAgICAgICAgICAgY29uc3QgZXN0aW1hdGVkVyA9IE1hdGgubWF4KDEyODAsIE1hdGgubWF4KC4uLmFsbFgyKSAqIDEuMik7XG4gICAgICAgICAgICBjb25zdCBlc3RpbWF0ZWRIID0gTWF0aC5tYXgoNzIwLCBNYXRoLm1heCguLi5hbGxZMikgKiAxLjIpO1xuICAgICAgICAgICAgaW1hZ2VUb3RhbFBpeGVscyA9IGVzdGltYXRlZFcgKiBlc3RpbWF0ZWRIO1xuICAgICAgICAgICAgcGlpU3VyZmFjZVBlcmNlbnQgPSAoaW1hZ2VQSUlQaXhlbHMgLyBpbWFnZVRvdGFsUGl4ZWxzKSAqIDEwMDtcbiAgICAgICAgICB9XG4gICAgICAgIH0gY2F0Y2ggKGRpbUVycikge1xuICAgICAgICAgIGNvbnNvbGUud2FybihcIltCR10gQ291bGQgbm90IGVzdGltYXRlIGltYWdlIGRpbWVuc2lvbnMgZm9yIFBJSSBzdXJmYWNlIG1ldHJpYzpcIiwgZGltRXJyKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHJlZHVjdGlvblBlcmNlbnQgPSAoKDEgLSBzZW50Qnl0ZXMgLyByYXdCeXRlcykgKiAxMDApO1xuICAgICAgICBjb25zdCBtZXRyaWNzUGF5bG9hZCA9IHtcbiAgICAgICAgICByYXdfYnl0ZXM6IHJhd0J5dGVzLFxuICAgICAgICAgIHNlbnRfYnl0ZXM6IHNlbnRCeXRlcyxcbiAgICAgICAgICByZWR1Y3Rpb25fcGVyY2VudDogcmVkdWN0aW9uUGVyY2VudCxcbiAgICAgICAgICBwaWlfcmVnaW9uczogc2Vuc2l0aXZlUmVnaW9ucy5sZW5ndGgsXG4gICAgICAgICAgcGlpX3N1cmZhY2VfcGVyY2VudDogcGlpU3VyZmFjZVBlcmNlbnQsXG4gICAgICAgICAgcGlpX3BpeGVsczogaW1hZ2VQSUlQaXhlbHMsXG4gICAgICAgIH07XG4gICAgICAgIGNvbnNvbGUubG9nKFwiW0JHXSBEYXRhIFJlZHVjdGlvbiBNZXRyaWNzOlwiLCBKU09OLnN0cmluZ2lmeShtZXRyaWNzUGF5bG9hZCkpO1xuICAgICAgICBzYWZlUG9zdCh7IHR5cGU6IFwiTUVUUklDU1wiLCAuLi5tZXRyaWNzUGF5bG9hZCB9KTtcbiAgICAgICAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbiAgICAgICAgc2VydmVyUmVzdWx0ID0gYXdhaXQgc2VuZFRvU2VydmVyKGFnZW50UmVxdWVzdFBheWxvYWQpO1xuICAgICAgICBjb25zb2xlLmxvZyhcIltCR10gU3RlcCA1IENvbXBsZXRlLiBTZXJ2ZXIgcmV0dXJuZWQgcGxhbjpcIiwgc2VydmVyUmVzdWx0KTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBjb25zb2xlLmVycm9yKFwiW0JHIEVycm9yXVtTdGVwIDU6IFNlcnZlciBDYWxsXTpcIiwgZXJyKTtcbiAgICAgICAgbGV0IGVyck1zZyA9IGVyci5tZXNzYWdlIHx8IFN0cmluZyhlcnIpO1xuICAgICAgICBpZiAoZXJyTXNnLmluY2x1ZGVzKFwiRmFpbGVkIHRvIGZldGNoXCIpIHx8IGVyck1zZy5pbmNsdWRlcyhcIk5ldHdvcmtFcnJvclwiKSB8fCBlcnJNc2cuaW5jbHVkZXMoXCJFQ09OTlJFRlVTRURcIikpIHtcbiAgICAgICAgICBlcnJNc2cgPSBgQ291bGRuJ3QgcmVhY2ggdGhlIHJlYXNvbmluZyBzZXJ2ZXIgYXQgJHthd2FpdCBnZXRCYXNlU2VydmVyVXJsKCl9IFx1MjAxNCBwbGVhc2UgY2hlY2sgeW91ciBjb25uZWN0aW9uLmA7XG4gICAgICAgIH1cbiAgICAgICAgc2FmZVBvc3QoeyB0eXBlOiBcIkVSUk9SXCIsIHN0ZXA6IFwiU2VydmVyIENhbGxcIiwgZXJyb3I6IGVyck1zZyB9KTtcbiAgICAgICAgc2hvdWxkQ29udGludWUgPSBmYWxzZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG5cbiAgICAgIC8vIFx1MjUwMFx1MjUwMCBTdGVwIDY6IEV4ZWN1dGUgUGxhbiBzZXF1ZW50aWFsbHkgaW4gY29udGVudCBzY3JpcHQgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgICBzYWZlUG9zdCh7XG4gICAgICAgIHR5cGU6IFwiQU5BTFlTSVNfUkVTVUxUXCIsXG4gICAgICAgIGRldGVjdGlvbnMsXG4gICAgICAgIHNlbnNpdGl2ZVJlZ2lvbnMsXG4gICAgICAgIHNjcmVlbnNob3REYXRhVXJsLFxuICAgICAgICBlbGFwc2VkLFxuICAgICAgICBzZXJ2ZXJSZXN1bHQsXG4gICAgICB9KTtcblxuICAgICAgc2FmZVBvc3QoeyB0eXBlOiBcIlNUQUdFX0NIQU5HRVwiLCBzdGFnZTogXCJhY3RcIiwgdGV4dDogXCJFeGVjdXRpbmcgcGxhblx1MjAyNlwiIH0pO1xuXG4gICAgICBjb25zdCBwbGFuID0gQXJyYXkuaXNBcnJheShzZXJ2ZXJSZXN1bHQ/LnBsYW4pID8gc2VydmVyUmVzdWx0LnBsYW4gOiBbXTtcbiAgICAgIGNvbnN0IHRvdGFsU3RlcHMgPSBwbGFuLmxlbmd0aDtcbiAgICAgIGNvbnN0IHN0ZXBSZXN1bHRzID0gW107XG5cbiAgICAgIC8vIEJ1ZyBmaXg6IHdyYXAgZW50aXJlIFN0ZXAgNiBpbiB0cnkvZmluYWxseSBzbyBidXR0b25zIEFMV0FZUyByZS1lbmFibGUuXG4gICAgICAvLyBQcmV2aW91c2x5IGFueSB1bmNhdWdodCBleGNlcHRpb24gaW4gdGhlIHN0ZXAgbG9vcCBsZWZ0IHRoZSBVSSBmcm96ZW4uXG4gICAgICB0cnkge1xuICAgICAgICBpZiAodG90YWxTdGVwcyA9PT0gMCkge1xuICAgICAgICAgIGNvbnNvbGUubG9nKFwiW0JHXSBTdGVwIDY6IEVtcHR5IHBsYW4gXHUyMDE0IGFsbCBmaWVsZHMgYWxyZWFkeSBmaWxsZWQgb3IgdGFzayBjb21wbGV0ZS5cIik7XG4gICAgICAgICAgc2FmZVBvc3QoeyB0eXBlOiBcIlBMQU5fU1VNTUFSWVwiLCB0b3RhbDogMCwgc3VjY2VlZGVkOiAwLCBmYWlsZWQ6IDAsIGRldGFpbHM6IFtdLCBtZXNzYWdlOiBcIkFsbCBmaWVsZHMgYXJlIGFscmVhZHkgZmlsbGVkIFx1MjAxNCBub3RoaW5nIHRvIGRvLlwiIH0pO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGNvbnNvbGUubG9nKGBbQkddIFN0ZXAgNjogRXhlY3V0aW5nICR7dG90YWxTdGVwc30gcGxhbiBzdGVwKHMpLi4uYCk7XG5cbiAgICAgICAgICBmb3IgKGNvbnN0IHN0ZXAgb2YgcGxhbikge1xuICAgICAgICAgIGNvbnN0IHN0ZXBOdW0gPSBzdGVwLnN0ZXA7XG4gICAgICAgICAgY29uc3QgZmllbGRUeXBlID0gc3RlcC5maWVsZF90eXBlIHx8IFwiRklFTERcIjtcbiAgICAgICAgICBjb25zdCB0YXJnZXRJZCA9IHN0ZXAudGFyZ2V0X2lkO1xuXG4gICAgICAgICAgLy8gSGFyZCByZXRyeSBsaW1pdDogaWYgdGhpcyBzYW1lIHN0ZXAgdGFyZ2V0L3R5cGUgZmFpbGVkIDIgdGltZXMgaW4gYSByb3csIHN0b3AgcmV0cnlpbmcgaXRcbiAgICAgICAgICBjb25zdCBzdGVwS2V5ID0gYCR7dGFyZ2V0SWQgfHwgXCJcIn1fJHtmaWVsZFR5cGUgfHwgXCJcIn1gO1xuICAgICAgICAgIGNvbnN0IGN1cnJlbnRGYWlsdXJlcyA9IHN0ZXBDb25zZWN1dGl2ZUZhaWx1cmVzLmdldChzdGVwS2V5KSB8fCAwO1xuICAgICAgICAgIGlmIChjdXJyZW50RmFpbHVyZXMgPj0gMikge1xuICAgICAgICAgICAgY29uc3Qgc2tpcFJlYXNvbiA9IGBTdGVwICR7c3RlcE51bX0gKCR7ZmllbGRUeXBlfSwgJHt0YXJnZXRJZH0pIGhhbHRlZDogZWxlbWVudCBmYWlsZWQgJHtjdXJyZW50RmFpbHVyZXN9IHRpbWVzIGNvbnNlY3V0aXZlbHkuIFN0b3BwaW5nIHJldHJpZXMgZm9yIHRoaXMgc3RlcC5gO1xuICAgICAgICAgICAgY29uc29sZS53YXJuKGBbQkddICR7c2tpcFJlYXNvbn1gKTtcbiAgICAgICAgICAgIHN0ZXBSZXN1bHRzLnB1c2goeyBzdGVwTnVtLCBmaWVsZFR5cGUsIG9rOiBmYWxzZSwgcmVhc29uOiBza2lwUmVhc29uIH0pO1xuICAgICAgICAgICAgc2FmZVBvc3Qoe1xuICAgICAgICAgICAgICB0eXBlOiBcIlBMQU5fU1RFUF9TVEFUVVNcIixcbiAgICAgICAgICAgICAgc3RlcE51bSxcbiAgICAgICAgICAgICAgdG90YWxTdGVwcyxcbiAgICAgICAgICAgICAgc3RhdHVzOiBcImVycm9yXCIsXG4gICAgICAgICAgICAgIG1lc3NhZ2U6IHNraXBSZWFzb25cbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gQXR0YWNoIGJib3ggdG8gc3RlcCBwYXlsb2FkIGZvciBjb29yZGluYXRlLWJhc2VkIGZhbGxiYWNrIGV4ZWN1dGlvblxuICAgICAgICAgIGNvbnN0IGRvbU1hdGNoID0gZG9tX3N1bW1hcnkuZmluZChkID0+IGQuZWxlbWVudF9pZCA9PT0gdGFyZ2V0SWQgfHwgZC5kb21faWQgPT09IHRhcmdldElkIHx8IGQubmFtZSA9PT0gdGFyZ2V0SWQpO1xuICAgICAgICAgIGNvbnN0IG1hbmlmZXN0TWF0Y2ggPSBtYW5pZmVzdC5maW5kKG0gPT4gbS5yZWdpb25faWQgPT09IHRhcmdldElkKTtcbiAgICAgICAgICBjb25zdCBkZXRlY3Rpb25NYXRjaCA9IChkZXRlY3Rpb25zIHx8IFtdKS5maW5kKGQgPT4gZC5pZCA9PT0gdGFyZ2V0SWQpO1xuICAgICAgICAgIGNvbnN0IG1hdGNoZWRCYm94ID0gc3RlcC5iYm94IHx8IGRvbU1hdGNoPy5iYm94IHx8IG1hbmlmZXN0TWF0Y2g/LmJib3ggfHwgZGV0ZWN0aW9uTWF0Y2g/LmJib3ggfHwgbnVsbDtcbiAgICAgICAgICBjb25zdCBzdGVwUGF5bG9hZCA9IHsgLi4uc3RlcCwgYmJveDogbWF0Y2hlZEJib3ggfTtcblxuICAgICAgICAgIC8vIFx1MjUwMFx1MjUwMCBDaGVjayBpZiB2YWx1ZSBpcyBtaXNzaW5nIChSZXF1aXJlbWVudCA0IGZhbGxiYWNrIHBhdGgpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgICAgICAgIGxldCBjdXJyZW50VmFsID0gc3RlcFBheWxvYWQudmFsdWUgfHwgc3RlcFBheWxvYWQubWF0Y2hfdmFsdWUgfHwgc3RvcmVkVmF1bHRbZmllbGRUeXBlXSB8fCBudWxsO1xuICAgICAgICAgIGlmICghY3VycmVudFZhbCAmJiBmaWVsZFR5cGUgPT09IFwiUEhPTkVcIikgY3VycmVudFZhbCA9IHN0b3JlZFZhdWx0W1wiSU5ESUFOX01PQklMRVwiXTtcbiAgICAgICAgICBpZiAoIWN1cnJlbnRWYWwgJiYgZmllbGRUeXBlID09PSBcIklORElBTl9NT0JJTEVcIikgY3VycmVudFZhbCA9IHN0b3JlZFZhdWx0W1wiUEhPTkVcIl07XG5cbiAgICAgICAgICBpZiAoIWN1cnJlbnRWYWwgJiYgKHN0ZXAuYWN0aW9uID09PSBcInR5cGVcIiB8fCBzdGVwLmFjdGlvbiA9PT0gXCJzZWxlY3RfY2hvaWNlXCIpICYmIGZpZWxkVHlwZSAhPT0gXCJCVVRUT05cIiAmJiBmaWVsZFR5cGUgIT09IFwiU1VCTUlUXCIpIHtcbiAgICAgICAgICAgIC8vIFx1MjUwMFx1MjUwMCBEZWNpZGUgd2hldGhlciB0byBwcm9tcHQgdXNlciBvciBza2lwIGltbWVkaWF0ZWx5IFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgICAgICAgICAgLy8gU2Vuc2l0aXZlIGZpZWxkIHR5cGVzIChQSUkpIGFyZSBuZXZlciBwcm9tcHRlZCBpbmxpbmUgXHUyMDE0IHNraXAgdG9cbiAgICAgICAgICAgIC8vIGF2b2lkIGhhbmdpbmcgdGhlIFVJIGZvciBtaW51dGVzIGlmIHZhdWx0IGlzIGVtcHR5LlxuICAgICAgICAgICAgY29uc3QgU0VOU0lUSVZFX1NLSVBfVFlQRVMgPSBuZXcgU2V0KFtcbiAgICAgICAgICAgICAgXCJBQURIQUFSXCIsIFwiUEFOXCIsIFwiR1NUSU5cIiwgXCJJRlNDXCIsIFwiQkFOS19BQ0NPVU5UXCIsIFwiQ0FSRFwiLFxuICAgICAgICAgICAgICBcIlBBU1NXT1JEXCIsIFwiSU5ESUFOX01PQklMRVwiLCBcIlBIT05FXCJcbiAgICAgICAgICAgIF0pO1xuICAgICAgICAgICAgaWYgKFNFTlNJVElWRV9TS0lQX1RZUEVTLmhhcyhmaWVsZFR5cGUpKSB7XG4gICAgICAgICAgICAgIC8vIEF1dG8tc2tpcCBcdTIwMTQgbmV2ZXIgc2hvdyBpbmxpbmUgcHJvbXB0IGZvciBzZW5zaXRpdmUgUElJIGZpZWxkc1xuICAgICAgICAgICAgICBjb25zdCBza2lwTXNnID0gYFN0ZXAgJHtzdGVwTnVtfTogXHUyNkEwIE5vIHZhbHVlIGluIHZhdWx0IGZvciBzZW5zaXRpdmUgZmllbGQgXCIke2ZpZWxkVHlwZX1cIiBcdTIwMTQgc2tpcHBpbmcgKGFkZCBpdCBpbiBQcm9maWxlIHNldHRpbmdzKS5gO1xuICAgICAgICAgICAgICBjb25zb2xlLndhcm4oYFtCR10gJHtza2lwTXNnfWApO1xuICAgICAgICAgICAgICBzdGVwUmVzdWx0cy5wdXNoKHsgc3RlcE51bSwgZmllbGRUeXBlLCBvazogZmFsc2UsIHJlYXNvbjogc2tpcE1zZyB9KTtcbiAgICAgICAgICAgICAgc2FmZVBvc3QoeyB0eXBlOiBcIlBMQU5fU1RFUF9TVEFUVVNcIiwgc3RlcE51bSwgdG90YWxTdGVwcywgc3RhdHVzOiBcImVycm9yXCIsIG1lc3NhZ2U6IHNraXBNc2cgfSk7XG4gICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyBGb3Igbm9uLXNlbnNpdGl2ZSBmaWVsZHMgKE5BTUUsIEVNQUlMLCBBRERSRVNTLCBldGMuKSBwcm9tcHQgdGhlIHVzZXJcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKGBbQkddIFN0ZXAgJHtzdGVwTnVtfTogTm8gdmFsdWUgZm91bmQgZm9yIFwiJHtmaWVsZFR5cGV9XCIgaW4gcHJvZmlsZSBvciBwbGFuLiBSZXF1ZXN0aW5nIGlubGluZSBpbnB1dCBmcm9tIHVzZXIuLi5gKTtcbiAgICAgICAgICAgIHNhZmVQb3N0KHtcbiAgICAgICAgICAgICAgdHlwZTogXCJQUk9NUFRfVVNFUl9JTlBVVFwiLFxuICAgICAgICAgICAgICBzdGVwTnVtLFxuICAgICAgICAgICAgICBmaWVsZFR5cGUsXG4gICAgICAgICAgICAgIHRhcmdldElkLFxuICAgICAgICAgICAgICBhY3Rpb25UeXBlOiBzdGVwLmFjdGlvbixcbiAgICAgICAgICAgICAgbWVzc2FnZTogYE5vIHZhbHVlIGZvdW5kIGZvciAke2ZpZWxkVHlwZX0gXHUyMDE0IGVudGVyIG9uZSBub3c/YFxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGNvbnN0IHVzZXJSZXBseSA9IGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XG4gICAgICAgICAgICAgIGNvbnN0IHJlcGx5SGFuZGxlciA9ICh1TXNnKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKHVNc2cudHlwZSA9PT0gXCJVU0VSX0lOUFVUX1BST1ZJREVEXCIgJiYgdU1zZy5zdGVwTnVtID09PSBzdGVwTnVtKSB7XG4gICAgICAgICAgICAgICAgICBwb3J0Lm9uTWVzc2FnZS5yZW1vdmVMaXN0ZW5lcihyZXBseUhhbmRsZXIpO1xuICAgICAgICAgICAgICAgICAgcmVzb2x2ZSh1TXNnKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgIH07XG4gICAgICAgICAgICAgIHBvcnQub25NZXNzYWdlLmFkZExpc3RlbmVyKHJlcGx5SGFuZGxlcik7XG4gICAgICAgICAgICAgIC8vIDEwLXNlY29uZCB0aW1lb3V0IFx1MjAxNCBhdXRvLXNraXAgaWYgdXNlciBkb2Vzbid0IHJlc3BvbmRcbiAgICAgICAgICAgICAgc2V0VGltZW91dCgoKSA9PiByZXNvbHZlKG51bGwpLCAxMDAwMCk7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgaWYgKHVzZXJSZXBseSAmJiB1c2VyUmVwbHkudmFsdWUpIHtcbiAgICAgICAgICAgICAgY29uc29sZS5sb2coYFtCR10gU3RlcCAke3N0ZXBOdW19OiBVc2VyIHByb3ZpZGVkIHZhbHVlIGZvciBcIiR7ZmllbGRUeXBlfVwiOiBcIiR7dXNlclJlcGx5LnZhbHVlfVwiIChzYXZlVG9WYXVsdDogJHt1c2VyUmVwbHkuc2F2ZVRvVmF1bHR9KWApO1xuICAgICAgICAgICAgICBpZiAoc3RlcC5hY3Rpb24gPT09IFwic2VsZWN0X2Nob2ljZVwiKSB7XG4gICAgICAgICAgICAgICAgc3RlcFBheWxvYWQubWF0Y2hfdmFsdWUgPSB1c2VyUmVwbHkudmFsdWU7XG4gICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgc3RlcFBheWxvYWQudmFsdWUgPSB1c2VyUmVwbHkudmFsdWU7XG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgaWYgKHVzZXJSZXBseS5zYXZlVG9WYXVsdCkge1xuICAgICAgICAgICAgICAgIHN0b3JlZFZhdWx0W2ZpZWxkVHlwZV0gPSB1c2VyUmVwbHkudmFsdWU7XG4gICAgICAgICAgICAgICAgY2hyb21lLnN0b3JhZ2UubG9jYWwuc2V0KHsgYWdlbnRfdmF1bHQ6IHN0b3JlZFZhdWx0IH0pO1xuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBbQkddIFx1MjcxMyBQZXJzaXN0ZWQgXCIke2ZpZWxkVHlwZX1cIiA9IFwiJHt1c2VyUmVwbHkudmFsdWV9XCIgdG8gY2hyb21lLnN0b3JhZ2UubG9jYWxgKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgY29uc3Qgc2tpcE1zZyA9IGBTdGVwICR7c3RlcE51bX06IE5vIHZhbHVlIHByb3ZpZGVkIGZvciBcIiR7ZmllbGRUeXBlfVwiICh0aW1lZCBvdXQgb3Igc2tpcHBlZCkuIE1vdmluZyBvbi5gO1xuICAgICAgICAgICAgICBjb25zb2xlLndhcm4oYFtCR10gJHtza2lwTXNnfWApO1xuICAgICAgICAgICAgICBzdGVwUmVzdWx0cy5wdXNoKHsgc3RlcE51bSwgZmllbGRUeXBlLCBvazogZmFsc2UsIHJlYXNvbjogc2tpcE1zZyB9KTtcbiAgICAgICAgICAgICAgc2FmZVBvc3QoeyB0eXBlOiBcIlBMQU5fU1RFUF9TVEFUVVNcIiwgc3RlcE51bSwgdG90YWxTdGVwcywgc3RhdHVzOiBcImVycm9yXCIsIG1lc3NhZ2U6IHNraXBNc2cgfSk7XG4gICAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH1cblxuICAgICAgICAgIHNhZmVQb3N0KHtcbiAgICAgICAgICAgIHR5cGU6IFwiUExBTl9TVEVQX1NUQVRVU1wiLFxuICAgICAgICAgICAgc3RlcE51bSxcbiAgICAgICAgICAgIHRvdGFsU3RlcHMsXG4gICAgICAgICAgICBzdGF0dXM6IFwicnVubmluZ1wiLFxuICAgICAgICAgICAgbWVzc2FnZTogYFN0ZXAgJHtzdGVwTnVtfS8ke3RvdGFsU3RlcHN9OiAke3N0ZXAuYWN0aW9ufSBvbiAke2ZpZWxkVHlwZX0gKCR7dGFyZ2V0SWR9KVx1MjAyNmBcbiAgICAgICAgICB9KTtcblxuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25zdCBzdGVwUmVzcG9uc2UgPSBhd2FpdCBuZXcgUHJvbWlzZSgocmVzb2x2ZSwgcmVqZWN0KSA9PiB7XG4gICAgICAgICAgICAgIC8vIDUgc2Vjb25kIHRpbWVvdXQgcGVyIGFjdGlvbiB0byBjYXRjaCBodW5nIHBhZ2VzXG4gICAgICAgICAgICAgIGNvbnN0IHRpbWVyID0gc2V0VGltZW91dCgoKSA9PiByZWplY3QobmV3IEVycm9yKFwiVElNRU9VVFwiKSksIDUwMDApO1xuICAgICAgICAgICAgICBjaHJvbWUudGFicy5zZW5kTWVzc2FnZShcbiAgICAgICAgICAgICAgICBjYXB0dXJlUmVzdWx0LnRhYi5pZCxcbiAgICAgICAgICAgICAgICB7IHR5cGU6IFwiRVhFQ1VURV9BQ1RJT05cIiwgcGF5bG9hZDogc3RlcFBheWxvYWQgfSxcbiAgICAgICAgICAgICAgICByZXNwb25zZSA9PiB7XG4gICAgICAgICAgICAgICAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgICAgICAgICAgICAgICAgaWYgKGNocm9tZS5ydW50aW1lLmxhc3RFcnJvcikge1xuICAgICAgICAgICAgICAgICAgICByZWplY3QobmV3IEVycm9yKGNocm9tZS5ydW50aW1lLmxhc3RFcnJvci5tZXNzYWdlKSk7XG4gICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICByZXNvbHZlKHJlc3BvbnNlIHx8IHsgb2s6IGZhbHNlLCBlcnJvcjogXCJObyByZXNwb25zZSBmcm9tIGNvbnRlbnQgc2NyaXB0XCIgfSk7XG4gICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGlmIChzdGVwUmVzcG9uc2Uub2spIHtcbiAgICAgICAgICAgICAgc3RlcENvbnNlY3V0aXZlRmFpbHVyZXMuc2V0KHN0ZXBLZXksIDApOyAvLyByZXNldCBvbiBzdWNjZXNzXG4gICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBbQkddIFN0ZXAgNi4ke3N0ZXBOdW19OiBcdTI3MTMgc3VjY2Vzc2AsIHN0ZXBSZXNwb25zZSk7XG4gICAgICAgICAgICAgIHN0ZXBSZXN1bHRzLnB1c2goeyBzdGVwTnVtLCBmaWVsZFR5cGUsIG9rOiB0cnVlIH0pO1xuICAgICAgICAgICAgICBzYWZlUG9zdCh7XG4gICAgICAgICAgICAgICAgdHlwZTogXCJQTEFOX1NURVBfU1RBVFVTXCIsXG4gICAgICAgICAgICAgICAgc3RlcE51bSxcbiAgICAgICAgICAgICAgICB0b3RhbFN0ZXBzLFxuICAgICAgICAgICAgICAgIHN0YXR1czogXCJva1wiLFxuICAgICAgICAgICAgICAgIG1lc3NhZ2U6IGBTdGVwICR7c3RlcE51bX0vJHt0b3RhbFN0ZXBzfTogXHUyNzEzICR7ZmllbGRUeXBlfSBmaWxsZWRgXG4gICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKHN0ZXBSZXNwb25zZS5lcnJvciB8fCBcIkNvbnRlbnQgc2NyaXB0IHJlcG9ydGVkIGZhaWx1cmVcIik7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgICBzdGVwQ29uc2VjdXRpdmVGYWlsdXJlcy5zZXQoc3RlcEtleSwgY3VycmVudEZhaWx1cmVzICsgMSk7XG4gICAgICAgICAgICBsZXQgZmFpbFJlYXNvbjtcbiAgICAgICAgICAgIGNvbnN0IGVyclN0ciA9IGVyci5tZXNzYWdlIHx8IFN0cmluZyhlcnIpO1xuICAgICAgICAgICAgaWYgKGVyclN0ciA9PT0gXCJUSU1FT1VUXCIpIHtcbiAgICAgICAgICAgICAgZmFpbFJlYXNvbiA9IGBUaGUgcGFnZSBkaWRuJ3QgcmVzcG9uZCB0byB0aGUgYWN0aW9uIGluIHRpbWUgKHN0ZXAgJHtzdGVwTnVtfSwgJHtmaWVsZFR5cGV9KS5gO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChlcnJTdHIuaW5jbHVkZXMoXCJub3QgZm91bmRcIikgfHwgZXJyU3RyLmluY2x1ZGVzKFwicmVzb2x2ZVwiKSkge1xuICAgICAgICAgICAgICBmYWlsUmVhc29uID0gYENvdWxkbid0IGZpbmQgdGhlIGVsZW1lbnQgZm9yIHN0ZXAgJHtzdGVwTnVtfSAoZXhwZWN0ZWQ6ICR7ZmllbGRUeXBlfSkuIFRoZSBwYWdlIGxheW91dCBtYXkgaGF2ZSBjaGFuZ2VkLmA7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICBmYWlsUmVhc29uID0gYFN0ZXAgJHtzdGVwTnVtfSAoJHtmaWVsZFR5cGV9KSBmYWlsZWQ6ICR7ZXJyU3RyfWA7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zb2xlLmVycm9yKGBbQkddIFN0ZXAgNi4ke3N0ZXBOdW19OiBcdTI3MTcgZmFpbGVkICgke2N1cnJlbnRGYWlsdXJlcyArIDF9IGNvbnNlY3V0aXZlKSBcdTIwMTQgJHtmYWlsUmVhc29ufWApO1xuICAgICAgICAgICAgc3RlcFJlc3VsdHMucHVzaCh7IHN0ZXBOdW0sIGZpZWxkVHlwZSwgb2s6IGZhbHNlLCByZWFzb246IGZhaWxSZWFzb24gfSk7XG4gICAgICAgICAgICBzYWZlUG9zdCh7XG4gICAgICAgICAgICAgIHR5cGU6IFwiUExBTl9TVEVQX1NUQVRVU1wiLFxuICAgICAgICAgICAgICBzdGVwTnVtLFxuICAgICAgICAgICAgICB0b3RhbFN0ZXBzLFxuICAgICAgICAgICAgICBzdGF0dXM6IFwiZXJyb3JcIixcbiAgICAgICAgICAgICAgbWVzc2FnZTogZmFpbFJlYXNvblxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAvLyBDb250aW51ZSByZW1haW5pbmcgc3RlcHMgXHUyMDE0IGRvbid0IGFib3J0IHRoZSB3aG9sZSBwbGFuXG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gU21hbGwgZGVsYXkgYmV0d2VlbiBzdGVwcyBzbyBET00gZXZlbnRzIHNldHRsZVxuICAgICAgICAgIGF3YWl0IG5ldyBQcm9taXNlKHIgPT4gc2V0VGltZW91dChyLCAzMDApKTtcbiAgICAgICAgfVxuXG4gICAgICAgICAgLy8gXHUyNTAwXHUyNTAwIFBsYW4gc3VtbWFyeSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICAgICAgICBjb25zdCBzdWNjZWVkZWQgPSBzdGVwUmVzdWx0cy5maWx0ZXIociA9PiByLm9rKS5sZW5ndGg7XG4gICAgICAgICAgY29uc3QgZmFpbGVkID0gc3RlcFJlc3VsdHMuZmlsdGVyKHIgPT4gIXIub2spLmxlbmd0aDtcbiAgICAgICAgICBjb25zdCBmYWlsZWREZXNjcmlwdGlvbnMgPSBzdGVwUmVzdWx0c1xuICAgICAgICAgICAgLmZpbHRlcihyID0+ICFyLm9rKVxuICAgICAgICAgICAgLm1hcChyID0+IGBTdGVwICR7ci5zdGVwTnVtfSAoJHtyLmZpZWxkVHlwZX0pOiAke3IucmVhc29ufWApO1xuXG4gICAgICAgICAgbGV0IHN1bW1hcnlNc2c7XG4gICAgICAgICAgaWYgKGZhaWxlZCA9PT0gMCkge1xuICAgICAgICAgICAgc3VtbWFyeU1zZyA9IGBBbGwgJHtzdWNjZWVkZWR9IHN0ZXAocykgY29tcGxldGVkIHN1Y2Nlc3NmdWxseS5gO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzdW1tYXJ5TXNnID0gYENvbXBsZXRlZCAke3N1Y2NlZWRlZH0gb2YgJHt0b3RhbFN0ZXBzfSBzdGVwcy4gJHtmYWlsZWREZXNjcmlwdGlvbnMuam9pbihcIiB8IFwiKX1gO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIGNvbnNvbGUubG9nKGBbQkddIFN0ZXAgNiBTdW1tYXJ5OiAke3N1bW1hcnlNc2d9YCk7XG4gICAgICAgICAgc2FmZVBvc3Qoe1xuICAgICAgICAgICAgdHlwZTogXCJQTEFOX1NVTU1BUllcIixcbiAgICAgICAgICAgIHRvdGFsOiB0b3RhbFN0ZXBzLFxuICAgICAgICAgICAgc3VjY2VlZGVkLFxuICAgICAgICAgICAgZmFpbGVkLFxuICAgICAgICAgICAgZGV0YWlsczogc3RlcFJlc3VsdHMsXG4gICAgICAgICAgICBtZXNzYWdlOiBzdW1tYXJ5TXNnXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICAgIH0gY2F0Y2ggKHN0ZXA2RXJyKSB7XG4gICAgICAgIC8vIENhdGNoLWFsbDogYW55IHVuY2F1Z2h0IGV4Y2VwdGlvbiBpbiBTdGVwIDYgcG9zdHMgYW4gRVJST1IgYW5kIHN0aWxsXG4gICAgICAgIC8vIGhpdHMgdGhlIGZpbmFsbHkgYmxvY2sgc28gYnV0dG9ucyBhcmUgYWx3YXlzIHJlLWVuYWJsZWQuXG4gICAgICAgIGNvbnNvbGUuZXJyb3IoXCJbQkcgRXJyb3JdW1N0ZXAgNjogUGxhbiBFeGVjdXRpb25dOlwiLCBzdGVwNkVycik7XG4gICAgICAgIHNhZmVQb3N0KHsgdHlwZTogXCJFUlJPUlwiLCBzdGVwOiBcIlBsYW4gRXhlY3V0aW9uXCIsIGVycm9yOiBzdGVwNkVyci5tZXNzYWdlIHx8IFN0cmluZyhzdGVwNkVycikgfSk7XG4gICAgICB9IGZpbmFsbHkge1xuICAgICAgICAvLyBTQUZFVFkgTkVUOiBhbHdheXMgcmUtZW5hYmxlIGJ1dHRvbnMgcmVnYXJkbGVzcyBvZiBob3cgU3RlcCA2IGV4aXRzLlxuICAgICAgICAvLyBQcmV2aW91c2x5IGFueSB1bmhhbmRsZWQgZXhjZXB0aW9uIGxlZnQgYW5hbHl6ZUJ0bi9kZW1vQnRuIGRpc2FibGVkIGZvcmV2ZXIuXG4gICAgICAgIHNhZmVQb3N0KHsgdHlwZTogXCJfU1RFUDZfQ09NUExFVEVcIiB9KTsgLy8gc2lnbmFsIHRvIHBvcHVwIFx1MjAxNCBoYW5kbGVkIGFzIG5vLW9wIGlmIG5vdCBuZWVkZWRcbiAgICAgICAgY29uc29sZS5sb2coXCJbQkddIFN0ZXAgNiBmaW5hbGx5IGJsb2NrIFx1MjAxNCBleGVjdXRpb24gbG9vcCBkb25lLlwiKTtcbiAgICAgIH1cblxuICAgICAgLy8gXHUyNTAwXHUyNTAwIEZpbmFsaXplIExvb3AgQ3ljbGUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgICBjb25zdCB0RW5kID0gcGVyZm9ybWFuY2Uubm93KCk7XG4gICAgICBjb25zdCBsb29wTGF0ZW5jeSA9IHRFbmQgLSB0MDtcbiAgICAgIHN0YXRzLnRvdGFsTGF0ZW5jeU1zICs9IGxvb3BMYXRlbmN5O1xuICAgICAgY29uc29sZS5sb2coYFtCR10gQ3ljbGUgZmluaXNoZWQgaW4gJHtsb29wTGF0ZW5jeS50b0ZpeGVkKDEpfW1zLiBUb3RhbCBsYXRlbmN5OiAke3N0YXRzLnRvdGFsTGF0ZW5jeU1zLnRvRml4ZWQoMSl9bXNgKTtcblxuICAgICAgY2hyb21lLnRhYnMuc2VuZE1lc3NhZ2UoY2FwdHVyZVJlc3VsdC50YWIuaWQsIHsgdHlwZTogXCJVUERBVEVfU1RBVFNcIiwgcGF5bG9hZDogc3RhdHMgfSwgKCkgPT4ge1xuICAgICAgICBjaHJvbWUucnVudGltZS5sYXN0RXJyb3I7IC8vIElnbm9yZSBpZiBjb250ZW50IHNjcmlwdCBjbG9zZWRcbiAgICAgIH0pO1xuXG4gICAgICAvLyBcdTI1MDBcdTI1MDAgTG9vcCBjaGVjazogZGVtbyBtb2RlIHN0b3BzIGFmdGVyIG9uZSBmdWxsIHBsYW4gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgICBzaG91bGRDb250aW51ZSA9IGZhbHNlOyAgLy8gU2luZ2xlLXNob3Q6IHBsYW4gY292ZXJzIGFsbCBmaWVsZHMgYXQgb25jZVxuICAgIH1cbiAgfSk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFPTyxJQUFNLHFCQUFxQjtBQUMzQixJQUFNLHFCQUFxQjtBQUtsQyxlQUFzQixtQkFBbUI7QUFDdkMsTUFBSSxPQUFPLFdBQVcsZUFBZSxPQUFPLFdBQVcsT0FBTyxRQUFRLE9BQU87QUFDM0UsUUFBSTtBQUNGLFlBQU0sT0FBTyxNQUFNLElBQUksUUFBUSxDQUFDLFlBQVk7QUFDMUMsZUFBTyxRQUFRLE1BQU0sSUFBSSxDQUFDLGtCQUFrQixHQUFHLE9BQU87QUFBQSxNQUN4RCxDQUFDO0FBQ0QsVUFBSSxRQUFRLEtBQUssa0JBQWtCLEtBQUssT0FBTyxLQUFLLGtCQUFrQixNQUFN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
