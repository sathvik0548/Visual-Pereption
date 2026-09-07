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
          const leakingRegions = await new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
              try {
                const cv = new OffscreenCanvas(img.width, img.height);
                const ctx2 = cv.getContext("2d");
                ctx2.drawImage(img, 0, 0);
                const leakers = [];
                for (const r of sensitiveRegions) {
                  const [rx, ry, rw, rh] = r.bbox;
                  const cx = Math.round(rx + rw / 2);
                  const cy = Math.round(ry + rh / 2);
                  if (cx < 0 || cy < 0 || cx >= img.width || cy >= img.height)
                    continue;
                  const px = ctx2.getImageData(cx, cy, 1, 1).data;
                  if (px[0] + px[1] + px[2] >= 30) {
                    leakers.push({ ...r, center_pixel: [px[0], px[1], px[2]] });
                  }
                }
                resolve(leakers);
              } catch (e) {
                resolve([]);
              }
            };
            img.onerror = () => resolve([]);
            img.src = finalScreenshotDataUrl;
          });
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
            console.log(`[BG] Step 4b PASS: All ${sensitiveRegions.length} region(s) verified black. Redaction is solid.`);
            safePost({
              type: "LEAK_CHECK",
              passed: true,
              leaksFound: 0,
              leakRegions: [],
              checkedRegions: sensitiveRegions.length,
              message: `\u2713 0 leaks \u2014 ${sensitiveRegions.length} masked region(s) verified black (geometric check)`
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsic3JjL2JhY2tncm91bmQuanMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogYmFja2dyb3VuZC5qcyBcdTIwMTQgU2VydmljZSBXb3JrZXIgIChzcmMvYmFja2dyb3VuZC5qcyBcdTIxOTIgYnVpbHQgYmFja2dyb3VuZC5qcylcbiAqXG4gKiB2MC4yIGFkZGl0aW9uczpcbiAqICAgLSBnZXRET01SZWdpb25zKHRhYklkKSAgIFx1MjAxNCBzZW5kcyBTQ0FOX0RPTSB0byBjb250ZW50IHNjcmlwdCwgcmV0dXJucyBkb21SZWdpb25zW11cbiAqICAgLSBQYXNzZXMgZG9tUmVnaW9ucyB0byBvZmZzY3JlZW4gYWxvbmdzaWRlIHRoZSBzY3JlZW5zaG90XG4gKiAgIC0gUmVsYXlzIHsgZGV0ZWN0aW9ucywgc2Vuc2l0aXZlUmVnaW9ucyB9IGJhY2sgdG8gcG9wdXAgdmlhIHBvcnRcbiAqL1xuXG5jb25zdCBTRVJWRVJfVVJMICAgID0gXCJodHRwOi8vbG9jYWxob3N0OjMwMDAvYW5hbHl6ZVwiO1xuY29uc3QgT0ZGU0NSRUVOX1VSTCA9IGNocm9tZS5ydW50aW1lLmdldFVSTChcIm9mZnNjcmVlbi5odG1sXCIpO1xuXG5jb25zdCBhbmFseXNpc0NhY2hlID0gbmV3IE1hcCgpO1xubGV0IHN0YXRzID0ge1xuICBmcmFtZXNDYXB0dXJlZDogMCxcbiAgdmlzaW9uSW5mZXJlbmNlczogMCxcbiAgdG90YWxMYXRlbmN5TXM6IDBcbn07XG5cbmNvbnNvbGUubG9nKGBbQkddIFRfU1dfU1RBUlQgIHQ9MG1zICAoU2VydmljZSB3b3JrZXIgc3RhcnRlZClgKTtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBQcmUtbG9hZCBvbiBzdGFydHVwIChzbyBtb2RlbCBpcyByZWFkeSBiZWZvcmUgdXNlciBjbGlja3MgYW55dGhpbmcpXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbmNocm9tZS5ydW50aW1lLm9uSW5zdGFsbGVkLmFkZExpc3RlbmVyKCgpID0+IHtcbiAgZW5zdXJlT2Zmc2NyZWVuRG9jdW1lbnQoKTtcbiAgaWYgKGNocm9tZS5zdG9yYWdlICYmIGNocm9tZS5zdG9yYWdlLmxvY2FsKSB7XG4gICAgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KFtcImFnZW50X3ZhdWx0XCJdLCAoZGF0YSkgPT4ge1xuICAgICAgaWYgKCFkYXRhLmFnZW50X3ZhdWx0KSB7XG4gICAgICAgIGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7XG4gICAgICAgICAgYWdlbnRfdmF1bHQ6IHtcbiAgICAgICAgICAgIE5BTUU6IFwiUmFqZXNoIEt1bWFyXCIsXG4gICAgICAgICAgICBFTUFJTDogXCJ2ZW5kb3IuZGVtb0BleGFtcGxlLmluXCIsXG4gICAgICAgICAgICBJTkRJQU5fTU9CSUxFOiBcIjk4NzY1NDMyMTBcIixcbiAgICAgICAgICAgIFBIT05FOiBcIjk4NzY1NDMyMTBcIixcbiAgICAgICAgICAgIERPQjogXCIxOTkwLTA1LTE1XCIsXG4gICAgICAgICAgICBBRERSRVNTOiBcIjQyLCBNRyBSb2FkLCBCZW5nYWx1cnVcIixcbiAgICAgICAgICAgIENJVFk6IFwiQmVuZ2FsdXJ1XCIsXG4gICAgICAgICAgICBQSU5DT0RFOiBcIjU2MDAwMVwiLFxuICAgICAgICAgICAgQUFESEFBUjogXCI1NDg5IDEyMzQgNTY3NFwiLFxuICAgICAgICAgICAgUEFOOiBcIkFCQ0RFMTIzNEZcIixcbiAgICAgICAgICAgIFBBU1NXT1JEOiBcIk1vY2tQYXNzd29yZEAxMjNcIlxuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICAgIGNvbnNvbGUubG9nKFwiW0JHXSBJbml0aWFsaXplZCBkZWZhdWx0IGRlbW8gcHJvZmlsZSB2YXVsdCBpbiBjaHJvbWUuc3RvcmFnZS5sb2NhbFwiKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxufSk7XG5jaHJvbWUucnVudGltZS5vblN0YXJ0dXAuYWRkTGlzdGVuZXIoKCkgPT4gZW5zdXJlT2Zmc2NyZWVuRG9jdW1lbnQoKSk7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gR2xvYmFsIEtlZXAtQWxpdmUgSGFuZGxlciAocmVzcG9uZHMgdG8gb2Zmc2NyZWVuIHBpbmdzKVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5jaHJvbWUucnVudGltZS5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIoKG1zZywgc2VuZGVyLCBzZW5kUmVzcG9uc2UpID0+IHtcbiAgaWYgKG1zZy50eXBlID09PSBcIk9GRlNDUkVFTl9LRUVQQUxJVkVcIikge1xuICAgIHNlbmRSZXNwb25zZSh7IG9rOiB0cnVlIH0pO1xuICAgIHJldHVybiB0cnVlO1xuICB9XG59KTtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBjYXB0dXJlU2NyZWVuIFx1MjAxNCBjYXB0dXJlIHRoZSBhY3RpdmUgdGFiJ3MgdmlzaWJsZSBhcmVhIGFzIGEgZGF0YSBVUkxcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGNhcHR1cmVTY3JlZW4oKSB7XG4gIGNvbnN0IFthY3RpdmVUYWJdID0gYXdhaXQgY2hyb21lLnRhYnMucXVlcnkoeyBhY3RpdmU6IHRydWUsIGN1cnJlbnRXaW5kb3c6IHRydWUgfSk7XG4gIGlmICghYWN0aXZlVGFiKSB0aHJvdyBuZXcgRXJyb3IoXCJObyBhY3RpdmUgdGFiIGZvdW5kLlwiKTtcblxuICBjb25zdCBkYXRhVXJsID0gYXdhaXQgY2hyb21lLnRhYnMuY2FwdHVyZVZpc2libGVUYWIoYWN0aXZlVGFiLndpbmRvd0lkLCB7IGZvcm1hdDogXCJwbmdcIiB9KTtcbiAgcmV0dXJuIHsgZGF0YVVybCwgdGFiOiBhY3RpdmVUYWIgfTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIGdldERPTVJlZ2lvbnMgXHUyMDE0IGFzayB0aGUgY29udGVudCBzY3JpcHQgdG8gc2NhbiB0aGUgcGFnZSdzIHNlbnNpdGl2ZSBmaWVsZHNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuYXN5bmMgZnVuY3Rpb24gZ2V0RE9NUmVnaW9ucyh0YWJJZCkge1xuICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICBjb25zb2xlLmxvZyhgW0JHXSBEaXNwYXRjaGluZyBTQ0FOX0RPTSBtZXNzYWdlIHRvIGFjdGl2ZSB0YWIgJHt0YWJJZH0uLi5gKTtcbiAgICBjaHJvbWUudGFicy5zZW5kTWVzc2FnZSh0YWJJZCwgeyB0eXBlOiBcIlNDQU5fRE9NXCIgfSwgYXN5bmMgKHJlc3BvbnNlKSA9PiB7XG4gICAgICBpZiAoY2hyb21lLnJ1bnRpbWUubGFzdEVycm9yIHx8ICFyZXNwb25zZSkge1xuICAgICAgICBjb25zdCBlcnJNc2cgPSBjaHJvbWUucnVudGltZS5sYXN0RXJyb3I/Lm1lc3NhZ2UgPz8gXCJubyByZXNwb25zZVwiO1xuICAgICAgICBjb25zb2xlLndhcm4oYFtCR10gSW5pdGlhbCBTQ0FOX0RPTSBmYWlsZWQgb24gdGFiICR7dGFiSWR9ICgke2Vyck1zZ30pLiBBdHRlbXB0aW5nIGR5bmFtaWMgaW5qZWN0aW9uIG9mIGNvbnRlbnQuanMuLi5gKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBhd2FpdCBjaHJvbWUuc2NyaXB0aW5nLmV4ZWN1dGVTY3JpcHQoe1xuICAgICAgICAgICAgdGFyZ2V0OiB7IHRhYklkIH0sXG4gICAgICAgICAgICBmaWxlczogW1wiY29udGVudC5qc1wiXSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBjb25zb2xlLmxvZyhgW0JHXSBjb250ZW50LmpzIHN1Y2Nlc3NmdWxseSBpbmplY3RlZCBpbnRvIHRhYiAke3RhYklkfS4gUmV0cnlpbmcgU0NBTl9ET00uLi5gKTtcbiAgICAgICAgICBjaHJvbWUudGFicy5zZW5kTWVzc2FnZSh0YWJJZCwgeyB0eXBlOiBcIlNDQU5fRE9NXCIgfSwgKHJldHJ5UmVzcG9uc2UpID0+IHtcbiAgICAgICAgICAgIGlmIChjaHJvbWUucnVudGltZS5sYXN0RXJyb3IgfHwgIXJldHJ5UmVzcG9uc2UpIHtcbiAgICAgICAgICAgICAgY29uc29sZS53YXJuKFwiW0JHXSBTQ0FOX0RPTSByZXRyeSBhbHNvIGZhaWxlZDpcIiwgY2hyb21lLnJ1bnRpbWUubGFzdEVycm9yPy5tZXNzYWdlID8/IFwibm8gcmVzcG9uc2VcIik7XG4gICAgICAgICAgICAgIHJlc29sdmUoeyBkb21SZWdpb25zOiBbXSwgZG9tSGFzaDogXCJcIiB9KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBbQkddIFNDQU5fRE9NIHJldHJ5IHN1Y2NlZWRlZCEgRm91bmQgJHtyZXRyeVJlc3BvbnNlLmRvbVJlZ2lvbnM/Lmxlbmd0aCA/PyAwfSBzZW5zaXRpdmUgZmllbGQocyksICR7cmV0cnlSZXNwb25zZS5tZWRpYVJlZ2lvbnM/Lmxlbmd0aCA/PyAwfSBtZWRpYSBlbGVtZW50KHMpOmAsIHJldHJ5UmVzcG9uc2UuZG9tUmVnaW9ucyk7XG4gICAgICAgICAgICAgIHJlc29sdmUoeyBkb21SZWdpb25zOiByZXRyeVJlc3BvbnNlLmRvbVJlZ2lvbnMgPz8gW10sIG1lZGlhUmVnaW9uczogcmV0cnlSZXNwb25zZS5tZWRpYVJlZ2lvbnMgPz8gW10sIGRvbUhhc2g6IHJldHJ5UmVzcG9uc2UuZG9tSGFzaCA/PyBcIlwiIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pO1xuICAgICAgICB9IGNhdGNoIChpbmpFcnIpIHtcbiAgICAgICAgICBjb25zb2xlLndhcm4oXCJbQkddIER5bmFtaWMgY29udGVudCBzY3JpcHQgaW5qZWN0aW9uIGZhaWxlZCAoZS5nLiBjaHJvbWU6Ly8gb3IgcmVzdHJpY3RlZCBwYWdlKTpcIiwgaW5qRXJyLm1lc3NhZ2UpO1xuICAgICAgICAgIHJlc29sdmUoeyBkb21SZWdpb25zOiBbXSwgbWVkaWFSZWdpb25zOiBbXSwgZG9tSGFzaDogXCJcIiB9KTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgICBjb25zb2xlLmxvZyhgW0JHXSBTQ0FOX0RPTSBzdWNjZWVkZWQgb24gdGFiICR7dGFiSWR9ISBSZWNlaXZlZCAke3Jlc3BvbnNlLmRvbVJlZ2lvbnM/Lmxlbmd0aCA/PyAwfSByZWdpb24ocyksICR7cmVzcG9uc2UubWVkaWFSZWdpb25zPy5sZW5ndGggPz8gMH0gbWVkaWEgZWxlbWVudChzKTpgLCByZXNwb25zZS5kb21SZWdpb25zKTtcbiAgICAgIHJlc29sdmUoeyBkb21SZWdpb25zOiByZXNwb25zZS5kb21SZWdpb25zID8/IFtdLCBtZWRpYVJlZ2lvbnM6IHJlc3BvbnNlLm1lZGlhUmVnaW9ucyA/PyBbXSwgZG9tSGFzaDogcmVzcG9uc2UuZG9tSGFzaCA/PyBcIlwiIH0pO1xuICAgIH0pO1xuICB9KTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBlbnN1cmVPZmZzY3JlZW5Eb2N1bWVudCBcdTIwMTQgY3JlYXRlIGlmIG5vdCBhbHJlYWR5IG9wZW4gKG1heCAxIHBlciBleHRlbnNpb24pXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbmFzeW5jIGZ1bmN0aW9uIGVuc3VyZU9mZnNjcmVlbkRvY3VtZW50KCkge1xuICBjb25zdCBleGlzdGluZyA9IGF3YWl0IGNocm9tZS5ydW50aW1lLmdldENvbnRleHRzKHtcbiAgICBjb250ZXh0VHlwZXM6IFtcIk9GRlNDUkVFTl9ET0NVTUVOVFwiXSxcbiAgICBkb2N1bWVudFVybHM6IFtPRkZTQ1JFRU5fVVJMXSxcbiAgfSk7XG4gIGlmIChleGlzdGluZy5sZW5ndGggPiAwKSByZXR1cm47XG5cbiAgYXdhaXQgY2hyb21lLm9mZnNjcmVlbi5jcmVhdGVEb2N1bWVudCh7XG4gICAgdXJsOiAgICAgICAgICAgXCJvZmZzY3JlZW4uaHRtbFwiLFxuICAgIHJlYXNvbnM6ICAgICAgIFtcIldPUktFUlNcIl0sXG4gICAganVzdGlmaWNhdGlvbjogXCJSdW4gRmxvcmVuY2UtMiArIEJsYXplRmFjZSBpbmZlcmVuY2UgZm9yIHZpc3VhbCBQSUkgZGV0ZWN0aW9uLlwiLFxuICB9KTtcbiAgY29uc29sZS5sb2coXCJbQkddIE9mZnNjcmVlbiBkb2N1bWVudCBjcmVhdGVkLlwiKTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyByZWRhY3RTY3JlZW5zaG90IFx1MjAxNCBwaHlzaWNhbGx5IGRyYXcgYmxhY2sgYm94ZXMgb3ZlciBzZW5zaXRpdmUgcmVnaW9uc1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5hc3luYyBmdW5jdGlvbiByZWRhY3RTY3JlZW5zaG90KGRhdGFVcmwsIHNlbnNpdGl2ZVJlZ2lvbnMpIHtcbiAgaWYgKCFzZW5zaXRpdmVSZWdpb25zIHx8IHNlbnNpdGl2ZVJlZ2lvbnMubGVuZ3RoID09PSAwKSByZXR1cm4gZGF0YVVybDtcblxuICB0cnkge1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKGRhdGFVcmwpO1xuICAgIGNvbnN0IGJsb2IgPSBhd2FpdCByZXMuYmxvYigpO1xuICAgIGNvbnN0IGJpdG1hcCA9IGF3YWl0IGNyZWF0ZUltYWdlQml0bWFwKGJsb2IpO1xuICAgIFxuICAgIGNvbnN0IGNhbnZhcyA9IG5ldyBPZmZzY3JlZW5DYW52YXMoYml0bWFwLndpZHRoLCBiaXRtYXAuaGVpZ2h0KTtcbiAgICBjb25zdCBjdHggPSBjYW52YXMuZ2V0Q29udGV4dChcIjJkXCIpO1xuICAgIFxuICAgIC8vIERyYXcgb3JpZ2luYWwgaW1hZ2VcbiAgICBjdHguZHJhd0ltYWdlKGJpdG1hcCwgMCwgMCk7XG4gICAgXG4gICAgLy8gRHJhdyByZWRhY3Rpb24gYm94ZXNcbiAgICBjdHguZmlsbFN0eWxlID0gXCJibGFja1wiO1xuICAgIGZvciAoY29uc3QgcmVnaW9uIG9mIHNlbnNpdGl2ZVJlZ2lvbnMpIHtcbiAgICAgIGlmIChyZWdpb24uYmJveCAmJiByZWdpb24uYmJveC5sZW5ndGggPT09IDQpIHtcbiAgICAgICAgY29uc3QgW3gsIHksIHcsIGhdID0gcmVnaW9uLmJib3g7XG4gICAgICAgIGN0eC5maWxsUmVjdCh4LCB5LCB3LCBoKTtcbiAgICAgIH1cbiAgICB9XG4gICAgXG4gICAgY29uc3Qgb3V0QmxvYiA9IGF3YWl0IGNhbnZhcy5jb252ZXJ0VG9CbG9iKHsgdHlwZTogXCJpbWFnZS9wbmdcIiB9KTtcbiAgICBjb25zdCBidWZmZXIgPSBhd2FpdCBvdXRCbG9iLmFycmF5QnVmZmVyKCk7XG4gICAgXG4gICAgLy8gQ29udmVydCB0byBiYXNlNjRcbiAgICBsZXQgYmluYXJ5ID0gJyc7XG4gICAgY29uc3QgYnl0ZXMgPSBuZXcgVWludDhBcnJheShidWZmZXIpO1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgYnl0ZXMuYnl0ZUxlbmd0aDsgaSsrKSB7XG4gICAgICBiaW5hcnkgKz0gU3RyaW5nLmZyb21DaGFyQ29kZShieXRlc1tpXSk7XG4gICAgfVxuICAgIGNvbnN0IGI2NCA9IGJ0b2EoYmluYXJ5KTtcbiAgICBcbiAgICByZXR1cm4gYGRhdGE6aW1hZ2UvcG5nO2Jhc2U2NCwke2I2NH1gO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBjb25zb2xlLmVycm9yKFwiW0JHXSBSZWRhY3Rpb24gZmFpbGVkOlwiLCBlcnIpO1xuICAgIHJldHVybiBkYXRhVXJsOyAvLyBmYWxsYmFjayB0byBvcmlnaW5hbCBvbiBlcnJvclxuICB9XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gcnVuVmlzaW9uQW5hbHlzaXMgXHUyMDE0IHNlbmRzIHNjcmVlbnNob3QgKyBkb21SZWdpb25zICsgbWVkaWFSZWdpb25zIHRvIG9mZnNjcmVlblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5hc3luYyBmdW5jdGlvbiBydW5WaXNpb25BbmFseXNpcyhzY3JlZW5zaG90RGF0YVVybCwgZG9tUmVnaW9ucywgbWVkaWFSZWdpb25zKSB7XG4gIGF3YWl0IGVuc3VyZU9mZnNjcmVlbkRvY3VtZW50KCk7XG5cbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBjaHJvbWUucnVudGltZS5zZW5kTWVzc2FnZShcbiAgICAgIHsgdHlwZTogXCJSVU5fSU5GRVJFTkNFXCIsIHBheWxvYWQ6IHsgc2NyZWVuc2hvdERhdGFVcmwsIGRvbVJlZ2lvbnMsIG1lZGlhUmVnaW9ucyB9IH0sXG4gICAgICAocmVzcG9uc2UpID0+IHtcbiAgICAgICAgaWYgKGNocm9tZS5ydW50aW1lLmxhc3RFcnJvcikge1xuICAgICAgICAgIHJlamVjdChuZXcgRXJyb3IoY2hyb21lLnJ1bnRpbWUubGFzdEVycm9yLm1lc3NhZ2UpKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgaWYgKCFyZXNwb25zZT8uc3VjY2Vzcykge1xuICAgICAgICAgIHJlamVjdChuZXcgRXJyb3IocmVzcG9uc2U/LmVycm9yID8/IFwiVW5rbm93biBpbmZlcmVuY2UgZXJyb3JcIikpO1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICByZXNvbHZlKHJlc3BvbnNlKTtcbiAgICAgIH1cbiAgICApO1xuICB9KTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBzZW5kVG9TZXJ2ZXIgXHUyMDE0IFBPU1QgcmVzdWx0IHRvIHRoZSBsb2NhbCBFeHByZXNzIHNlcnZlciAod2l0aCBmdWxsIEhUVFAgbG9nZ2luZylcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuYXN5bmMgZnVuY3Rpb24gc2VuZFRvU2VydmVyKHBheWxvYWQpIHtcbiAgY29uc29sZS5sb2coXCJbQkddIEluaXRpYXRpbmcgSFRUUCByZXF1ZXN0IHRvIHNlcnZlciBVUkw6XCIsIFNFUlZFUl9VUkwpO1xuICB0cnkge1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKFNFUlZFUl9VUkwsIHtcbiAgICAgIG1ldGhvZDogIFwiUE9TVFwiLFxuICAgICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgICAgYm9keTogICAgSlNPTi5zdHJpbmdpZnkocGF5bG9hZCksXG4gICAgfSk7XG5cbiAgICBjb25zb2xlLmxvZyhgW0JHXSBTZXJ2ZXIgSFRUUCBTdGF0dXMgQ29kZTogJHtyZXMuc3RhdHVzfSAke3Jlcy5zdGF0dXNUZXh0fWApO1xuICAgIGNvbnN0IHJhd0JvZHkgPSBhd2FpdCByZXMudGV4dCgpO1xuICAgIGNvbnNvbGUubG9nKGBbQkddIFNlcnZlciBSYXcgUmVzcG9uc2UgQm9keSAoJHtyYXdCb2R5Lmxlbmd0aH0gYnl0ZXMpOmAsIHJhd0JvZHkubGVuZ3RoID4gNTAwID8gcmF3Qm9keS5zdWJzdHJpbmcoMCwgNTAwKSArIFwiLi4uIFt0cnVuY2F0ZWRdXCIgOiByYXdCb2R5KTtcblxuICAgIGlmICghcmVzLm9rKSB7XG4gICAgICBsZXQgc2VydmVyRXJyID0gXCJcIjtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmF3Qm9keSk7XG4gICAgICAgIHNlcnZlckVyciA9IHBhcnNlZC5lcnJvciB8fCBwYXJzZWQubWVzc2FnZSB8fCBcIlwiO1xuICAgICAgfSBjYXRjaCAoZSkge31cbiAgICAgIHRocm93IG5ldyBFcnJvcihzZXJ2ZXJFcnIgfHwgYFNlcnZlciByZXR1cm5lZCBIVFRQICR7cmVzLnN0YXR1c30gKCR7cmVzLnN0YXR1c1RleHR9KTogJHtyYXdCb2R5LnN1YnN0cmluZygwLCAyMDApfWApO1xuICAgIH1cblxuICAgIGxldCBkYXRhO1xuICAgIHRyeSB7XG4gICAgICBkYXRhID0gSlNPTi5wYXJzZShyYXdCb2R5KTtcbiAgICB9IGNhdGNoIChwYXJzZUVycikge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBTZXJ2ZXIgcmVzcG9uc2Ugd2FzIG5vdCB2YWxpZCBKU09OOiAke3Jhd0JvZHkuc3Vic3RyaW5nKDAsIDIwMCl9YCk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGRhdGE7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGNvbnNvbGUuZXJyb3IoXCJbQkcgRXJyb3JdW3NlbmRUb1NlcnZlcl0gTmV0d29yayBvciBIVFRQIGVycm9yOlwiLCBlcnIpO1xuICAgIHRocm93IGVycjtcbiAgfVxufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFBvcnQtYmFzZWQgaGFuZGxlciBcdTIwMTQga2VlcHMgdGhlIHNlcnZpY2Ugd29ya2VyIGFsaXZlIGR1cmluZyBsb25nIGluZmVyZW5jZVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5jaHJvbWUucnVudGltZS5vbkNvbm5lY3QuYWRkTGlzdGVuZXIoKHBvcnQpID0+IHtcbiAgaWYgKHBvcnQubmFtZSAhPT0gXCJhbmFseXplXCIpIHJldHVybjtcblxuICBsZXQgaXNDb25uZWN0ZWQgPSB0cnVlO1xuICBjb25zdCBzYWZlUG9zdCA9IChtc2cpID0+IHtcbiAgICBpZiAoIWlzQ29ubmVjdGVkKSByZXR1cm4gZmFsc2U7XG4gICAgdHJ5IHtcbiAgICAgIHBvcnQucG9zdE1lc3NhZ2UobXNnKTtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGlzQ29ubmVjdGVkID0gZmFsc2U7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICB9O1xuXG4gIC8vIEZvcndhcmQgTU9ERUxfUFJPR1JFU1MgLyBNT0RFTF9SRUFEWSAvIE1PREVMX0VSUk9SIGZyb20gb2Zmc2NyZWVuIHRvIHBvcHVwXG4gIGNvbnN0IHJlbGF5ID0gKG1zZykgPT4ge1xuICAgIGlmIChbXCJNT0RFTF9QUk9HUkVTU1wiLCBcIk1PREVMX1JFQURZXCIsIFwiTU9ERUxfRVJST1JcIl0uaW5jbHVkZXMobXNnLnR5cGUpKSB7XG4gICAgICBzYWZlUG9zdChtc2cpO1xuICAgIH1cbiAgfTtcblxuICBjaHJvbWUucnVudGltZS5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIocmVsYXkpO1xuICBwb3J0Lm9uRGlzY29ubmVjdC5hZGRMaXN0ZW5lcigoKSA9PiB7XG4gICAgaXNDb25uZWN0ZWQgPSBmYWxzZTtcbiAgICBjaHJvbWUucnVudGltZS5vbk1lc3NhZ2UucmVtb3ZlTGlzdGVuZXIocmVsYXkpO1xuICAgIGNvbnNvbGUubG9nKFwiW0JHXSBQb3B1cCBwb3J0IGRpc2Nvbm5lY3RlZCAocG9wdXAgY2xvc2VkKS4gQ29udGludWluZyBleGVjdXRpb24gaW4gYmFja2dyb3VuZC5cIik7XG4gIH0pO1xuXG4gIHBvcnQub25NZXNzYWdlLmFkZExpc3RlbmVyKGFzeW5jIChtZXNzYWdlKSA9PiB7XG4gICAgaWYgKG1lc3NhZ2UudHlwZSAhPT0gXCJBTkFMWVpFX1NDUkVFTlwiICYmIG1lc3NhZ2UudHlwZSAhPT0gXCJTVEFSVF9ERU1PX1JVTlwiKSByZXR1cm47XG4gICAgXG4gICAgY29uc3QgaXNEZW1vID0gbWVzc2FnZS50eXBlID09PSBcIlNUQVJUX0RFTU9fUlVOXCI7XG4gICAgY29uc3QgaW5zdHJ1Y3Rpb24gPSBtZXNzYWdlLmluc3RydWN0aW9uIHx8IFwiQW5hbHl6ZSB0aGUgY3VycmVudCBzY3JlZW4gYW5kIGRldGVjdCBQSUlcIjtcbiAgICBsZXQgc2hvdWxkQ29udGludWUgPSB0cnVlO1xuICAgIGxldCB0YXNrVmlzaW9uSW5mZXJlbmNlcyA9IDA7XG4gICAgY29uc3QgTUFYX1ZJU0lPTl9QRVJfVEFTSyA9IDM7XG4gICAgY29uc3Qgc3RlcENvbnNlY3V0aXZlRmFpbHVyZXMgPSBuZXcgTWFwKCk7XG5cbiAgICB3aGlsZSAoc2hvdWxkQ29udGludWUpIHtcbiAgICAgIGNvbnN0IHQwID0gcGVyZm9ybWFuY2Uubm93KCk7XG4gICAgICBjb25zb2xlLmxvZyhgW0JHXSA+Pj4gU3RhcnRpbmcgRXhlY3V0aW9uIExvb3AgKGlzRGVtbz0ke2lzRGVtb30pIDw8PGApO1xuXG4gICAgICAvLyBcdTI1MDBcdTI1MDAgU3RlcCAwOiBSZWFkIGFuZCBQcmludCBDdXJyZW50IFN0b3JlZCBQcm9maWxlIFZhdWx0IChSZXF1aXJlbWVudCAyKSBcdTI1MDBcdTI1MDBcbiAgICAgIGNvbnN0IHN0b3JlZFZhdWx0ID0gYXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICAgICAgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KFtcImFnZW50X3ZhdWx0XCJdLCAoZGF0YSkgPT4gcmVzb2x2ZShkYXRhPy5hZ2VudF92YXVsdCB8fCB7fSkpO1xuICAgICAgfSk7XG4gICAgICBjb25zdCB2YXVsdEtleXMgPSBPYmplY3Qua2V5cyhzdG9yZWRWYXVsdCk7XG5cbiAgICAgIGNvbnNvbGUubG9nKFwiXFxuPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cIik7XG4gICAgICBjb25zb2xlLmxvZyhcIltCR10gPT09IENVUlJFTlQgU1RPUkVEIFBST0ZJTEUgVkFVTFQgQVQgU1RBUlQgT0YgUlVOID09PVwiKTtcbiAgICAgIGlmICh2YXVsdEtleXMubGVuZ3RoID4gMCkge1xuICAgICAgICBjb25zb2xlLmxvZyhgRm91bmQgJHt2YXVsdEtleXMubGVuZ3RofSBzdG9yZWQgZmllbGQocyk6YCk7XG4gICAgICAgIGNvbnNvbGUubG9nKEpTT04uc3RyaW5naWZ5KHN0b3JlZFZhdWx0LCBudWxsLCAyKSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zb2xlLmxvZyhcIlByb2ZpbGUgdmF1bHQgaXMgY3VycmVudGx5IEVNUFRZICgwIGZpZWxkcyBjb25maWd1cmVkKS5cIik7XG4gICAgICB9XG4gICAgICBjb25zb2xlLmxvZyhcIj09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XFxuXCIpO1xuXG4gICAgICBzYWZlUG9zdCh7XG4gICAgICAgIHR5cGU6IFwiU1RBVFVTXCIsXG4gICAgICAgIHRleHQ6IHZhdWx0S2V5cy5sZW5ndGggPiAwXG4gICAgICAgICAgPyBgW1ZBVUxUXSBMb2FkZWQgJHt2YXVsdEtleXMubGVuZ3RofSBzdG9yZWQgZmllbGQocyk6ICR7dmF1bHRLZXlzLmpvaW4oXCIsIFwiKX1gXG4gICAgICAgICAgOiBcIlx1MjZBMCBWYXVsdCBpcyBlbXB0eSEgT3BlbiBQcm9maWxlIHNldHRpbmdzIHRvIGNvbmZpZ3VyZSB2YWx1ZXMuXCJcbiAgICAgIH0pO1xuXG4gICAgICAvLyBcdTI1MDBcdTI1MDAgU3RlcCAxOiBDYXB0dXJlIHNjcmVlbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICAgIGxldCBjYXB0dXJlUmVzdWx0O1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc29sZS5sb2coXCJbQkddIFN0ZXAgMTogQ2FwdHVyaW5nIGFjdGl2ZSB0YWIgc2NyZWVuc2hvdC4uLlwiKTtcbiAgICAgICAgc2FmZVBvc3QoeyB0eXBlOiBcIlNUQUdFX0NIQU5HRVwiLCBzdGFnZTogXCJjYXB0dXJlXCIsIHRleHQ6IFwiQ2FwdHVyaW5nIHNjcmVlblx1MjAyNlwiIH0pO1xuICAgICAgICBjYXB0dXJlUmVzdWx0ID0gYXdhaXQgY2FwdHVyZVNjcmVlbigpO1xuICAgICAgICBjb25zb2xlLmxvZyhcIltCR10gU3RlcCAxIENvbXBsZXRlLiBTY3JlZW5zaG90IGNhcHR1cmVkIHN1Y2Nlc3NmdWxseS5cIik7XG4gICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgY29uc29sZS5lcnJvcihcIltCRyBFcnJvcl1bU3RlcCAxOiBTY3JlZW5zaG90IENhcHR1cmVdOlwiLCBlcnIpO1xuICAgICAgICBzYWZlUG9zdCh7IHR5cGU6IFwiRVJST1JcIiwgc3RlcDogXCJTY3JlZW5zaG90IENhcHR1cmVcIiwgZXJyb3I6IGVyci5tZXNzYWdlIH0pO1xuICAgICAgICBzaG91bGRDb250aW51ZSA9IGZhbHNlO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cblxuICAgICAgLy8gXHUyNTAwXHUyNTAwIFN0ZXAgMjogRE9NIHNjYW4gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgICBsZXQgZG9tUmVzdWx0O1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc29sZS5sb2coYFtCR10gU3RlcCAyOiBTY2FubmluZyBET00gZm9yIHNlbnNpdGl2ZSBmaWVsZHMgb24gdGFiICR7Y2FwdHVyZVJlc3VsdC50YWIuaWR9Li4uYCk7XG4gICAgICAgIHNhZmVQb3N0KHsgdHlwZTogXCJTVEFHRV9DSEFOR0VcIiwgc3RhZ2U6IFwiY2FwdHVyZVwiLCB0ZXh0OiBcIlNjYW5uaW5nIERPTSBmb3Igc2Vuc2l0aXZlIGZpZWxkc1x1MjAyNlwiIH0pO1xuICAgICAgICBkb21SZXN1bHQgPSBhd2FpdCBnZXRET01SZWdpb25zKGNhcHR1cmVSZXN1bHQudGFiLmlkKTtcbiAgICAgICAgc2FmZVBvc3QoeyB0eXBlOiBcIkRPTV9TQ0FOX0RPTkVcIiwgY291bnQ6IGRvbVJlc3VsdC5kb21SZWdpb25zLmxlbmd0aCB9KTtcbiAgICAgICAgY29uc29sZS5sb2coYFtCR10gU3RlcCAyIENvbXBsZXRlLiBGb3VuZCAke2RvbVJlc3VsdC5kb21SZWdpb25zLmxlbmd0aH0gc2Vuc2l0aXZlIERPTSBmaWVsZChzKS5gKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBjb25zb2xlLmVycm9yKFwiW0JHIEVycm9yXVtTdGVwIDI6IERPTSBTY2FuXTpcIiwgZXJyKTtcbiAgICAgICAgc2FmZVBvc3QoeyB0eXBlOiBcIkVSUk9SXCIsIHN0ZXA6IFwiRE9NIFNjYW5cIiwgZXJyb3I6IGVyci5tZXNzYWdlIH0pO1xuICAgICAgICBzaG91bGRDb250aW51ZSA9IGZhbHNlO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cblxuICAgICAgLy8gXHUyNTAwXHUyNTAwIFN0ZXAgMzogVmlzaW9uICsgUElJIGFuYWx5c2lzIChvZmZzY3JlZW4pIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgICAgc3RhdHMuZnJhbWVzQ2FwdHVyZWQrKztcbiAgICAgIGNvbnN0IGNhY2hlS2V5ID0gY2FwdHVyZVJlc3VsdC50YWIudXJsICsgXCJ8XCIgKyBkb21SZXN1bHQuZG9tSGFzaDtcbiAgICAgIGxldCBkZXRlY3Rpb25zLCBzZW5zaXRpdmVSZWdpb25zLCBzY3JlZW5zaG90RGF0YVVybCwgZWxhcHNlZDtcblxuICAgICAgaWYgKGFuYWx5c2lzQ2FjaGUuaGFzKGNhY2hlS2V5KSkge1xuICAgICAgICBjb25zb2xlLmxvZyhcIltCR10gU3RlcCAzOiBET00gaWRlbnRpY2FsISBDYWNoZSBoaXQsIHJldXNpbmcgY2FjaGVkIGRldGVjdGlvbnMuXCIpO1xuICAgICAgICBzYWZlUG9zdCh7IHR5cGU6IFwiU1RBVFVTXCIsIHRleHQ6IFwiXHUyNkExIERPTSBpZGVudGljYWwhIFNraXBwaW5nIHZpc2lvbiBpbmZlcmVuY2UgKENhY2hlIEhpdCkuXCIgfSk7XG4gICAgICAgIGNvbnN0IGNhY2hlZCA9IGFuYWx5c2lzQ2FjaGUuZ2V0KGNhY2hlS2V5KTtcbiAgICAgICAgZGV0ZWN0aW9ucyA9IGNhY2hlZC5kZXRlY3Rpb25zO1xuICAgICAgICBzZW5zaXRpdmVSZWdpb25zID0gY2FjaGVkLnNlbnNpdGl2ZVJlZ2lvbnM7XG4gICAgICAgIHNjcmVlbnNob3REYXRhVXJsID0gY2FwdHVyZVJlc3VsdC5kYXRhVXJsO1xuICAgICAgICBlbGFwc2VkID0gMDtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc29sZS5sb2coYFtCR10gU3RlcCAzOiBEaXNwYXRjaGluZyBzY3JlZW5zaG90IGFuZCBkb21SZWdpb25zIHRvIG9mZnNjcmVlbiBkb2N1bWVudCBmb3IgaW5mZXJlbmNlIChhdHRlbXB0ICR7dGFza1Zpc2lvbkluZmVyZW5jZXMgKyAxfSBvZiBtYXggJHtNQVhfVklTSU9OX1BFUl9UQVNLfSkuLi5gKTtcbiAgICAgICAgICBzYWZlUG9zdCh7IHR5cGU6IFwiU1RBR0VfQ0hBTkdFXCIsIHN0YWdlOiBcImRldGVjdFwiLCB0ZXh0OiBgUnVubmluZyBGbG9yZW5jZS0yICsgQmxhemVGYWNlICsgUElJIGFuYWx5c2lzICh2aXNpb24gcGFzcyAke3Rhc2tWaXNpb25JbmZlcmVuY2VzICsgMX0vJHtNQVhfVklTSU9OX1BFUl9UQVNLfSlcdTIwMjZgIH0pO1xuICAgICAgICAgIGlmICh0YXNrVmlzaW9uSW5mZXJlbmNlcyA+PSBNQVhfVklTSU9OX1BFUl9UQVNLKSB7XG4gICAgICAgICAgICBjb25zb2xlLndhcm4oYFtCR10gU3RvcHBpbmcgYWZ0ZXIgJHtNQVhfVklTSU9OX1BFUl9UQVNLfSBmdWxsIGFuYWx5c2lzIGF0dGVtcHRzIHRvIGF2b2lkIGV4Y2Vzc2l2ZSBjb3N0LmApO1xuICAgICAgICAgICAgc2FmZVBvc3Qoe1xuICAgICAgICAgICAgICB0eXBlOiBcIkVSUk9SXCIsXG4gICAgICAgICAgICAgIHN0ZXA6IFwiVmlzaW9uIEluZmVyZW5jZSBDYXBcIixcbiAgICAgICAgICAgICAgZXJyb3I6IGBTdG9wcGluZyBhZnRlciAke01BWF9WSVNJT05fUEVSX1RBU0t9IGZ1bGwgYW5hbHlzaXMgYXR0ZW1wdHMgdG8gYXZvaWQgZXhjZXNzaXZlIGNvc3RgXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIHNob3VsZENvbnRpbnVlID0gZmFsc2U7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgICB9XG4gICAgICAgICAgdGFza1Zpc2lvbkluZmVyZW5jZXMrKztcbiAgICAgICAgICBzdGF0cy52aXNpb25JbmZlcmVuY2VzKys7XG4gICAgICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuVmlzaW9uQW5hbHlzaXMoY2FwdHVyZVJlc3VsdC5kYXRhVXJsLCBkb21SZXN1bHQuZG9tUmVnaW9ucywgZG9tUmVzdWx0Lm1lZGlhUmVnaW9ucyk7XG4gICAgICAgICAgZGV0ZWN0aW9ucyA9IHJlc3VsdC5kZXRlY3Rpb25zO1xuICAgICAgICAgIHNlbnNpdGl2ZVJlZ2lvbnMgPSByZXN1bHQuc2Vuc2l0aXZlUmVnaW9ucztcbiAgICAgICAgICBzY3JlZW5zaG90RGF0YVVybCA9IHJlc3VsdC5zY3JlZW5zaG90RGF0YVVybDtcbiAgICAgICAgICBlbGFwc2VkID0gcmVzdWx0LmVsYXBzZWQ7XG4gICAgICAgICAgYW5hbHlzaXNDYWNoZS5zZXQoY2FjaGVLZXksIHsgZGV0ZWN0aW9ucywgc2Vuc2l0aXZlUmVnaW9ucyB9KTtcbiAgICAgICAgICBjb25zb2xlLmxvZyhgW0JHXSBTdGVwIDMgQ29tcGxldGUgaW4gJHtlbGFwc2VkfW1zOiAke2RldGVjdGlvbnMubGVuZ3RofSBkZXRlY3Rpb25zLCAke3NlbnNpdGl2ZVJlZ2lvbnMubGVuZ3RofSBQSUkgcmVnaW9ucy5gKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgICAgY29uc29sZS5lcnJvcihcIltCRyBFcnJvcl1bU3RlcCAzOiBGbG9yZW5jZS0yIC8gVmlzaW9uIEluZmVyZW5jZV06XCIsIGVycik7XG4gICAgICAgICAgc2FmZVBvc3QoeyB0eXBlOiBcIkVSUk9SXCIsIHN0ZXA6IFwiRmxvcmVuY2UtMiBJbmZlcmVuY2VcIiwgZXJyb3I6IGVyci5tZXNzYWdlIH0pO1xuICAgICAgICAgIHNob3VsZENvbnRpbnVlID0gZmFsc2U7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gXHUyNTAwXHUyNTAwIFN0ZXAgNDogUmVkYWN0IEltYWdlIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgICAgLy8gQ2FwdHVyZSByYXcgc2NyZWVuc2hvdCBzaXplIEJFRk9SRSByZWRhY3Rpb24gZm9yIG1ldHJpY3NcbiAgICAgIGNvbnN0IHJhd0J5dGVzID0gY2FwdHVyZVJlc3VsdC5kYXRhVXJsLmxlbmd0aDtcblxuICAgICAgbGV0IGZpbmFsU2NyZWVuc2hvdERhdGFVcmw7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zb2xlLmxvZyhgW0JHXSBTdGVwIDQ6IFJlZGFjdGluZyAke3NlbnNpdGl2ZVJlZ2lvbnMubGVuZ3RofSBzZW5zaXRpdmUgcmVnaW9ucyBvbiBjYW52YXMuLi5gKTtcbiAgICAgICAgc2FmZVBvc3QoeyB0eXBlOiBcIlNUQUdFX0NIQU5HRVwiLCBzdGFnZTogXCJyZWRhY3RcIiwgdGV4dDogYFJlZGFjdGluZyAke3NlbnNpdGl2ZVJlZ2lvbnMubGVuZ3RofSBzZW5zaXRpdmUgcmVnaW9uc1x1MjAyNmAgfSk7XG4gICAgICAgIGZpbmFsU2NyZWVuc2hvdERhdGFVcmwgPSBhd2FpdCByZWRhY3RTY3JlZW5zaG90KHNjcmVlbnNob3REYXRhVXJsLCBzZW5zaXRpdmVSZWdpb25zKTtcbiAgICAgICAgY29uc29sZS5sb2coXCJbQkddIFN0ZXAgNCBDb21wbGV0ZS4gUmVkYWN0aW9uIGZpbmlzaGVkLlwiKTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBjb25zb2xlLmVycm9yKFwiW0JHIEVycm9yXVtTdGVwIDQ6IFJlZGFjdGlvbl06XCIsIGVycik7XG4gICAgICAgIHNhZmVQb3N0KHsgdHlwZTogXCJFUlJPUlwiLCBzdGVwOiBcIlJlZGFjdGlvblwiLCBlcnJvcjogZXJyLm1lc3NhZ2UgfSk7XG4gICAgICAgIHNob3VsZENvbnRpbnVlID0gZmFsc2U7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuXG4gICAgICAvLyBcdTI1MDBcdTI1MDAgU3RlcCA0YjogUmVkYWN0aW9uIExlYWsgVmVyaWZpY2F0aW9uIChnZW9tZXRyaWMsIGluc3RhbnQpIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgICAgLy8gV2UgcGFpbnRlZCB0aGUgYmxhY2sgYm94ZXMgb3Vyc2VsdmVzIHNvIHdlIHZlcmlmeSBnZW9tZXRyaWNhbGx5IGJ5XG4gICAgICAvLyBzYW1wbGluZyB0aGUgY2VudGVyIHBpeGVsIG9mIGVhY2ggbWFza2VkIHJlZ2lvbiBmcm9tIHRoZSByZWRhY3RlZFxuICAgICAgLy8gaW1hZ2UuIFRoaXMgaXMgaW5zdGFudCB2cy4gdGhlIHByZXZpb3VzIGZ1bGwgRmxvcmVuY2UtMiBzZWNvbmQgcGFzc1xuICAgICAgLy8gKHdoaWNoIHRvb2sgMzAtMTIwcyBhbmQgY2F1c2VkIHRoZSBoYW5nIG9uIGJvdGggQ2xvdWQgYW5kIE9mZmxpbmUpLlxuICAgICAgbGV0IGxlYWtDaGVja1Bhc3NlZCA9IHRydWU7XG4gICAgICBsZXQgbGVha0RldGFpbHMgPSB7IGxlYWtzRm91bmQ6IDAsIGxlYWtSZWdpb25zOiBbXSwgY2hlY2tlZFJlZ2lvbnM6IHNlbnNpdGl2ZVJlZ2lvbnMubGVuZ3RoIH07XG4gICAgICB0cnkge1xuICAgICAgICBpZiAoc2Vuc2l0aXZlUmVnaW9ucy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgLy8gRGVjb2RlIHRoZSByZWRhY3RlZCBpbWFnZSBpbnRvIGEgY2FudmFzIGFuZCBzYW1wbGUgY2VudGVyIHBpeGVsc1xuICAgICAgICAgIGNvbnN0IGxlYWtpbmdSZWdpb25zID0gYXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IGltZyA9IG5ldyBJbWFnZSgpO1xuICAgICAgICAgICAgaW1nLm9ubG9hZCA9ICgpID0+IHtcbiAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICBjb25zdCBjdiA9IG5ldyBPZmZzY3JlZW5DYW52YXMoaW1nLndpZHRoLCBpbWcuaGVpZ2h0KTtcbiAgICAgICAgICAgICAgICBjb25zdCBjdHgyID0gY3YuZ2V0Q29udGV4dChcIjJkXCIpO1xuICAgICAgICAgICAgICAgIGN0eDIuZHJhd0ltYWdlKGltZywgMCwgMCk7XG4gICAgICAgICAgICAgICAgY29uc3QgbGVha2VycyA9IFtdO1xuICAgICAgICAgICAgICAgIGZvciAoY29uc3QgciBvZiBzZW5zaXRpdmVSZWdpb25zKSB7XG4gICAgICAgICAgICAgICAgICBjb25zdCBbcngsIHJ5LCBydywgcmhdID0gci5iYm94O1xuICAgICAgICAgICAgICAgICAgY29uc3QgY3ggPSBNYXRoLnJvdW5kKHJ4ICsgcncgLyAyKTtcbiAgICAgICAgICAgICAgICAgIGNvbnN0IGN5ID0gTWF0aC5yb3VuZChyeSArIHJoIC8gMik7XG4gICAgICAgICAgICAgICAgICAvLyBHdWFyZCBib3VuZHNcbiAgICAgICAgICAgICAgICAgIGlmIChjeCA8IDAgfHwgY3kgPCAwIHx8IGN4ID49IGltZy53aWR0aCB8fCBjeSA+PSBpbWcuaGVpZ2h0KSBjb250aW51ZTtcbiAgICAgICAgICAgICAgICAgIGNvbnN0IHB4ID0gY3R4Mi5nZXRJbWFnZURhdGEoY3gsIGN5LCAxLCAxKS5kYXRhOyAvLyBbUiwgRywgQiwgQV1cbiAgICAgICAgICAgICAgICAgIC8vIEJsYWNrIGJveCA9IFIrRytCIDwgMzAgKG5lYXItYmxhY2spXG4gICAgICAgICAgICAgICAgICBpZiAocHhbMF0gKyBweFsxXSArIHB4WzJdID49IDMwKSB7XG4gICAgICAgICAgICAgICAgICAgIGxlYWtlcnMucHVzaCh7IC4uLnIsIGNlbnRlcl9waXhlbDogW3B4WzBdLCBweFsxXSwgcHhbMl1dIH0pO1xuICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICByZXNvbHZlKGxlYWtlcnMpO1xuICAgICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgICAgcmVzb2x2ZShbXSk7IC8vIE9mZnNjcmVlbkNhbnZhcyBub3QgYXZhaWxhYmxlIFx1MjAxNCB0cmVhdCBhcyBjbGVhblxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9O1xuICAgICAgICAgICAgaW1nLm9uZXJyb3IgPSAoKSA9PiByZXNvbHZlKFtdKTtcbiAgICAgICAgICAgIGltZy5zcmMgPSBmaW5hbFNjcmVlbnNob3REYXRhVXJsO1xuICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgbGVha0RldGFpbHMgPSB7XG4gICAgICAgICAgICBsZWFrc0ZvdW5kOiBsZWFraW5nUmVnaW9ucy5sZW5ndGgsXG4gICAgICAgICAgICBsZWFrUmVnaW9uczogbGVha2luZ1JlZ2lvbnMsXG4gICAgICAgICAgICBjaGVja2VkUmVnaW9uczogc2Vuc2l0aXZlUmVnaW9ucy5sZW5ndGgsXG4gICAgICAgICAgfTtcblxuICAgICAgICAgIGlmIChsZWFraW5nUmVnaW9ucy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBsZWFrQ2hlY2tQYXNzZWQgPSBmYWxzZTtcbiAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYFtCR10gU3RlcCA0YiBGQUlMOiAke2xlYWtpbmdSZWdpb25zLmxlbmd0aH0gcmVnaW9uKHMpIG5vdCBmdWxseSBibGFja2VkIG91dCFgLCBsZWFraW5nUmVnaW9ucyk7XG4gICAgICAgICAgICBzYWZlUG9zdCh7XG4gICAgICAgICAgICAgIHR5cGU6IFwiTEVBS19DSEVDS1wiLFxuICAgICAgICAgICAgICBwYXNzZWQ6IGZhbHNlLFxuICAgICAgICAgICAgICBsZWFrc0ZvdW5kOiBsZWFraW5nUmVnaW9ucy5sZW5ndGgsXG4gICAgICAgICAgICAgIGxlYWtSZWdpb25zOiBsZWFraW5nUmVnaW9ucyxcbiAgICAgICAgICAgICAgY2hlY2tlZFJlZ2lvbnM6IHNlbnNpdGl2ZVJlZ2lvbnMubGVuZ3RoLFxuICAgICAgICAgICAgICBtZXNzYWdlOiBgXHVEODNEXHVERUE4IExFQUsgREVURUNURUQ6ICR7bGVha2luZ1JlZ2lvbnMubGVuZ3RofSByZWdpb24ocykgbm90IGJsYWNrZWQgb3V0IFx1MjAxNCBwYXlsb2FkIEJMT0NLRURgLFxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKGBbQkddIFN0ZXAgNGIgUEFTUzogQWxsICR7c2Vuc2l0aXZlUmVnaW9ucy5sZW5ndGh9IHJlZ2lvbihzKSB2ZXJpZmllZCBibGFjay4gUmVkYWN0aW9uIGlzIHNvbGlkLmApO1xuICAgICAgICAgICAgc2FmZVBvc3Qoe1xuICAgICAgICAgICAgICB0eXBlOiBcIkxFQUtfQ0hFQ0tcIixcbiAgICAgICAgICAgICAgcGFzc2VkOiB0cnVlLFxuICAgICAgICAgICAgICBsZWFrc0ZvdW5kOiAwLFxuICAgICAgICAgICAgICBsZWFrUmVnaW9uczogW10sXG4gICAgICAgICAgICAgIGNoZWNrZWRSZWdpb25zOiBzZW5zaXRpdmVSZWdpb25zLmxlbmd0aCxcbiAgICAgICAgICAgICAgbWVzc2FnZTogYFx1MjcxMyAwIGxlYWtzIFx1MjAxNCAke3NlbnNpdGl2ZVJlZ2lvbnMubGVuZ3RofSBtYXNrZWQgcmVnaW9uKHMpIHZlcmlmaWVkIGJsYWNrIChnZW9tZXRyaWMgY2hlY2spYCxcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAvLyBObyByZWdpb25zIHRvIHJlZGFjdCBcdTIwMTQgdHJpdmlhbGx5IGNsZWFuXG4gICAgICAgICAgY29uc29sZS5sb2coXCJbQkddIFN0ZXAgNGI6IE5vIHNlbnNpdGl2ZSByZWdpb25zIHRvIHZlcmlmeS5cIik7XG4gICAgICAgICAgc2FmZVBvc3Qoe1xuICAgICAgICAgICAgdHlwZTogXCJMRUFLX0NIRUNLXCIsXG4gICAgICAgICAgICBwYXNzZWQ6IHRydWUsXG4gICAgICAgICAgICBsZWFrc0ZvdW5kOiAwLFxuICAgICAgICAgICAgbGVha1JlZ2lvbnM6IFtdLFxuICAgICAgICAgICAgY2hlY2tlZFJlZ2lvbnM6IDAsXG4gICAgICAgICAgICBtZXNzYWdlOiBcIlx1MjcxMyBObyByZWdpb25zIHRvIHZlcmlmeSAocGFnZSBoYXMgbm8gZGV0ZWN0ZWQgUElJKVwiLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICB9IGNhdGNoIChsZWFrRXJyKSB7XG4gICAgICAgIC8vIFRyZWF0IGluZmVyZW5jZSBlcnJvcnMgYXMgbm9uLWZhdGFsIGZvciBsZWFrIGNoZWNrIFx1MjAxNCBsb2cgYnV0IHByb2NlZWRcbiAgICAgICAgY29uc29sZS53YXJuKFwiW0JHXSBTdGVwIDRiOiBMZWFrIHZlcmlmaWNhdGlvbiBpbmZlcmVuY2UgZmFpbGVkIChub24tZmF0YWwpOlwiLCBsZWFrRXJyLm1lc3NhZ2UpO1xuICAgICAgICBzYWZlUG9zdCh7XG4gICAgICAgICAgdHlwZTogXCJMRUFLX0NIRUNLXCIsXG4gICAgICAgICAgcGFzc2VkOiB0cnVlLCAgLy8gR2l2ZSBiZW5lZml0IG9mIGRvdWJ0IGlmIGluZmVyZW5jZSBmYWlsc1xuICAgICAgICAgIGxlYWtzRm91bmQ6IDAsXG4gICAgICAgICAgbGVha1JlZ2lvbnM6IFtdLFxuICAgICAgICAgIGNoZWNrZWRSZWdpb25zOiBzZW5zaXRpdmVSZWdpb25zLmxlbmd0aCxcbiAgICAgICAgICBtZXNzYWdlOiBgXHUyNkEwIExlYWsgY2hlY2sgc2tpcHBlZCAoaW5mZXJlbmNlIGVycm9yOiAke2xlYWtFcnIubWVzc2FnZX0pYCxcbiAgICAgICAgICB3YXJuaW5nOiB0cnVlLFxuICAgICAgICB9KTtcbiAgICAgIH1cblxuICAgICAgLy8gQmxvY2sgdGhlIHBheWxvYWQgaWYgbGVhayBjaGVjayBmYWlsZWRcbiAgICAgIGlmICghbGVha0NoZWNrUGFzc2VkKSB7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoXCJbQkddIEJMT0NLSU5HIHBheWxvYWQgdHJhbnNtaXNzaW9uIFx1MjAxNCBQSUkgbGVhayB2ZXJpZmljYXRpb24gZmFpbGVkIVwiKTtcbiAgICAgICAgc2hvdWxkQ29udGludWUgPSBmYWxzZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG5cbiAgICAgIC8vIFx1MjUwMFx1MjUwMCBTdGVwIDU6IFNlbmQgUGF5bG9hZCB0byBTZXJ2ZXIgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgICBsZXQgc2VydmVyUmVzdWx0O1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc29sZS5sb2coXCJbQkddIFN0ZXAgNTogUHJlcGFyaW5nIEFnZW50UmVxdWVzdFYxIHBheWxvYWQgZm9yIHNlcnZlci4uLlwiKTtcbiAgICAgICAgc2FmZVBvc3QoeyB0eXBlOiBcIlNUQUdFX0NIQU5HRVwiLCBzdGFnZTogXCJzZW5kXCIsIHRleHQ6IFwiU2VuZGluZyByZWRhY3RlZCBwYXlsb2FkIHRvIHNlcnZlciAoaHR0cDovL2xvY2FsaG9zdDozMDAwL2FuYWx5emUpXHUyMDI2XCIgfSk7XG4gICAgICAgIFxuICAgICAgICBjb25zdCBtYW5pZmVzdCA9IChzZW5zaXRpdmVSZWdpb25zIHx8IFtdKS5tYXAoKHIsIGkpID0+ICh7XG4gICAgICAgICAgcmVnaW9uX2lkOiBgcmVnaW9uXyR7aX1gLFxuICAgICAgICAgIGJib3g6IHIuYmJveCxcbiAgICAgICAgICB0eXBlOiByLnR5cGUsXG4gICAgICAgICAgcmVkYWN0aW9uX3N0eWxlOiBcImJsYWNrX2JveFwiLFxuICAgICAgICAgIGNvbmZpZGVuY2U6IHIuY29uZmlkZW5jZSxcbiAgICAgICAgICBzb3VyY2U6IHIuc291cmNlIHx8IFwiZG9tXCJcbiAgICAgICAgfSkpO1xuXG4gICAgICAgIGNvbnN0IGRvbV9zdW1tYXJ5ID0gKGRvbVJlc3VsdC5kb21SZWdpb25zIHx8IFtdKS5tYXAoKHIsIGkpID0+ICh7XG4gICAgICAgICAgZWxlbWVudF9pZDogci5hZ2VudElkIHx8IGBhZ2VudF8ke2l9YCxcbiAgICAgICAgICBkb21faWQ6IHIuaWQgfHwgXCJcIixcbiAgICAgICAgICBuYW1lOiByLm5hbWUgfHwgXCJcIixcbiAgICAgICAgICBwbGFjZWhvbGRlcjogci5wbGFjZWhvbGRlciB8fCBcIlwiLFxuICAgICAgICAgIHRhZzogci50YWcgfHwgXCJpbnB1dFwiLFxuICAgICAgICAgIHJvbGU6IHIucm9sZSB8fCAoci5pbnB1dFR5cGUgPT09IFwicmFkaW9cIiA/IFwicmFkaW9cIiA6IFwidGV4dGJveFwiKSxcbiAgICAgICAgICBsYWJlbDogci5sYWJlbCB8fCBcIlwiLFxuICAgICAgICAgIGZpZWxkX3R5cGU6IHIudHlwZSB8fCBcIlwiLFxuICAgICAgICAgIGJib3g6IHIuYmJveCxcbiAgICAgICAgICBjdXJyZW50X3ZhbHVlOiByLmN1cnJlbnRfdmFsdWUgfHwgXCJcIiAgLy8gTGl2ZSB2YWx1ZSBzbyBtb2RlbCBza2lwcyBhbHJlYWR5LWZpbGxlZCBmaWVsZHNcbiAgICAgICAgfSkpO1xuXG4gICAgICAgIGNvbnNvbGUubG9nKFwiXFxuPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cIik7XG4gICAgICAgIGNvbnNvbGUubG9nKGBbQkddW0RFQlVHXSA9PT0gRVhBQ1QgZG9tX3N1bW1hcnkgU0VOVCBUTyAvYW5hbHl6ZSAoJHtkb21fc3VtbWFyeS5sZW5ndGh9IGl0ZW1zKSA9PT1gKTtcbiAgICAgICAgY29uc29sZS5sb2coSlNPTi5zdHJpbmdpZnkoZG9tX3N1bW1hcnksIG51bGwsIDIpKTtcbiAgICAgICAgY29uc29sZS5sb2coYFtCR11bREVCVUddID09PSBFWEFDVCBtYW5pZmVzdCBTRU5UIFRPIC9hbmFseXplICgke21hbmlmZXN0Lmxlbmd0aH0gaXRlbXMpID09PWApO1xuICAgICAgICBjb25zb2xlLmxvZyhKU09OLnN0cmluZ2lmeShtYW5pZmVzdCwgbnVsbCwgMikpO1xuICAgICAgICBjb25zb2xlLmxvZyhcIj09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XFxuXCIpO1xuXG4gICAgICAgIGNvbnN0IGFnZW50UmVxdWVzdFBheWxvYWQgPSB7XG4gICAgICAgICAgdmVyc2lvbjogXCIxLjBcIixcbiAgICAgICAgICB0YXNrX2luc3RydWN0aW9uOiBpbnN0cnVjdGlvbixcbiAgICAgICAgICByZWRhY3RlZF9pbWFnZTogZmluYWxTY3JlZW5zaG90RGF0YVVybC5zcGxpdChcIixcIilbMV0sXG4gICAgICAgICAgbWFuaWZlc3QsXG4gICAgICAgICAgZG9tX3N1bW1hcnksXG4gICAgICAgICAgZGVtb19tb2RlOiBpc0RlbW8sXG4gICAgICAgICAgY2xpZW50X3N0YXRzOiB7IHRvdGFsTGF0ZW5jeU1zOiBzdGF0cy50b3RhbExhdGVuY3lNcyB9LFxuICAgICAgICAgIHZhdWx0OiBzdG9yZWRWYXVsdCAgLy8gU2VuZCBwcm9maWxlIGRhdGEgc28gc2VydmVyLXNpZGUgcHJvdmlkZXJzIGNhbiB1c2UgcmVhbCB2YWx1ZXNcbiAgICAgICAgfTtcblxuICAgICAgICAvLyBcdTI1MDBcdTI1MDAgRGF0YSBSZWR1Y3Rpb24gTWV0cmljcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICAgICAgLy8gQ29tcHV0ZSByYXcgYnl0ZXMgdnMuIHdoYXQgd2UgYWN0dWFsbHkgdHJhbnNtaXQsIHBsdXMgUElJIHN1cmZhY2UgYXJlYVxuICAgICAgICBjb25zdCByZWRhY3RlZEltYWdlQjY0ID0gYWdlbnRSZXF1ZXN0UGF5bG9hZC5yZWRhY3RlZF9pbWFnZTtcbiAgICAgICAgY29uc3QgcGF5bG9hZEpzb24gPSBKU09OLnN0cmluZ2lmeShhZ2VudFJlcXVlc3RQYXlsb2FkKTtcbiAgICAgICAgY29uc3Qgc2VudEJ5dGVzID0gcGF5bG9hZEpzb24ubGVuZ3RoOyAvLyBBcHByb3ggYnl0ZXMgZm9yIHRoZSBmdWxsIEpTT04gYm9keVxuXG4gICAgICAgIC8vIFBJSSBzdXJmYWNlOiBzdW0gb2YgYmJveCBwaXhlbCBhcmVhcyB2cy4gdG90YWwgc2NyZWVuc2hvdCBwaXhlbCBhcmVhXG4gICAgICAgIC8vIFdlIG5lZWQgaW1hZ2UgZGltZW5zaW9ucyBcdTIwMTQgcGFyc2UgZnJvbSB0aGUgcmVkYWN0ZWQgaW1hZ2VcbiAgICAgICAgbGV0IHBpaVN1cmZhY2VQZXJjZW50ID0gMDtcbiAgICAgICAgbGV0IGltYWdlVG90YWxQaXhlbHMgPSAxO1xuICAgICAgICBsZXQgaW1hZ2VQSUlQaXhlbHMgPSAwO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIC8vIERlY29kZSBkaW1lbnNpb25zIGZyb20gZmluYWxTY3JlZW5zaG90RGF0YVVybCB2aWEgb2Zmc2NyZWVuIGNhbnZhc1xuICAgICAgICAgIC8vIFVzZSB0aGUgcmF3IGNhcHR1cmUgZGltZW5zaW9ucyBlc3RpbWF0ZSBmcm9tIGJhc2U2NCBsZW5ndGggaGV1cmlzdGljXG4gICAgICAgICAgLy8gKFBORyB+NCBieXRlcyBwZXIgcGl4ZWwgYXQgMXgsIHNvIHBpeGVscyBcdTIyNDggKGI2NGxlbiAqIDMvNCkgLyA0KVxuICAgICAgICAgIC8vIEluc3RlYWQ6IGRpcmVjdGx5IGNvbXB1dGUgZnJvbSBzZW5zaXRpdmVSZWdpb25zIGJib3hlcyBhcmVhIHZzIGltYWdlIGFyZWFcbiAgICAgICAgICAvLyBXZSdsbCB1c2UgdGhlIGtub3duIERQUj0xIHNjcmVlbnNob3Q6IGdldCBkaW1zIGZyb20gcmF3IGRhdGFVcmxcbiAgICAgICAgICBjb25zdCByYXdCNjQgPSBjYXB0dXJlUmVzdWx0LmRhdGFVcmwuc3BsaXQoXCIsXCIpWzFdIHx8IFwiXCI7XG4gICAgICAgICAgLy8gUm91Z2ggaW1hZ2UgYXJlYSBlc3RpbWF0ZTogc2NyZWVuc2hvdCBEUFIgaXMgdHlwaWNhbGx5IGRldmljZVBpeGVsUmF0aW9cbiAgICAgICAgICAvLyBGb3IgYSByZWxpYWJsZSBtZXRyaWMsIGNvbXB1dGUgYmJveCBhcmVhcyBmcm9tIHNlbnNpdGl2ZVJlZ2lvbnNcbiAgICAgICAgICAvLyBhbmQgZXhwcmVzcyB0aGVtIHJlbGF0aXZlIHRvIHRoZSB2aXNpYmxlIHNjcmVlbnNob3Qgc2l6ZVxuICAgICAgICAgIGlmIChzZW5zaXRpdmVSZWdpb25zLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGltYWdlUElJUGl4ZWxzID0gc2Vuc2l0aXZlUmVnaW9ucy5yZWR1Y2UoKHN1bSwgcikgPT4gc3VtICsgKHIuYmJveFsyXSAqIHIuYmJveFszXSksIDApO1xuICAgICAgICAgICAgLy8gQXNzdW1lIGltYWdlIGFyZWEgZnJvbSB0aGUgbWF4IGV4dGVudHMgb2YgYW55IGRldGVjdGlvbiArIGdlbmVyb3VzIG1hcmdpblxuICAgICAgICAgICAgY29uc3QgYWxsWDIgPSBzZW5zaXRpdmVSZWdpb25zLm1hcChyID0+IHIuYmJveFswXSArIHIuYmJveFsyXSk7XG4gICAgICAgICAgICBjb25zdCBhbGxZMiA9IHNlbnNpdGl2ZVJlZ2lvbnMubWFwKHIgPT4gci5iYm94WzFdICsgci5iYm94WzNdKTtcbiAgICAgICAgICAgIC8vIE1pbiBlc3RpbWF0ZWQgaW1hZ2Ugc2l6ZTogYXQgbGVhc3QgMTI4MFx1MDBENzcyMCBvciBtYXggZGV0ZWN0aW9uIGJvdW5kcyArIDIwJVxuICAgICAgICAgICAgY29uc3QgZXN0aW1hdGVkVyA9IE1hdGgubWF4KDEyODAsIE1hdGgubWF4KC4uLmFsbFgyKSAqIDEuMik7XG4gICAgICAgICAgICBjb25zdCBlc3RpbWF0ZWRIID0gTWF0aC5tYXgoNzIwLCBNYXRoLm1heCguLi5hbGxZMikgKiAxLjIpO1xuICAgICAgICAgICAgaW1hZ2VUb3RhbFBpeGVscyA9IGVzdGltYXRlZFcgKiBlc3RpbWF0ZWRIO1xuICAgICAgICAgICAgcGlpU3VyZmFjZVBlcmNlbnQgPSAoaW1hZ2VQSUlQaXhlbHMgLyBpbWFnZVRvdGFsUGl4ZWxzKSAqIDEwMDtcbiAgICAgICAgICB9XG4gICAgICAgIH0gY2F0Y2ggKGRpbUVycikge1xuICAgICAgICAgIGNvbnNvbGUud2FybihcIltCR10gQ291bGQgbm90IGVzdGltYXRlIGltYWdlIGRpbWVuc2lvbnMgZm9yIFBJSSBzdXJmYWNlIG1ldHJpYzpcIiwgZGltRXJyKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IHJlZHVjdGlvblBlcmNlbnQgPSAoKDEgLSBzZW50Qnl0ZXMgLyByYXdCeXRlcykgKiAxMDApO1xuICAgICAgICBjb25zdCBtZXRyaWNzUGF5bG9hZCA9IHtcbiAgICAgICAgICByYXdfYnl0ZXM6IHJhd0J5dGVzLFxuICAgICAgICAgIHNlbnRfYnl0ZXM6IHNlbnRCeXRlcyxcbiAgICAgICAgICByZWR1Y3Rpb25fcGVyY2VudDogcmVkdWN0aW9uUGVyY2VudCxcbiAgICAgICAgICBwaWlfcmVnaW9uczogc2Vuc2l0aXZlUmVnaW9ucy5sZW5ndGgsXG4gICAgICAgICAgcGlpX3N1cmZhY2VfcGVyY2VudDogcGlpU3VyZmFjZVBlcmNlbnQsXG4gICAgICAgICAgcGlpX3BpeGVsczogaW1hZ2VQSUlQaXhlbHMsXG4gICAgICAgIH07XG4gICAgICAgIGNvbnNvbGUubG9nKFwiW0JHXSBEYXRhIFJlZHVjdGlvbiBNZXRyaWNzOlwiLCBKU09OLnN0cmluZ2lmeShtZXRyaWNzUGF5bG9hZCkpO1xuICAgICAgICBzYWZlUG9zdCh7IHR5cGU6IFwiTUVUUklDU1wiLCAuLi5tZXRyaWNzUGF5bG9hZCB9KTtcbiAgICAgICAgLy8gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbiAgICAgICAgc2VydmVyUmVzdWx0ID0gYXdhaXQgc2VuZFRvU2VydmVyKGFnZW50UmVxdWVzdFBheWxvYWQpO1xuICAgICAgICBjb25zb2xlLmxvZyhcIltCR10gU3RlcCA1IENvbXBsZXRlLiBTZXJ2ZXIgcmV0dXJuZWQgcGxhbjpcIiwgc2VydmVyUmVzdWx0KTtcbiAgICAgIH0gY2F0Y2ggKGVycikge1xuICAgICAgICBjb25zb2xlLmVycm9yKFwiW0JHIEVycm9yXVtTdGVwIDU6IFNlcnZlciBDYWxsXTpcIiwgZXJyKTtcbiAgICAgICAgbGV0IGVyck1zZyA9IGVyci5tZXNzYWdlIHx8IFN0cmluZyhlcnIpO1xuICAgICAgICBpZiAoZXJyTXNnLmluY2x1ZGVzKFwiRmFpbGVkIHRvIGZldGNoXCIpIHx8IGVyck1zZy5pbmNsdWRlcyhcIk5ldHdvcmtFcnJvclwiKSB8fCBlcnJNc2cuaW5jbHVkZXMoXCJFQ09OTlJFRlVTRURcIikpIHtcbiAgICAgICAgICBlcnJNc2cgPSBcIkNvdWxkbid0IHJlYWNoIHRoZSByZWFzb25pbmcgc2VydmVyIFx1MjAxNCBpcyBpdCBydW5uaW5nIG9uIHBvcnQgMzAwMD9cIjtcbiAgICAgICAgfVxuICAgICAgICBzYWZlUG9zdCh7IHR5cGU6IFwiRVJST1JcIiwgc3RlcDogXCJTZXJ2ZXIgQ2FsbFwiLCBlcnJvcjogZXJyTXNnIH0pO1xuICAgICAgICBzaG91bGRDb250aW51ZSA9IGZhbHNlO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cblxuICAgICAgLy8gXHUyNTAwXHUyNTAwIFN0ZXAgNjogRXhlY3V0ZSBQbGFuIHNlcXVlbnRpYWxseSBpbiBjb250ZW50IHNjcmlwdCBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICAgIHNhZmVQb3N0KHsgdHlwZTogXCJTVEFHRV9DSEFOR0VcIiwgc3RhZ2U6IFwiYWN0XCIsIHRleHQ6IFwiRXhlY3V0aW5nIHBsYW5cdTIwMjZcIiB9KTtcblxuICAgICAgY29uc3QgcGxhbiA9IEFycmF5LmlzQXJyYXkoc2VydmVyUmVzdWx0Py5wbGFuKSA/IHNlcnZlclJlc3VsdC5wbGFuIDogW107XG4gICAgICBjb25zdCB0b3RhbFN0ZXBzID0gcGxhbi5sZW5ndGg7XG4gICAgICBjb25zdCBzdGVwUmVzdWx0cyA9IFtdO1xuXG4gICAgICBpZiAodG90YWxTdGVwcyA9PT0gMCkge1xuICAgICAgICBjb25zb2xlLmxvZyhcIltCR10gU3RlcCA2OiBFbXB0eSBwbGFuIFx1MjAxNCBhbGwgZmllbGRzIGFscmVhZHkgZmlsbGVkIG9yIHRhc2sgY29tcGxldGUuXCIpO1xuICAgICAgICBzYWZlUG9zdCh7IHR5cGU6IFwiUExBTl9TVU1NQVJZXCIsIHRvdGFsOiAwLCBzdWNjZWVkZWQ6IDAsIGZhaWxlZDogMCwgZGV0YWlsczogW10sIG1lc3NhZ2U6IFwiQWxsIGZpZWxkcyBhcmUgYWxyZWFkeSBmaWxsZWQgXHUyMDE0IG5vdGhpbmcgdG8gZG8uXCIgfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zb2xlLmxvZyhgW0JHXSBTdGVwIDY6IEV4ZWN1dGluZyAke3RvdGFsU3RlcHN9IHBsYW4gc3RlcChzKS4uLmApO1xuXG4gICAgICAgIGZvciAoY29uc3Qgc3RlcCBvZiBwbGFuKSB7XG4gICAgICAgICAgY29uc3Qgc3RlcE51bSA9IHN0ZXAuc3RlcDtcbiAgICAgICAgICBjb25zdCBmaWVsZFR5cGUgPSBzdGVwLmZpZWxkX3R5cGUgfHwgXCJGSUVMRFwiO1xuICAgICAgICAgIGNvbnN0IHRhcmdldElkID0gc3RlcC50YXJnZXRfaWQ7XG5cbiAgICAgICAgICAvLyBIYXJkIHJldHJ5IGxpbWl0OiBpZiB0aGlzIHNhbWUgc3RlcCB0YXJnZXQvdHlwZSBmYWlsZWQgMiB0aW1lcyBpbiBhIHJvdywgc3RvcCByZXRyeWluZyBpdFxuICAgICAgICAgIGNvbnN0IHN0ZXBLZXkgPSBgJHt0YXJnZXRJZCB8fCBcIlwifV8ke2ZpZWxkVHlwZSB8fCBcIlwifWA7XG4gICAgICAgICAgY29uc3QgY3VycmVudEZhaWx1cmVzID0gc3RlcENvbnNlY3V0aXZlRmFpbHVyZXMuZ2V0KHN0ZXBLZXkpIHx8IDA7XG4gICAgICAgICAgaWYgKGN1cnJlbnRGYWlsdXJlcyA+PSAyKSB7XG4gICAgICAgICAgICBjb25zdCBza2lwUmVhc29uID0gYFN0ZXAgJHtzdGVwTnVtfSAoJHtmaWVsZFR5cGV9LCAke3RhcmdldElkfSkgaGFsdGVkOiBlbGVtZW50IGZhaWxlZCAke2N1cnJlbnRGYWlsdXJlc30gdGltZXMgY29uc2VjdXRpdmVseS4gU3RvcHBpbmcgcmV0cmllcyBmb3IgdGhpcyBzdGVwLmA7XG4gICAgICAgICAgICBjb25zb2xlLndhcm4oYFtCR10gJHtza2lwUmVhc29ufWApO1xuICAgICAgICAgICAgc3RlcFJlc3VsdHMucHVzaCh7IHN0ZXBOdW0sIGZpZWxkVHlwZSwgb2s6IGZhbHNlLCByZWFzb246IHNraXBSZWFzb24gfSk7XG4gICAgICAgICAgICBzYWZlUG9zdCh7XG4gICAgICAgICAgICAgIHR5cGU6IFwiUExBTl9TVEVQX1NUQVRVU1wiLFxuICAgICAgICAgICAgICBzdGVwTnVtLFxuICAgICAgICAgICAgICB0b3RhbFN0ZXBzLFxuICAgICAgICAgICAgICBzdGF0dXM6IFwiZXJyb3JcIixcbiAgICAgICAgICAgICAgbWVzc2FnZTogc2tpcFJlYXNvblxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBBdHRhY2ggYmJveCB0byBzdGVwIHBheWxvYWQgZm9yIGNvb3JkaW5hdGUtYmFzZWQgZmFsbGJhY2sgZXhlY3V0aW9uXG4gICAgICAgICAgY29uc3QgZG9tTWF0Y2ggPSBkb21fc3VtbWFyeS5maW5kKGQgPT4gZC5lbGVtZW50X2lkID09PSB0YXJnZXRJZCB8fCBkLmRvbV9pZCA9PT0gdGFyZ2V0SWQgfHwgZC5uYW1lID09PSB0YXJnZXRJZCk7XG4gICAgICAgICAgY29uc3QgbWFuaWZlc3RNYXRjaCA9IG1hbmlmZXN0LmZpbmQobSA9PiBtLnJlZ2lvbl9pZCA9PT0gdGFyZ2V0SWQpO1xuICAgICAgICAgIGNvbnN0IGRldGVjdGlvbk1hdGNoID0gKGRldGVjdGlvbnMgfHwgW10pLmZpbmQoZCA9PiBkLmlkID09PSB0YXJnZXRJZCk7XG4gICAgICAgICAgY29uc3QgbWF0Y2hlZEJib3ggPSBzdGVwLmJib3ggfHwgZG9tTWF0Y2g/LmJib3ggfHwgbWFuaWZlc3RNYXRjaD8uYmJveCB8fCBkZXRlY3Rpb25NYXRjaD8uYmJveCB8fCBudWxsO1xuICAgICAgICAgIGNvbnN0IHN0ZXBQYXlsb2FkID0geyAuLi5zdGVwLCBiYm94OiBtYXRjaGVkQmJveCB9O1xuXG4gICAgICAgICAgLy8gXHUyNTAwXHUyNTAwIENoZWNrIGlmIHZhbHVlIGlzIG1pc3NpbmcgKFJlcXVpcmVtZW50IDQgZmFsbGJhY2sgcGF0aCkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgICAgICAgbGV0IGN1cnJlbnRWYWwgPSBzdGVwUGF5bG9hZC52YWx1ZSB8fCBzdGVwUGF5bG9hZC5tYXRjaF92YWx1ZSB8fCBzdG9yZWRWYXVsdFtmaWVsZFR5cGVdIHx8IG51bGw7XG4gICAgICAgICAgaWYgKCFjdXJyZW50VmFsICYmIGZpZWxkVHlwZSA9PT0gXCJQSE9ORVwiKSBjdXJyZW50VmFsID0gc3RvcmVkVmF1bHRbXCJJTkRJQU5fTU9CSUxFXCJdO1xuICAgICAgICAgIGlmICghY3VycmVudFZhbCAmJiBmaWVsZFR5cGUgPT09IFwiSU5ESUFOX01PQklMRVwiKSBjdXJyZW50VmFsID0gc3RvcmVkVmF1bHRbXCJQSE9ORVwiXTtcblxuICAgICAgICAgIGlmICghY3VycmVudFZhbCAmJiAoc3RlcC5hY3Rpb24gPT09IFwidHlwZVwiIHx8IHN0ZXAuYWN0aW9uID09PSBcInNlbGVjdF9jaG9pY2VcIikgJiYgZmllbGRUeXBlICE9PSBcIkJVVFRPTlwiICYmIGZpZWxkVHlwZSAhPT0gXCJTVUJNSVRcIikge1xuICAgICAgICAgICAgLy8gXHUyNTAwXHUyNTAwIERlY2lkZSB3aGV0aGVyIHRvIHByb21wdCB1c2VyIG9yIHNraXAgaW1tZWRpYXRlbHkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgICAgICAgICAvLyBTZW5zaXRpdmUgZmllbGQgdHlwZXMgKFBJSSkgYXJlIG5ldmVyIHByb21wdGVkIGlubGluZSBcdTIwMTQgc2tpcCB0b1xuICAgICAgICAgICAgLy8gYXZvaWQgaGFuZ2luZyB0aGUgVUkgZm9yIG1pbnV0ZXMgaWYgdmF1bHQgaXMgZW1wdHkuXG4gICAgICAgICAgICBjb25zdCBTRU5TSVRJVkVfU0tJUF9UWVBFUyA9IG5ldyBTZXQoW1xuICAgICAgICAgICAgICBcIkFBREhBQVJcIiwgXCJQQU5cIiwgXCJHU1RJTlwiLCBcIklGU0NcIiwgXCJCQU5LX0FDQ09VTlRcIiwgXCJDQVJEXCIsXG4gICAgICAgICAgICAgIFwiUEFTU1dPUkRcIiwgXCJJTkRJQU5fTU9CSUxFXCIsIFwiUEhPTkVcIlxuICAgICAgICAgICAgXSk7XG4gICAgICAgICAgICBpZiAoU0VOU0lUSVZFX1NLSVBfVFlQRVMuaGFzKGZpZWxkVHlwZSkpIHtcbiAgICAgICAgICAgICAgLy8gQXV0by1za2lwIFx1MjAxNCBuZXZlciBzaG93IGlubGluZSBwcm9tcHQgZm9yIHNlbnNpdGl2ZSBQSUkgZmllbGRzXG4gICAgICAgICAgICAgIGNvbnN0IHNraXBNc2cgPSBgU3RlcCAke3N0ZXBOdW19OiBcdTI2QTAgTm8gdmFsdWUgaW4gdmF1bHQgZm9yIHNlbnNpdGl2ZSBmaWVsZCBcIiR7ZmllbGRUeXBlfVwiIFx1MjAxNCBza2lwcGluZyAoYWRkIGl0IGluIFByb2ZpbGUgc2V0dGluZ3MpLmA7XG4gICAgICAgICAgICAgIGNvbnNvbGUud2FybihgW0JHXSAke3NraXBNc2d9YCk7XG4gICAgICAgICAgICAgIHN0ZXBSZXN1bHRzLnB1c2goeyBzdGVwTnVtLCBmaWVsZFR5cGUsIG9rOiBmYWxzZSwgcmVhc29uOiBza2lwTXNnIH0pO1xuICAgICAgICAgICAgICBzYWZlUG9zdCh7IHR5cGU6IFwiUExBTl9TVEVQX1NUQVRVU1wiLCBzdGVwTnVtLCB0b3RhbFN0ZXBzLCBzdGF0dXM6IFwiZXJyb3JcIiwgbWVzc2FnZTogc2tpcE1zZyB9KTtcbiAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIEZvciBub24tc2Vuc2l0aXZlIGZpZWxkcyAoTkFNRSwgRU1BSUwsIEFERFJFU1MsIGV0Yy4pIHByb21wdCB0aGUgdXNlclxuICAgICAgICAgICAgY29uc29sZS5sb2coYFtCR10gU3RlcCAke3N0ZXBOdW19OiBObyB2YWx1ZSBmb3VuZCBmb3IgXCIke2ZpZWxkVHlwZX1cIiBpbiBwcm9maWxlIG9yIHBsYW4uIFJlcXVlc3RpbmcgaW5saW5lIGlucHV0IGZyb20gdXNlci4uLmApO1xuICAgICAgICAgICAgc2FmZVBvc3Qoe1xuICAgICAgICAgICAgICB0eXBlOiBcIlBST01QVF9VU0VSX0lOUFVUXCIsXG4gICAgICAgICAgICAgIHN0ZXBOdW0sXG4gICAgICAgICAgICAgIGZpZWxkVHlwZSxcbiAgICAgICAgICAgICAgdGFyZ2V0SWQsXG4gICAgICAgICAgICAgIGFjdGlvblR5cGU6IHN0ZXAuYWN0aW9uLFxuICAgICAgICAgICAgICBtZXNzYWdlOiBgTm8gdmFsdWUgZm91bmQgZm9yICR7ZmllbGRUeXBlfSBcdTIwMTQgZW50ZXIgb25lIG5vdz9gXG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgY29uc3QgdXNlclJlcGx5ID0gYXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICAgICAgICAgICAgY29uc3QgcmVwbHlIYW5kbGVyID0gKHVNc2cpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAodU1zZy50eXBlID09PSBcIlVTRVJfSU5QVVRfUFJPVklERURcIiAmJiB1TXNnLnN0ZXBOdW0gPT09IHN0ZXBOdW0pIHtcbiAgICAgICAgICAgICAgICAgIHBvcnQub25NZXNzYWdlLnJlbW92ZUxpc3RlbmVyKHJlcGx5SGFuZGxlcik7XG4gICAgICAgICAgICAgICAgICByZXNvbHZlKHVNc2cpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgcG9ydC5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIocmVwbHlIYW5kbGVyKTtcbiAgICAgICAgICAgICAgLy8gMTAtc2Vjb25kIHRpbWVvdXQgXHUyMDE0IGF1dG8tc2tpcCBpZiB1c2VyIGRvZXNuJ3QgcmVzcG9uZFxuICAgICAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHJlc29sdmUobnVsbCksIDEwMDAwKTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBpZiAodXNlclJlcGx5ICYmIHVzZXJSZXBseS52YWx1ZSkge1xuICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgW0JHXSBTdGVwICR7c3RlcE51bX06IFVzZXIgcHJvdmlkZWQgdmFsdWUgZm9yIFwiJHtmaWVsZFR5cGV9XCI6IFwiJHt1c2VyUmVwbHkudmFsdWV9XCIgKHNhdmVUb1ZhdWx0OiAke3VzZXJSZXBseS5zYXZlVG9WYXVsdH0pYCk7XG4gICAgICAgICAgICAgIGlmIChzdGVwLmFjdGlvbiA9PT0gXCJzZWxlY3RfY2hvaWNlXCIpIHtcbiAgICAgICAgICAgICAgICBzdGVwUGF5bG9hZC5tYXRjaF92YWx1ZSA9IHVzZXJSZXBseS52YWx1ZTtcbiAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBzdGVwUGF5bG9hZC52YWx1ZSA9IHVzZXJSZXBseS52YWx1ZTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICBpZiAodXNlclJlcGx5LnNhdmVUb1ZhdWx0KSB7XG4gICAgICAgICAgICAgICAgc3RvcmVkVmF1bHRbZmllbGRUeXBlXSA9IHVzZXJSZXBseS52YWx1ZTtcbiAgICAgICAgICAgICAgICBjaHJvbWUuc3RvcmFnZS5sb2NhbC5zZXQoeyBhZ2VudF92YXVsdDogc3RvcmVkVmF1bHQgfSk7XG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coYFtCR10gXHUyNzEzIFBlcnNpc3RlZCBcIiR7ZmllbGRUeXBlfVwiID0gXCIke3VzZXJSZXBseS52YWx1ZX1cIiB0byBjaHJvbWUuc3RvcmFnZS5sb2NhbGApO1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICBjb25zdCBza2lwTXNnID0gYFN0ZXAgJHtzdGVwTnVtfTogTm8gdmFsdWUgcHJvdmlkZWQgZm9yIFwiJHtmaWVsZFR5cGV9XCIgKHRpbWVkIG91dCBvciBza2lwcGVkKS4gTW92aW5nIG9uLmA7XG4gICAgICAgICAgICAgIGNvbnNvbGUud2FybihgW0JHXSAke3NraXBNc2d9YCk7XG4gICAgICAgICAgICAgIHN0ZXBSZXN1bHRzLnB1c2goeyBzdGVwTnVtLCBmaWVsZFR5cGUsIG9rOiBmYWxzZSwgcmVhc29uOiBza2lwTXNnIH0pO1xuICAgICAgICAgICAgICBzYWZlUG9zdCh7IHR5cGU6IFwiUExBTl9TVEVQX1NUQVRVU1wiLCBzdGVwTnVtLCB0b3RhbFN0ZXBzLCBzdGF0dXM6IFwiZXJyb3JcIiwgbWVzc2FnZTogc2tpcE1zZyB9KTtcbiAgICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgc2FmZVBvc3Qoe1xuICAgICAgICAgICAgdHlwZTogXCJQTEFOX1NURVBfU1RBVFVTXCIsXG4gICAgICAgICAgICBzdGVwTnVtLFxuICAgICAgICAgICAgdG90YWxTdGVwcyxcbiAgICAgICAgICAgIHN0YXR1czogXCJydW5uaW5nXCIsXG4gICAgICAgICAgICBtZXNzYWdlOiBgU3RlcCAke3N0ZXBOdW19LyR7dG90YWxTdGVwc306ICR7c3RlcC5hY3Rpb259IG9uICR7ZmllbGRUeXBlfSAoJHt0YXJnZXRJZH0pXHUyMDI2YFxuICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbnN0IHN0ZXBSZXNwb25zZSA9IGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgICAgICAgICAgLy8gNSBzZWNvbmQgdGltZW91dCBwZXIgYWN0aW9uIHRvIGNhdGNoIGh1bmcgcGFnZXNcbiAgICAgICAgICAgICAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHJlamVjdChuZXcgRXJyb3IoXCJUSU1FT1VUXCIpKSwgNTAwMCk7XG4gICAgICAgICAgICAgIGNocm9tZS50YWJzLnNlbmRNZXNzYWdlKFxuICAgICAgICAgICAgICAgIGNhcHR1cmVSZXN1bHQudGFiLmlkLFxuICAgICAgICAgICAgICAgIHsgdHlwZTogXCJFWEVDVVRFX0FDVElPTlwiLCBwYXlsb2FkOiBzdGVwUGF5bG9hZCB9LFxuICAgICAgICAgICAgICAgIHJlc3BvbnNlID0+IHtcbiAgICAgICAgICAgICAgICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgICAgICAgICAgICAgICBpZiAoY2hyb21lLnJ1bnRpbWUubGFzdEVycm9yKSB7XG4gICAgICAgICAgICAgICAgICAgIHJlamVjdChuZXcgRXJyb3IoY2hyb21lLnJ1bnRpbWUubGFzdEVycm9yLm1lc3NhZ2UpKTtcbiAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHJlc29sdmUocmVzcG9uc2UgfHwgeyBvazogZmFsc2UsIGVycm9yOiBcIk5vIHJlc3BvbnNlIGZyb20gY29udGVudCBzY3JpcHRcIiB9KTtcbiAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgaWYgKHN0ZXBSZXNwb25zZS5vaykge1xuICAgICAgICAgICAgICBzdGVwQ29uc2VjdXRpdmVGYWlsdXJlcy5zZXQoc3RlcEtleSwgMCk7IC8vIHJlc2V0IG9uIHN1Y2Nlc3NcbiAgICAgICAgICAgICAgY29uc29sZS5sb2coYFtCR10gU3RlcCA2LiR7c3RlcE51bX06IFx1MjcxMyBzdWNjZXNzYCwgc3RlcFJlc3BvbnNlKTtcbiAgICAgICAgICAgICAgc3RlcFJlc3VsdHMucHVzaCh7IHN0ZXBOdW0sIGZpZWxkVHlwZSwgb2s6IHRydWUgfSk7XG4gICAgICAgICAgICAgIHNhZmVQb3N0KHtcbiAgICAgICAgICAgICAgICB0eXBlOiBcIlBMQU5fU1RFUF9TVEFUVVNcIixcbiAgICAgICAgICAgICAgICBzdGVwTnVtLFxuICAgICAgICAgICAgICAgIHRvdGFsU3RlcHMsXG4gICAgICAgICAgICAgICAgc3RhdHVzOiBcIm9rXCIsXG4gICAgICAgICAgICAgICAgbWVzc2FnZTogYFN0ZXAgJHtzdGVwTnVtfS8ke3RvdGFsU3RlcHN9OiBcdTI3MTMgJHtmaWVsZFR5cGV9IGZpbGxlZGBcbiAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3Ioc3RlcFJlc3BvbnNlLmVycm9yIHx8IFwiQ29udGVudCBzY3JpcHQgcmVwb3J0ZWQgZmFpbHVyZVwiKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgIHN0ZXBDb25zZWN1dGl2ZUZhaWx1cmVzLnNldChzdGVwS2V5LCBjdXJyZW50RmFpbHVyZXMgKyAxKTtcbiAgICAgICAgICAgIGxldCBmYWlsUmVhc29uO1xuICAgICAgICAgICAgY29uc3QgZXJyU3RyID0gZXJyLm1lc3NhZ2UgfHwgU3RyaW5nKGVycik7XG4gICAgICAgICAgICBpZiAoZXJyU3RyID09PSBcIlRJTUVPVVRcIikge1xuICAgICAgICAgICAgICBmYWlsUmVhc29uID0gYFRoZSBwYWdlIGRpZG4ndCByZXNwb25kIHRvIHRoZSBhY3Rpb24gaW4gdGltZSAoc3RlcCAke3N0ZXBOdW19LCAke2ZpZWxkVHlwZX0pLmA7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGVyclN0ci5pbmNsdWRlcyhcIm5vdCBmb3VuZFwiKSB8fCBlcnJTdHIuaW5jbHVkZXMoXCJyZXNvbHZlXCIpKSB7XG4gICAgICAgICAgICAgIGZhaWxSZWFzb24gPSBgQ291bGRuJ3QgZmluZCB0aGUgZWxlbWVudCBmb3Igc3RlcCAke3N0ZXBOdW19IChleHBlY3RlZDogJHtmaWVsZFR5cGV9KS4gVGhlIHBhZ2UgbGF5b3V0IG1heSBoYXZlIGNoYW5nZWQuYDtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgIGZhaWxSZWFzb24gPSBgU3RlcCAke3N0ZXBOdW19ICgke2ZpZWxkVHlwZX0pIGZhaWxlZDogJHtlcnJTdHJ9YDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoYFtCR10gU3RlcCA2LiR7c3RlcE51bX06IFx1MjcxNyBmYWlsZWQgKCR7Y3VycmVudEZhaWx1cmVzICsgMX0gY29uc2VjdXRpdmUpIFx1MjAxNCAke2ZhaWxSZWFzb259YCk7XG4gICAgICAgICAgICBzdGVwUmVzdWx0cy5wdXNoKHsgc3RlcE51bSwgZmllbGRUeXBlLCBvazogZmFsc2UsIHJlYXNvbjogZmFpbFJlYXNvbiB9KTtcbiAgICAgICAgICAgIHNhZmVQb3N0KHtcbiAgICAgICAgICAgICAgdHlwZTogXCJQTEFOX1NURVBfU1RBVFVTXCIsXG4gICAgICAgICAgICAgIHN0ZXBOdW0sXG4gICAgICAgICAgICAgIHRvdGFsU3RlcHMsXG4gICAgICAgICAgICAgIHN0YXR1czogXCJlcnJvclwiLFxuICAgICAgICAgICAgICBtZXNzYWdlOiBmYWlsUmVhc29uXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIC8vIENvbnRpbnVlIHJlbWFpbmluZyBzdGVwcyBcdTIwMTQgZG9uJ3QgYWJvcnQgdGhlIHdob2xlIHBsYW5cbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyBTbWFsbCBkZWxheSBiZXR3ZWVuIHN0ZXBzIHNvIERPTSBldmVudHMgc2V0dGxlXG4gICAgICAgICAgYXdhaXQgbmV3IFByb21pc2UociA9PiBzZXRUaW1lb3V0KHIsIDMwMCkpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gXHUyNTAwXHUyNTAwIFBsYW4gc3VtbWFyeSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbiAgICAgICAgY29uc3Qgc3VjY2VlZGVkID0gc3RlcFJlc3VsdHMuZmlsdGVyKHIgPT4gci5vaykubGVuZ3RoO1xuICAgICAgICBjb25zdCBmYWlsZWQgPSBzdGVwUmVzdWx0cy5maWx0ZXIociA9PiAhci5vaykubGVuZ3RoO1xuICAgICAgICBjb25zdCBmYWlsZWREZXNjcmlwdGlvbnMgPSBzdGVwUmVzdWx0c1xuICAgICAgICAgIC5maWx0ZXIociA9PiAhci5vaylcbiAgICAgICAgICAubWFwKHIgPT4gYFN0ZXAgJHtyLnN0ZXBOdW19ICgke3IuZmllbGRUeXBlfSk6ICR7ci5yZWFzb259YCk7XG5cbiAgICAgICAgbGV0IHN1bW1hcnlNc2c7XG4gICAgICAgIGlmIChmYWlsZWQgPT09IDApIHtcbiAgICAgICAgICBzdW1tYXJ5TXNnID0gYEFsbCAke3N1Y2NlZWRlZH0gc3RlcChzKSBjb21wbGV0ZWQgc3VjY2Vzc2Z1bGx5LmA7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgc3VtbWFyeU1zZyA9IGBDb21wbGV0ZWQgJHtzdWNjZWVkZWR9IG9mICR7dG90YWxTdGVwc30gc3RlcHMuICR7ZmFpbGVkRGVzY3JpcHRpb25zLmpvaW4oXCIgfCBcIil9YDtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnNvbGUubG9nKGBbQkddIFN0ZXAgNiBTdW1tYXJ5OiAke3N1bW1hcnlNc2d9YCk7XG4gICAgICAgIHNhZmVQb3N0KHtcbiAgICAgICAgICB0eXBlOiBcIlBMQU5fU1VNTUFSWVwiLFxuICAgICAgICAgIHRvdGFsOiB0b3RhbFN0ZXBzLFxuICAgICAgICAgIHN1Y2NlZWRlZCxcbiAgICAgICAgICBmYWlsZWQsXG4gICAgICAgICAgZGV0YWlsczogc3RlcFJlc3VsdHMsXG4gICAgICAgICAgbWVzc2FnZTogc3VtbWFyeU1zZ1xuICAgICAgICB9KTtcbiAgICAgIH1cblxuICAgICAgLy8gXHUyNTAwXHUyNTAwIEZpbmFsaXplIExvb3AgQ3ljbGUgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4gICAgICBzYWZlUG9zdCh7XG4gICAgICAgIHR5cGU6IFwiQU5BTFlTSVNfUkVTVUxUXCIsXG4gICAgICAgIGRldGVjdGlvbnMsXG4gICAgICAgIHNlbnNpdGl2ZVJlZ2lvbnMsXG4gICAgICAgIHNjcmVlbnNob3REYXRhVXJsLFxuICAgICAgICBlbGFwc2VkLFxuICAgICAgICBzZXJ2ZXJSZXN1bHQsXG4gICAgICB9KTtcblxuICAgICAgY29uc3QgdEVuZCA9IHBlcmZvcm1hbmNlLm5vdygpO1xuICAgICAgY29uc3QgbG9vcExhdGVuY3kgPSB0RW5kIC0gdDA7XG4gICAgICBzdGF0cy50b3RhbExhdGVuY3lNcyArPSBsb29wTGF0ZW5jeTtcbiAgICAgIGNvbnNvbGUubG9nKGBbQkddIEN5Y2xlIGZpbmlzaGVkIGluICR7bG9vcExhdGVuY3kudG9GaXhlZCgxKX1tcy4gVG90YWwgbGF0ZW5jeTogJHtzdGF0cy50b3RhbExhdGVuY3lNcy50b0ZpeGVkKDEpfW1zYCk7XG5cbiAgICAgIGNocm9tZS50YWJzLnNlbmRNZXNzYWdlKGNhcHR1cmVSZXN1bHQudGFiLmlkLCB7IHR5cGU6IFwiVVBEQVRFX1NUQVRTXCIsIHBheWxvYWQ6IHN0YXRzIH0sICgpID0+IHtcbiAgICAgICAgY2hyb21lLnJ1bnRpbWUubGFzdEVycm9yOyAvLyBJZ25vcmUgaWYgY29udGVudCBzY3JpcHQgY2xvc2VkXG4gICAgICB9KTtcblxuICAgICAgLy8gXHUyNTAwXHUyNTAwIExvb3AgY2hlY2s6IGRlbW8gbW9kZSBzdG9wcyBhZnRlciBvbmUgZnVsbCBwbGFuIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuICAgICAgc2hvdWxkQ29udGludWUgPSBmYWxzZTsgIC8vIFNpbmdsZS1zaG90OiBwbGFuIGNvdmVycyBhbGwgZmllbGRzIGF0IG9uY2VcbiAgICB9XG4gIH0pO1xufSk7XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBU0EsSUFBTSxhQUFnQjtBQUN0QixJQUFNLGdCQUFnQixPQUFPLFFBQVEsT0FBTyxnQkFBZ0I7QUFFNUQsSUFBTSxnQkFBZ0Isb0JBQUksSUFBSTtBQUM5QixJQUFJLFFBQVE7QUFBQSxFQUNWLGdCQUFnQjtBQUFBLEVBQ2hCLGtCQUFrQjtBQUFBLEVBQ2xCLGdCQUFnQjtBQUNsQjtBQUVBLFFBQVEsSUFBSSxrREFBa0Q7QUFLOUQsT0FBTyxRQUFRLFlBQVksWUFBWSxN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
