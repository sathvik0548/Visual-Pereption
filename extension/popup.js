// src/pii.js
var PII_TYPE = Object.freeze({
  PASSWORD: "PASSWORD",
  EMAIL: "EMAIL",
  PHONE: "PHONE",
  CARD: "CARD",
  FACE: "FACE",
  NAME: "NAME",
  AADHAAR: "AADHAAR",
  PAN: "PAN",
  GSTIN: "GSTIN",
  IFSC: "IFSC",
  INDIAN_MOBILE: "INDIAN_MOBILE",
  OTHER_PII: "OTHER_PII"
});
var PII_COLORS = {
  PASSWORD: { fill: "rgba(220,38,38,0.35)", stroke: "#ef4444", text: "#fff" },
  EMAIL: { fill: "rgba(234,88,12,0.35)", stroke: "#f97316", text: "#fff" },
  PHONE: { fill: "rgba(202,138,4,0.35)", stroke: "#eab308", text: "#000" },
  CARD: { fill: "rgba(219,39,119,0.35)", stroke: "#ec4899", text: "#fff" },
  FACE: { fill: "rgba(8,145,178,0.35)", stroke: "#06b6d4", text: "#fff" },
  NAME: { fill: "rgba(147,51,234,0.35)", stroke: "#a855f7", text: "#fff" },
  AADHAAR: { fill: "rgba(234,88,12,0.35)", stroke: "#ea580c", text: "#fff" },
  // Saffron / Deep Orange
  PAN: { fill: "rgba(16,185,129,0.35)", stroke: "#10b981", text: "#fff" },
  // Emerald
  GSTIN: { fill: "rgba(99,102,241,0.35)", stroke: "#6366f1", text: "#fff" },
  // Indigo
  IFSC: { fill: "rgba(14,165,233,0.35)", stroke: "#0ea5e9", text: "#fff" },
  // Cyan / Sky
  INDIAN_MOBILE: { fill: "rgba(234,179,8,0.35)", stroke: "#ca8a04", text: "#000" },
  // Amber Gold
  OTHER_PII: { fill: "rgba(100,116,139,0.35)", stroke: "#64748b", text: "#fff" }
};

// src/popup.js
var analyzeBtn = document.getElementById("analyzeBtn");
var demoBtn = document.getElementById("demoBtn");
var taskInput = document.getElementById("taskInput");
var statusEl = document.getElementById("statusText");
var canvasWrap = document.getElementById("canvasWrap");
var canvas = document.getElementById("debugCanvas");
var legendEl = document.getElementById("legend");
var piiTable = document.getElementById("piiTable");
var modeSelect = document.getElementById("modeSelect");
var modeBadge = document.getElementById("modeStatusBadge");
var modeDot = document.getElementById("modeStatusDot");
var modeText = document.getElementById("modeStatusText");
var openVaultBtn = document.getElementById("openVaultBtn");
var ctx = canvas.getContext("2d");
if (openVaultBtn) {
  openVaultBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
  });
}
var SERVER_PROVIDER_URL = "http://localhost:3000/provider";
function updateModeUI(mode, customText) {
  if (mode === "offline") {
    if (modeSelect)
      modeSelect.value = "offline";
    if (modeBadge) {
      modeBadge.style.background = "#f0fdf4";
      modeBadge.style.color = "#15803d";
      modeBadge.style.borderColor = "#bbf7d0";
    }
    if (modeDot)
      modeDot.style.background = "#16a34a";
    if (modeText)
      modeText.textContent = customText || "OFFLINE MODE (Local Ollama \u2014 no network required)";
  } else {
    if (modeSelect)
      modeSelect.value = "cloud";
    if (modeBadge) {
      modeBadge.style.background = "#e0f2fe";
      modeBadge.style.color = "#0369a1";
      modeBadge.style.borderColor = "#bae6fd";
    }
    if (modeDot)
      modeDot.style.background = "#0284c7";
    if (modeText)
      modeText.textContent = customText || "CLOUD MODE (Groq)";
  }
}
async function fetchProviderStatus() {
  try {
    const res = await fetch(SERVER_PROVIDER_URL);
    if (res.ok) {
      const data = await res.json();
      updateModeUI(data.mode, data.statusText);
    }
  } catch (err) {
    console.warn("[Popup] Could not fetch provider status from server:", err.message);
  }
}
async function setProviderMode(mode) {
  try {
    const res = await fetch(SERVER_PROVIDER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode })
    });
    if (res.ok) {
      const data = await res.json();
      updateModeUI(data.mode, data.statusText);
      setStatus(false, `[MODE] Active provider switched to ${data.provider}`);
    } else {
      throw new Error(`Server returned HTTP ${res.status}`);
    }
  } catch (err) {
    console.error("[Popup] Failed to switch provider mode:", err);
    setStatus(true, `[MODE ERROR] Failed to switch provider: ${err.message}`);
    fetchProviderStatus();
  }
}
if (modeSelect) {
  modeSelect.addEventListener("change", (e) => {
    setProviderMode(e.target.value);
  });
}
fetchProviderStatus();
var STAGES = ["capture", "detect", "redact", "send", "act"];
function setPipelineStage(activeStage) {
  let passed = true;
  for (const stage of STAGES) {
    const el = document.getElementById(`stage-${stage}`);
    if (!el)
      continue;
    el.className = "stage";
    if (stage === activeStage) {
      el.classList.add("active");
      passed = false;
    } else if (passed) {
      el.classList.add("done");
    }
  }
}
function resetPipeline() {
  for (const stage of STAGES) {
    const el = document.getElementById(`stage-${stage}`);
    if (el)
      el.className = "stage";
  }
}
function setStatus(isError, text) {
  statusEl.style.display = "block";
  statusEl.className = isError ? "error" : "";
  statusEl.textContent = text;
}
function resetCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  canvasWrap.style.display = "none";
  legendEl.style.display = "none";
  piiTable.style.display = "none";
  piiTable.innerHTML = "";
  const metricsPanel = document.getElementById("metricsPanel");
  if (metricsPanel)
    metricsPanel.style.display = "none";
  const leakPanel = document.getElementById("leakPanel");
  if (leakPanel) {
    leakPanel.style.display = "none";
    leakPanel.className = "";
    leakPanel.id = "leakPanel";
  }
  const leakText = document.getElementById("leakPanelText");
  if (leakText)
    leakText.textContent = "Awaiting redaction\u2026";
  resetPipeline();
  clearPlanSteps();
  const progressWrap = document.getElementById("modelLoadWrap");
  if (progressWrap)
    progressWrap.style.display = "none";
}
function clearPlanSteps() {
  const el = document.getElementById("planStepList");
  if (el) {
    el.innerHTML = "";
    el.style.display = "none";
  }
}
function upsertPlanStep(stepNum, totalSteps, status, message) {
  let listEl = document.getElementById("planStepList");
  if (!listEl) {
    listEl = document.createElement("div");
    listEl.id = "planStepList";
    listEl.style.cssText = [
      "margin-top:6px",
      "border-radius:4px",
      "overflow:hidden",
      "border:1px solid #e2e8f0",
      "font-size:11px",
      "font-family:monospace"
    ].join(";");
    statusEl.insertAdjacentElement("afterend", listEl);
  }
  listEl.style.display = "block";
  const id = `plan-step-${stepNum}`;
  let row = document.getElementById(id);
  if (!row) {
    row = document.createElement("div");
    row.id = id;
    row.style.cssText = "display:flex;align-items:flex-start;gap:6px;padding:4px 8px;border-bottom:1px solid #e2e8f0;";
    listEl.appendChild(row);
  }
  const icons = { running: "\u23F3", ok: "\u2713", error: "\u2717", summary: "\u{1F4CB}" };
  const colors = { running: "#64748b", ok: "#16a34a", error: "#dc2626", summary: "#0369a1" };
  const icon = icons[status] || "\xB7";
  const color = colors[status] || "#334155";
  row.style.color = color;
  row.style.background = status === "error" ? "#fef2f2" : status === "ok" ? "#f0fdf4" : status === "summary" ? "#eff6ff" : "transparent";
  row.innerHTML = `<span style="flex-shrink:0;font-weight:bold">${icon}</span><span style="white-space:pre-wrap">${message}</span>`;
}
function drawVisionLayer(detections, scale) {
  for (const det of detections) {
    const [x, y, w, h] = det.bbox.map((v) => Math.round(v * scale));
    const isRegion = det.type === "region";
    ctx.lineWidth = 1;
    ctx.strokeStyle = isRegion ? "rgba(34,197,94,0.55)" : "rgba(96,165,250,0.55)";
    ctx.strokeRect(x, y, w, h);
  }
}
function drawPIILayer(sensitiveRegions, scale) {
  for (const r of sensitiveRegions) {
    const [rx, ry, rw, rh] = r.bbox.map((v) => Math.round(v * scale));
    const colors = PII_COLORS[r.type] ?? PII_COLORS.OTHER_PII;
    ctx.fillStyle = colors.fill;
    ctx.fillRect(rx, ry, rw, rh);
    ctx.strokeStyle = colors.stroke;
    ctx.lineWidth = 2;
    ctx.strokeRect(rx, ry, rw, rh);
    const label = `${r.type}`;
    ctx.font = "bold 10px system-ui";
    const tw = ctx.measureText(label).width + 8;
    ctx.fillStyle = colors.stroke;
    ctx.fillRect(rx, Math.max(0, ry - 17), tw, 17);
    ctx.fillStyle = colors.text;
    ctx.fillText(label, rx + 4, Math.max(11, ry - 3));
  }
}
function renderPIITable(sensitiveRegions) {
  if (sensitiveRegions.length === 0)
    return;
  const byType = {};
  for (const r of sensitiveRegions) {
    (byType[r.type] ??= []).push(r);
  }
  let html = '<table style="width:100%;border-collapse:collapse;font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">';
  html += '<tr style="border-bottom:1px solid #cbd5e1;background:#f8fafc"><th style="text-align:left;padding:6px 8px;color:#475569;font-weight:600">Type</th><th style="text-align:right;padding:6px 8px;color:#475569;font-weight:600">Count</th><th style="text-align:right;padding:6px 8px;color:#475569;font-weight:600">Avg Conf</th><th style="text-align:right;padding:6px 8px;color:#475569;font-weight:600">Sources</th></tr>';
  for (const [type, rr] of Object.entries(byType)) {
    const color = PII_COLORS[type]?.stroke ?? "#64748b";
    const fill = PII_COLORS[type]?.fill ?? "rgba(100,116,139,0.15)";
    const avgConf = (rr.reduce((s, r) => s + r.confidence, 0) / rr.length * 100).toFixed(0);
    const sources = [...new Set(rr.map((r) => r.source))].join(", ");
    html += `<tr style="border-bottom:1px solid #e2e8f0">
      <td style="padding:6px 8px">
        <span style="display:inline-block;padding:2px 6px;border-radius:3px;background:${fill};border:1px solid ${color};color:${color};font-weight:700;font-size:10px">${type}</span>
      </td>
      <td style="text-align:right;padding:6px 8px;color:#0f172a;font-weight:600">${rr.length}</td>
      <td style="text-align:right;padding:6px 8px;color:#334155">${avgConf}%</td>
      <td style="text-align:right;padding:6px 8px;color:#64748b;font-size:10px">${sources}</td>
    </tr>`;
  }
  html += "</table>";
  piiTable.innerHTML = html;
  piiTable.style.display = "block";
}
async function renderResults(screenshotDataUrl, detections, sensitiveRegions) {
  const img = new Image();
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = rej;
    img.src = screenshotDataUrl;
  });
  const maxW = canvas.offsetWidth || 400;
  const scale = maxW / img.naturalWidth;
  canvas.width = maxW;
  canvas.height = Math.round(img.naturalHeight * scale);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  drawVisionLayer(detections, scale);
  drawPIILayer(sensitiveRegions, scale);
  canvasWrap.style.display = "block";
  legendEl.style.display = "flex";
}
function startAnalysis(isDemo = false) {
  const mode = isDemo ? "Demo Mode" : "Execute";
  console.log(`[Popup] startAnalysis(${mode}) initiated. Current state:`, {
    task: taskInput ? taskInput.value : "",
    time: (/* @__PURE__ */ new Date()).toISOString()
  });
  analyzeBtn.disabled = true;
  if (demoBtn)
    demoBtn.disabled = true;
  resetCanvas();
  setPipelineStage("capture");
  setStatus(false, `[INIT] Starting ${mode}... Connecting to background...`);
  let port;
  try {
    port = chrome.runtime.connect({ name: "analyze" });
    console.log("[Popup] chrome.runtime.connect port established:", port);
  } catch (err) {
    console.error("[Popup Error][Port Connection]:", err);
    setStatus(true, `[PORT ERROR] Connection failed: ${err.message}`);
    analyzeBtn.disabled = false;
    if (demoBtn)
      demoBtn.disabled = false;
    return;
  }
  const instruction = taskInput ? taskInput.value.trim() : "";
  const initialPayload = {
    type: isDemo ? "START_DEMO_RUN" : "ANALYZE_SCREEN",
    instruction: instruction || void 0
  };
  try {
    port.postMessage(initialPayload);
    console.log("[Popup] Dispatched initial message to background:", initialPayload);
  } catch (err) {
    console.error("[Popup Error][Post Message]:", err);
    setStatus(true, `[POST ERROR] Failed to send message: ${err.message}`);
    analyzeBtn.disabled = false;
    if (demoBtn)
      demoBtn.disabled = false;
    return;
  }
  port.onMessage.addListener(async (msg) => {
    console.log("[Popup] Received message from background:", msg.type, msg);
    switch (msg.type) {
      case "STATUS":
        setStatus(false, msg.text);
        break;
      case "STAGE_CHANGE":
        setPipelineStage(msg.stage);
        setStatus(false, `[${msg.stage.toUpperCase()}] ${msg.text}`);
        break;
      case "DOM_SCAN_DONE":
        setStatus(false, `[DOM] Found ${msg.count} sensitive DOM field(s)`);
        break;
      case "MODEL_PROGRESS": {
        const progressWrap = document.getElementById("modelLoadWrap");
        const progressPct = document.getElementById("modelLoadPct");
        const progressFile = document.getElementById("modelLoadFile");
        const progressBar = document.getElementById("modelLoadProgress");
        if (progressWrap)
          progressWrap.style.display = "block";
        const fileName = msg.file ? msg.file.split("/").pop() : "model weights";
        if (progressFile)
          progressFile.textContent = fileName;
        if (progressPct)
          progressPct.textContent = `${msg.percent || 0}%`;
        if (progressBar)
          progressBar.value = msg.percent || 0;
        setStatus(false, `[MODEL] Downloading ${fileName} (${msg.percent || 0}%)...`);
        break;
      }
      case "MODEL_READY": {
        const progressWrap = document.getElementById("modelLoadWrap");
        if (progressWrap)
          progressWrap.style.display = "none";
        setStatus(false, "[MODEL] Model loaded and ready in memory.");
        break;
      }
      case "MODEL_ERROR": {
        const progressWrap = document.getElementById("modelLoadWrap");
        if (progressWrap)
          progressWrap.style.display = "none";
        console.error("[Popup Error][Model Load]:", msg.error);
        setStatus(true, `[MODEL ERROR] ${msg.error}`);
        analyzeBtn.disabled = false;
        if (demoBtn)
          demoBtn.disabled = false;
        break;
      }
      case "PLAN_STEP_STATUS": {
        upsertPlanStep(msg.stepNum, msg.totalSteps, msg.status, msg.message);
        setStatus(msg.status === "error" ? true : false, msg.message);
        break;
      }
      case "PLAN_SUMMARY": {
        const isAllOk = msg.failed === 0;
        const summaryText = msg.total === 0 ? `[DONE] ${msg.message}` : isAllOk ? `[DONE] ${msg.message}` : `[PARTIAL] ${msg.message}`;
        setStatus(!isAllOk && msg.failed > 0, summaryText);
        upsertPlanStep("summary", msg.total, "summary", summaryText);
        analyzeBtn.disabled = false;
        if (demoBtn)
          demoBtn.disabled = false;
        break;
      }
      case "ANALYSIS_RESULT": {
        const { detections, sensitiveRegions, screenshotDataUrl, elapsed, serverResult } = msg;
        const piiCount = sensitiveRegions?.length ?? 0;
        const planSteps = serverResult?.plan?.length ?? 0;
        setStatus(
          false,
          `[DETECTED] ${piiCount} PII region(s) in ${elapsed || 0}ms \u2014 executing ${planSteps} step plan\u2026`
        );
        setPipelineStage("act");
        if (screenshotDataUrl) {
          try {
            await renderResults(screenshotDataUrl, detections ?? [], sensitiveRegions ?? []);
          } catch (renderErr) {
            console.error("[Popup Error][Render Results]:", renderErr);
            setStatus(true, `[RENDER ERROR] ${renderErr.message}`);
          }
        }
        renderPIITable(sensitiveRegions ?? []);
        if (planSteps === 0) {
          analyzeBtn.disabled = false;
          if (demoBtn)
            demoBtn.disabled = false;
        }
        break;
      }
      case "METRICS": {
        const metricsPanel = document.getElementById("metricsPanel");
        if (!metricsPanel)
          break;
        metricsPanel.style.display = "block";
        const fmtBytes = (b) => b >= 1048576 ? (b / 1048576).toFixed(2) + " MB" : b >= 1024 ? (b / 1024).toFixed(1) + " KB" : b + " B";
        const rawEl = document.getElementById("metric-raw");
        const sentEl = document.getElementById("metric-sent");
        const redEl = document.getElementById("metric-reduction");
        const surEl = document.getElementById("metric-surface");
        const noteEl = document.getElementById("metric-note");
        if (rawEl)
          rawEl.textContent = fmtBytes(msg.raw_bytes);
        if (sentEl)
          sentEl.textContent = fmtBytes(msg.sent_bytes);
        const byteRedPct = msg.reduction_percent;
        if (redEl) {
          if (byteRedPct >= 0) {
            redEl.textContent = `\u2212${byteRedPct.toFixed(1)}% sent`;
            redEl.className = "metric-value good";
          } else {
            redEl.textContent = `+${(-byteRedPct).toFixed(1)}% overhead`;
            redEl.className = "metric-value warn";
          }
        }
        if (surEl) {
          if (msg.pii_regions > 0) {
            surEl.textContent = `${msg.pii_surface_percent.toFixed(1)}% area`;
            surEl.className = "metric-value good";
          } else {
            surEl.textContent = "N/A (no PII)";
            surEl.className = "metric-value";
          }
        }
        if (noteEl) {
          if (msg.pii_regions > 0) {
            noteEl.textContent = `${msg.pii_regions} sensitive region(s) covering ~${msg.pii_surface_percent.toFixed(2)}% of image area were never transmitted in readable form.`;
          } else {
            const note = byteRedPct >= 0 ? `Raw capture: ${fmtBytes(msg.raw_bytes)} \u2192 sent payload: ${fmtBytes(msg.sent_bytes)} (${byteRedPct.toFixed(1)}% reduction via redaction + schema encoding).` : `Note: JSON encoding adds overhead vs. raw PNG. No PII was detected on this page.`;
            noteEl.textContent = note;
          }
        }
        break;
      }
      case "LEAK_CHECK": {
        const leakPanel = document.getElementById("leakPanel");
        const leakText = document.getElementById("leakPanelText");
        if (!leakPanel)
          break;
        leakPanel.style.display = "block";
        leakPanel.className = "";
        if (msg.warning) {
          leakPanel.classList.add("warn");
        } else if (msg.passed) {
          leakPanel.classList.add("pass");
        } else {
          leakPanel.classList.add("fail");
        }
        if (leakText)
          leakText.textContent = msg.message;
        break;
      }
      case "PROMPT_USER_INPUT": {
        const promptCard = document.getElementById("userInputPromptCard");
        const titleEl = document.getElementById("promptCardTitle");
        const inputEl = document.getElementById("promptCardInput");
        const saveCheck = document.getElementById("promptCardSaveDefault");
        const submitBtn = document.getElementById("promptCardSubmitBtn");
        const skipBtn = document.getElementById("promptCardSkipBtn");
        if (promptCard && titleEl && inputEl) {
          promptCard.style.display = "block";
          titleEl.textContent = `No value found for ${msg.fieldType || "field"} \u2014 enter one now?`;
          inputEl.value = "";
          inputEl.placeholder = `Enter ${msg.fieldType || "value"}...`;
          inputEl.focus();
          const handleSubmit = () => {
            const val = inputEl.value.trim();
            const saveToVault = Boolean(saveCheck?.checked);
            promptCard.style.display = "none";
            cleanup();
            port.postMessage({
              type: "USER_INPUT_PROVIDED",
              stepNum: msg.stepNum,
              value: val,
              saveToVault,
              fieldType: msg.fieldType
            });
            setStatus(false, `Provided value for ${msg.fieldType}: "${val}" (save default: ${saveToVault})`);
          };
          const handleSkip = () => {
            promptCard.style.display = "none";
            cleanup();
            port.postMessage({
              type: "USER_INPUT_PROVIDED",
              stepNum: msg.stepNum,
              value: null,
              saveToVault: false,
              fieldType: msg.fieldType
            });
            setStatus(true, `Skipped step for ${msg.fieldType}`);
          };
          const cleanup = () => {
            submitBtn?.removeEventListener("click", handleSubmit);
            skipBtn?.removeEventListener("click", handleSkip);
          };
          submitBtn?.addEventListener("click", handleSubmit);
          skipBtn?.addEventListener("click", handleSkip);
        }
        break;
      }
      case "_STEP6_COMPLETE": {
        analyzeBtn.disabled = false;
        if (demoBtn)
          demoBtn.disabled = false;
        break;
      }
      case "ERROR": {
        console.error("[Popup Error][Pipeline Step Failed]:", msg.step, msg.error);
        setStatus(true, `[ERROR in ${msg.step || "Pipeline"}] ${msg.error}`);
        analyzeBtn.disabled = false;
        if (demoBtn)
          demoBtn.disabled = false;
        break;
      }
    }
  });
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    if (err) {
      console.error("[Popup Error][Port Disconnected]:", err.message);
      setStatus(true, `[SW DISCONNECTED] Service worker terminated: ${err.message}`);
    } else {
      console.log("[Popup] Port disconnected cleanly.");
    }
    analyzeBtn.disabled = false;
    if (demoBtn)
      demoBtn.disabled = false;
  });
}
analyzeBtn.addEventListener("click", () => {
  console.log("[Popup] >>> EXECUTE BUTTON CLICKED! <<< Timestamp:", Date.now());
  startAnalysis(false);
});
if (demoBtn) {
  demoBtn.addEventListener("click", () => {
    console.log("[Popup] >>> DEMO MODE BUTTON CLICKED! <<< Timestamp:", Date.now());
    startAnalysis(true);
  });
}
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsic3JjL3BpaS5qcyIsICJzcmMvcG9wdXAuanMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbIi8qKlxuICogcGlpLmpzIFx1MjAxNCBQSUkgKFBlcnNvbmFsbHkgSWRlbnRpZmlhYmxlIEluZm9ybWF0aW9uKSBEZXRlY3Rpb24gTW9kdWxlXG4gKlxuICogZGV0ZWN0U2Vuc2l0aXZlUmVnaW9ucyh7IGRvbVJlZ2lvbnMsIG9jckRldGVjdGlvbnMsIGZhY2VEZXRlY3Rpb25zIH0pXG4gKiAgIFx1MjE5MiBTZW5zaXRpdmVSZWdpb25bXVxuICpcbiAqIFNlbnNpdGl2ZVJlZ2lvbiBzY2hlbWE6XG4gKiAgIHtcbiAqICAgICBiYm94OiAgICAgICBbeCwgeSwgdywgaF0sICAgICAgICAgIC8vIHBpeGVsIGNvb3JkcyBtYXRjaGluZyB0aGUgc2NyZWVuc2hvdFxuICogICAgIHR5cGU6ICAgICAgIFBJSV9UWVBFLiosXG4gKiAgICAgY29uZmlkZW5jZTogbnVtYmVyLCAgICAgICAgICAgICAgICAgIC8vIDBcdTIwMTMxXG4gKiAgICAgc291cmNlOiAgICAgXCJkb21cInxcIm9jcl9yZWdleFwifFwidmlzaW9uXCJ8XCJkb20rb2NyX3JlZ2V4XCIsXG4gKiAgICAgbWF0Y2hlZD86ICAgc3RyaW5nLCAgICAgICAgICAgICAgICAgIC8vIHRoZSBtYXRjaGVkIHRleHQgc25pcHBldCAoZGVidWcpXG4gKiAgICAgbHVoblZhbGlkPzogYm9vbGVhbiwgICAgICAgICAgICAgICAgIC8vIGZvciBDQVJEIHR5cGVcbiAqICAgfVxuICovXG5cbi8vIFx1MjUwMFx1MjUwMCBQSUkgdHlwZSBjb25zdGFudHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5leHBvcnQgY29uc3QgUElJX1RZUEUgPSBPYmplY3QuZnJlZXplKHtcbiAgUEFTU1dPUkQ6ICAgICAgXCJQQVNTV09SRFwiLFxuICBFTUFJTDogICAgICAgICBcIkVNQUlMXCIsXG4gIFBIT05FOiAgICAgICAgIFwiUEhPTkVcIixcbiAgQ0FSRDogICAgICAgICAgXCJDQVJEXCIsXG4gIEZBQ0U6ICAgICAgICAgIFwiRkFDRVwiLFxuICBOQU1FOiAgICAgICAgICBcIk5BTUVcIixcbiAgQUFESEFBUjogICAgICAgXCJBQURIQUFSXCIsXG4gIFBBTjogICAgICAgICAgIFwiUEFOXCIsXG4gIEdTVElOOiAgICAgICAgIFwiR1NUSU5cIixcbiAgSUZTQzogICAgICAgICAgXCJJRlNDXCIsXG4gIElORElBTl9NT0JJTEU6IFwiSU5ESUFOX01PQklMRVwiLFxuICBPVEhFUl9QSUk6ICAgICBcIk9USEVSX1BJSVwiLFxufSk7XG5cbi8vIFJlbmRlcmluZyBjb2xvdXJzIHVzZWQgYnkgcG9wdXAgYW5kIHRlc3QgaGFybmVzcyAoZXhwb3J0ZWQgZm9yIHJldXNlKVxuZXhwb3J0IGNvbnN0IFBJSV9DT0xPUlMgPSB7XG4gIFBBU1NXT1JEOiAgICAgIHsgZmlsbDogXCJyZ2JhKDIyMCwzOCwzOCwwLjM1KVwiLCAgIHN0cm9rZTogXCIjZWY0NDQ0XCIsIHRleHQ6IFwiI2ZmZlwiIH0sXG4gIEVNQUlMOiAgICAgICAgIHsgZmlsbDogXCJyZ2JhKDIzNCw4OCwxMiwwLjM1KVwiLCAgIHN0cm9rZTogXCIjZjk3MzE2XCIsIHRleHQ6IFwiI2ZmZlwiIH0sXG4gIFBIT05FOiAgICAgICAgIHsgZmlsbDogXCJyZ2JhKDIwMiwxMzgsNCwwLjM1KVwiLCAgIHN0cm9rZTogXCIjZWFiMzA4XCIsIHRleHQ6IFwiIzAwMFwiIH0sXG4gIENBUkQ6ICAgICAgICAgIHsgZmlsbDogXCJyZ2JhKDIxOSwzOSwxMTksMC4zNSlcIiwgIHN0cm9rZTogXCIjZWM0ODk5XCIsIHRleHQ6IFwiI2ZmZlwiIH0sXG4gIEZBQ0U6ICAgICAgICAgIHsgZmlsbDogXCJyZ2JhKDgsMTQ1LDE3OCwwLjM1KVwiLCAgIHN0cm9rZTogXCIjMDZiNmQ0XCIsIHRleHQ6IFwiI2ZmZlwiIH0sXG4gIE5BTUU6ICAgICAgICAgIHsgZmlsbDogXCJyZ2JhKDE0Nyw1MSwyMzQsMC4zNSlcIiwgIHN0cm9rZTogXCIjYTg1NWY3XCIsIHRleHQ6IFwiI2ZmZlwiIH0sXG4gIEFBREhBQVI6ICAgICAgIHsgZmlsbDogXCJyZ2JhKDIzNCw4OCwxMiwwLjM1KVwiLCAgIHN0cm9rZTogXCIjZWE1ODBjXCIsIHRleHQ6IFwiI2ZmZlwiIH0sIC8vIFNhZmZyb24gLyBEZWVwIE9yYW5nZVxuICBQQU46ICAgICAgICAgICB7IGZpbGw6IFwicmdiYSgxNiwxODUsMTI5LDAuMzUpXCIsICBzdHJva2U6IFwiIzEwYjk4MVwiLCB0ZXh0OiBcIiNmZmZcIiB9LCAvLyBFbWVyYWxkXG4gIEdTVElOOiAgICAgICAgIHsgZmlsbDogXCJyZ2JhKDk5LDEwMiwyNDEsMC4zNSlcIiwgIHN0cm9rZTogXCIjNjM2NmYxXCIsIHRleHQ6IFwiI2ZmZlwiIH0sIC8vIEluZGlnb1xuICBJRlNDOiAgICAgICAgICB7IGZpbGw6IFwicmdiYSgxNCwxNjUsMjMzLDAuMzUpXCIsICBzdHJva2U6IFwiIzBlYTVlOVwiLCB0ZXh0OiBcIiNmZmZcIiB9LCAvLyBDeWFuIC8gU2t5XG4gIElORElBTl9NT0JJTEU6IHsgZmlsbDogXCJyZ2JhKDIzNCwxNzksOCwwLjM1KVwiLCAgc3Ryb2tlOiBcIiNjYThhMDRcIiwgdGV4dDogXCIjMDAwXCIgfSwgLy8gQW1iZXIgR29sZFxuICBPVEhFUl9QSUk6ICAgICB7IGZpbGw6IFwicmdiYSgxMDAsMTE2LDEzOSwwLjM1KVwiLCBzdHJva2U6IFwiIzY0NzQ4YlwiLCB0ZXh0OiBcIiNmZmZcIiB9LFxufTtcblxuLy8gXHUyNTAwXHUyNTAwIFZlcmhvZWZmIEFsZ29yaXRobSBUYWJsZXMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5jb25zdCBWRVJIT0VGRl9EID0gW1xuICBbMCwgMSwgMiwgMywgNCwgNSwgNiwgNywgOCwgOV0sXG4gIFsxLCAyLCAzLCA0LCAwLCA2LCA3LCA4LCA5LCA1XSxcbiAgWzIsIDMsIDQsIDAsIDEsIDcsIDgsIDksIDUsIDZdLFxuICBbMywgNCwgMCwgMSwgMiwgOCwgOSwgNSwgNiwgN10sXG4gIFs0LCAwLCAxLCAyLCAzLCA5LCA1LCA2LCA3LCA4XSxcbiAgWzUsIDksIDgsIDcsIDYsIDAsIDQsIDMsIDIsIDFdLFxuICBbNiwgNSwgOSwgOCwgNywgMSwgMCwgNCwgMywgMl0sXG4gIFs3LCA2LCA1LCA5LCA4LCAyLCAxLCAwLCA0LCAzXSxcbiAgWzgsIDcsIDYsIDUsIDksIDMsIDIsIDEsIDAsIDRdLFxuICBbOSwgOCwgNywgNiwgNSwgNCwgMywgMiwgMSwgMF1cbl07XG5cbmNvbnN0IFZFUkhPRUZGX1AgPSBbXG4gIFswLCAxLCAyLCAzLCA0LCA1LCA2LCA3LCA4LCA5XSxcbiAgWzEsIDUsIDcsIDYsIDIsIDgsIDMsIDAsIDksIDRdLFxuICBbNSwgOCwgMCwgMywgNywgOSwgNiwgMSwgNCwgMl0sXG4gIFs4LCA5LCAxLCA2LCAwLCA0LCAzLCA1LCAyLCA3XSxcbiAgWzksIDQsIDUsIDMsIDEsIDIsIDYsIDgsIDcsIDBdLFxuICBbNCwgMiwgOCwgNiwgNSwgNywgMywgOSwgMCwgMV0sXG4gIFsyLCA3LCA5LCAzLCA4LCAwLCA2LCA0LCAxLCA1XSxcbiAgWzcsIDAsIDQsIDYsIDksIDEsIDMsIDIsIDUsIDhdXG5dO1xuXG5leHBvcnQgZnVuY3Rpb24gdmVyaG9lZmZDaGVjayhyYXcpIHtcbiAgaWYgKHR5cGVvZiByYXcgIT09IFwic3RyaW5nXCIpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgZGlnaXRzID0gcmF3LnJlcGxhY2UoL1xcRC9nLCBcIlwiKTtcbiAgaWYgKCFkaWdpdHMpIHJldHVybiBmYWxzZTtcbiAgbGV0IGMgPSAwO1xuICBjb25zdCByZXZlcnNlZCA9IGRpZ2l0cy5zcGxpdChcIlwiKS5yZXZlcnNlKCkubWFwKE51bWJlcik7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgcmV2ZXJzZWQubGVuZ3RoOyBpKyspIHtcbiAgICBjID0gVkVSSE9FRkZfRFtjXVtWRVJIT0VGRl9QW2kgJSA4XVtyZXZlcnNlZFtpXV1dO1xuICB9XG4gIHJldHVybiBjID09PSAwO1xufVxuXG4vLyBcdTI1MDBcdTI1MDAgU3RydWN0dXJhbCBWYWxpZGF0b3JzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuXG4vKipcbiAqIEFBREhBQVI6IGV4YWN0bHkgMTIgZGlnaXRzLCBmaXJzdCBkaWdpdCAxLTkgZXhjbHVkaW5nIGxlYWRpbmcgMC8xIChpLmUuIHN0YXJ0cyB3aXRoIDItOSksXG4gKiBjb21tb25seSBncm91cGVkIGluIDRzIChlLmcuIFwiWFhYWCBYWFhYIFhYWFhcIiBvciBcIlhYWFhYWFhYWFhYWFwiKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHZhbGlkYXRlQWFkaGFhcihyYXcpIHtcbiAgaWYgKHR5cGVvZiByYXcgIT09IFwic3RyaW5nXCIpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgY2xlYW5lZCA9IHJhdy5yZXBsYWNlKC9bXFxzXFwtXS9nLCBcIlwiKTtcbiAgaWYgKCEvXlxcZHsxMn0kLy50ZXN0KGNsZWFuZWQpKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGZpcnN0ID0gY2xlYW5lZC5jaGFyQXQoMCk7XG4gIGlmIChmaXJzdCA9PT0gXCIwXCIgfHwgZmlyc3QgPT09IFwiMVwiKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiB0cnVlO1xufVxuXG4vKipcbiAqIFBBTjogZXhhY3RseSAxMCBjaGFyYWN0ZXJzIG1hdGNoaW5nIHBhdHRlcm4gW0EtWl17NX1bMC05XXs0fVtBLVpdezF9XG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB2YWxpZGF0ZVBBTihyYXcpIHtcbiAgaWYgKHR5cGVvZiByYXcgIT09IFwic3RyaW5nXCIpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgY2xlYW5lZCA9IHJhdy50cmltKCkudG9VcHBlckNhc2UoKTtcbiAgaWYgKGNsZWFuZWQubGVuZ3RoICE9PSAxMCkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gL15bQS1aXXs1fVswLTldezR9W0EtWl0kLy50ZXN0KGNsZWFuZWQpO1xufVxuXG4vKipcbiAqIEdTVElOOiAxNSBjaGFyYWN0ZXJzLCBmaXJzdCAyIGRpZ2l0cyBhcmUgYSB2YWxpZCBzdGF0ZSBjb2RlICgwMS0zOCksXG4gKiBjaGFyYWN0ZXJzIDMtMTIgc3RydWN0dXJhbGx5IG1hdGNoIGEgUEFOLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdmFsaWRhdGVHU1RJTihyYXcpIHtcbiAgaWYgKHR5cGVvZiByYXcgIT09IFwic3RyaW5nXCIpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgY2xlYW5lZCA9IHJhdy50cmltKCkudG9VcHBlckNhc2UoKTtcbiAgaWYgKGNsZWFuZWQubGVuZ3RoICE9PSAxNSkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBzdGF0ZUNvZGVTdHIgPSBjbGVhbmVkLnNsaWNlKDAsIDIpO1xuICBpZiAoIS9eXFxkezJ9JC8udGVzdChzdGF0ZUNvZGVTdHIpKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IHN0YXRlQ29kZSA9IHBhcnNlSW50KHN0YXRlQ29kZVN0ciwgMTApO1xuICBpZiAoc3RhdGVDb2RlIDwgMSB8fCBzdGF0ZUNvZGUgPiAzOCkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBwYW5QYXJ0ID0gY2xlYW5lZC5zbGljZSgyLCAxMik7XG4gIGlmICghdmFsaWRhdGVQQU4ocGFuUGFydCkpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgdGFpbCA9IGNsZWFuZWQuc2xpY2UoMTIsIDE1KTtcbiAgcmV0dXJuIC9eWzAtOUEtWl1aWzAtOUEtWl0kLy50ZXN0KHRhaWwpIHx8IC9eWzAtOUEtWl17M30kLy50ZXN0KHRhaWwpO1xufVxuXG4vKipcbiAqIElGU0M6IDExIGNoYXJhY3RlcnMsIHBhdHRlcm4gW0EtWl17NH0wW0EtWjAtOV17Nn0gKDV0aCBjaGFyYWN0ZXIgc3RyaWN0bHkgJzAnKVxuICovXG5leHBvcnQgZnVuY3Rpb24gdmFsaWRhdGVJRlNDKHJhdykge1xuICBpZiAodHlwZW9mIHJhdyAhPT0gXCJzdHJpbmdcIikgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBjbGVhbmVkID0gcmF3LnRyaW0oKS50b1VwcGVyQ2FzZSgpO1xuICBpZiAoY2xlYW5lZC5sZW5ndGggIT09IDExKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiAvXltBLVpdezR9MFtBLVowLTldezZ9JC8udGVzdChjbGVhbmVkKTtcbn1cblxuLyoqXG4gKiBJTkRJQU5fTU9CSUxFOiAxMCBkaWdpdHMgc3RhcnRpbmcgd2l0aCA2LCA3LCA4LCBvciA5LCBvcHRpb25hbGx5IHByZWZpeGVkICs5MSwgOTEsIG9yIDBcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHZhbGlkYXRlSW5kaWFuTW9iaWxlKHJhdykge1xuICBpZiAodHlwZW9mIHJhdyAhPT0gXCJzdHJpbmdcIikgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBjbGVhbmVkID0gcmF3LnRyaW0oKS5yZXBsYWNlKC9bXFxzXFwtXFwoXFwpXS9nLCBcIlwiKTtcbiAgcmV0dXJuIC9eKD86XFwrOTF8OTF8MCk/WzYtOV1cXGR7OX0kLy50ZXN0KGNsZWFuZWQpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDAgTHVobiBhbGdvcml0aG0gZm9yIGNhcmRzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuZnVuY3Rpb24gbHVobkNoZWNrKHJhdykge1xuICBjb25zdCBkaWdpdHMgPSByYXcucmVwbGFjZSgvXFxEL2csIFwiXCIpLnNwbGl0KFwiXCIpLnJldmVyc2UoKS5tYXAoTnVtYmVyKTtcbiAgaWYgKGRpZ2l0cy5sZW5ndGggPCAxNSkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBzdW0gPSBkaWdpdHMucmVkdWNlKChhY2MsIGQsIGkpID0+IHtcbiAgICBpZiAoaSAlIDIgPT09IDEpIHsgZCAqPSAyOyBpZiAoZCA+IDkpIGQgLT0gOTsgfVxuICAgIHJldHVybiBhY2MgKyBkO1xuICB9LCAwKTtcbiAgcmV0dXJuIHN1bSAlIDEwID09PSAwO1xufVxuXG4vLyBcdTI1MDBcdTI1MDAgSW9VIGhlbHBlciBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbmZ1bmN0aW9uIGlvdShhLCBiKSB7XG4gIGNvbnN0IFtheCwgYXksIGF3LCBhaF0gPSBhLmJib3g7XG4gIGNvbnN0IFtieCwgYnksIGJ3LCBiaF0gPSBiLmJib3g7XG4gIGNvbnN0IGl4ID0gTWF0aC5tYXgoYXgsIGJ4KTtcbiAgY29uc3QgaXkgPSBNYXRoLm1heChheSwgYnkpO1xuICBjb25zdCBpdyA9IE1hdGgubWluKGF4ICsgYXcsIGJ4ICsgYncpIC0gaXg7XG4gIGNvbnN0IGloID0gTWF0aC5taW4oYXkgKyBhaCwgYnkgKyBiaCkgLSBpeTtcbiAgaWYgKGl3IDw9IDAgfHwgaWggPD0gMCkgcmV0dXJuIDA7XG4gIGNvbnN0IGludGVyc2VjdGlvbiA9IGl3ICogaWg7XG4gIGNvbnN0IHVuaW9uID0gYXcgKiBhaCArIGJ3ICogYmggLSBpbnRlcnNlY3Rpb247XG4gIHJldHVybiB1bmlvbiA+IDAgPyBpbnRlcnNlY3Rpb24gLyB1bmlvbiA6IDA7XG59XG5cbi8vIFx1MjUwMFx1MjUwMCBNZXJnZSBvdmVybGFwcGluZyBkZXRlY3Rpb25zIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuY29uc3QgSU9VX1RIUkVTSE9MRCA9IDAuMjU7XG5cbmZ1bmN0aW9uIG1lcmdlUmVnaW9ucyhyZWdpb25zKSB7XG4gIGNvbnN0IG1lcmdlZCA9IFtdO1xuICBjb25zdCB1c2VkICAgPSBuZXcgU2V0KCk7XG5cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCByZWdpb25zLmxlbmd0aDsgaSsrKSB7XG4gICAgaWYgKHVzZWQuaGFzKGkpKSBjb250aW51ZTtcbiAgICBjb25zdCBjbHVzdGVyID0gW3JlZ2lvbnNbaV1dO1xuICAgIHVzZWQuYWRkKGkpO1xuXG4gICAgZm9yIChsZXQgaiA9IGkgKyAxOyBqIDwgcmVnaW9ucy5sZW5ndGg7IGorKykge1xuICAgICAgaWYgKHVzZWQuaGFzKGopKSBjb250aW51ZTtcbiAgICAgIGlmIChpb3UocmVnaW9uc1tpXSwgcmVnaW9uc1tqXSkgPj0gSU9VX1RIUkVTSE9MRCkge1xuICAgICAgICBjbHVzdGVyLnB1c2gocmVnaW9uc1tqXSk7XG4gICAgICAgIHVzZWQuYWRkKGopO1xuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChjbHVzdGVyLmxlbmd0aCA9PT0gMSkge1xuICAgICAgbWVyZ2VkLnB1c2goY2x1c3RlclswXSk7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG5cbiAgICAvLyBVbmlvbiBib3VuZGluZyBib3ggYWNyb3NzIGFsbCBjbHVzdGVyIG1lbWJlcnNcbiAgICBjb25zdCB4cyAgICA9IGNsdXN0ZXIuZmxhdE1hcCgocikgPT4gW3IuYmJveFswXSwgci5iYm94WzBdICsgci5iYm94WzJdXSk7XG4gICAgY29uc3QgeXMgICAgPSBjbHVzdGVyLmZsYXRNYXAoKHIpID0+IFtyLmJib3hbMV0sIHIuYmJveFsxXSArIHIuYmJveFszXV0pO1xuICAgIGNvbnN0IG1pblggID0gTWF0aC5taW4oLi4ueHMpLCBtaW5ZID0gTWF0aC5taW4oLi4ueXMpO1xuICAgIGNvbnN0IG1heFggID0gTWF0aC5tYXgoLi4ueHMpLCBtYXhZID0gTWF0aC5tYXgoLi4ueXMpO1xuXG4gICAgY29uc3Qgc291cmNlcyA9IFsuLi5uZXcgU2V0KGNsdXN0ZXIubWFwKChyKSA9PiByLnNvdXJjZSkpXTtcbiAgICAvLyBIaWdoZXN0LXByaW9yaXR5IHNvdXJjZSAoRE9NID4gT0NSID4gdmlzaW9uKVxuICAgIGNvbnN0IHByaW9yaXR5ID0gW1wiZG9tXCIsIFwib2NyX3JlZ2V4XCIsIFwidmlzaW9uXCJdO1xuICAgIC8vIFNwZWNpZmljIEluZGlhbiB0eXBlcyBwcmlvcml0aXplZCBvdmVyIGdlbmVyaWMgZmFsbGJhY2sgdHlwZXNcbiAgICBjb25zdCB0eXBlUHJpb3JpdHkgPSBbXG4gICAgICBQSUlfVFlQRS5QQVNTV09SRCxcbiAgICAgIFBJSV9UWVBFLkNBUkQsXG4gICAgICBQSUlfVFlQRS5BQURIQUFSLFxuICAgICAgUElJX1RZUEUuR1NUSU4sXG4gICAgICBQSUlfVFlQRS5QQU4sXG4gICAgICBQSUlfVFlQRS5JRlNDLFxuICAgICAgUElJX1RZUEUuSU5ESUFOX01PQklMRSxcbiAgICAgIFBJSV9UWVBFLkVNQUlMLFxuICAgICAgUElJX1RZUEUuUEhPTkUsXG4gICAgICBQSUlfVFlQRS5GQUNFLFxuICAgICAgUElJX1RZUEUuTkFNRSxcbiAgICAgIFBJSV9UWVBFLk9USEVSX1BJSSxcbiAgICBdO1xuXG4gICAgY2x1c3Rlci5zb3J0KChhLCBiKSA9PiB7XG4gICAgICBjb25zdCBzcmNEaWZmID0gcHJpb3JpdHkuaW5kZXhPZihhLnNvdXJjZSkgLSBwcmlvcml0eS5pbmRleE9mKGIuc291cmNlKTtcbiAgICAgIGlmIChzcmNEaWZmICE9PSAwKSByZXR1cm4gc3JjRGlmZjtcbiAgICAgIHJldHVybiB0eXBlUHJpb3JpdHkuaW5kZXhPZihhLnR5cGUpIC0gdHlwZVByaW9yaXR5LmluZGV4T2YoYi50eXBlKTtcbiAgICB9KTtcblxuICAgIGNvbnN0IG1heENvbmYgPSBNYXRoLm1heCguLi5jbHVzdGVyLm1hcCgocikgPT4gci5jb25maWRlbmNlKSk7XG4gICAgY29uc3QgYm9vc3RlZCA9IE1hdGgubWluKDEsIG1heENvbmYgKyAoc291cmNlcy5sZW5ndGggLSAxKSAqIDAuMDgpO1xuXG4gICAgbWVyZ2VkLnB1c2goe1xuICAgICAgYmJveDogICAgICAgW21pblgsIG1pblksIG1heFggLSBtaW5YLCBtYXhZIC0gbWluWV0sXG4gICAgICB0eXBlOiAgICAgICBjbHVzdGVyWzBdLnR5cGUsXG4gICAgICBjb25maWRlbmNlOiArYm9vc3RlZC50b0ZpeGVkKDMpLFxuICAgICAgc291cmNlOiAgICAgc291cmNlcy5sZW5ndGggPT09IDEgPyBzb3VyY2VzWzBdIDogc291cmNlcy5qb2luKFwiK1wiKSxcbiAgICAgIF9jbHVzdGVyOiAgIGNsdXN0ZXIubWFwKCh7IHR5cGUsIHNvdXJjZSwgY29uZmlkZW5jZSB9KSA9PiAoeyB0eXBlLCBzb3VyY2UsIGNvbmZpZGVuY2UgfSkpLFxuICAgIH0pO1xuICB9XG5cbiAgcmV0dXJuIG1lcmdlZDtcbn1cblxuLy8gXHUyNTAwXHUyNTAwIFBhc3MgMSBcdTIwMTQgRE9NIHNjYW4gcmVzdWx0cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbmZ1bmN0aW9uIHBhc3NET00oZG9tUmVnaW9ucykge1xuICByZXR1cm4gKGRvbVJlZ2lvbnMgPz8gW10pLm1hcCgocikgPT4gKHtcbiAgICBiYm94OiAgICAgICByLmJib3gsXG4gICAgdHlwZTogICAgICAgci50eXBlLFxuICAgIGNvbmZpZGVuY2U6IHIuY29uZmlkZW5jZSA/PyAxLjAsXG4gICAgc291cmNlOiAgICAgXCJkb21cIixcbiAgfSkpO1xufVxuXG4vLyBcdTI1MDBcdTI1MDAgUGFzcyAyIFx1MjAxNCBPQ1ItcmVnZXggd2l0aCBTdHJ1Y3R1cmFsIFZhbGlkYXRpb24gXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5mdW5jdGlvbiBwYXNzT0NSKG9jckRldGVjdGlvbnMpIHtcbiAgY29uc3QgaGl0cyA9IFtdO1xuXG4gIGZvciAoY29uc3QgZGV0IG9mIG9jckRldGVjdGlvbnMgPz8gW10pIHtcbiAgICBpZiAoZGV0LnR5cGUgIT09IFwidGV4dFwiKSBjb250aW51ZTtcbiAgICBjb25zdCB0ZXh0ID0gZGV0LmxhYmVsX29yX3RleHQgPz8gXCJcIjtcbiAgICBjb25zdCBiYm94ID0gZGV0LmJib3g7XG5cbiAgICAvLyAxLiBHU1RJTiAoMTUgY2hhcnMpIFx1MjAxNCB0ZXN0ZWQgYmVmb3JlIFBBTiBzbyBQQU4gaXMgbm90IGlzb2xhdGVkIGZyb20gYSBHU1RJTlxuICAgIGNvbnN0IGdzdGluTWF0Y2hlcyA9IHRleHQubWF0Y2hBbGwoL1xcYigwWzEtOV18WzEyXVswLTldfDNbMC04XSlbQS1aXXs1fVswLTldezR9W0EtWl1bMC05QS1aXXszfVxcYi9naSk7XG4gICAgZm9yIChjb25zdCBtIG9mIGdzdGluTWF0Y2hlcykge1xuICAgICAgaWYgKHZhbGlkYXRlR1NUSU4obVswXSkpIHtcbiAgICAgICAgaGl0cy5wdXNoKHtcbiAgICAgICAgICBiYm94LCBzb3VyY2U6IFwib2NyX3JlZ2V4XCIsIG1hdGNoZWQ6IG1bMF0udG9VcHBlckNhc2UoKSxcbiAgICAgICAgICB0eXBlOiAgICAgICBQSUlfVFlQRS5HU1RJTixcbiAgICAgICAgICBjb25maWRlbmNlOiAwLjk2LFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyAyLiBQQU4gKDEwIGNoYXJzKVxuICAgIGNvbnN0IHBhbk1hdGNoZXMgPSB0ZXh0Lm1hdGNoQWxsKC9cXGJbQS1aXXs1fVswLTldezR9W0EtWl1cXGIvZ2kpO1xuICAgIGZvciAoY29uc3QgbSBvZiBwYW5NYXRjaGVzKSB7XG4gICAgICBjb25zdCBpc1BhcnRPZkdzdGluID0gaGl0cy5zb21lKGggPT4gaC50eXBlID09PSBQSUlfVFlQRS5HU1RJTiAmJiBoLm1hdGNoZWQ/LmluY2x1ZGVzKG1bMF0udG9VcHBlckNhc2UoKSkpO1xuICAgICAgaWYgKCFpc1BhcnRPZkdzdGluICYmIHZhbGlkYXRlUEFOKG1bMF0pKSB7XG4gICAgICAgIGhpdHMucHVzaCh7XG4gICAgICAgICAgYmJveCwgc291cmNlOiBcIm9jcl9yZWdleFwiLCBtYXRjaGVkOiBtWzBdLnRvVXBwZXJDYXNlKCksXG4gICAgICAgICAgdHlwZTogICAgICAgUElJX1RZUEUuUEFOLFxuICAgICAgICAgIGNvbmZpZGVuY2U6IDAuOTQsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIDMuIEFBREhBQVIgKDEyIGRpZ2l0cywgZ3JvdXBlZCBvciByYXcsIGZpcnN0IGRpZ2l0IDItOSlcbiAgICBjb25zdCBhYWRoYWFyTWF0Y2hlcyA9IHRleHQubWF0Y2hBbGwoL1xcYlsyLTldXFxkezN9W1xcc1xcLV0/WzAtOV17NH1bXFxzXFwtXT9bMC05XXs0fVxcYi9nKTtcbiAgICBmb3IgKGNvbnN0IG0gb2YgYWFkaGFhck1hdGNoZXMpIHtcbiAgICAgIGlmICh2YWxpZGF0ZUFhZGhhYXIobVswXSkpIHtcbiAgICAgICAgY29uc3QgdlZhbGlkID0gdmVyaG9lZmZDaGVjayhtWzBdKTtcbiAgICAgICAgaGl0cy5wdXNoKHtcbiAgICAgICAgICBiYm94LCBzb3VyY2U6IFwib2NyX3JlZ2V4XCIsIG1hdGNoZWQ6IG1bMF0udHJpbSgpLFxuICAgICAgICAgIHZlcmhvZWZmVmFsaWQ6IHZWYWxpZCxcbiAgICAgICAgICB0eXBlOiAgICAgICAgICBQSUlfVFlQRS5BQURIQUFSLFxuICAgICAgICAgIGNvbmZpZGVuY2U6ICAgIHZWYWxpZCA/IDAuOTYgOiAwLjkxLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyA0LiBJRlNDICgxMSBjaGFycywgNXRoIGRpZ2l0ICcwJylcbiAgICBjb25zdCBpZnNjTWF0Y2hlcyA9IHRleHQubWF0Y2hBbGwoL1xcYltBLVpdezR9MFtBLVowLTldezZ9XFxiL2dpKTtcbiAgICBmb3IgKGNvbnN0IG0gb2YgaWZzY01hdGNoZXMpIHtcbiAgICAgIGlmICh2YWxpZGF0ZUlGU0MobVswXSkpIHtcbiAgICAgICAgaGl0cy5wdXNoKHtcbiAgICAgICAgICBiYm94LCBzb3VyY2U6IFwib2NyX3JlZ2V4XCIsIG1hdGNoZWQ6IG1bMF0udG9VcHBlckNhc2UoKSxcbiAgICAgICAgICB0eXBlOiAgICAgICBQSUlfVFlQRS5JRlNDLFxuICAgICAgICAgIGNvbmZpZGVuY2U6IDAuOTQsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIDUuIElORElBTl9NT0JJTEVcbiAgICBjb25zdCBtb2JpbGVNYXRjaGVzID0gdGV4dC5tYXRjaEFsbCgvKD86KD86XFwrOTF8MClbXFxzXFwtXT8pP1s2LTldXFxkezR9W1xcc1xcLV0/XFxkezV9XFxifCg/OlxcKzkxW1xcc1xcLV0/KT9bNi05XVxcZHs5fVxcYnxcXGJbNi05XVxcZHs5fVxcYi9nKTtcbiAgICBmb3IgKGNvbnN0IG0gb2YgbW9iaWxlTWF0Y2hlcykge1xuICAgICAgaWYgKHZhbGlkYXRlSW5kaWFuTW9iaWxlKG1bMF0pKSB7XG4gICAgICAgIGhpdHMucHVzaCh7XG4gICAgICAgICAgYmJveCwgc291cmNlOiBcIm9jcl9yZWdleFwiLCBtYXRjaGVkOiBtWzBdLnRyaW0oKSxcbiAgICAgICAgICB0eXBlOiAgICAgICBQSUlfVFlQRS5JTkRJQU5fTU9CSUxFLFxuICAgICAgICAgIGNvbmZpZGVuY2U6IDAuOTIsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIDYuIEVNQUlMXG4gICAgY29uc3QgZW1haWxNYXRjaGVzID0gdGV4dC5tYXRjaEFsbCgvW2EtekEtWjAtOS5fJStcXC1dK0BbYS16QS1aMC05LlxcLV0rXFwuW2EtekEtWl17Mix9L2cpO1xuICAgIGZvciAoY29uc3QgbSBvZiBlbWFpbE1hdGNoZXMpIHtcbiAgICAgIGhpdHMucHVzaCh7XG4gICAgICAgIGJib3gsIHNvdXJjZTogXCJvY3JfcmVnZXhcIiwgbWF0Y2hlZDogbVswXSxcbiAgICAgICAgdHlwZTogICAgICAgUElJX1RZUEUuRU1BSUwsXG4gICAgICAgIGNvbmZpZGVuY2U6IDAuOTUsXG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyA3LiBHZW5lcmljIFBIT05FIChpZiBub3QgYWxyZWFkeSBtYXRjaGVkIGFzIElORElBTl9NT0JJTEUpXG4gICAgY29uc3QgcGhvbmVNYXRjaGVzID0gdGV4dC5tYXRjaEFsbCgvKD86KD86XFwrOTF8MDA5MXwwKVtcXHNcXC1dPyk/WzYtOV1cXGR7OX18KD86XFwrXFxkezEsM31bXFxzXFwtXT8pP1xcKD9cXGR7Miw0fVxcKT9bXFxzXFwtXT9cXGR7Myw0fVtcXHNcXC1dP1xcZHs0fS9nKTtcbiAgICBmb3IgKGNvbnN0IG0gb2YgcGhvbmVNYXRjaGVzKSB7XG4gICAgICBjb25zdCBkaWdpdHMgPSBtWzBdLnJlcGxhY2UoL1xcRC9nLCBcIlwiKTtcbiAgICAgIGlmIChkaWdpdHMubGVuZ3RoID49IDEwKSB7XG4gICAgICAgIGNvbnN0IGFscmVhZHlNb2JpbGUgPSBoaXRzLnNvbWUoaCA9PiBoLnR5cGUgPT09IFBJSV9UWVBFLklORElBTl9NT0JJTEUgJiYgaC5tYXRjaGVkPy5pbmNsdWRlcyhkaWdpdHMuc2xpY2UoLTEwKSkpO1xuICAgICAgICBpZiAoIWFscmVhZHlNb2JpbGUpIHtcbiAgICAgICAgICBoaXRzLnB1c2goe1xuICAgICAgICAgICAgYmJveCwgc291cmNlOiBcIm9jcl9yZWdleFwiLCBtYXRjaGVkOiBtWzBdLnRyaW0oKSxcbiAgICAgICAgICAgIHR5cGU6ICAgICAgIFBJSV9UWVBFLlBIT05FLFxuICAgICAgICAgICAgY29uZmlkZW5jZTogMC44MixcbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIC8vIDguIENBUkQgbnVtYmVyIHdpdGggTHVobiB2ZXJpZmljYXRpb25cbiAgICBjb25zdCBjYXJkTWF0Y2hlcyA9IHRleHQubWF0Y2hBbGwoL1xcYig/OlxcZHs0fVtcXHNcXC1dPyl7M31cXGR7NH1cXGJ8XFxiXFxkezE1LDE2fVxcYi9nKTtcbiAgICBmb3IgKGNvbnN0IG0gb2YgY2FyZE1hdGNoZXMpIHtcbiAgICAgIGNvbnN0IGRpZ2l0cyA9IG1bMF0ucmVwbGFjZSgvXFxEL2csIFwiXCIpO1xuICAgICAgaWYgKGRpZ2l0cy5sZW5ndGggPj0gMTUpIHtcbiAgICAgICAgY29uc3QgdmFsaWQgPSBsdWhuQ2hlY2soZGlnaXRzKTtcbiAgICAgICAgaGl0cy5wdXNoKHtcbiAgICAgICAgICBiYm94LCBzb3VyY2U6IFwib2NyX3JlZ2V4XCIsIG1hdGNoZWQ6IG1bMF0sIGx1aG5WYWxpZDogdmFsaWQsXG4gICAgICAgICAgdHlwZTogICAgICAgUElJX1RZUEUuQ0FSRCxcbiAgICAgICAgICBjb25maWRlbmNlOiB2YWxpZCA/IDAuOTMgOiAwLjcyLFxuICAgICAgICB9KTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gaGl0cztcbn1cblxuLy8gXHUyNTAwXHUyNTAwIFBhc3MgMyBcdTIwMTQgRmFjZSBkZXRlY3Rpb25zIChmcm9tIEJsYXplRmFjZSkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5mdW5jdGlvbiBwYXNzRmFjZShmYWNlRGV0ZWN0aW9ucykge1xuICByZXR1cm4gKGZhY2VEZXRlY3Rpb25zID8/IFtdKVxuICAgIC5maWx0ZXIoKGYpID0+IHtcbiAgICAgIGNvbnN0IFt4LCB5LCB3LCBoXSA9IGYuYmJveCB8fCBbXTtcbiAgICAgIGlmICghdyB8fCAhaCB8fCB3IDwgMjQgfHwgaCA8IDI0KSByZXR1cm4gZmFsc2U7XG4gICAgICBjb25zdCBhc3BlY3QgPSB3IC8gaDtcbiAgICAgIGlmIChhc3BlY3QgPCAwLjU1IHx8IGFzcGVjdCA+IDEuNDApIHJldHVybiBmYWxzZTtcbiAgICAgIHJldHVybiAoZi5jb25maWRlbmNlID8/IDApID49IDAuODU7XG4gICAgfSlcbiAgICAubWFwKChmKSA9PiAoe1xuICAgICAgYmJveDogICAgICAgZi5iYm94LFxuICAgICAgdHlwZTogICAgICAgUElJX1RZUEUuRkFDRSxcbiAgICAgIGNvbmZpZGVuY2U6ICtOdW1iZXIoZi5jb25maWRlbmNlKS50b0ZpeGVkKDQpLFxuICAgICAgc291cmNlOiAgICAgXCJ2aXNpb25cIixcbiAgICB9KSk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMCBQdWJsaWMgQVBJIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuLyoqXG4gKiBkZXRlY3RTZW5zaXRpdmVSZWdpb25zXG4gKlxuICogQHBhcmFtIHtvYmplY3R9IHBhcmFtc1xuICogQHBhcmFtIHtBcnJheX0gIHBhcmFtcy5kb21SZWdpb25zICAgICBcdTIwMTQgZnJvbSBjb250ZW50LmpzIFNDQU5fRE9NIChwcmUtRFBSLXNjYWxlZClcbiAqIEBwYXJhbSB7QXJyYXl9ICBwYXJhbXMub2NyRGV0ZWN0aW9ucyAgXHUyMDE0IGZyb20gRmxvcmVuY2UtMiBhbmFseXplSW1hZ2UoKVxuICogQHBhcmFtIHtBcnJheX0gIHBhcmFtcy5mYWNlRGV0ZWN0aW9ucyBcdTIwMTQgZnJvbSBmYWNlLmpzIGRldGVjdEZhY2VzKClcbiAqIEByZXR1cm5zIHtTZW5zaXRpdmVSZWdpb25bXX1cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRldGVjdFNlbnNpdGl2ZVJlZ2lvbnMoeyBkb21SZWdpb25zLCBvY3JEZXRlY3Rpb25zLCBmYWNlRGV0ZWN0aW9ucyB9KSB7XG4gIGNvbnNvbGUubG9nKFwiW1BJSV0gPT09IGRldGVjdFNlbnNpdGl2ZVJlZ2lvbnMgSU5WT0tFRCA9PT1cIik7XG4gIGNvbnNvbGUubG9nKGBbUElJXSBSYXcgSW5wdXRzIC0+IGRvbVJlZ2lvbnM6ICR7KGRvbVJlZ2lvbnMgPz8gW10pLmxlbmd0aH0sIG9jckRldGVjdGlvbnM6ICR7KG9jckRldGVjdGlvbnMgPz8gW10pLmxlbmd0aH0sIGZhY2VEZXRlY3Rpb25zOiAkeyhmYWNlRGV0ZWN0aW9ucyA/PyBbXSkubGVuZ3RofWApO1xuXG4gIGNvbnN0IGRvbUhpdHMgID0gcGFzc0RPTShkb21SZWdpb25zKTtcbiAgY29uc3Qgb2NySGl0cyAgPSBwYXNzT0NSKG9jckRldGVjdGlvbnMpO1xuICBjb25zdCBmYWNlSGl0cyA9IHBhc3NGYWNlKGZhY2VEZXRlY3Rpb25zKTtcblxuICBjb25zb2xlLmxvZyhgW1BJSV0gW1NvdXJjZSAxOiBET00gUGFzc10gUmF3IG91dHB1dCAoJHtkb21IaXRzLmxlbmd0aH0gaXRlbXMpOmAsIGRvbUhpdHMpO1xuICBjb25zb2xlLmxvZyhgW1BJSV0gW1NvdXJjZSAyOiBPQ1IgUGFzc10gUmF3IG91dHB1dCAoJHtvY3JIaXRzLmxlbmd0aH0gaXRlbXMpOmAsIG9jckhpdHMpO1xuICBjb25zb2xlLmxvZyhgW1BJSV0gW1NvdXJjZSAzOiBWaXNpb24vRmFjZSBQYXNzXSBSYXcgb3V0cHV0ICgke2ZhY2VIaXRzLmxlbmd0aH0gaXRlbXMpOmAsIGZhY2VIaXRzKTtcblxuICBjb25zdCBhbGwgPSBbLi4uZG9tSGl0cywgLi4ub2NySGl0cywgLi4uZmFjZUhpdHNdO1xuICBjb25zb2xlLmxvZyhgW1BJSV0gQ29tYmluZWQgdW5tZXJnZWQgY2FuZGlkYXRlcyAoJHthbGwubGVuZ3RofSB0b3RhbCBmcm9tIERPTSArIE9DUiArIFZpc2lvbik6YCwgYWxsKTtcblxuICBjb25zdCByZXN1bHQgPSBtZXJnZVJlZ2lvbnMoYWxsKTtcblxuICBjb25zb2xlLmxvZyhcbiAgICBgW1BJSV0gRmluYWwgbWVyZ2VkIHNlbnNpdGl2ZSByZWdpb24ocyk6ICR7cmVzdWx0Lmxlbmd0aH1gICtcbiAgICBgIChkb206JHtkb21IaXRzLmxlbmd0aH0sIG9jcjoke29jckhpdHMubGVuZ3RofSwgZmFjZToke2ZhY2VIaXRzLmxlbmd0aH0pXFxuYCArXG4gICAgSlNPTi5zdHJpbmdpZnkocmVzdWx0LCBudWxsLCAyKVxuICApO1xuXG4gIHJldHVybiByZXN1bHQ7XG59XG5cbiIsICIvKipcbiAqIHBvcHVwLmpzIFx1MjAxNCBQb3B1cCBzY3JpcHQgIChzcmMvcG9wdXAuanMgXHUyMTkyIGJ1aWx0IHBvcHVwLmpzKVxuICpcbiAqIHYwLjI6IHJlbmRlcnMgdHdvIG92ZXJsYXkgbGF5ZXJzIG9uIHRoZSBkZWJ1ZyBjYW52YXM6XG4gKiAgIExheWVyIDEgXHUyMDE0IEZsb3JlbmNlLTIgZGV0ZWN0aW9ucyAoT0Q9Z3JlZW4gb3V0bGluZSwgT0NSPWJsdWUgb3V0bGluZSlcbiAqICAgTGF5ZXIgMiBcdTIwMTQgUElJIHNlbnNpdGl2ZSByZWdpb25zIChmaWxsZWQsIGNvbG91ci1jb2RlZCBwZXIgdHlwZSlcbiAqXG4gKiBBbHNvIHNob3dzIGEgY29tcGFjdCBQSUkgYnJlYWtkb3duIHRhYmxlIGJlbG93IHRoZSBjYW52YXMuXG4gKi9cblxuaW1wb3J0IHsgUElJX0NPTE9SUyB9IGZyb20gXCIuL3BpaS5qc1wiO1xuXG5jb25zdCBhbmFseXplQnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJhbmFseXplQnRuXCIpO1xuY29uc3QgZGVtb0J0biAgICA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwiZGVtb0J0blwiKTtcbmNvbnN0IHRhc2tJbnB1dCAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInRhc2tJbnB1dFwiKTtcbmNvbnN0IHN0YXR1c0VsICAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInN0YXR1c1RleHRcIik7XG5jb25zdCBjYW52YXNXcmFwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJjYW52YXNXcmFwXCIpO1xuY29uc3QgY2FudmFzICAgICA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwiZGVidWdDYW52YXNcIik7XG5jb25zdCBsZWdlbmRFbCAgID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJsZWdlbmRcIik7XG5jb25zdCBwaWlUYWJsZSAgID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJwaWlUYWJsZVwiKTtcbmNvbnN0IG1vZGVTZWxlY3QgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcIm1vZGVTZWxlY3RcIik7XG5jb25zdCBtb2RlQmFkZ2UgID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJtb2RlU3RhdHVzQmFkZ2VcIik7XG5jb25zdCBtb2RlRG90ICAgID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJtb2RlU3RhdHVzRG90XCIpO1xuY29uc3QgbW9kZVRleHQgICA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwibW9kZVN0YXR1c1RleHRcIik7XG5jb25zdCBvcGVuVmF1bHRCdG4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcIm9wZW5WYXVsdEJ0blwiKTtcbmNvbnN0IGN0eCAgICAgICAgPSBjYW52YXMuZ2V0Q29udGV4dChcIjJkXCIpO1xuXG5pZiAob3BlblZhdWx0QnRuKSB7XG4gIG9wZW5WYXVsdEJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xuICAgIGNocm9tZS50YWJzLmNyZWF0ZSh7IHVybDogY2hyb21lLnJ1bnRpbWUuZ2V0VVJMKFwic2V0dGluZ3MuaHRtbFwiKSB9KTtcbiAgfSk7XG59XG5cbmNvbnN0IFNFUlZFUl9QUk9WSURFUl9VUkwgPSBcImh0dHA6Ly9sb2NhbGhvc3Q6MzAwMC9wcm92aWRlclwiO1xuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFByb3ZpZGVyIE1vZGUgU3RhdHVzICYgU3dpdGNoZXJcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuZnVuY3Rpb24gdXBkYXRlTW9kZVVJKG1vZGUsIGN1c3RvbVRleHQpIHtcbiAgaWYgKG1vZGUgPT09IFwib2ZmbGluZVwiKSB7XG4gICAgaWYgKG1vZGVTZWxlY3QpIG1vZGVTZWxlY3QudmFsdWUgPSBcIm9mZmxpbmVcIjtcbiAgICBpZiAobW9kZUJhZGdlKSB7XG4gICAgICBtb2RlQmFkZ2Uuc3R5bGUuYmFja2dyb3VuZCA9IFwiI2YwZmRmNFwiO1xuICAgICAgbW9kZUJhZGdlLnN0eWxlLmNvbG9yID0gXCIjMTU4MDNkXCI7XG4gICAgICBtb2RlQmFkZ2Uuc3R5bGUuYm9yZGVyQ29sb3IgPSBcIiNiYmY3ZDBcIjtcbiAgICB9XG4gICAgaWYgKG1vZGVEb3QpIG1vZGVEb3Quc3R5bGUuYmFja2dyb3VuZCA9IFwiIzE2YTM0YVwiO1xuICAgIGlmIChtb2RlVGV4dCkgbW9kZVRleHQudGV4dENvbnRlbnQgPSBjdXN0b21UZXh0IHx8IFwiT0ZGTElORSBNT0RFIChMb2NhbCBPbGxhbWEgXHUyMDE0IG5vIG5ldHdvcmsgcmVxdWlyZWQpXCI7XG4gIH0gZWxzZSB7XG4gICAgaWYgKG1vZGVTZWxlY3QpIG1vZGVTZWxlY3QudmFsdWUgPSBcImNsb3VkXCI7XG4gICAgaWYgKG1vZGVCYWRnZSkge1xuICAgICAgbW9kZUJhZGdlLnN0eWxlLmJhY2tncm91bmQgPSBcIiNlMGYyZmVcIjtcbiAgICAgIG1vZGVCYWRnZS5zdHlsZS5jb2xvciA9IFwiIzAzNjlhMVwiO1xuICAgICAgbW9kZUJhZGdlLnN0eWxlLmJvcmRlckNvbG9yID0gXCIjYmFlNmZkXCI7XG4gICAgfVxuICAgIGlmIChtb2RlRG90KSBtb2RlRG90LnN0eWxlLmJhY2tncm91bmQgPSBcIiMwMjg0YzdcIjtcbiAgICBpZiAobW9kZVRleHQpIG1vZGVUZXh0LnRleHRDb250ZW50ID0gY3VzdG9tVGV4dCB8fCBcIkNMT1VEIE1PREUgKEdyb3EpXCI7XG4gIH1cbn1cblxuYXN5bmMgZnVuY3Rpb24gZmV0Y2hQcm92aWRlclN0YXR1cygpIHtcbiAgdHJ5IHtcbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChTRVJWRVJfUFJPVklERVJfVVJMKTtcbiAgICBpZiAocmVzLm9rKSB7XG4gICAgICBjb25zdCBkYXRhID0gYXdhaXQgcmVzLmpzb24oKTtcbiAgICAgIHVwZGF0ZU1vZGVVSShkYXRhLm1vZGUsIGRhdGEuc3RhdHVzVGV4dCk7XG4gICAgfVxuICB9IGNhdGNoIChlcnIpIHtcbiAgICBjb25zb2xlLndhcm4oXCJbUG9wdXBdIENvdWxkIG5vdCBmZXRjaCBwcm92aWRlciBzdGF0dXMgZnJvbSBzZXJ2ZXI6XCIsIGVyci5tZXNzYWdlKTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBzZXRQcm92aWRlck1vZGUobW9kZSkge1xuICB0cnkge1xuICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKFNFUlZFUl9QUk9WSURFUl9VUkwsIHtcbiAgICAgIG1ldGhvZDogXCJQT1NUXCIsXG4gICAgICBoZWFkZXJzOiB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0sXG4gICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7IG1vZGUgfSksXG4gICAgfSk7XG4gICAgaWYgKHJlcy5vaykge1xuICAgICAgY29uc3QgZGF0YSA9IGF3YWl0IHJlcy5qc29uKCk7XG4gICAgICB1cGRhdGVNb2RlVUkoZGF0YS5tb2RlLCBkYXRhLnN0YXR1c1RleHQpO1xuICAgICAgc2V0U3RhdHVzKGZhbHNlLCBgW01PREVdIEFjdGl2ZSBwcm92aWRlciBzd2l0Y2hlZCB0byAke2RhdGEucHJvdmlkZXJ9YCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgU2VydmVyIHJldHVybmVkIEhUVFAgJHtyZXMuc3RhdHVzfWApO1xuICAgIH1cbiAgfSBjYXRjaCAoZXJyKSB7XG4gICAgY29uc29sZS5lcnJvcihcIltQb3B1cF0gRmFpbGVkIHRvIHN3aXRjaCBwcm92aWRlciBtb2RlOlwiLCBlcnIpO1xuICAgIHNldFN0YXR1cyh0cnVlLCBgW01PREUgRVJST1JdIEZhaWxlZCB0byBzd2l0Y2ggcHJvdmlkZXI6ICR7ZXJyLm1lc3NhZ2V9YCk7XG4gICAgLy8gUmV2ZXJ0IFVJIHRvIG1hdGNoIHNlcnZlclxuICAgIGZldGNoUHJvdmlkZXJTdGF0dXMoKTtcbiAgfVxufVxuXG5pZiAobW9kZVNlbGVjdCkge1xuICBtb2RlU2VsZWN0LmFkZEV2ZW50TGlzdGVuZXIoXCJjaGFuZ2VcIiwgKGUpID0+IHtcbiAgICBzZXRQcm92aWRlck1vZGUoZS50YXJnZXQudmFsdWUpO1xuICB9KTtcbn1cblxuLy8gQ2hlY2sgcHJvdmlkZXIgc3RhdHVzIG9uIHBvcHVwIGxvYWRcbmZldGNoUHJvdmlkZXJTdGF0dXMoKTtcblxuXG5jb25zdCBTVEFHRVMgPSBbXCJjYXB0dXJlXCIsIFwiZGV0ZWN0XCIsIFwicmVkYWN0XCIsIFwic2VuZFwiLCBcImFjdFwiXTtcblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBQaXBlbGluZSAmIFN0YXR1cyBoZWxwZXJzXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbmZ1bmN0aW9uIHNldFBpcGVsaW5lU3RhZ2UoYWN0aXZlU3RhZ2UpIHtcbiAgbGV0IHBhc3NlZCA9IHRydWU7XG4gIGZvciAoY29uc3Qgc3RhZ2Ugb2YgU1RBR0VTKSB7XG4gICAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChgc3RhZ2UtJHtzdGFnZX1gKTtcbiAgICBpZiAoIWVsKSBjb250aW51ZTtcbiAgICBcbiAgICBlbC5jbGFzc05hbWUgPSBcInN0YWdlXCI7XG4gICAgaWYgKHN0YWdlID09PSBhY3RpdmVTdGFnZSkge1xuICAgICAgZWwuY2xhc3NMaXN0LmFkZChcImFjdGl2ZVwiKTtcbiAgICAgIHBhc3NlZCA9IGZhbHNlO1xuICAgIH0gZWxzZSBpZiAocGFzc2VkKSB7XG4gICAgICBlbC5jbGFzc0xpc3QuYWRkKFwiZG9uZVwiKTtcbiAgICB9XG4gIH1cbn1cblxuZnVuY3Rpb24gcmVzZXRQaXBlbGluZSgpIHtcbiAgZm9yIChjb25zdCBzdGFnZSBvZiBTVEFHRVMpIHtcbiAgICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGBzdGFnZS0ke3N0YWdlfWApO1xuICAgIGlmIChlbCkgZWwuY2xhc3NOYW1lID0gXCJzdGFnZVwiO1xuICB9XG59XG5cbmZ1bmN0aW9uIHNldFN0YXR1cyhpc0Vycm9yLCB0ZXh0KSB7XG4gIHN0YXR1c0VsLnN0eWxlLmRpc3BsYXkgPSBcImJsb2NrXCI7XG4gIHN0YXR1c0VsLmNsYXNzTmFtZSAgID0gaXNFcnJvciA/IFwiZXJyb3JcIiA6IFwiXCI7XG4gIHN0YXR1c0VsLnRleHRDb250ZW50ID0gdGV4dDtcbn1cblxuZnVuY3Rpb24gcmVzZXRDYW52YXMoKSB7XG4gIGN0eC5jbGVhclJlY3QoMCwgMCwgY2FudmFzLndpZHRoLCBjYW52YXMuaGVpZ2h0KTtcbiAgY2FudmFzV3JhcC5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG4gIGxlZ2VuZEVsLnN0eWxlLmRpc3BsYXkgICA9IFwibm9uZVwiO1xuICBwaWlUYWJsZS5zdHlsZS5kaXNwbGF5ICAgPSBcIm5vbmVcIjtcbiAgcGlpVGFibGUuaW5uZXJIVE1MICAgICAgID0gXCJcIjtcbiAgXG4gIC8vIFJlc2V0IG1ldHJpY3MgcGFuZWxcbiAgY29uc3QgbWV0cmljc1BhbmVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJtZXRyaWNzUGFuZWxcIik7XG4gIGlmIChtZXRyaWNzUGFuZWwpIG1ldHJpY3NQYW5lbC5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG5cbiAgLy8gUmVzZXQgbGVhayBwYW5lbFxuICBjb25zdCBsZWFrUGFuZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImxlYWtQYW5lbFwiKTtcbiAgaWYgKGxlYWtQYW5lbCkgeyBsZWFrUGFuZWwuc3R5bGUuZGlzcGxheSA9IFwibm9uZVwiOyBsZWFrUGFuZWwuY2xhc3NOYW1lID0gXCJcIjsgbGVha1BhbmVsLmlkID0gXCJsZWFrUGFuZWxcIjsgfVxuICBjb25zdCBsZWFrVGV4dCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwibGVha1BhbmVsVGV4dFwiKTtcbiAgaWYgKGxlYWtUZXh0KSBsZWFrVGV4dC50ZXh0Q29udGVudCA9IFwiQXdhaXRpbmcgcmVkYWN0aW9uXHUyMDI2XCI7XG4gIFxuICByZXNldFBpcGVsaW5lKCk7XG4gIGNsZWFyUGxhblN0ZXBzKCk7XG4gIFxuICBjb25zdCBwcm9ncmVzc1dyYXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcIm1vZGVsTG9hZFdyYXBcIik7XG4gIGlmIChwcm9ncmVzc1dyYXApIHByb2dyZXNzV3JhcC5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gUGxhbiBzdGVwIHRyYWNrZXIgXHUyMDE0IHNob3dzIGxpdmUgcGVyLXN0ZXAgc3RhdHVzIHVuZGVyIHRoZSBzdGF0dXMgYmFyXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbmZ1bmN0aW9uIGNsZWFyUGxhblN0ZXBzKCkge1xuICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwicGxhblN0ZXBMaXN0XCIpO1xuICBpZiAoZWwpIHsgZWwuaW5uZXJIVE1MID0gXCJcIjsgZWwuc3R5bGUuZGlzcGxheSA9IFwibm9uZVwiOyB9XG59XG5cbmZ1bmN0aW9uIHVwc2VydFBsYW5TdGVwKHN0ZXBOdW0sIHRvdGFsU3RlcHMsIHN0YXR1cywgbWVzc2FnZSkge1xuICBsZXQgbGlzdEVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJwbGFuU3RlcExpc3RcIik7XG4gIGlmICghbGlzdEVsKSB7XG4gICAgbGlzdEVsID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICBsaXN0RWwuaWQgPSBcInBsYW5TdGVwTGlzdFwiO1xuICAgIGxpc3RFbC5zdHlsZS5jc3NUZXh0ID0gW1xuICAgICAgXCJtYXJnaW4tdG9wOjZweFwiLFwiYm9yZGVyLXJhZGl1czo0cHhcIixcIm92ZXJmbG93OmhpZGRlblwiLFxuICAgICAgXCJib3JkZXI6MXB4IHNvbGlkICNlMmU4ZjBcIixcImZvbnQtc2l6ZToxMXB4XCIsXCJmb250LWZhbWlseTptb25vc3BhY2VcIlxuICAgIF0uam9pbihcIjtcIik7XG4gICAgc3RhdHVzRWwuaW5zZXJ0QWRqYWNlbnRFbGVtZW50KFwiYWZ0ZXJlbmRcIiwgbGlzdEVsKTtcbiAgfVxuICBsaXN0RWwuc3R5bGUuZGlzcGxheSA9IFwiYmxvY2tcIjtcblxuICBjb25zdCBpZCA9IGBwbGFuLXN0ZXAtJHtzdGVwTnVtfWA7XG4gIGxldCByb3cgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCk7XG4gIGlmICghcm93KSB7XG4gICAgcm93ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICByb3cuaWQgPSBpZDtcbiAgICByb3cuc3R5bGUuY3NzVGV4dCA9IFwiZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmZsZXgtc3RhcnQ7Z2FwOjZweDtwYWRkaW5nOjRweCA4cHg7Ym9yZGVyLWJvdHRvbToxcHggc29saWQgI2UyZThmMDtcIjtcbiAgICBsaXN0RWwuYXBwZW5kQ2hpbGQocm93KTtcbiAgfVxuXG4gIGNvbnN0IGljb25zID0geyBydW5uaW5nOiBcIlx1MjNGM1wiLCBvazogXCJcdTI3MTNcIiwgZXJyb3I6IFwiXHUyNzE3XCIsIHN1bW1hcnk6IFwiXHVEODNEXHVEQ0NCXCIgfTtcbiAgY29uc3QgY29sb3JzID0geyBydW5uaW5nOiBcIiM2NDc0OGJcIiwgb2s6IFwiIzE2YTM0YVwiLCBlcnJvcjogXCIjZGMyNjI2XCIsIHN1bW1hcnk6IFwiIzAzNjlhMVwiIH07XG4gIGNvbnN0IGljb24gPSBpY29uc1tzdGF0dXNdIHx8IFwiXHUwMEI3XCI7XG4gIGNvbnN0IGNvbG9yID0gY29sb3JzW3N0YXR1c10gfHwgXCIjMzM0MTU1XCI7XG4gIHJvdy5zdHlsZS5jb2xvciA9IGNvbG9yO1xuICByb3cuc3R5bGUuYmFja2dyb3VuZCA9IHN0YXR1cyA9PT0gXCJlcnJvclwiID8gXCIjZmVmMmYyXCIgOiBzdGF0dXMgPT09IFwib2tcIiA/IFwiI2YwZmRmNFwiIDogc3RhdHVzID09PSBcInN1bW1hcnlcIiA/IFwiI2VmZjZmZlwiIDogXCJ0cmFuc3BhcmVudFwiO1xuICByb3cuaW5uZXJIVE1MID0gYDxzcGFuIHN0eWxlPVwiZmxleC1zaHJpbms6MDtmb250LXdlaWdodDpib2xkXCI+JHtpY29ufTwvc3Bhbj48c3BhbiBzdHlsZT1cIndoaXRlLXNwYWNlOnByZS13cmFwXCI+JHttZXNzYWdlfTwvc3Bhbj5gO1xufVxuXG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gTGF5ZXIgMSBcdTIwMTQgRmxvcmVuY2UtMiBkZXRlY3Rpb25zIChmYWludCBvdXRsaW5lcyBmb3IgY29udGV4dClcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuZnVuY3Rpb24gZHJhd1Zpc2lvbkxheWVyKGRldGVjdGlvbnMsIHNjYWxlKSB7XG4gIGZvciAoY29uc3QgZGV0IG9mIGRldGVjdGlvbnMpIHtcbiAgICBjb25zdCBbeCwgeSwgdywgaF0gPSBkZXQuYmJveC5tYXAoKHYpID0+IE1hdGgucm91bmQodiAqIHNjYWxlKSk7XG4gICAgY29uc3QgaXNSZWdpb24gPSBkZXQudHlwZSA9PT0gXCJyZWdpb25cIjtcbiAgICBjdHgubGluZVdpZHRoICAgPSAxO1xuICAgIGN0eC5zdHJva2VTdHlsZSA9IGlzUmVnaW9uID8gXCJyZ2JhKDM0LDE5Nyw5NCwwLjU1KVwiIDogXCJyZ2JhKDk2LDE2NSwyNTAsMC41NSlcIjtcbiAgICBjdHguc3Ryb2tlUmVjdCh4LCB5LCB3LCBoKTtcbiAgfVxufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIExheWVyIDIgXHUyMDE0IFBJSSBzZW5zaXRpdmUgcmVnaW9ucyAoZmlsbGVkICsgbGFiZWxsZWQpXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbmZ1bmN0aW9uIGRyYXdQSUlMYXllcihzZW5zaXRpdmVSZWdpb25zLCBzY2FsZSkge1xuICBmb3IgKGNvbnN0IHIgb2Ygc2Vuc2l0aXZlUmVnaW9ucykge1xuICAgIGNvbnN0IFtyeCwgcnksIHJ3LCByaF0gPSByLmJib3gubWFwKCh2KSA9PiBNYXRoLnJvdW5kKHYgKiBzY2FsZSkpO1xuICAgIGNvbnN0IGNvbG9ycyA9IFBJSV9DT0xPUlNbci50eXBlXSA/PyBQSUlfQ09MT1JTLk9USEVSX1BJSTtcblxuICAgIC8vIEZpbGxlZCBvdmVybGF5XG4gICAgY3R4LmZpbGxTdHlsZSAgID0gY29sb3JzLmZpbGw7XG4gICAgY3R4LmZpbGxSZWN0KHJ4LCByeSwgcncsIHJoKTtcblxuICAgIC8vIFNvbGlkIGJvcmRlclxuICAgIGN0eC5zdHJva2VTdHlsZSA9IGNvbG9ycy5zdHJva2U7XG4gICAgY3R4LmxpbmVXaWR0aCAgID0gMjtcbiAgICBjdHguc3Ryb2tlUmVjdChyeCwgcnksIHJ3LCByaCk7XG5cbiAgICAvLyBCYWRnZVxuICAgIGNvbnN0IGxhYmVsID0gYCR7ci50eXBlfWA7XG4gICAgY3R4LmZvbnQgICAgID0gXCJib2xkIDEwcHggc3lzdGVtLXVpXCI7XG4gICAgY29uc3QgdHcgICAgID0gY3R4Lm1lYXN1cmVUZXh0KGxhYmVsKS53aWR0aCArIDg7XG4gICAgY3R4LmZpbGxTdHlsZSA9IGNvbG9ycy5zdHJva2U7XG4gICAgY3R4LmZpbGxSZWN0KHJ4LCBNYXRoLm1heCgwLCByeSAtIDE3KSwgdHcsIDE3KTtcbiAgICBjdHguZmlsbFN0eWxlID0gY29sb3JzLnRleHQ7XG4gICAgY3R4LmZpbGxUZXh0KGxhYmVsLCByeCArIDQsIE1hdGgubWF4KDExLCByeSAtIDMpKTtcbiAgfVxufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFBJSSBicmVha2Rvd24gdGFibGVcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuZnVuY3Rpb24gcmVuZGVyUElJVGFibGUoc2Vuc2l0aXZlUmVnaW9ucykge1xuICBpZiAoc2Vuc2l0aXZlUmVnaW9ucy5sZW5ndGggPT09IDApIHJldHVybjtcblxuICBjb25zdCBieVR5cGUgPSB7fTtcbiAgZm9yIChjb25zdCByIG9mIHNlbnNpdGl2ZVJlZ2lvbnMpIHtcbiAgICAoYnlUeXBlW3IudHlwZV0gPz89IFtdKS5wdXNoKHIpO1xuICB9XG5cbiAgbGV0IGh0bWwgPSAnPHRhYmxlIHN0eWxlPVwid2lkdGg6MTAwJTtib3JkZXItY29sbGFwc2U6Y29sbGFwc2U7Zm9udC1zaXplOjExcHg7Zm9udC1mYW1pbHk6dWktbW9ub3NwYWNlLFNGTW9uby1SZWd1bGFyLE1lbmxvLG1vbm9zcGFjZVwiPic7XG4gIGh0bWwgKz0gJzx0ciBzdHlsZT1cImJvcmRlci1ib3R0b206MXB4IHNvbGlkICNjYmQ1ZTE7YmFja2dyb3VuZDojZjhmYWZjXCI+PHRoIHN0eWxlPVwidGV4dC1hbGlnbjpsZWZ0O3BhZGRpbmc6NnB4IDhweDtjb2xvcjojNDc1NTY5O2ZvbnQtd2VpZ2h0OjYwMFwiPlR5cGU8L3RoPjx0aCBzdHlsZT1cInRleHQtYWxpZ246cmlnaHQ7cGFkZGluZzo2cHggOHB4O2NvbG9yOiM0NzU1Njk7Zm9udC13ZWlnaHQ6NjAwXCI+Q291bnQ8L3RoPjx0aCBzdHlsZT1cInRleHQtYWxpZ246cmlnaHQ7cGFkZGluZzo2cHggOHB4O2NvbG9yOiM0NzU1Njk7Zm9udC13ZWlnaHQ6NjAwXCI+QXZnIENvbmY8L3RoPjx0aCBzdHlsZT1cInRleHQtYWxpZ246cmlnaHQ7cGFkZGluZzo2cHggOHB4O2NvbG9yOiM0NzU1Njk7Zm9udC13ZWlnaHQ6NjAwXCI+U291cmNlczwvdGg+PC90cj4nO1xuXG4gIGZvciAoY29uc3QgW3R5cGUsIHJyXSBvZiBPYmplY3QuZW50cmllcyhieVR5cGUpKSB7XG4gICAgY29uc3QgY29sb3IgICA9IFBJSV9DT0xPUlNbdHlwZV0/LnN0cm9rZSA/PyBcIiM2NDc0OGJcIjtcbiAgICBjb25zdCBmaWxsICAgID0gUElJX0NPTE9SU1t0eXBlXT8uZmlsbCA/PyBcInJnYmEoMTAwLDExNiwxMzksMC4xNSlcIjtcbiAgICBjb25zdCBhdmdDb25mID0gKHJyLnJlZHVjZSgocywgcikgPT4gcyArIHIuY29uZmlkZW5jZSwgMCkgLyByci5sZW5ndGggKiAxMDApLnRvRml4ZWQoMCk7XG4gICAgY29uc3Qgc291cmNlcyA9IFsuLi5uZXcgU2V0KHJyLm1hcCgocikgPT4gci5zb3VyY2UpKV0uam9pbihcIiwgXCIpO1xuICAgIGh0bWwgKz0gYDx0ciBzdHlsZT1cImJvcmRlci1ib3R0b206MXB4IHNvbGlkICNlMmU4ZjBcIj5cbiAgICAgIDx0ZCBzdHlsZT1cInBhZGRpbmc6NnB4IDhweFwiPlxuICAgICAgICA8c3BhbiBzdHlsZT1cImRpc3BsYXk6aW5saW5lLWJsb2NrO3BhZGRpbmc6MnB4IDZweDtib3JkZXItcmFkaXVzOjNweDtiYWNrZ3JvdW5kOiR7ZmlsbH07Ym9yZGVyOjFweCBzb2xpZCAke2NvbG9yfTtjb2xvcjoke2NvbG9yfTtmb250LXdlaWdodDo3MDA7Zm9udC1zaXplOjEwcHhcIj4ke3R5cGV9PC9zcGFuPlxuICAgICAgPC90ZD5cbiAgICAgIDx0ZCBzdHlsZT1cInRleHQtYWxpZ246cmlnaHQ7cGFkZGluZzo2cHggOHB4O2NvbG9yOiMwZjE3MmE7Zm9udC13ZWlnaHQ6NjAwXCI+JHtyci5sZW5ndGh9PC90ZD5cbiAgICAgIDx0ZCBzdHlsZT1cInRleHQtYWxpZ246cmlnaHQ7cGFkZGluZzo2cHggOHB4O2NvbG9yOiMzMzQxNTVcIj4ke2F2Z0NvbmZ9JTwvdGQ+XG4gICAgICA8dGQgc3R5bGU9XCJ0ZXh0LWFsaWduOnJpZ2h0O3BhZGRpbmc6NnB4IDhweDtjb2xvcjojNjQ3NDhiO2ZvbnQtc2l6ZToxMHB4XCI+JHtzb3VyY2VzfTwvdGQ+XG4gICAgPC90cj5gO1xuICB9XG4gIGh0bWwgKz0gXCI8L3RhYmxlPlwiO1xuXG4gIHBpaVRhYmxlLmlubmVySFRNTCAgICA9IGh0bWw7XG4gIHBpaVRhYmxlLnN0eWxlLmRpc3BsYXkgPSBcImJsb2NrXCI7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gTWFpbiBjYW52YXMgcmVuZGVyZXJcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuYXN5bmMgZnVuY3Rpb24gcmVuZGVyUmVzdWx0cyhzY3JlZW5zaG90RGF0YVVybCwgZGV0ZWN0aW9ucywgc2Vuc2l0aXZlUmVnaW9ucykge1xuICBjb25zdCBpbWcgPSBuZXcgSW1hZ2UoKTtcbiAgYXdhaXQgbmV3IFByb21pc2UoKHJlcywgcmVqKSA9PiB7IGltZy5vbmxvYWQgPSByZXM7IGltZy5vbmVycm9yID0gcmVqOyBpbWcuc3JjID0gc2NyZWVuc2hvdERhdGFVcmw7IH0pO1xuXG4gIGNvbnN0IG1heFcgID0gY2FudmFzLm9mZnNldFdpZHRoIHx8IDQwMDtcbiAgY29uc3Qgc2NhbGUgPSBtYXhXIC8gaW1nLm5hdHVyYWxXaWR0aDtcbiAgY2FudmFzLndpZHRoICA9IG1heFc7XG4gIGNhbnZhcy5oZWlnaHQgPSBNYXRoLnJvdW5kKGltZy5uYXR1cmFsSGVpZ2h0ICogc2NhbGUpO1xuXG4gIC8vIFNjcmVlbnNob3RcbiAgY3R4LmRyYXdJbWFnZShpbWcsIDAsIDAsIGNhbnZhcy53aWR0aCwgY2FudmFzLmhlaWdodCk7XG5cbiAgLy8gTGF5ZXIgMSBcdTIwMTQgdmlzaW9uIGNvbnRleHQgKGZhaW50KVxuICBkcmF3VmlzaW9uTGF5ZXIoZGV0ZWN0aW9ucywgc2NhbGUpO1xuXG4gIC8vIExheWVyIDIgXHUyMDE0IFBJSSAocHJvbWluZW50KVxuICBkcmF3UElJTGF5ZXIoc2Vuc2l0aXZlUmVnaW9ucywgc2NhbGUpO1xuXG4gIGNhbnZhc1dyYXAuc3R5bGUuZGlzcGxheSA9IFwiYmxvY2tcIjtcbiAgbGVnZW5kRWwuc3R5bGUuZGlzcGxheSAgID0gXCJmbGV4XCI7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gQnV0dG9uIGNsaWNrIFx1MjE5MiBwb3J0IFx1MjE5MiBiYWNrZ3JvdW5kIGV4ZWN1dGlvbiBmbG93XG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbmZ1bmN0aW9uIHN0YXJ0QW5hbHlzaXMoaXNEZW1vID0gZmFsc2UpIHtcbiAgY29uc3QgbW9kZSA9IGlzRGVtbyA/IFwiRGVtbyBNb2RlXCIgOiBcIkV4ZWN1dGVcIjtcbiAgY29uc29sZS5sb2coYFtQb3B1cF0gc3RhcnRBbmFseXNpcygke21vZGV9KSBpbml0aWF0ZWQuIEN1cnJlbnQgc3RhdGU6YCwge1xuICAgIHRhc2s6IHRhc2tJbnB1dCA/IHRhc2tJbnB1dC52YWx1ZSA6IFwiXCIsXG4gICAgdGltZTogbmV3IERhdGUoKS50b0lTT1N0cmluZygpXG4gIH0pO1xuXG4gIGFuYWx5emVCdG4uZGlzYWJsZWQgPSB0cnVlO1xuICBpZiAoZGVtb0J0bikgZGVtb0J0bi5kaXNhYmxlZCA9IHRydWU7XG5cbiAgcmVzZXRDYW52YXMoKTtcbiAgc2V0UGlwZWxpbmVTdGFnZShcImNhcHR1cmVcIik7XG4gIHNldFN0YXR1cyhmYWxzZSwgYFtJTklUXSBTdGFydGluZyAke21vZGV9Li4uIENvbm5lY3RpbmcgdG8gYmFja2dyb3VuZC4uLmApO1xuXG4gIGxldCBwb3J0O1xuICB0cnkge1xuICAgIHBvcnQgPSBjaHJvbWUucnVudGltZS5jb25uZWN0KHsgbmFtZTogXCJhbmFseXplXCIgfSk7XG4gICAgY29uc29sZS5sb2coXCJbUG9wdXBdIGNocm9tZS5ydW50aW1lLmNvbm5lY3QgcG9ydCBlc3RhYmxpc2hlZDpcIiwgcG9ydCk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGNvbnNvbGUuZXJyb3IoXCJbUG9wdXAgRXJyb3JdW1BvcnQgQ29ubmVjdGlvbl06XCIsIGVycik7XG4gICAgc2V0U3RhdHVzKHRydWUsIGBbUE9SVCBFUlJPUl0gQ29ubmVjdGlvbiBmYWlsZWQ6ICR7ZXJyLm1lc3NhZ2V9YCk7XG4gICAgYW5hbHl6ZUJ0bi5kaXNhYmxlZCA9IGZhbHNlO1xuICAgIGlmIChkZW1vQnRuKSBkZW1vQnRuLmRpc2FibGVkID0gZmFsc2U7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3QgaW5zdHJ1Y3Rpb24gPSB0YXNrSW5wdXQgPyB0YXNrSW5wdXQudmFsdWUudHJpbSgpIDogXCJcIjtcbiAgY29uc3QgaW5pdGlhbFBheWxvYWQgPSB7XG4gICAgdHlwZTogaXNEZW1vID8gXCJTVEFSVF9ERU1PX1JVTlwiIDogXCJBTkFMWVpFX1NDUkVFTlwiLFxuICAgIGluc3RydWN0aW9uOiBpbnN0cnVjdGlvbiB8fCB1bmRlZmluZWRcbiAgfTtcblxuICB0cnkge1xuICAgIHBvcnQucG9zdE1lc3NhZ2UoaW5pdGlhbFBheWxvYWQpO1xuICAgIGNvbnNvbGUubG9nKFwiW1BvcHVwXSBEaXNwYXRjaGVkIGluaXRpYWwgbWVzc2FnZSB0byBiYWNrZ3JvdW5kOlwiLCBpbml0aWFsUGF5bG9hZCk7XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGNvbnNvbGUuZXJyb3IoXCJbUG9wdXAgRXJyb3JdW1Bvc3QgTWVzc2FnZV06XCIsIGVycik7XG4gICAgc2V0U3RhdHVzKHRydWUsIGBbUE9TVCBFUlJPUl0gRmFpbGVkIHRvIHNlbmQgbWVzc2FnZTogJHtlcnIubWVzc2FnZX1gKTtcbiAgICBhbmFseXplQnRuLmRpc2FibGVkID0gZmFsc2U7XG4gICAgaWYgKGRlbW9CdG4pIGRlbW9CdG4uZGlzYWJsZWQgPSBmYWxzZTtcbiAgICByZXR1cm47XG4gIH1cblxuICBwb3J0Lm9uTWVzc2FnZS5hZGRMaXN0ZW5lcihhc3luYyAobXNnKSA9PiB7XG4gICAgY29uc29sZS5sb2coXCJbUG9wdXBdIFJlY2VpdmVkIG1lc3NhZ2UgZnJvbSBiYWNrZ3JvdW5kOlwiLCBtc2cudHlwZSwgbXNnKTtcbiAgICBzd2l0Y2ggKG1zZy50eXBlKSB7XG4gICAgICBjYXNlIFwiU1RBVFVTXCI6XG4gICAgICAgIHNldFN0YXR1cyhmYWxzZSwgbXNnLnRleHQpO1xuICAgICAgICBicmVhaztcblxuICAgICAgY2FzZSBcIlNUQUdFX0NIQU5HRVwiOlxuICAgICAgICBzZXRQaXBlbGluZVN0YWdlKG1zZy5zdGFnZSk7XG4gICAgICAgIHNldFN0YXR1cyhmYWxzZSwgYFske21zZy5zdGFnZS50b1VwcGVyQ2FzZSgpfV0gJHttc2cudGV4dH1gKTtcbiAgICAgICAgYnJlYWs7XG5cbiAgICAgIGNhc2UgXCJET01fU0NBTl9ET05FXCI6XG4gICAgICAgIHNldFN0YXR1cyhmYWxzZSwgYFtET01dIEZvdW5kICR7bXNnLmNvdW50fSBzZW5zaXRpdmUgRE9NIGZpZWxkKHMpYCk7XG4gICAgICAgIGJyZWFrO1xuXG4gICAgICBjYXNlIFwiTU9ERUxfUFJPR1JFU1NcIjoge1xuICAgICAgICBjb25zdCBwcm9ncmVzc1dyYXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcIm1vZGVsTG9hZFdyYXBcIik7XG4gICAgICAgIGNvbnN0IHByb2dyZXNzUGN0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJtb2RlbExvYWRQY3RcIik7XG4gICAgICAgIGNvbnN0IHByb2dyZXNzRmlsZSA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwibW9kZWxMb2FkRmlsZVwiKTtcbiAgICAgICAgY29uc3QgcHJvZ3Jlc3NCYXIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcIm1vZGVsTG9hZFByb2dyZXNzXCIpO1xuICAgICAgICBpZiAocHJvZ3Jlc3NXcmFwKSBwcm9ncmVzc1dyYXAuc3R5bGUuZGlzcGxheSA9IFwiYmxvY2tcIjtcbiAgICAgICAgY29uc3QgZmlsZU5hbWUgPSBtc2cuZmlsZSA/IG1zZy5maWxlLnNwbGl0KFwiL1wiKS5wb3AoKSA6IFwibW9kZWwgd2VpZ2h0c1wiO1xuICAgICAgICBpZiAocHJvZ3Jlc3NGaWxlKSBwcm9ncmVzc0ZpbGUudGV4dENvbnRlbnQgPSBmaWxlTmFtZTtcbiAgICAgICAgaWYgKHByb2dyZXNzUGN0KSBwcm9ncmVzc1BjdC50ZXh0Q29udGVudCA9IGAke21zZy5wZXJjZW50IHx8IDB9JWA7XG4gICAgICAgIGlmIChwcm9ncmVzc0JhcikgcHJvZ3Jlc3NCYXIudmFsdWUgPSBtc2cucGVyY2VudCB8fCAwO1xuICAgICAgICBzZXRTdGF0dXMoZmFsc2UsIGBbTU9ERUxdIERvd25sb2FkaW5nICR7ZmlsZU5hbWV9ICgke21zZy5wZXJjZW50IHx8IDB9JSkuLi5gKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG5cbiAgICAgIGNhc2UgXCJNT0RFTF9SRUFEWVwiOiB7XG4gICAgICAgIGNvbnN0IHByb2dyZXNzV3JhcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwibW9kZWxMb2FkV3JhcFwiKTtcbiAgICAgICAgaWYgKHByb2dyZXNzV3JhcCkgcHJvZ3Jlc3NXcmFwLnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjtcbiAgICAgICAgc2V0U3RhdHVzKGZhbHNlLCBcIltNT0RFTF0gTW9kZWwgbG9hZGVkIGFuZCByZWFkeSBpbiBtZW1vcnkuXCIpO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cblxuICAgICAgY2FzZSBcIk1PREVMX0VSUk9SXCI6IHtcbiAgICAgICAgY29uc3QgcHJvZ3Jlc3NXcmFwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJtb2RlbExvYWRXcmFwXCIpO1xuICAgICAgICBpZiAocHJvZ3Jlc3NXcmFwKSBwcm9ncmVzc1dyYXAuc3R5bGUuZGlzcGxheSA9IFwibm9uZVwiO1xuICAgICAgICBjb25zb2xlLmVycm9yKFwiW1BvcHVwIEVycm9yXVtNb2RlbCBMb2FkXTpcIiwgbXNnLmVycm9yKTtcbiAgICAgICAgc2V0U3RhdHVzKHRydWUsIGBbTU9ERUwgRVJST1JdICR7bXNnLmVycm9yfWApO1xuICAgICAgICBhbmFseXplQnRuLmRpc2FibGVkID0gZmFsc2U7XG4gICAgICAgIGlmIChkZW1vQnRuKSBkZW1vQnRuLmRpc2FibGVkID0gZmFsc2U7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuXG4gICAgICBjYXNlIFwiUExBTl9TVEVQX1NUQVRVU1wiOiB7XG4gICAgICAgIC8vIExpdmUgcGVyLXN0ZXAgdXBkYXRlcyBhcyBlYWNoIGFjdGlvbiBleGVjdXRlc1xuICAgICAgICB1cHNlcnRQbGFuU3RlcChtc2cuc3RlcE51bSwgbXNnLnRvdGFsU3RlcHMsIG1zZy5zdGF0dXMsIG1zZy5tZXNzYWdlKTtcbiAgICAgICAgc2V0U3RhdHVzKG1zZy5zdGF0dXMgPT09IFwiZXJyb3JcIiA/IHRydWUgOiBmYWxzZSwgbXNnLm1lc3NhZ2UpO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cblxuICAgICAgY2FzZSBcIlBMQU5fU1VNTUFSWVwiOiB7XG4gICAgICAgIC8vIEZpbmFsIHN1bW1hcnkgYWZ0ZXIgYWxsIHBsYW4gc3RlcHMgYXJlIGF0dGVtcHRlZFxuICAgICAgICBjb25zdCBpc0FsbE9rID0gbXNnLmZhaWxlZCA9PT0gMDtcbiAgICAgICAgY29uc3Qgc3VtbWFyeVRleHQgPSBtc2cudG90YWwgPT09IDBcbiAgICAgICAgICA/IGBbRE9ORV0gJHttc2cubWVzc2FnZX1gXG4gICAgICAgICAgOiBpc0FsbE9rXG4gICAgICAgICAgICA/IGBbRE9ORV0gJHttc2cubWVzc2FnZX1gXG4gICAgICAgICAgICA6IGBbUEFSVElBTF0gJHttc2cubWVzc2FnZX1gO1xuICAgICAgICBzZXRTdGF0dXMoIWlzQWxsT2sgJiYgbXNnLmZhaWxlZCA+IDAsIHN1bW1hcnlUZXh0KTtcbiAgICAgICAgLy8gU2hvdyBzdW1tYXJ5IHJvdyBpbiBzdGVwIGxpc3RcbiAgICAgICAgdXBzZXJ0UGxhblN0ZXAoXCJzdW1tYXJ5XCIsIG1zZy50b3RhbCwgXCJzdW1tYXJ5XCIsIHN1bW1hcnlUZXh0KTtcbiAgICAgICAgYW5hbHl6ZUJ0bi5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICAgICBpZiAoZGVtb0J0bikgZGVtb0J0bi5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cblxuICAgICAgY2FzZSBcIkFOQUxZU0lTX1JFU1VMVFwiOiB7XG4gICAgICAgIGNvbnN0IHsgZGV0ZWN0aW9ucywgc2Vuc2l0aXZlUmVnaW9ucywgc2NyZWVuc2hvdERhdGFVcmwsIGVsYXBzZWQsIHNlcnZlclJlc3VsdCB9ID0gbXNnO1xuICAgICAgICBjb25zdCBwaWlDb3VudCA9IHNlbnNpdGl2ZVJlZ2lvbnM/Lmxlbmd0aCA/PyAwO1xuICAgICAgICBjb25zdCBwbGFuU3RlcHMgPSBzZXJ2ZXJSZXN1bHQ/LnBsYW4/Lmxlbmd0aCA/PyAwO1xuICAgICAgICBzZXRTdGF0dXMoXG4gICAgICAgICAgZmFsc2UsXG4gICAgICAgICAgYFtERVRFQ1RFRF0gJHtwaWlDb3VudH0gUElJIHJlZ2lvbihzKSBpbiAke2VsYXBzZWQgfHwgMH1tcyBcdTIwMTQgZXhlY3V0aW5nICR7cGxhblN0ZXBzfSBzdGVwIHBsYW5cdTIwMjZgXG4gICAgICAgICk7XG4gICAgICAgIHNldFBpcGVsaW5lU3RhZ2UoXCJhY3RcIik7XG4gICAgICAgIGlmIChzY3JlZW5zaG90RGF0YVVybCkge1xuICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICBhd2FpdCByZW5kZXJSZXN1bHRzKHNjcmVlbnNob3REYXRhVXJsLCBkZXRlY3Rpb25zID8/IFtdLCBzZW5zaXRpdmVSZWdpb25zID8/IFtdKTtcbiAgICAgICAgICB9IGNhdGNoIChyZW5kZXJFcnIpIHtcbiAgICAgICAgICAgIGNvbnNvbGUuZXJyb3IoXCJbUG9wdXAgRXJyb3JdW1JlbmRlciBSZXN1bHRzXTpcIiwgcmVuZGVyRXJyKTtcbiAgICAgICAgICAgIHNldFN0YXR1cyh0cnVlLCBgW1JFTkRFUiBFUlJPUl0gJHtyZW5kZXJFcnIubWVzc2FnZX1gKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgcmVuZGVyUElJVGFibGUoc2Vuc2l0aXZlUmVnaW9ucyA/PyBbXSk7XG4gICAgICAgIC8vIEJ1dHRvbnMgc3RheSBkaXNhYmxlZCB1bnRpbCBQTEFOX1NVTU1BUlkgaXMgcmVjZWl2ZWRcbiAgICAgICAgaWYgKHBsYW5TdGVwcyA9PT0gMCkge1xuICAgICAgICAgIGFuYWx5emVCdG4uZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgICBpZiAoZGVtb0J0bikgZGVtb0J0bi5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuXG4gICAgICBjYXNlIFwiTUVUUklDU1wiOiB7XG4gICAgICAgIC8vIERhdGEgUmVkdWN0aW9uIE1ldHJpY3MgcGFuZWxcbiAgICAgICAgY29uc3QgbWV0cmljc1BhbmVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJtZXRyaWNzUGFuZWxcIik7XG4gICAgICAgIGlmICghbWV0cmljc1BhbmVsKSBicmVhaztcbiAgICAgICAgbWV0cmljc1BhbmVsLnN0eWxlLmRpc3BsYXkgPSBcImJsb2NrXCI7XG5cbiAgICAgICAgY29uc3QgZm10Qnl0ZXMgPSAoYikgPT4gYiA+PSAxMDQ4NTc2XG4gICAgICAgICAgPyAoYiAvIDEwNDg1NzYpLnRvRml4ZWQoMikgKyBcIiBNQlwiXG4gICAgICAgICAgOiBiID49IDEwMjQgPyAoYiAvIDEwMjQpLnRvRml4ZWQoMSkgKyBcIiBLQlwiXG4gICAgICAgICAgOiBiICsgXCIgQlwiO1xuXG4gICAgICAgIGNvbnN0IHJhd0VsICA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwibWV0cmljLXJhd1wiKTtcbiAgICAgICAgY29uc3Qgc2VudEVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJtZXRyaWMtc2VudFwiKTtcbiAgICAgICAgY29uc3QgcmVkRWwgID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJtZXRyaWMtcmVkdWN0aW9uXCIpO1xuICAgICAgICBjb25zdCBzdXJFbCAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcIm1ldHJpYy1zdXJmYWNlXCIpO1xuICAgICAgICBjb25zdCBub3RlRWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcIm1ldHJpYy1ub3RlXCIpO1xuXG4gICAgICAgIGlmIChyYXdFbCkgIHJhd0VsLnRleHRDb250ZW50ICA9IGZtdEJ5dGVzKG1zZy5yYXdfYnl0ZXMpO1xuICAgICAgICBpZiAoc2VudEVsKSBzZW50RWwudGV4dENvbnRlbnQgPSBmbXRCeXRlcyhtc2cuc2VudF9ieXRlcyk7XG5cbiAgICAgICAgLy8gQnl0ZSByZWR1Y3Rpb25cbiAgICAgICAgY29uc3QgYnl0ZVJlZFBjdCA9IG1zZy5yZWR1Y3Rpb25fcGVyY2VudDtcbiAgICAgICAgaWYgKHJlZEVsKSB7XG4gICAgICAgICAgLy8gTm90ZTogZW5jb2RpbmcgSlNPTiBvdmVyaGVhZCBjYW4gbWFrZSBzZW50X2J5dGVzID4gcmF3X2J5dGVzIChKUEVHIDwgUE5HKVxuICAgICAgICAgIC8vIFJlcG9ydCBob25lc3RseSBcdTIwMTQgcG9zaXRpdmUgPSBzYXZlZCwgbmVnYXRpdmUgPSBvdmVyaGVhZCBhZGRlZFxuICAgICAgICAgIGlmIChieXRlUmVkUGN0ID49IDApIHtcbiAgICAgICAgICAgIHJlZEVsLnRleHRDb250ZW50ID0gYFxcdTIyMTIke2J5dGVSZWRQY3QudG9GaXhlZCgxKX0lIHNlbnRgO1xuICAgICAgICAgICAgcmVkRWwuY2xhc3NOYW1lID0gXCJtZXRyaWMtdmFsdWUgZ29vZFwiO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAvLyBQYXlsb2FkIGlzIGxhcmdlciAoZS5nLiBQTkcgbG9zc2xlc3NseSBleHBhbmRlZCBieSBKU09OIHdyYXBwaW5nKVxuICAgICAgICAgICAgcmVkRWwudGV4dENvbnRlbnQgPSBgKyR7KC1ieXRlUmVkUGN0KS50b0ZpeGVkKDEpfSUgb3ZlcmhlYWRgO1xuICAgICAgICAgICAgcmVkRWwuY2xhc3NOYW1lID0gXCJtZXRyaWMtdmFsdWUgd2FyblwiO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vIFBJSSBzdXJmYWNlIGFyZWFcbiAgICAgICAgaWYgKHN1ckVsKSB7XG4gICAgICAgICAgaWYgKG1zZy5waWlfcmVnaW9ucyA+IDApIHtcbiAgICAgICAgICAgIHN1ckVsLnRleHRDb250ZW50ID0gYCR7bXNnLnBpaV9zdXJmYWNlX3BlcmNlbnQudG9GaXhlZCgxKX0lIGFyZWFgO1xuICAgICAgICAgICAgc3VyRWwuY2xhc3NOYW1lID0gXCJtZXRyaWMtdmFsdWUgZ29vZFwiO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzdXJFbC50ZXh0Q29udGVudCA9IFwiTi9BIChubyBQSUkpXCI7XG4gICAgICAgICAgICBzdXJFbC5jbGFzc05hbWUgPSBcIm1ldHJpYy12YWx1ZVwiO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChub3RlRWwpIHtcbiAgICAgICAgICBpZiAobXNnLnBpaV9yZWdpb25zID4gMCkge1xuICAgICAgICAgICAgbm90ZUVsLnRleHRDb250ZW50ID0gYCR7bXNnLnBpaV9yZWdpb25zfSBzZW5zaXRpdmUgcmVnaW9uKHMpIGNvdmVyaW5nIH4ke21zZy5waWlfc3VyZmFjZV9wZXJjZW50LnRvRml4ZWQoMil9JSBvZiBpbWFnZSBhcmVhIHdlcmUgbmV2ZXIgdHJhbnNtaXR0ZWQgaW4gcmVhZGFibGUgZm9ybS5gO1xuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBjb25zdCBub3RlID0gYnl0ZVJlZFBjdCA+PSAwXG4gICAgICAgICAgICAgID8gYFJhdyBjYXB0dXJlOiAke2ZtdEJ5dGVzKG1zZy5yYXdfYnl0ZXMpfSBcXHUyMTkyIHNlbnQgcGF5bG9hZDogJHtmbXRCeXRlcyhtc2cuc2VudF9ieXRlcyl9ICgke2J5dGVSZWRQY3QudG9GaXhlZCgxKX0lIHJlZHVjdGlvbiB2aWEgcmVkYWN0aW9uICsgc2NoZW1hIGVuY29kaW5nKS5gXG4gICAgICAgICAgICAgIDogYE5vdGU6IEpTT04gZW5jb2RpbmcgYWRkcyBvdmVyaGVhZCB2cy4gcmF3IFBORy4gTm8gUElJIHdhcyBkZXRlY3RlZCBvbiB0aGlzIHBhZ2UuYDtcbiAgICAgICAgICAgIG5vdGVFbC50ZXh0Q29udGVudCA9IG5vdGU7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuXG4gICAgICBjYXNlIFwiTEVBS19DSEVDS1wiOiB7XG4gICAgICAgIC8vIFJlZGFjdGlvbiBMZWFrIFZlcmlmaWNhdGlvbiBwYW5lbFxuICAgICAgICBjb25zdCBsZWFrUGFuZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImxlYWtQYW5lbFwiKTtcbiAgICAgICAgY29uc3QgbGVha1RleHQgID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJsZWFrUGFuZWxUZXh0XCIpO1xuICAgICAgICBpZiAoIWxlYWtQYW5lbCkgYnJlYWs7XG4gICAgICAgIGxlYWtQYW5lbC5zdHlsZS5kaXNwbGF5ID0gXCJibG9ja1wiO1xuXG4gICAgICAgIGxlYWtQYW5lbC5jbGFzc05hbWUgPSBcIlwiOyAvLyBjbGVhciBvbGQgc3RhdGUgY2xhc3Nlc1xuICAgICAgICBpZiAobXNnLndhcm5pbmcpIHtcbiAgICAgICAgICBsZWFrUGFuZWwuY2xhc3NMaXN0LmFkZChcIndhcm5cIik7XG4gICAgICAgIH0gZWxzZSBpZiAobXNnLnBhc3NlZCkge1xuICAgICAgICAgIGxlYWtQYW5lbC5jbGFzc0xpc3QuYWRkKFwicGFzc1wiKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBsZWFrUGFuZWwuY2xhc3NMaXN0LmFkZChcImZhaWxcIik7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAobGVha1RleHQpIGxlYWtUZXh0LnRleHRDb250ZW50ID0gbXNnLm1lc3NhZ2U7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuXG4gICAgICBjYXNlIFwiUFJPTVBUX1VTRVJfSU5QVVRcIjoge1xuICAgICAgICAvLyBJbmxpbmUgZmFsbGJhY2sgcHJvbXB0IGZvciBtaXNzaW5nIHZhbHVlcyAoUmVxdWlyZW1lbnQgNClcbiAgICAgICAgY29uc3QgcHJvbXB0Q2FyZCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwidXNlcklucHV0UHJvbXB0Q2FyZFwiKTtcbiAgICAgICAgY29uc3QgdGl0bGVFbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwicHJvbXB0Q2FyZFRpdGxlXCIpO1xuICAgICAgICBjb25zdCBpbnB1dEVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJwcm9tcHRDYXJkSW5wdXRcIik7XG4gICAgICAgIGNvbnN0IHNhdmVDaGVjayA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwicHJvbXB0Q2FyZFNhdmVEZWZhdWx0XCIpO1xuICAgICAgICBjb25zdCBzdWJtaXRCdG4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInByb21wdENhcmRTdWJtaXRCdG5cIik7XG4gICAgICAgIGNvbnN0IHNraXBCdG4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInByb21wdENhcmRTa2lwQnRuXCIpO1xuXG4gICAgICAgIGlmIChwcm9tcHRDYXJkICYmIHRpdGxlRWwgJiYgaW5wdXRFbCkge1xuICAgICAgICAgIHByb21wdENhcmQuc3R5bGUuZGlzcGxheSA9IFwiYmxvY2tcIjtcbiAgICAgICAgICB0aXRsZUVsLnRleHRDb250ZW50ID0gYE5vIHZhbHVlIGZvdW5kIGZvciAke21zZy5maWVsZFR5cGUgfHwgXCJmaWVsZFwifSBcdTIwMTQgZW50ZXIgb25lIG5vdz9gO1xuICAgICAgICAgIGlucHV0RWwudmFsdWUgPSBcIlwiO1xuICAgICAgICAgIGlucHV0RWwucGxhY2Vob2xkZXIgPSBgRW50ZXIgJHttc2cuZmllbGRUeXBlIHx8IFwidmFsdWVcIn0uLi5gO1xuICAgICAgICAgIGlucHV0RWwuZm9jdXMoKTtcblxuICAgICAgICAgIGNvbnN0IGhhbmRsZVN1Ym1pdCA9ICgpID0+IHtcbiAgICAgICAgICAgIGNvbnN0IHZhbCA9IGlucHV0RWwudmFsdWUudHJpbSgpO1xuICAgICAgICAgICAgY29uc3Qgc2F2ZVRvVmF1bHQgPSBCb29sZWFuKHNhdmVDaGVjaz8uY2hlY2tlZCk7XG4gICAgICAgICAgICBwcm9tcHRDYXJkLnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjtcbiAgICAgICAgICAgIGNsZWFudXAoKTtcbiAgICAgICAgICAgIHBvcnQucG9zdE1lc3NhZ2Uoe1xuICAgICAgICAgICAgICB0eXBlOiBcIlVTRVJfSU5QVVRfUFJPVklERURcIixcbiAgICAgICAgICAgICAgc3RlcE51bTogbXNnLnN0ZXBOdW0sXG4gICAgICAgICAgICAgIHZhbHVlOiB2YWwsXG4gICAgICAgICAgICAgIHNhdmVUb1ZhdWx0LFxuICAgICAgICAgICAgICBmaWVsZFR5cGU6IG1zZy5maWVsZFR5cGVcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgc2V0U3RhdHVzKGZhbHNlLCBgUHJvdmlkZWQgdmFsdWUgZm9yICR7bXNnLmZpZWxkVHlwZX06IFwiJHt2YWx9XCIgKHNhdmUgZGVmYXVsdDogJHtzYXZlVG9WYXVsdH0pYCk7XG4gICAgICAgICAgfTtcblxuICAgICAgICAgIGNvbnN0IGhhbmRsZVNraXAgPSAoKSA9PiB7XG4gICAgICAgICAgICBwcm9tcHRDYXJkLnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjtcbiAgICAgICAgICAgIGNsZWFudXAoKTtcbiAgICAgICAgICAgIHBvcnQucG9zdE1lc3NhZ2Uoe1xuICAgICAgICAgICAgICB0eXBlOiBcIlVTRVJfSU5QVVRfUFJPVklERURcIixcbiAgICAgICAgICAgICAgc3RlcE51bTogbXNnLnN0ZXBOdW0sXG4gICAgICAgICAgICAgIHZhbHVlOiBudWxsLFxuICAgICAgICAgICAgICBzYXZlVG9WYXVsdDogZmFsc2UsXG4gICAgICAgICAgICAgIGZpZWxkVHlwZTogbXNnLmZpZWxkVHlwZVxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBzZXRTdGF0dXModHJ1ZSwgYFNraXBwZWQgc3RlcCBmb3IgJHttc2cuZmllbGRUeXBlfWApO1xuICAgICAgICAgIH07XG5cbiAgICAgICAgICBjb25zdCBjbGVhbnVwID0gKCkgPT4ge1xuICAgICAgICAgICAgc3VibWl0QnRuPy5yZW1vdmVFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgaGFuZGxlU3VibWl0KTtcbiAgICAgICAgICAgIHNraXBCdG4/LnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCBoYW5kbGVTa2lwKTtcbiAgICAgICAgICB9O1xuXG4gICAgICAgICAgc3VibWl0QnRuPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgaGFuZGxlU3VibWl0KTtcbiAgICAgICAgICBza2lwQnRuPy5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgaGFuZGxlU2tpcCk7XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG5cbiAgICAgIGNhc2UgXCJfU1RFUDZfQ09NUExFVEVcIjoge1xuICAgICAgICAvLyBTYWZldHkgbmV0OiBmaXJlZCBmcm9tIGJhY2tncm91bmQuanMncyBmaW5hbGx5IGJsb2NrIFx1MjAxNCBlbnN1cmVzIGJ1dHRvbnNcbiAgICAgICAgLy8gYXJlIGFsd2F5cyByZS1lbmFibGVkIGV2ZW4gaWYgYW4gZXhjZXB0aW9uIHNraXBwZWQgUExBTl9TVU1NQVJZLlxuICAgICAgICBhbmFseXplQnRuLmRpc2FibGVkID0gZmFsc2U7XG4gICAgICAgIGlmIChkZW1vQnRuKSBkZW1vQnRuLmRpc2FibGVkID0gZmFsc2U7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuXG4gICAgICBjYXNlIFwiRVJST1JcIjoge1xuICAgICAgICBjb25zb2xlLmVycm9yKFwiW1BvcHVwIEVycm9yXVtQaXBlbGluZSBTdGVwIEZhaWxlZF06XCIsIG1zZy5zdGVwLCBtc2cuZXJyb3IpO1xuICAgICAgICBzZXRTdGF0dXModHJ1ZSwgYFtFUlJPUiBpbiAke21zZy5zdGVwIHx8IFwiUGlwZWxpbmVcIn1dICR7bXNnLmVycm9yfWApO1xuICAgICAgICBhbmFseXplQnRuLmRpc2FibGVkID0gZmFsc2U7XG4gICAgICAgIGlmIChkZW1vQnRuKSBkZW1vQnRuLmRpc2FibGVkID0gZmFsc2U7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH1cbiAgfSk7XG5cbiAgcG9ydC5vbkRpc2Nvbm5lY3QuYWRkTGlzdGVuZXIoKCkgPT4ge1xuICAgIGNvbnN0IGVyciA9IGNocm9tZS5ydW50aW1lLmxhc3RFcnJvcjtcbiAgICBpZiAoZXJyKSB7XG4gICAgICBjb25zb2xlLmVycm9yKFwiW1BvcHVwIEVycm9yXVtQb3J0IERpc2Nvbm5lY3RlZF06XCIsIGVyci5tZXNzYWdlKTtcbiAgICAgIHNldFN0YXR1cyh0cnVlLCBgW1NXIERJU0NPTk5FQ1RFRF0gU2VydmljZSB3b3JrZXIgdGVybWluYXRlZDogJHtlcnIubWVzc2FnZX1gKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc29sZS5sb2coXCJbUG9wdXBdIFBvcnQgZGlzY29ubmVjdGVkIGNsZWFubHkuXCIpO1xuICAgIH1cbiAgICBhbmFseXplQnRuLmRpc2FibGVkID0gZmFsc2U7XG4gICAgaWYgKGRlbW9CdG4pIGRlbW9CdG4uZGlzYWJsZWQgPSBmYWxzZTtcbiAgfSk7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gQ2xpY2sgSGFuZGxlcnMgd2l0aCByZXF1aXJlZCBsb2dnaW5nXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbmFuYWx5emVCdG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHtcbiAgY29uc29sZS5sb2coXCJbUG9wdXBdID4+PiBFWEVDVVRFIEJVVFRPTiBDTElDS0VEISA8PDwgVGltZXN0YW1wOlwiLCBEYXRlLm5vdygpKTtcbiAgc3RhcnRBbmFseXNpcyhmYWxzZSk7XG59KTtcblxuaWYgKGRlbW9CdG4pIHtcbiAgZGVtb0J0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xuICAgIGNvbnNvbGUubG9nKFwiW1BvcHVwXSA+Pj4gREVNTyBNT0RFIEJVVFRPTiBDTElDS0VEISA8PDwgVGltZXN0YW1wOlwiLCBEYXRlLm5vdygpKTtcbiAgICBzdGFydEFuYWx5c2lzKHRydWUpO1xuICB9KTtcbn1cbiJdLAogICJtYXBwaW5ncyI6ICI7QUFrQk8sSUFBTSxXQUFXLE9BQU8sT0FBTztBQUFBLEVBQ3BDLFVBQWU7QUFBQSxFQUNmLE9BQWU7QUFBQSxFQUNmLE9BQWU7QUFBQSxFQUNmLE1BQWU7QUFBQSxFQUNmLE1BQWU7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
