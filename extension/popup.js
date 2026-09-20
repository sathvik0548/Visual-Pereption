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
async function setBaseServerUrl(url) {
  const clean = (url || "").trim().replace(/\/+$/, "");
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    if (!clean || clean === DEFAULT_SERVER_URL) {
      await new Promise((resolve) => chrome.storage.local.remove([STORAGE_SERVER_KEY], resolve));
    } else {
      await new Promise((resolve) => chrome.storage.local.set({ [STORAGE_SERVER_KEY]: clean }, resolve));
    }
  }
  return clean || DEFAULT_SERVER_URL;
}

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
var serverUrlInput = document.getElementById("serverUrlInput");
var saveServerBtn = document.getElementById("saveServerBtn");
var resetServerBtn = document.getElementById("resetServerBtn");
var serverUrlStatus = document.getElementById("serverUrlStatus");
var ctx = canvas.getContext("2d");
if (openVaultBtn) {
  openVaultBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
  });
}
async function initServerUrlUI() {
  const activeUrl = await getBaseServerUrl();
  if (serverUrlInput)
    serverUrlInput.value = activeUrl;
  if (serverUrlStatus)
    serverUrlStatus.textContent = `Active: ${activeUrl}`;
}
if (saveServerBtn && serverUrlInput) {
  saveServerBtn.addEventListener("click", async () => {
    const rawVal = serverUrlInput.value.trim();
    const saved = await setBaseServerUrl(rawVal);
    if (serverUrlStatus)
      serverUrlStatus.textContent = `Active: ${saved}`;
    setStatus(false, `[SERVER] Updated active endpoint to ${saved}`);
    await fetchProviderStatus();
  });
}
if (resetServerBtn) {
  resetServerBtn.addEventListener("click", async () => {
    const reset = await setBaseServerUrl("");
    if (serverUrlInput)
      serverUrlInput.value = reset;
    if (serverUrlStatus)
      serverUrlStatus.textContent = `Active: ${reset}`;
    setStatus(false, `[SERVER] Reset endpoint to default (${DEFAULT_SERVER_URL})`);
    await fetchProviderStatus();
  });
}
initServerUrlUI();
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
    const baseUrl = await getBaseServerUrl();
    const res = await fetch(`${baseUrl}/provider`);
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
    const baseUrl = await getBaseServerUrl();
    const res = await fetch(`${baseUrl}/provider`, {
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
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsic3JjL3BpaS5qcyIsICJzcmMvc2VydmVyQ29uZmlnLmpzIiwgInNyYy9wb3B1cC5qcyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiLyoqXG4gKiBwaWkuanMgXHUyMDE0IFBJSSAoUGVyc29uYWxseSBJZGVudGlmaWFibGUgSW5mb3JtYXRpb24pIERldGVjdGlvbiBNb2R1bGVcbiAqXG4gKiBkZXRlY3RTZW5zaXRpdmVSZWdpb25zKHsgZG9tUmVnaW9ucywgb2NyRGV0ZWN0aW9ucywgZmFjZURldGVjdGlvbnMgfSlcbiAqICAgXHUyMTkyIFNlbnNpdGl2ZVJlZ2lvbltdXG4gKlxuICogU2Vuc2l0aXZlUmVnaW9uIHNjaGVtYTpcbiAqICAge1xuICogICAgIGJib3g6ICAgICAgIFt4LCB5LCB3LCBoXSwgICAgICAgICAgLy8gcGl4ZWwgY29vcmRzIG1hdGNoaW5nIHRoZSBzY3JlZW5zaG90XG4gKiAgICAgdHlwZTogICAgICAgUElJX1RZUEUuKixcbiAqICAgICBjb25maWRlbmNlOiBudW1iZXIsICAgICAgICAgICAgICAgICAgLy8gMFx1MjAxMzFcbiAqICAgICBzb3VyY2U6ICAgICBcImRvbVwifFwib2NyX3JlZ2V4XCJ8XCJ2aXNpb25cInxcImRvbStvY3JfcmVnZXhcIixcbiAqICAgICBtYXRjaGVkPzogICBzdHJpbmcsICAgICAgICAgICAgICAgICAgLy8gdGhlIG1hdGNoZWQgdGV4dCBzbmlwcGV0IChkZWJ1ZylcbiAqICAgICBsdWhuVmFsaWQ/OiBib29sZWFuLCAgICAgICAgICAgICAgICAgLy8gZm9yIENBUkQgdHlwZVxuICogICB9XG4gKi9cblxuLy8gXHUyNTAwXHUyNTAwIFBJSSB0eXBlIGNvbnN0YW50cyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbmV4cG9ydCBjb25zdCBQSUlfVFlQRSA9IE9iamVjdC5mcmVlemUoe1xuICBQQVNTV09SRDogICAgICBcIlBBU1NXT1JEXCIsXG4gIEVNQUlMOiAgICAgICAgIFwiRU1BSUxcIixcbiAgUEhPTkU6ICAgICAgICAgXCJQSE9ORVwiLFxuICBDQVJEOiAgICAgICAgICBcIkNBUkRcIixcbiAgRkFDRTogICAgICAgICAgXCJGQUNFXCIsXG4gIE5BTUU6ICAgICAgICAgIFwiTkFNRVwiLFxuICBBQURIQUFSOiAgICAgICBcIkFBREhBQVJcIixcbiAgUEFOOiAgICAgICAgICAgXCJQQU5cIixcbiAgR1NUSU46ICAgICAgICAgXCJHU1RJTlwiLFxuICBJRlNDOiAgICAgICAgICBcIklGU0NcIixcbiAgSU5ESUFOX01PQklMRTogXCJJTkRJQU5fTU9CSUxFXCIsXG4gIE9USEVSX1BJSTogICAgIFwiT1RIRVJfUElJXCIsXG59KTtcblxuLy8gUmVuZGVyaW5nIGNvbG91cnMgdXNlZCBieSBwb3B1cCBhbmQgdGVzdCBoYXJuZXNzIChleHBvcnRlZCBmb3IgcmV1c2UpXG5leHBvcnQgY29uc3QgUElJX0NPTE9SUyA9IHtcbiAgUEFTU1dPUkQ6ICAgICAgeyBmaWxsOiBcInJnYmEoMjIwLDM4LDM4LDAuMzUpXCIsICAgc3Ryb2tlOiBcIiNlZjQ0NDRcIiwgdGV4dDogXCIjZmZmXCIgfSxcbiAgRU1BSUw6ICAgICAgICAgeyBmaWxsOiBcInJnYmEoMjM0LDg4LDEyLDAuMzUpXCIsICAgc3Ryb2tlOiBcIiNmOTczMTZcIiwgdGV4dDogXCIjZmZmXCIgfSxcbiAgUEhPTkU6ICAgICAgICAgeyBmaWxsOiBcInJnYmEoMjAyLDEzOCw0LDAuMzUpXCIsICAgc3Ryb2tlOiBcIiNlYWIzMDhcIiwgdGV4dDogXCIjMDAwXCIgfSxcbiAgQ0FSRDogICAgICAgICAgeyBmaWxsOiBcInJnYmEoMjE5LDM5LDExOSwwLjM1KVwiLCAgc3Ryb2tlOiBcIiNlYzQ4OTlcIiwgdGV4dDogXCIjZmZmXCIgfSxcbiAgRkFDRTogICAgICAgICAgeyBmaWxsOiBcInJnYmEoOCwxNDUsMTc4LDAuMzUpXCIsICAgc3Ryb2tlOiBcIiMwNmI2ZDRcIiwgdGV4dDogXCIjZmZmXCIgfSxcbiAgTkFNRTogICAgICAgICAgeyBmaWxsOiBcInJnYmEoMTQ3LDUxLDIzNCwwLjM1KVwiLCAgc3Ryb2tlOiBcIiNhODU1ZjdcIiwgdGV4dDogXCIjZmZmXCIgfSxcbiAgQUFESEFBUjogICAgICAgeyBmaWxsOiBcInJnYmEoMjM0LDg4LDEyLDAuMzUpXCIsICAgc3Ryb2tlOiBcIiNlYTU4MGNcIiwgdGV4dDogXCIjZmZmXCIgfSwgLy8gU2FmZnJvbiAvIERlZXAgT3JhbmdlXG4gIFBBTjogICAgICAgICAgIHsgZmlsbDogXCJyZ2JhKDE2LDE4NSwxMjksMC4zNSlcIiwgIHN0cm9rZTogXCIjMTBiOTgxXCIsIHRleHQ6IFwiI2ZmZlwiIH0sIC8vIEVtZXJhbGRcbiAgR1NUSU46ICAgICAgICAgeyBmaWxsOiBcInJnYmEoOTksMTAyLDI0MSwwLjM1KVwiLCAgc3Ryb2tlOiBcIiM2MzY2ZjFcIiwgdGV4dDogXCIjZmZmXCIgfSwgLy8gSW5kaWdvXG4gIElGU0M6ICAgICAgICAgIHsgZmlsbDogXCJyZ2JhKDE0LDE2NSwyMzMsMC4zNSlcIiwgIHN0cm9rZTogXCIjMGVhNWU5XCIsIHRleHQ6IFwiI2ZmZlwiIH0sIC8vIEN5YW4gLyBTa3lcbiAgSU5ESUFOX01PQklMRTogeyBmaWxsOiBcInJnYmEoMjM0LDE3OSw4LDAuMzUpXCIsICBzdHJva2U6IFwiI2NhOGEwNFwiLCB0ZXh0OiBcIiMwMDBcIiB9LCAvLyBBbWJlciBHb2xkXG4gIE9USEVSX1BJSTogICAgIHsgZmlsbDogXCJyZ2JhKDEwMCwxMTYsMTM5LDAuMzUpXCIsIHN0cm9rZTogXCIjNjQ3NDhiXCIsIHRleHQ6IFwiI2ZmZlwiIH0sXG59O1xuXG4vLyBcdTI1MDBcdTI1MDAgVmVyaG9lZmYgQWxnb3JpdGhtIFRhYmxlcyBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbmNvbnN0IFZFUkhPRUZGX0QgPSBbXG4gIFswLCAxLCAyLCAzLCA0LCA1LCA2LCA3LCA4LCA5XSxcbiAgWzEsIDIsIDMsIDQsIDAsIDYsIDcsIDgsIDksIDVdLFxuICBbMiwgMywgNCwgMCwgMSwgNywgOCwgOSwgNSwgNl0sXG4gIFszLCA0LCAwLCAxLCAyLCA4LCA5LCA1LCA2LCA3XSxcbiAgWzQsIDAsIDEsIDIsIDMsIDksIDUsIDYsIDcsIDhdLFxuICBbNSwgOSwgOCwgNywgNiwgMCwgNCwgMywgMiwgMV0sXG4gIFs2LCA1LCA5LCA4LCA3LCAxLCAwLCA0LCAzLCAyXSxcbiAgWzcsIDYsIDUsIDksIDgsIDIsIDEsIDAsIDQsIDNdLFxuICBbOCwgNywgNiwgNSwgOSwgMywgMiwgMSwgMCwgNF0sXG4gIFs5LCA4LCA3LCA2LCA1LCA0LCAzLCAyLCAxLCAwXVxuXTtcblxuY29uc3QgVkVSSE9FRkZfUCA9IFtcbiAgWzAsIDEsIDIsIDMsIDQsIDUsIDYsIDcsIDgsIDldLFxuICBbMSwgNSwgNywgNiwgMiwgOCwgMywgMCwgOSwgNF0sXG4gIFs1LCA4LCAwLCAzLCA3LCA5LCA2LCAxLCA0LCAyXSxcbiAgWzgsIDksIDEsIDYsIDAsIDQsIDMsIDUsIDIsIDddLFxuICBbOSwgNCwgNSwgMywgMSwgMiwgNiwgOCwgNywgMF0sXG4gIFs0LCAyLCA4LCA2LCA1LCA3LCAzLCA5LCAwLCAxXSxcbiAgWzIsIDcsIDksIDMsIDgsIDAsIDYsIDQsIDEsIDVdLFxuICBbNywgMCwgNCwgNiwgOSwgMSwgMywgMiwgNSwgOF1cbl07XG5cbmV4cG9ydCBmdW5jdGlvbiB2ZXJob2VmZkNoZWNrKHJhdykge1xuICBpZiAodHlwZW9mIHJhdyAhPT0gXCJzdHJpbmdcIikgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBkaWdpdHMgPSByYXcucmVwbGFjZSgvXFxEL2csIFwiXCIpO1xuICBpZiAoIWRpZ2l0cykgcmV0dXJuIGZhbHNlO1xuICBsZXQgYyA9IDA7XG4gIGNvbnN0IHJldmVyc2VkID0gZGlnaXRzLnNwbGl0KFwiXCIpLnJldmVyc2UoKS5tYXAoTnVtYmVyKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCByZXZlcnNlZC5sZW5ndGg7IGkrKykge1xuICAgIGMgPSBWRVJIT0VGRl9EW2NdW1ZFUkhPRUZGX1BbaSAlIDhdW3JldmVyc2VkW2ldXV07XG4gIH1cbiAgcmV0dXJuIGMgPT09IDA7XG59XG5cbi8vIFx1MjUwMFx1MjUwMCBTdHJ1Y3R1cmFsIFZhbGlkYXRvcnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5cbi8qKlxuICogQUFESEFBUjogZXhhY3RseSAxMiBkaWdpdHMsIGZpcnN0IGRpZ2l0IDEtOSBleGNsdWRpbmcgbGVhZGluZyAwLzEgKGkuZS4gc3RhcnRzIHdpdGggMi05KSxcbiAqIGNvbW1vbmx5IGdyb3VwZWQgaW4gNHMgKGUuZy4gXCJYWFhYIFhYWFggWFhYWFwiIG9yIFwiWFhYWFhYWFhYWFhYXCIpLlxuICovXG5leHBvcnQgZnVuY3Rpb24gdmFsaWRhdGVBYWRoYWFyKHJhdykge1xuICBpZiAodHlwZW9mIHJhdyAhPT0gXCJzdHJpbmdcIikgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBjbGVhbmVkID0gcmF3LnJlcGxhY2UoL1tcXHNcXC1dL2csIFwiXCIpO1xuICBpZiAoIS9eXFxkezEyfSQvLnRlc3QoY2xlYW5lZCkpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgZmlyc3QgPSBjbGVhbmVkLmNoYXJBdCgwKTtcbiAgaWYgKGZpcnN0ID09PSBcIjBcIiB8fCBmaXJzdCA9PT0gXCIxXCIpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIHRydWU7XG59XG5cbi8qKlxuICogUEFOOiBleGFjdGx5IDEwIGNoYXJhY3RlcnMgbWF0Y2hpbmcgcGF0dGVybiBbQS1aXXs1fVswLTldezR9W0EtWl17MX1cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHZhbGlkYXRlUEFOKHJhdykge1xuICBpZiAodHlwZW9mIHJhdyAhPT0gXCJzdHJpbmdcIikgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBjbGVhbmVkID0gcmF3LnRyaW0oKS50b1VwcGVyQ2FzZSgpO1xuICBpZiAoY2xlYW5lZC5sZW5ndGggIT09IDEwKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiAvXltBLVpdezV9WzAtOV17NH1bQS1aXSQvLnRlc3QoY2xlYW5lZCk7XG59XG5cbi8qKlxuICogR1NUSU46IDE1IGNoYXJhY3RlcnMsIGZpcnN0IDIgZGlnaXRzIGFyZSBhIHZhbGlkIHN0YXRlIGNvZGUgKDAxLTM4KSxcbiAqIGNoYXJhY3RlcnMgMy0xMiBzdHJ1Y3R1cmFsbHkgbWF0Y2ggYSBQQU4uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB2YWxpZGF0ZUdTVElOKHJhdykge1xuICBpZiAodHlwZW9mIHJhdyAhPT0gXCJzdHJpbmdcIikgcmV0dXJuIGZhbHNlO1xuICBjb25zdCBjbGVhbmVkID0gcmF3LnRyaW0oKS50b1VwcGVyQ2FzZSgpO1xuICBpZiAoY2xlYW5lZC5sZW5ndGggIT09IDE1KSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IHN0YXRlQ29kZVN0ciA9IGNsZWFuZWQuc2xpY2UoMCwgMik7XG4gIGlmICghL15cXGR7Mn0kLy50ZXN0KHN0YXRlQ29kZVN0cikpIHJldHVybiBmYWxzZTtcbiAgY29uc3Qgc3RhdGVDb2RlID0gcGFyc2VJbnQoc3RhdGVDb2RlU3RyLCAxMCk7XG4gIGlmIChzdGF0ZUNvZGUgPCAxIHx8IHN0YXRlQ29kZSA+IDM4KSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IHBhblBhcnQgPSBjbGVhbmVkLnNsaWNlKDIsIDEyKTtcbiAgaWYgKCF2YWxpZGF0ZVBBTihwYW5QYXJ0KSkgcmV0dXJuIGZhbHNlO1xuICBjb25zdCB0YWlsID0gY2xlYW5lZC5zbGljZSgxMiwgMTUpO1xuICByZXR1cm4gL15bMC05QS1aXVpbMC05QS1aXSQvLnRlc3QodGFpbCkgfHwgL15bMC05QS1aXXszfSQvLnRlc3QodGFpbCk7XG59XG5cbi8qKlxuICogSUZTQzogMTEgY2hhcmFjdGVycywgcGF0dGVybiBbQS1aXXs0fTBbQS1aMC05XXs2fSAoNXRoIGNoYXJhY3RlciBzdHJpY3RseSAnMCcpXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB2YWxpZGF0ZUlGU0MocmF3KSB7XG4gIGlmICh0eXBlb2YgcmF3ICE9PSBcInN0cmluZ1wiKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGNsZWFuZWQgPSByYXcudHJpbSgpLnRvVXBwZXJDYXNlKCk7XG4gIGlmIChjbGVhbmVkLmxlbmd0aCAhPT0gMTEpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIC9eW0EtWl17NH0wW0EtWjAtOV17Nn0kLy50ZXN0KGNsZWFuZWQpO1xufVxuXG4vKipcbiAqIElORElBTl9NT0JJTEU6IDEwIGRpZ2l0cyBzdGFydGluZyB3aXRoIDYsIDcsIDgsIG9yIDksIG9wdGlvbmFsbHkgcHJlZml4ZWQgKzkxLCA5MSwgb3IgMFxuICovXG5leHBvcnQgZnVuY3Rpb24gdmFsaWRhdGVJbmRpYW5Nb2JpbGUocmF3KSB7XG4gIGlmICh0eXBlb2YgcmF3ICE9PSBcInN0cmluZ1wiKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGNsZWFuZWQgPSByYXcudHJpbSgpLnJlcGxhY2UoL1tcXHNcXC1cXChcXCldL2csIFwiXCIpO1xuICByZXR1cm4gL14oPzpcXCs5MXw5MXwwKT9bNi05XVxcZHs5fSQvLnRlc3QoY2xlYW5lZCk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMCBMdWhuIGFsZ29yaXRobSBmb3IgY2FyZHMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5mdW5jdGlvbiBsdWhuQ2hlY2socmF3KSB7XG4gIGNvbnN0IGRpZ2l0cyA9IHJhdy5yZXBsYWNlKC9cXEQvZywgXCJcIikuc3BsaXQoXCJcIikucmV2ZXJzZSgpLm1hcChOdW1iZXIpO1xuICBpZiAoZGlnaXRzLmxlbmd0aCA8IDE1KSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IHN1bSA9IGRpZ2l0cy5yZWR1Y2UoKGFjYywgZCwgaSkgPT4ge1xuICAgIGlmIChpICUgMiA9PT0gMSkgeyBkICo9IDI7IGlmIChkID4gOSkgZCAtPSA5OyB9XG4gICAgcmV0dXJuIGFjYyArIGQ7XG4gIH0sIDApO1xuICByZXR1cm4gc3VtICUgMTAgPT09IDA7XG59XG5cbi8vIFx1MjUwMFx1MjUwMCBJb1UgaGVscGVyIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuZnVuY3Rpb24gaW91KGEsIGIpIHtcbiAgY29uc3QgW2F4LCBheSwgYXcsIGFoXSA9IGEuYmJveDtcbiAgY29uc3QgW2J4LCBieSwgYncsIGJoXSA9IGIuYmJveDtcbiAgY29uc3QgaXggPSBNYXRoLm1heChheCwgYngpO1xuICBjb25zdCBpeSA9IE1hdGgubWF4KGF5LCBieSk7XG4gIGNvbnN0IGl3ID0gTWF0aC5taW4oYXggKyBhdywgYnggKyBidykgLSBpeDtcbiAgY29uc3QgaWggPSBNYXRoLm1pbihheSArIGFoLCBieSArIGJoKSAtIGl5O1xuICBpZiAoaXcgPD0gMCB8fCBpaCA8PSAwKSByZXR1cm4gMDtcbiAgY29uc3QgaW50ZXJzZWN0aW9uID0gaXcgKiBpaDtcbiAgY29uc3QgdW5pb24gPSBhdyAqIGFoICsgYncgKiBiaCAtIGludGVyc2VjdGlvbjtcbiAgcmV0dXJuIHVuaW9uID4gMCA/IGludGVyc2VjdGlvbiAvIHVuaW9uIDogMDtcbn1cblxuLy8gXHUyNTAwXHUyNTAwIE1lcmdlIG92ZXJsYXBwaW5nIGRldGVjdGlvbnMgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG5jb25zdCBJT1VfVEhSRVNIT0xEID0gMC4yNTtcblxuZnVuY3Rpb24gbWVyZ2VSZWdpb25zKHJlZ2lvbnMpIHtcbiAgY29uc3QgbWVyZ2VkID0gW107XG4gIGNvbnN0IHVzZWQgICA9IG5ldyBTZXQoKTtcblxuICBmb3IgKGxldCBpID0gMDsgaSA8IHJlZ2lvbnMubGVuZ3RoOyBpKyspIHtcbiAgICBpZiAodXNlZC5oYXMoaSkpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGNsdXN0ZXIgPSBbcmVnaW9uc1tpXV07XG4gICAgdXNlZC5hZGQoaSk7XG5cbiAgICBmb3IgKGxldCBqID0gaSArIDE7IGogPCByZWdpb25zLmxlbmd0aDsgaisrKSB7XG4gICAgICBpZiAodXNlZC5oYXMoaikpIGNvbnRpbnVlO1xuICAgICAgaWYgKGlvdShyZWdpb25zW2ldLCByZWdpb25zW2pdKSA+PSBJT1VfVEhSRVNIT0xEKSB7XG4gICAgICAgIGNsdXN0ZXIucHVzaChyZWdpb25zW2pdKTtcbiAgICAgICAgdXNlZC5hZGQoaik7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGNsdXN0ZXIubGVuZ3RoID09PSAxKSB7XG4gICAgICBtZXJnZWQucHVzaChjbHVzdGVyWzBdKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cblxuICAgIC8vIFVuaW9uIGJvdW5kaW5nIGJveCBhY3Jvc3MgYWxsIGNsdXN0ZXIgbWVtYmVyc1xuICAgIGNvbnN0IHhzICAgID0gY2x1c3Rlci5mbGF0TWFwKChyKSA9PiBbci5iYm94WzBdLCByLmJib3hbMF0gKyByLmJib3hbMl1dKTtcbiAgICBjb25zdCB5cyAgICA9IGNsdXN0ZXIuZmxhdE1hcCgocikgPT4gW3IuYmJveFsxXSwgci5iYm94WzFdICsgci5iYm94WzNdXSk7XG4gICAgY29uc3QgbWluWCAgPSBNYXRoLm1pbiguLi54cyksIG1pblkgPSBNYXRoLm1pbiguLi55cyk7XG4gICAgY29uc3QgbWF4WCAgPSBNYXRoLm1heCguLi54cyksIG1heFkgPSBNYXRoLm1heCguLi55cyk7XG5cbiAgICBjb25zdCBzb3VyY2VzID0gWy4uLm5ldyBTZXQoY2x1c3Rlci5tYXAoKHIpID0+IHIuc291cmNlKSldO1xuICAgIC8vIEhpZ2hlc3QtcHJpb3JpdHkgc291cmNlIChET00gPiBPQ1IgPiB2aXNpb24pXG4gICAgY29uc3QgcHJpb3JpdHkgPSBbXCJkb21cIiwgXCJvY3JfcmVnZXhcIiwgXCJ2aXNpb25cIl07XG4gICAgLy8gU3BlY2lmaWMgSW5kaWFuIHR5cGVzIHByaW9yaXRpemVkIG92ZXIgZ2VuZXJpYyBmYWxsYmFjayB0eXBlc1xuICAgIGNvbnN0IHR5cGVQcmlvcml0eSA9IFtcbiAgICAgIFBJSV9UWVBFLlBBU1NXT1JELFxuICAgICAgUElJX1RZUEUuQ0FSRCxcbiAgICAgIFBJSV9UWVBFLkFBREhBQVIsXG4gICAgICBQSUlfVFlQRS5HU1RJTixcbiAgICAgIFBJSV9UWVBFLlBBTixcbiAgICAgIFBJSV9UWVBFLklGU0MsXG4gICAgICBQSUlfVFlQRS5JTkRJQU5fTU9CSUxFLFxuICAgICAgUElJX1RZUEUuRU1BSUwsXG4gICAgICBQSUlfVFlQRS5QSE9ORSxcbiAgICAgIFBJSV9UWVBFLkZBQ0UsXG4gICAgICBQSUlfVFlQRS5OQU1FLFxuICAgICAgUElJX1RZUEUuT1RIRVJfUElJLFxuICAgIF07XG5cbiAgICBjbHVzdGVyLnNvcnQoKGEsIGIpID0+IHtcbiAgICAgIGNvbnN0IHNyY0RpZmYgPSBwcmlvcml0eS5pbmRleE9mKGEuc291cmNlKSAtIHByaW9yaXR5LmluZGV4T2YoYi5zb3VyY2UpO1xuICAgICAgaWYgKHNyY0RpZmYgIT09IDApIHJldHVybiBzcmNEaWZmO1xuICAgICAgcmV0dXJuIHR5cGVQcmlvcml0eS5pbmRleE9mKGEudHlwZSkgLSB0eXBlUHJpb3JpdHkuaW5kZXhPZihiLnR5cGUpO1xuICAgIH0pO1xuXG4gICAgY29uc3QgbWF4Q29uZiA9IE1hdGgubWF4KC4uLmNsdXN0ZXIubWFwKChyKSA9PiByLmNvbmZpZGVuY2UpKTtcbiAgICBjb25zdCBib29zdGVkID0gTWF0aC5taW4oMSwgbWF4Q29uZiArIChzb3VyY2VzLmxlbmd0aCAtIDEpICogMC4wOCk7XG5cbiAgICBtZXJnZWQucHVzaCh7XG4gICAgICBiYm94OiAgICAgICBbbWluWCwgbWluWSwgbWF4WCAtIG1pblgsIG1heFkgLSBtaW5ZXSxcbiAgICAgIHR5cGU6ICAgICAgIGNsdXN0ZXJbMF0udHlwZSxcbiAgICAgIGNvbmZpZGVuY2U6ICtib29zdGVkLnRvRml4ZWQoMyksXG4gICAgICBzb3VyY2U6ICAgICBzb3VyY2VzLmxlbmd0aCA9PT0gMSA/IHNvdXJjZXNbMF0gOiBzb3VyY2VzLmpvaW4oXCIrXCIpLFxuICAgICAgX2NsdXN0ZXI6ICAgY2x1c3Rlci5tYXAoKHsgdHlwZSwgc291cmNlLCBjb25maWRlbmNlIH0pID0+ICh7IHR5cGUsIHNvdXJjZSwgY29uZmlkZW5jZSB9KSksXG4gICAgfSk7XG4gIH1cblxuICByZXR1cm4gbWVyZ2VkO1xufVxuXG4vLyBcdTI1MDBcdTI1MDAgUGFzcyAxIFx1MjAxNCBET00gc2NhbiByZXN1bHRzIFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFx1MjUwMFxuZnVuY3Rpb24gcGFzc0RPTShkb21SZWdpb25zKSB7XG4gIHJldHVybiAoZG9tUmVnaW9ucyA/PyBbXSkubWFwKChyKSA9PiAoe1xuICAgIGJib3g6ICAgICAgIHIuYmJveCxcbiAgICB0eXBlOiAgICAgICByLnR5cGUsXG4gICAgY29uZmlkZW5jZTogci5jb25maWRlbmNlID8/IDEuMCxcbiAgICBzb3VyY2U6ICAgICBcImRvbVwiLFxuICB9KSk7XG59XG5cbi8vIFx1MjUwMFx1MjUwMCBQYXNzIDIgXHUyMDE0IE9DUi1yZWdleCB3aXRoIFN0cnVjdHVyYWwgVmFsaWRhdGlvbiBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbmZ1bmN0aW9uIHBhc3NPQ1Iob2NyRGV0ZWN0aW9ucykge1xuICBjb25zdCBoaXRzID0gW107XG5cbiAgZm9yIChjb25zdCBkZXQgb2Ygb2NyRGV0ZWN0aW9ucyA/PyBbXSkge1xuICAgIGlmIChkZXQudHlwZSAhPT0gXCJ0ZXh0XCIpIGNvbnRpbnVlO1xuICAgIGNvbnN0IHRleHQgPSBkZXQubGFiZWxfb3JfdGV4dCA/PyBcIlwiO1xuICAgIGNvbnN0IGJib3ggPSBkZXQuYmJveDtcblxuICAgIC8vIDEuIEdTVElOICgxNSBjaGFycykgXHUyMDE0IHRlc3RlZCBiZWZvcmUgUEFOIHNvIFBBTiBpcyBub3QgaXNvbGF0ZWQgZnJvbSBhIEdTVElOXG4gICAgY29uc3QgZ3N0aW5NYXRjaGVzID0gdGV4dC5tYXRjaEFsbCgvXFxiKDBbMS05XXxbMTJdWzAtOV18M1swLThdKVtBLVpdezV9WzAtOV17NH1bQS1aXVswLTlBLVpdezN9XFxiL2dpKTtcbiAgICBmb3IgKGNvbnN0IG0gb2YgZ3N0aW5NYXRjaGVzKSB7XG4gICAgICBpZiAodmFsaWRhdGVHU1RJTihtWzBdKSkge1xuICAgICAgICBoaXRzLnB1c2goe1xuICAgICAgICAgIGJib3gsIHNvdXJjZTogXCJvY3JfcmVnZXhcIiwgbWF0Y2hlZDogbVswXS50b1VwcGVyQ2FzZSgpLFxuICAgICAgICAgIHR5cGU6ICAgICAgIFBJSV9UWVBFLkdTVElOLFxuICAgICAgICAgIGNvbmZpZGVuY2U6IDAuOTYsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIDIuIFBBTiAoMTAgY2hhcnMpXG4gICAgY29uc3QgcGFuTWF0Y2hlcyA9IHRleHQubWF0Y2hBbGwoL1xcYltBLVpdezV9WzAtOV17NH1bQS1aXVxcYi9naSk7XG4gICAgZm9yIChjb25zdCBtIG9mIHBhbk1hdGNoZXMpIHtcbiAgICAgIGNvbnN0IGlzUGFydE9mR3N0aW4gPSBoaXRzLnNvbWUoaCA9PiBoLnR5cGUgPT09IFBJSV9UWVBFLkdTVElOICYmIGgubWF0Y2hlZD8uaW5jbHVkZXMobVswXS50b1VwcGVyQ2FzZSgpKSk7XG4gICAgICBpZiAoIWlzUGFydE9mR3N0aW4gJiYgdmFsaWRhdGVQQU4obVswXSkpIHtcbiAgICAgICAgaGl0cy5wdXNoKHtcbiAgICAgICAgICBiYm94LCBzb3VyY2U6IFwib2NyX3JlZ2V4XCIsIG1hdGNoZWQ6IG1bMF0udG9VcHBlckNhc2UoKSxcbiAgICAgICAgICB0eXBlOiAgICAgICBQSUlfVFlQRS5QQU4sXG4gICAgICAgICAgY29uZmlkZW5jZTogMC45NCxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gMy4gQUFESEFBUiAoMTIgZGlnaXRzLCBncm91cGVkIG9yIHJhdywgZmlyc3QgZGlnaXQgMi05KVxuICAgIGNvbnN0IGFhZGhhYXJNYXRjaGVzID0gdGV4dC5tYXRjaEFsbCgvXFxiWzItOV1cXGR7M31bXFxzXFwtXT9bMC05XXs0fVtcXHNcXC1dP1swLTldezR9XFxiL2cpO1xuICAgIGZvciAoY29uc3QgbSBvZiBhYWRoYWFyTWF0Y2hlcykge1xuICAgICAgaWYgKHZhbGlkYXRlQWFkaGFhcihtWzBdKSkge1xuICAgICAgICBjb25zdCB2VmFsaWQgPSB2ZXJob2VmZkNoZWNrKG1bMF0pO1xuICAgICAgICBoaXRzLnB1c2goe1xuICAgICAgICAgIGJib3gsIHNvdXJjZTogXCJvY3JfcmVnZXhcIiwgbWF0Y2hlZDogbVswXS50cmltKCksXG4gICAgICAgICAgdmVyaG9lZmZWYWxpZDogdlZhbGlkLFxuICAgICAgICAgIHR5cGU6ICAgICAgICAgIFBJSV9UWVBFLkFBREhBQVIsXG4gICAgICAgICAgY29uZmlkZW5jZTogICAgdlZhbGlkID8gMC45NiA6IDAuOTEsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIDQuIElGU0MgKDExIGNoYXJzLCA1dGggZGlnaXQgJzAnKVxuICAgIGNvbnN0IGlmc2NNYXRjaGVzID0gdGV4dC5tYXRjaEFsbCgvXFxiW0EtWl17NH0wW0EtWjAtOV17Nn1cXGIvZ2kpO1xuICAgIGZvciAoY29uc3QgbSBvZiBpZnNjTWF0Y2hlcykge1xuICAgICAgaWYgKHZhbGlkYXRlSUZTQyhtWzBdKSkge1xuICAgICAgICBoaXRzLnB1c2goe1xuICAgICAgICAgIGJib3gsIHNvdXJjZTogXCJvY3JfcmVnZXhcIiwgbWF0Y2hlZDogbVswXS50b1VwcGVyQ2FzZSgpLFxuICAgICAgICAgIHR5cGU6ICAgICAgIFBJSV9UWVBFLklGU0MsXG4gICAgICAgICAgY29uZmlkZW5jZTogMC45NCxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gNS4gSU5ESUFOX01PQklMRVxuICAgIGNvbnN0IG1vYmlsZU1hdGNoZXMgPSB0ZXh0Lm1hdGNoQWxsKC8oPzooPzpcXCs5MXwwKVtcXHNcXC1dPyk/WzYtOV1cXGR7NH1bXFxzXFwtXT9cXGR7NX1cXGJ8KD86XFwrOTFbXFxzXFwtXT8pP1s2LTldXFxkezl9XFxifFxcYls2LTldXFxkezl9XFxiL2cpO1xuICAgIGZvciAoY29uc3QgbSBvZiBtb2JpbGVNYXRjaGVzKSB7XG4gICAgICBpZiAodmFsaWRhdGVJbmRpYW5Nb2JpbGUobVswXSkpIHtcbiAgICAgICAgaGl0cy5wdXNoKHtcbiAgICAgICAgICBiYm94LCBzb3VyY2U6IFwib2NyX3JlZ2V4XCIsIG1hdGNoZWQ6IG1bMF0udHJpbSgpLFxuICAgICAgICAgIHR5cGU6ICAgICAgIFBJSV9UWVBFLklORElBTl9NT0JJTEUsXG4gICAgICAgICAgY29uZmlkZW5jZTogMC45MixcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gNi4gRU1BSUxcbiAgICBjb25zdCBlbWFpbE1hdGNoZXMgPSB0ZXh0Lm1hdGNoQWxsKC9bYS16QS1aMC05Ll8lK1xcLV0rQFthLXpBLVowLTkuXFwtXStcXC5bYS16QS1aXXsyLH0vZyk7XG4gICAgZm9yIChjb25zdCBtIG9mIGVtYWlsTWF0Y2hlcykge1xuICAgICAgaGl0cy5wdXNoKHtcbiAgICAgICAgYmJveCwgc291cmNlOiBcIm9jcl9yZWdleFwiLCBtYXRjaGVkOiBtWzBdLFxuICAgICAgICB0eXBlOiAgICAgICBQSUlfVFlQRS5FTUFJTCxcbiAgICAgICAgY29uZmlkZW5jZTogMC45NSxcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIDcuIEdlbmVyaWMgUEhPTkUgKGlmIG5vdCBhbHJlYWR5IG1hdGNoZWQgYXMgSU5ESUFOX01PQklMRSlcbiAgICBjb25zdCBwaG9uZU1hdGNoZXMgPSB0ZXh0Lm1hdGNoQWxsKC8oPzooPzpcXCs5MXwwMDkxfDApW1xcc1xcLV0/KT9bNi05XVxcZHs5fXwoPzpcXCtcXGR7MSwzfVtcXHNcXC1dPyk/XFwoP1xcZHsyLDR9XFwpP1tcXHNcXC1dP1xcZHszLDR9W1xcc1xcLV0/XFxkezR9L2cpO1xuICAgIGZvciAoY29uc3QgbSBvZiBwaG9uZU1hdGNoZXMpIHtcbiAgICAgIGNvbnN0IGRpZ2l0cyA9IG1bMF0ucmVwbGFjZSgvXFxEL2csIFwiXCIpO1xuICAgICAgaWYgKGRpZ2l0cy5sZW5ndGggPj0gMTApIHtcbiAgICAgICAgY29uc3QgYWxyZWFkeU1vYmlsZSA9IGhpdHMuc29tZShoID0+IGgudHlwZSA9PT0gUElJX1RZUEUuSU5ESUFOX01PQklMRSAmJiBoLm1hdGNoZWQ/LmluY2x1ZGVzKGRpZ2l0cy5zbGljZSgtMTApKSk7XG4gICAgICAgIGlmICghYWxyZWFkeU1vYmlsZSkge1xuICAgICAgICAgIGhpdHMucHVzaCh7XG4gICAgICAgICAgICBiYm94LCBzb3VyY2U6IFwib2NyX3JlZ2V4XCIsIG1hdGNoZWQ6IG1bMF0udHJpbSgpLFxuICAgICAgICAgICAgdHlwZTogICAgICAgUElJX1RZUEUuUEhPTkUsXG4gICAgICAgICAgICBjb25maWRlbmNlOiAwLjgyLFxuICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgLy8gOC4gQ0FSRCBudW1iZXIgd2l0aCBMdWhuIHZlcmlmaWNhdGlvblxuICAgIGNvbnN0IGNhcmRNYXRjaGVzID0gdGV4dC5tYXRjaEFsbCgvXFxiKD86XFxkezR9W1xcc1xcLV0/KXszfVxcZHs0fVxcYnxcXGJcXGR7MTUsMTZ9XFxiL2cpO1xuICAgIGZvciAoY29uc3QgbSBvZiBjYXJkTWF0Y2hlcykge1xuICAgICAgY29uc3QgZGlnaXRzID0gbVswXS5yZXBsYWNlKC9cXEQvZywgXCJcIik7XG4gICAgICBpZiAoZGlnaXRzLmxlbmd0aCA+PSAxNSkge1xuICAgICAgICBjb25zdCB2YWxpZCA9IGx1aG5DaGVjayhkaWdpdHMpO1xuICAgICAgICBoaXRzLnB1c2goe1xuICAgICAgICAgIGJib3gsIHNvdXJjZTogXCJvY3JfcmVnZXhcIiwgbWF0Y2hlZDogbVswXSwgbHVoblZhbGlkOiB2YWxpZCxcbiAgICAgICAgICB0eXBlOiAgICAgICBQSUlfVFlQRS5DQVJELFxuICAgICAgICAgIGNvbmZpZGVuY2U6IHZhbGlkID8gMC45MyA6IDAuNzIsXG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH1cbiAgfVxuXG4gIHJldHVybiBoaXRzO1xufVxuXG4vLyBcdTI1MDBcdTI1MDAgUGFzcyAzIFx1MjAxNCBGYWNlIGRldGVjdGlvbnMgKGZyb20gQmxhemVGYWNlKSBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcdTI1MDBcbmZ1bmN0aW9uIHBhc3NGYWNlKGZhY2VEZXRlY3Rpb25zKSB7XG4gIHJldHVybiAoZmFjZURldGVjdGlvbnMgPz8gW10pXG4gICAgLmZpbHRlcigoZikgPT4ge1xuICAgICAgY29uc3QgW3gsIHksIHcsIGhdID0gZi5iYm94IHx8IFtdO1xuICAgICAgaWYgKCF3IHx8ICFoIHx8IHcgPCAyNCB8fCBoIDwgMjQpIHJldHVybiBmYWxzZTtcbiAgICAgIGNvbnN0IGFzcGVjdCA9IHcgLyBoO1xuICAgICAgaWYgKGFzcGVjdCA8IDAuNTUgfHwgYXNwZWN0ID4gMS40MCkgcmV0dXJuIGZhbHNlO1xuICAgICAgcmV0dXJuIChmLmNvbmZpZGVuY2UgPz8gMCkgPj0gMC44NTtcbiAgICB9KVxuICAgIC5tYXAoKGYpID0+ICh7XG4gICAgICBiYm94OiAgICAgICBmLmJib3gsXG4gICAgICB0eXBlOiAgICAgICBQSUlfVFlQRS5GQUNFLFxuICAgICAgY29uZmlkZW5jZTogK051bWJlcihmLmNvbmZpZGVuY2UpLnRvRml4ZWQoNCksXG4gICAgICBzb3VyY2U6ICAgICBcInZpc2lvblwiLFxuICAgIH0pKTtcbn1cblxuLy8gXHUyNTAwXHUyNTAwIFB1YmxpYyBBUEkgXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXHUyNTAwXG4vKipcbiAqIGRldGVjdFNlbnNpdGl2ZVJlZ2lvbnNcbiAqXG4gKiBAcGFyYW0ge29iamVjdH0gcGFyYW1zXG4gKiBAcGFyYW0ge0FycmF5fSAgcGFyYW1zLmRvbVJlZ2lvbnMgICAgIFx1MjAxNCBmcm9tIGNvbnRlbnQuanMgU0NBTl9ET00gKHByZS1EUFItc2NhbGVkKVxuICogQHBhcmFtIHtBcnJheX0gIHBhcmFtcy5vY3JEZXRlY3Rpb25zICBcdTIwMTQgZnJvbSBGbG9yZW5jZS0yIGFuYWx5emVJbWFnZSgpXG4gKiBAcGFyYW0ge0FycmF5fSAgcGFyYW1zLmZhY2VEZXRlY3Rpb25zIFx1MjAxNCBmcm9tIGZhY2UuanMgZGV0ZWN0RmFjZXMoKVxuICogQHJldHVybnMge1NlbnNpdGl2ZVJlZ2lvbltdfVxuICovXG5leHBvcnQgZnVuY3Rpb24gZGV0ZWN0U2Vuc2l0aXZlUmVnaW9ucyh7IGRvbVJlZ2lvbnMsIG9jckRldGVjdGlvbnMsIGZhY2VEZXRlY3Rpb25zIH0pIHtcbiAgY29uc29sZS5sb2coXCJbUElJXSA9PT0gZGV0ZWN0U2Vuc2l0aXZlUmVnaW9ucyBJTlZPS0VEID09PVwiKTtcbiAgY29uc29sZS5sb2coYFtQSUldIFJhdyBJbnB1dHMgLT4gZG9tUmVnaW9uczogJHsoZG9tUmVnaW9ucyA/PyBbXSkubGVuZ3RofSwgb2NyRGV0ZWN0aW9uczogJHsob2NyRGV0ZWN0aW9ucyA/PyBbXSkubGVuZ3RofSwgZmFjZURldGVjdGlvbnM6ICR7KGZhY2VEZXRlY3Rpb25zID8/IFtdKS5sZW5ndGh9YCk7XG5cbiAgY29uc3QgZG9tSGl0cyAgPSBwYXNzRE9NKGRvbVJlZ2lvbnMpO1xuICBjb25zdCBvY3JIaXRzICA9IHBhc3NPQ1Iob2NyRGV0ZWN0aW9ucyk7XG4gIGNvbnN0IGZhY2VIaXRzID0gcGFzc0ZhY2UoZmFjZURldGVjdGlvbnMpO1xuXG4gIGNvbnNvbGUubG9nKGBbUElJXSBbU291cmNlIDE6IERPTSBQYXNzXSBSYXcgb3V0cHV0ICgke2RvbUhpdHMubGVuZ3RofSBpdGVtcyk6YCwgZG9tSGl0cyk7XG4gIGNvbnNvbGUubG9nKGBbUElJXSBbU291cmNlIDI6IE9DUiBQYXNzXSBSYXcgb3V0cHV0ICgke29jckhpdHMubGVuZ3RofSBpdGVtcyk6YCwgb2NySGl0cyk7XG4gIGNvbnNvbGUubG9nKGBbUElJXSBbU291cmNlIDM6IFZpc2lvbi9GYWNlIFBhc3NdIFJhdyBvdXRwdXQgKCR7ZmFjZUhpdHMubGVuZ3RofSBpdGVtcyk6YCwgZmFjZUhpdHMpO1xuXG4gIGNvbnN0IGFsbCA9IFsuLi5kb21IaXRzLCAuLi5vY3JIaXRzLCAuLi5mYWNlSGl0c107XG4gIGNvbnNvbGUubG9nKGBbUElJXSBDb21iaW5lZCB1bm1lcmdlZCBjYW5kaWRhdGVzICgke2FsbC5sZW5ndGh9IHRvdGFsIGZyb20gRE9NICsgT0NSICsgVmlzaW9uKTpgLCBhbGwpO1xuXG4gIGNvbnN0IHJlc3VsdCA9IG1lcmdlUmVnaW9ucyhhbGwpO1xuXG4gIGNvbnNvbGUubG9nKFxuICAgIGBbUElJXSBGaW5hbCBtZXJnZWQgc2Vuc2l0aXZlIHJlZ2lvbihzKTogJHtyZXN1bHQubGVuZ3RofWAgK1xuICAgIGAgKGRvbToke2RvbUhpdHMubGVuZ3RofSwgb2NyOiR7b2NySGl0cy5sZW5ndGh9LCBmYWNlOiR7ZmFjZUhpdHMubGVuZ3RofSlcXG5gICtcbiAgICBKU09OLnN0cmluZ2lmeShyZXN1bHQsIG51bGwsIDIpXG4gICk7XG5cbiAgcmV0dXJuIHJlc3VsdDtcbn1cblxuIiwgIi8qKlxuICogc2VydmVyQ29uZmlnLmpzIFx1MjAxNCBTaGFyZWQgU2VydmVyIENvbmZpZ3VyYXRpb24gSGVscGVyXG4gKlxuICogRGVmYXVsdCByZW1vdGUgc2VydmVyOiBodHRwczovL3Zpc3VhbC1wZXJlcHRpb24ub25yZW5kZXIuY29tXG4gKiBTdG9yZWQgdW5kZXIga2V5IFwiY3VzdG9tX3NlcnZlcl91cmxcIiBpbiBjaHJvbWUuc3RvcmFnZS5sb2NhbCBmb3IgcG9wdXAgb3ZlcnJpZGVzLlxuICovXG5cbmV4cG9ydCBjb25zdCBERUZBVUxUX1NFUlZFUl9VUkwgPSBcImh0dHBzOi8vdmlzdWFsLXBlcmVwdGlvbi5vbnJlbmRlci5jb21cIjtcbmV4cG9ydCBjb25zdCBTVE9SQUdFX1NFUlZFUl9LRVkgPSBcImN1c3RvbV9zZXJ2ZXJfdXJsXCI7XG5cbi8qKlxuICogUmV0dXJucyB0aGUgZWZmZWN0aXZlIGJhc2Ugc2VydmVyIFVSTCAod2l0aG91dCB0cmFpbGluZyBzbGFzaCkuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBnZXRCYXNlU2VydmVyVXJsKCkge1xuICBpZiAodHlwZW9mIGNocm9tZSAhPT0gXCJ1bmRlZmluZWRcIiAmJiBjaHJvbWUuc3RvcmFnZSAmJiBjaHJvbWUuc3RvcmFnZS5sb2NhbCkge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBkYXRhID0gYXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmUpID0+IHtcbiAgICAgICAgY2hyb21lLnN0b3JhZ2UubG9jYWwuZ2V0KFtTVE9SQUdFX1NFUlZFUl9LRVldLCByZXNvbHZlKTtcbiAgICAgIH0pO1xuICAgICAgaWYgKGRhdGEgJiYgZGF0YVtTVE9SQUdFX1NFUlZFUl9LRVldICYmIHR5cGVvZiBkYXRhW1NUT1JBR0VfU0VSVkVSX0tFWV0gPT09IFwic3RyaW5nXCIgJiYgZGF0YVtTVE9SQUdFX1NFUlZFUl9LRVldLnRyaW0oKSkge1xuICAgICAgICByZXR1cm4gZGF0YVtTVE9SQUdFX1NFUlZFUl9LRVldLnRyaW0oKS5yZXBsYWNlKC9cXC8rJC8sIFwiXCIpO1xuICAgICAgfVxuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnNvbGUud2FybihcIltzZXJ2ZXJDb25maWddIENvdWxkIG5vdCByZWFkIGN1c3RvbV9zZXJ2ZXJfdXJsOlwiLCBlKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIERFRkFVTFRfU0VSVkVSX1VSTDtcbn1cblxuLyoqXG4gKiBQZXJzaXN0cyBhIG5ldyBiYXNlIHNlcnZlciBVUkwgb3ZlcnJpZGUgKG9yIHJlc2V0cyB0byBkZWZhdWx0IGlmIGVtcHR5KS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHNldEJhc2VTZXJ2ZXJVcmwodXJsKSB7XG4gIGNvbnN0IGNsZWFuID0gKHVybCB8fCBcIlwiKS50cmltKCkucmVwbGFjZSgvXFwvKyQvLCBcIlwiKTtcbiAgaWYgKHR5cGVvZiBjaHJvbWUgIT09IFwidW5kZWZpbmVkXCIgJiYgY2hyb21lLnN0b3JhZ2UgJiYgY2hyb21lLnN0b3JhZ2UubG9jYWwpIHtcbiAgICBpZiAoIWNsZWFuIHx8IGNsZWFuID09PSBERUZBVUxUX1NFUlZFUl9VUkwpIHtcbiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiBjaHJvbWUuc3RvcmFnZS5sb2NhbC5yZW1vdmUoW1NUT1JBR0VfU0VSVkVSX0tFWV0sIHJlc29sdmUpKTtcbiAgICB9IGVsc2Uge1xuICAgICAgYXdhaXQgbmV3IFByb21pc2UoKHJlc29sdmUpID0+IGNocm9tZS5zdG9yYWdlLmxvY2FsLnNldCh7IFtTVE9SQUdFX1NFUlZFUl9LRVldOiBjbGVhbiB9LCByZXNvbHZlKSk7XG4gICAgfVxuICB9XG4gIHJldHVybiBjbGVhbiB8fCBERUZBVUxUX1NFUlZFUl9VUkw7XG59XG4iLCAiLyoqXG4gKiBwb3B1cC5qcyBcdTIwMTQgUG9wdXAgc2NyaXB0ICAoc3JjL3BvcHVwLmpzIFx1MjE5MiBidWlsdCBwb3B1cC5qcylcbiAqXG4gKiB2MC4yOiByZW5kZXJzIHR3byBvdmVybGF5IGxheWVycyBvbiB0aGUgZGVidWcgY2FudmFzOlxuICogICBMYXllciAxIFx1MjAxNCBGbG9yZW5jZS0yIGRldGVjdGlvbnMgKE9EPWdyZWVuIG91dGxpbmUsIE9DUj1ibHVlIG91dGxpbmUpXG4gKiAgIExheWVyIDIgXHUyMDE0IFBJSSBzZW5zaXRpdmUgcmVnaW9ucyAoZmlsbGVkLCBjb2xvdXItY29kZWQgcGVyIHR5cGUpXG4gKlxuICogQWxzbyBzaG93cyBhIGNvbXBhY3QgUElJIGJyZWFrZG93biB0YWJsZSBiZWxvdyB0aGUgY2FudmFzLlxuICovXG5cbmltcG9ydCB7IFBJSV9DT0xPUlMgfSBmcm9tIFwiLi9waWkuanNcIjtcbmltcG9ydCB7IGdldEJhc2VTZXJ2ZXJVcmwsIHNldEJhc2VTZXJ2ZXJVcmwsIERFRkFVTFRfU0VSVkVSX1VSTCB9IGZyb20gXCIuL3NlcnZlckNvbmZpZy5qc1wiO1xuXG5jb25zdCBhbmFseXplQnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJhbmFseXplQnRuXCIpO1xuY29uc3QgZGVtb0J0biAgICA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwiZGVtb0J0blwiKTtcbmNvbnN0IHRhc2tJbnB1dCAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInRhc2tJbnB1dFwiKTtcbmNvbnN0IHN0YXR1c0VsICAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInN0YXR1c1RleHRcIik7XG5jb25zdCBjYW52YXNXcmFwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJjYW52YXNXcmFwXCIpO1xuY29uc3QgY2FudmFzICAgICA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwiZGVidWdDYW52YXNcIik7XG4gICAgY29uc3QgbGVnZW5kRWwgICA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwibGVnZW5kXCIpO1xuY29uc3QgcGlpVGFibGUgICA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwicGlpVGFibGVcIik7XG5jb25zdCBtb2RlU2VsZWN0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJtb2RlU2VsZWN0XCIpO1xuY29uc3QgbW9kZUJhZGdlICA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwibW9kZVN0YXR1c0JhZGdlXCIpO1xuY29uc3QgbW9kZURvdCAgICA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwibW9kZVN0YXR1c0RvdFwiKTtcbmNvbnN0IG1vZGVUZXh0ICAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcIm1vZGVTdGF0dXNUZXh0XCIpO1xuY29uc3Qgb3BlblZhdWx0QnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJvcGVuVmF1bHRCdG5cIik7XG5jb25zdCBzZXJ2ZXJVcmxJbnB1dCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic2VydmVyVXJsSW5wdXRcIik7XG5jb25zdCBzYXZlU2VydmVyQnRuICA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic2F2ZVNlcnZlckJ0blwiKTtcbmNvbnN0IHJlc2V0U2VydmVyQnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJyZXNldFNlcnZlckJ0blwiKTtcbmNvbnN0IHNlcnZlclVybFN0YXR1cyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwic2VydmVyVXJsU3RhdHVzXCIpO1xuY29uc3QgY3R4ICAgICAgICA9IGNhbnZhcy5nZXRDb250ZXh0KFwiMmRcIik7XG5cbmlmIChvcGVuVmF1bHRCdG4pIHtcbiAgb3BlblZhdWx0QnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiB7XG4gICAgY2hyb21lLnRhYnMuY3JlYXRlKHsgdXJsOiBjaHJvbWUucnVudGltZS5nZXRVUkwoXCJzZXR0aW5ncy5odG1sXCIpIH0pO1xuICB9KTtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBTZXJ2ZXIgVVJMIENvbmZpZ3VyYXRpb24gJiBQZXJzaXN0ZW5jZVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5hc3luYyBmdW5jdGlvbiBpbml0U2VydmVyVXJsVUkoKSB7XG4gIGNvbnN0IGFjdGl2ZVVybCA9IGF3YWl0IGdldEJhc2VTZXJ2ZXJVcmwoKTtcbiAgaWYgKHNlcnZlclVybElucHV0KSBzZXJ2ZXJVcmxJbnB1dC52YWx1ZSA9IGFjdGl2ZVVybDtcbiAgaWYgKHNlcnZlclVybFN0YXR1cykgc2VydmVyVXJsU3RhdHVzLnRleHRDb250ZW50ID0gYEFjdGl2ZTogJHthY3RpdmVVcmx9YDtcbn1cblxuaWYgKHNhdmVTZXJ2ZXJCdG4gJiYgc2VydmVyVXJsSW5wdXQpIHtcbiAgc2F2ZVNlcnZlckJ0bi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHJhd1ZhbCA9IHNlcnZlclVybElucHV0LnZhbHVlLnRyaW0oKTtcbiAgICBjb25zdCBzYXZlZCA9IGF3YWl0IHNldEJhc2VTZXJ2ZXJVcmwocmF3VmFsKTtcbiAgICBpZiAoc2VydmVyVXJsU3RhdHVzKSBzZXJ2ZXJVcmxTdGF0dXMudGV4dENvbnRlbnQgPSBgQWN0aXZlOiAke3NhdmVkfWA7XG4gICAgc2V0U3RhdHVzKGZhbHNlLCBgW1NFUlZFUl0gVXBkYXRlZCBhY3RpdmUgZW5kcG9pbnQgdG8gJHtzYXZlZH1gKTtcbiAgICBhd2FpdCBmZXRjaFByb3ZpZGVyU3RhdHVzKCk7XG4gIH0pO1xufVxuXG5pZiAocmVzZXRTZXJ2ZXJCdG4pIHtcbiAgcmVzZXRTZXJ2ZXJCdG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGFzeW5jICgpID0+IHtcbiAgICBjb25zdCByZXNldCA9IGF3YWl0IHNldEJhc2VTZXJ2ZXJVcmwoXCJcIik7XG4gICAgaWYgKHNlcnZlclVybElucHV0KSBzZXJ2ZXJVcmxJbnB1dC52YWx1ZSA9IHJlc2V0O1xuICAgIGlmIChzZXJ2ZXJVcmxTdGF0dXMpIHNlcnZlclVybFN0YXR1cy50ZXh0Q29udGVudCA9IGBBY3RpdmU6ICR7cmVzZXR9YDtcbiAgICBzZXRTdGF0dXMoZmFsc2UsIGBbU0VSVkVSXSBSZXNldCBlbmRwb2ludCB0byBkZWZhdWx0ICgke0RFRkFVTFRfU0VSVkVSX1VSTH0pYCk7XG4gICAgYXdhaXQgZmV0Y2hQcm92aWRlclN0YXR1cygpO1xuICB9KTtcbn1cblxuaW5pdFNlcnZlclVybFVJKCk7XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gUHJvdmlkZXIgTW9kZSBTdGF0dXMgJiBTd2l0Y2hlclxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5mdW5jdGlvbiB1cGRhdGVNb2RlVUkobW9kZSwgY3VzdG9tVGV4dCkge1xuICBpZiAobW9kZSA9PT0gXCJvZmZsaW5lXCIpIHtcbiAgICBpZiAobW9kZVNlbGVjdCkgbW9kZVNlbGVjdC52YWx1ZSA9IFwib2ZmbGluZVwiO1xuICAgIGlmIChtb2RlQmFkZ2UpIHtcbiAgICAgIG1vZGVCYWRnZS5zdHlsZS5iYWNrZ3JvdW5kID0gXCIjZjBmZGY0XCI7XG4gICAgICBtb2RlQmFkZ2Uuc3R5bGUuY29sb3IgPSBcIiMxNTgwM2RcIjtcbiAgICAgIG1vZGVCYWRnZS5zdHlsZS5ib3JkZXJDb2xvciA9IFwiI2JiZjdkMFwiO1xuICAgIH1cbiAgICBpZiAobW9kZURvdCkgbW9kZURvdC5zdHlsZS5iYWNrZ3JvdW5kID0gXCIjMTZhMzRhXCI7XG4gICAgaWYgKG1vZGVUZXh0KSBtb2RlVGV4dC50ZXh0Q29udGVudCA9IGN1c3RvbVRleHQgfHwgXCJPRkZMSU5FIE1PREUgKExvY2FsIE9sbGFtYSBcdTIwMTQgbm8gbmV0d29yayByZXF1aXJlZClcIjtcbiAgfSBlbHNlIHtcbiAgICBpZiAobW9kZVNlbGVjdCkgbW9kZVNlbGVjdC52YWx1ZSA9IFwiY2xvdWRcIjtcbiAgICBpZiAobW9kZUJhZGdlKSB7XG4gICAgICBtb2RlQmFkZ2Uuc3R5bGUuYmFja2dyb3VuZCA9IFwiI2UwZjJmZVwiO1xuICAgICAgbW9kZUJhZGdlLnN0eWxlLmNvbG9yID0gXCIjMDM2OWExXCI7XG4gICAgICBtb2RlQmFkZ2Uuc3R5bGUuYm9yZGVyQ29sb3IgPSBcIiNiYWU2ZmRcIjtcbiAgICB9XG4gICAgaWYgKG1vZGVEb3QpIG1vZGVEb3Quc3R5bGUuYmFja2dyb3VuZCA9IFwiIzAyODRjN1wiO1xuICAgIGlmIChtb2RlVGV4dCkgbW9kZVRleHQudGV4dENvbnRlbnQgPSBjdXN0b21UZXh0IHx8IFwiQ0xPVUQgTU9ERSAoR3JvcSlcIjtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBmZXRjaFByb3ZpZGVyU3RhdHVzKCkge1xuICB0cnkge1xuICAgIGNvbnN0IGJhc2VVcmwgPSBhd2FpdCBnZXRCYXNlU2VydmVyVXJsKCk7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYCR7YmFzZVVybH0vcHJvdmlkZXJgKTtcbiAgICBpZiAocmVzLm9rKSB7XG4gICAgICBjb25zdCBkYXRhID0gYXdhaXQgcmVzLmpzb24oKTtcbiAgICAgIHVwZGF0ZU1vZGVVSShkYXRhLm1vZGUsIGRhdGEuc3RhdHVzVGV4dCk7XG4gICAgfVxuICB9IGNhdGNoIChlcnIpIHtcbiAgICBjb25zb2xlLndhcm4oXCJbUG9wdXBdIENvdWxkIG5vdCBmZXRjaCBwcm92aWRlciBzdGF0dXMgZnJvbSBzZXJ2ZXI6XCIsIGVyci5tZXNzYWdlKTtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBzZXRQcm92aWRlck1vZGUobW9kZSkge1xuICB0cnkge1xuICAgIGNvbnN0IGJhc2VVcmwgPSBhd2FpdCBnZXRCYXNlU2VydmVyVXJsKCk7XG4gICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goYCR7YmFzZVVybH0vcHJvdmlkZXJgLCB7XG4gICAgICBtZXRob2Q6IFwiUE9TVFwiLFxuICAgICAgaGVhZGVyczogeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9LFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBtb2RlIH0pLFxuICAgIH0pO1xuICAgIGlmIChyZXMub2spIHtcbiAgICAgIGNvbnN0IGRhdGEgPSBhd2FpdCByZXMuanNvbigpO1xuICAgICAgdXBkYXRlTW9kZVVJKGRhdGEubW9kZSwgZGF0YS5zdGF0dXNUZXh0KTtcbiAgICAgIHNldFN0YXR1cyhmYWxzZSwgYFtNT0RFXSBBY3RpdmUgcHJvdmlkZXIgc3dpdGNoZWQgdG8gJHtkYXRhLnByb3ZpZGVyfWApO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYFNlcnZlciByZXR1cm5lZCBIVFRQICR7cmVzLnN0YXR1c31gKTtcbiAgICB9XG4gIH0gY2F0Y2ggKGVycikge1xuICAgIGNvbnNvbGUuZXJyb3IoXCJbUG9wdXBdIEZhaWxlZCB0byBzd2l0Y2ggcHJvdmlkZXIgbW9kZTpcIiwgZXJyKTtcbiAgICBzZXRTdGF0dXModHJ1ZSwgYFtNT0RFIEVSUk9SXSBGYWlsZWQgdG8gc3dpdGNoIHByb3ZpZGVyOiAke2Vyci5tZXNzYWdlfWApO1xuICAgIC8vIFJldmVydCBVSSB0byBtYXRjaCBzZXJ2ZXJcbiAgICBmZXRjaFByb3ZpZGVyU3RhdHVzKCk7XG4gIH1cbn1cblxuaWYgKG1vZGVTZWxlY3QpIHtcbiAgbW9kZVNlbGVjdC5hZGRFdmVudExpc3RlbmVyKFwiY2hhbmdlXCIsIChlKSA9PiB7XG4gICAgc2V0UHJvdmlkZXJNb2RlKGUudGFyZ2V0LnZhbHVlKTtcbiAgfSk7XG59XG5cbi8vIENoZWNrIHByb3ZpZGVyIHN0YXR1cyBvbiBwb3B1cCBsb2FkXG5mZXRjaFByb3ZpZGVyU3RhdHVzKCk7XG5cblxuY29uc3QgU1RBR0VTID0gW1wiY2FwdHVyZVwiLCBcImRldGVjdFwiLCBcInJlZGFjdFwiLCBcInNlbmRcIiwgXCJhY3RcIl07XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gUGlwZWxpbmUgJiBTdGF0dXMgaGVscGVyc1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5mdW5jdGlvbiBzZXRQaXBlbGluZVN0YWdlKGFjdGl2ZVN0YWdlKSB7XG4gIGxldCBwYXNzZWQgPSB0cnVlO1xuICBmb3IgKGNvbnN0IHN0YWdlIG9mIFNUQUdFUykge1xuICAgIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoYHN0YWdlLSR7c3RhZ2V9YCk7XG4gICAgaWYgKCFlbCkgY29udGludWU7XG4gICAgXG4gICAgZWwuY2xhc3NOYW1lID0gXCJzdGFnZVwiO1xuICAgIGlmIChzdGFnZSA9PT0gYWN0aXZlU3RhZ2UpIHtcbiAgICAgIGVsLmNsYXNzTGlzdC5hZGQoXCJhY3RpdmVcIik7XG4gICAgICBwYXNzZWQgPSBmYWxzZTtcbiAgICB9IGVsc2UgaWYgKHBhc3NlZCkge1xuICAgICAgZWwuY2xhc3NMaXN0LmFkZChcImRvbmVcIik7XG4gICAgfVxuICB9XG59XG5cbmZ1bmN0aW9uIHJlc2V0UGlwZWxpbmUoKSB7XG4gIGZvciAoY29uc3Qgc3RhZ2Ugb2YgU1RBR0VTKSB7XG4gICAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChgc3RhZ2UtJHtzdGFnZX1gKTtcbiAgICBpZiAoZWwpIGVsLmNsYXNzTmFtZSA9IFwic3RhZ2VcIjtcbiAgfVxufVxuXG5mdW5jdGlvbiBzZXRTdGF0dXMoaXNFcnJvciwgdGV4dCkge1xuICBzdGF0dXNFbC5zdHlsZS5kaXNwbGF5ID0gXCJibG9ja1wiO1xuICBzdGF0dXNFbC5jbGFzc05hbWUgICA9IGlzRXJyb3IgPyBcImVycm9yXCIgOiBcIlwiO1xuICBzdGF0dXNFbC50ZXh0Q29udGVudCA9IHRleHQ7XG59XG5cbmZ1bmN0aW9uIHJlc2V0Q2FudmFzKCkge1xuICBjdHguY2xlYXJSZWN0KDAsIDAsIGNhbnZhcy53aWR0aCwgY2FudmFzLmhlaWdodCk7XG4gIGNhbnZhc1dyYXAuc3R5bGUuZGlzcGxheSA9IFwibm9uZVwiO1xuICBsZWdlbmRFbC5zdHlsZS5kaXNwbGF5ICAgPSBcIm5vbmVcIjtcbiAgcGlpVGFibGUuc3R5bGUuZGlzcGxheSAgID0gXCJub25lXCI7XG4gIHBpaVRhYmxlLmlubmVySFRNTCAgICAgICA9IFwiXCI7XG4gIFxuICAvLyBSZXNldCBtZXRyaWNzIHBhbmVsXG4gIGNvbnN0IG1ldHJpY3NQYW5lbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwibWV0cmljc1BhbmVsXCIpO1xuICBpZiAobWV0cmljc1BhbmVsKSBtZXRyaWNzUGFuZWwuc3R5bGUuZGlzcGxheSA9IFwibm9uZVwiO1xuXG4gIC8vIFJlc2V0IGxlYWsgcGFuZWxcbiAgY29uc3QgbGVha1BhbmVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJsZWFrUGFuZWxcIik7XG4gIGlmIChsZWFrUGFuZWwpIHsgbGVha1BhbmVsLnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjsgbGVha1BhbmVsLmNsYXNzTmFtZSA9IFwiXCI7IGxlYWtQYW5lbC5pZCA9IFwibGVha1BhbmVsXCI7IH1cbiAgY29uc3QgbGVha1RleHQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcImxlYWtQYW5lbFRleHRcIik7XG4gIGlmIChsZWFrVGV4dCkgbGVha1RleHQudGV4dENvbnRlbnQgPSBcIkF3YWl0aW5nIHJlZGFjdGlvblx1MjAyNlwiO1xuICBcbiAgcmVzZXRQaXBlbGluZSgpO1xuICBjbGVhclBsYW5TdGVwcygpO1xuICBcbiAgY29uc3QgcHJvZ3Jlc3NXcmFwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJtb2RlbExvYWRXcmFwXCIpO1xuICBpZiAocHJvZ3Jlc3NXcmFwKSBwcm9ncmVzc1dyYXAuc3R5bGUuZGlzcGxheSA9IFwibm9uZVwiO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIFBsYW4gc3RlcCB0cmFja2VyIFx1MjAxNCBzaG93cyBsaXZlIHBlci1zdGVwIHN0YXR1cyB1bmRlciB0aGUgc3RhdHVzIGJhclxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5mdW5jdGlvbiBjbGVhclBsYW5TdGVwcygpIHtcbiAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInBsYW5TdGVwTGlzdFwiKTtcbiAgaWYgKGVsKSB7IGVsLmlubmVySFRNTCA9IFwiXCI7IGVsLnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjsgfVxufVxuXG5mdW5jdGlvbiB1cHNlcnRQbGFuU3RlcChzdGVwTnVtLCB0b3RhbFN0ZXBzLCBzdGF0dXMsIG1lc3NhZ2UpIHtcbiAgbGV0IGxpc3RFbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwicGxhblN0ZXBMaXN0XCIpO1xuICBpZiAoIWxpc3RFbCkge1xuICAgIGxpc3RFbCA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgbGlzdEVsLmlkID0gXCJwbGFuU3RlcExpc3RcIjtcbiAgICBsaXN0RWwuc3R5bGUuY3NzVGV4dCA9IFtcbiAgICAgIFwibWFyZ2luLXRvcDo2cHhcIixcImJvcmRlci1yYWRpdXM6NHB4XCIsXCJvdmVyZmxvdzpoaWRkZW5cIixcbiAgICAgIFwiYm9yZGVyOjFweCBzb2xpZCAjZTJlOGYwXCIsXCJmb250LXNpemU6MTFweFwiLFwiZm9udC1mYW1pbHk6bW9ub3NwYWNlXCJcbiAgICBdLmpvaW4oXCI7XCIpO1xuICAgIHN0YXR1c0VsLmluc2VydEFkamFjZW50RWxlbWVudChcImFmdGVyZW5kXCIsIGxpc3RFbCk7XG4gIH1cbiAgbGlzdEVsLnN0eWxlLmRpc3BsYXkgPSBcImJsb2NrXCI7XG5cbiAgY29uc3QgaWQgPSBgcGxhbi1zdGVwLSR7c3RlcE51bX1gO1xuICBsZXQgcm93ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpO1xuICBpZiAoIXJvdykge1xuICAgIHJvdyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoXCJkaXZcIik7XG4gICAgcm93LmlkID0gaWQ7XG4gICAgcm93LnN0eWxlLmNzc1RleHQgPSBcImRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpmbGV4LXN0YXJ0O2dhcDo2cHg7cGFkZGluZzo0cHggOHB4O2JvcmRlci1ib3R0b206MXB4IHNvbGlkICNlMmU4ZjA7XCI7XG4gICAgbGlzdEVsLmFwcGVuZENoaWxkKHJvdyk7XG4gIH1cblxuICBjb25zdCBpY29ucyA9IHsgcnVubmluZzogXCJcdTIzRjNcIiwgb2s6IFwiXHUyNzEzXCIsIGVycm9yOiBcIlx1MjcxN1wiLCBzdW1tYXJ5OiBcIlx1RDgzRFx1RENDQlwiIH07XG4gIGNvbnN0IGNvbG9ycyA9IHsgcnVubmluZzogXCIjNjQ3NDhiXCIsIG9rOiBcIiMxNmEzNGFcIiwgZXJyb3I6IFwiI2RjMjYyNlwiLCBzdW1tYXJ5OiBcIiMwMzY5YTFcIiB9O1xuICBjb25zdCBpY29uID0gaWNvbnNbc3RhdHVzXSB8fCBcIlx1MDBCN1wiO1xuICBjb25zdCBjb2xvciA9IGNvbG9yc1tzdGF0dXNdIHx8IFwiIzMzNDE1NVwiO1xuICByb3cuc3R5bGUuY29sb3IgPSBjb2xvcjtcbiAgcm93LnN0eWxlLmJhY2tncm91bmQgPSBzdGF0dXMgPT09IFwiZXJyb3JcIiA/IFwiI2ZlZjJmMlwiIDogc3RhdHVzID09PSBcIm9rXCIgPyBcIiNmMGZkZjRcIiA6IHN0YXR1cyA9PT0gXCJzdW1tYXJ5XCIgPyBcIiNlZmY2ZmZcIiA6IFwidHJhbnNwYXJlbnRcIjtcbiAgcm93LmlubmVySFRNTCA9IGA8c3BhbiBzdHlsZT1cImZsZXgtc2hyaW5rOjA7Zm9udC13ZWlnaHQ6Ym9sZFwiPiR7aWNvbn08L3NwYW4+PHNwYW4gc3R5bGU9XCJ3aGl0ZS1zcGFjZTpwcmUtd3JhcFwiPiR7bWVzc2FnZX08L3NwYW4+YDtcbn1cblxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIExheWVyIDEgXHUyMDE0IEZsb3JlbmNlLTIgZGV0ZWN0aW9ucyAoZmFpbnQgb3V0bGluZXMgZm9yIGNvbnRleHQpXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbmZ1bmN0aW9uIGRyYXdWaXNpb25MYXllcihkZXRlY3Rpb25zLCBzY2FsZSkge1xuICBmb3IgKGNvbnN0IGRldCBvZiBkZXRlY3Rpb25zKSB7XG4gICAgY29uc3QgW3gsIHksIHcsIGhdID0gZGV0LmJib3gubWFwKCh2KSA9PiBNYXRoLnJvdW5kKHYgKiBzY2FsZSkpO1xuICAgIGNvbnN0IGlzUmVnaW9uID0gZGV0LnR5cGUgPT09IFwicmVnaW9uXCI7XG4gICAgY3R4LmxpbmVXaWR0aCAgID0gMTtcbiAgICBjdHguc3Ryb2tlU3R5bGUgPSBpc1JlZ2lvbiA/IFwicmdiYSgzNCwxOTcsOTQsMC41NSlcIiA6IFwicmdiYSg5NiwxNjUsMjUwLDAuNTUpXCI7XG4gICAgY3R4LnN0cm9rZVJlY3QoeCwgeSwgdywgaCk7XG4gIH1cbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBMYXllciAyIFx1MjAxNCBQSUkgc2Vuc2l0aXZlIHJlZ2lvbnMgKGZpbGxlZCArIGxhYmVsbGVkKVxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5mdW5jdGlvbiBkcmF3UElJTGF5ZXIoc2Vuc2l0aXZlUmVnaW9ucywgc2NhbGUpIHtcbiAgZm9yIChjb25zdCByIG9mIHNlbnNpdGl2ZVJlZ2lvbnMpIHtcbiAgICBjb25zdCBbcngsIHJ5LCBydywgcmhdID0gci5iYm94Lm1hcCgodikgPT4gTWF0aC5yb3VuZCh2ICogc2NhbGUpKTtcbiAgICBjb25zdCBjb2xvcnMgPSBQSUlfQ09MT1JTW3IudHlwZV0gPz8gUElJX0NPTE9SUy5PVEhFUl9QSUk7XG5cbiAgICAvLyBGaWxsZWQgb3ZlcmxheVxuICAgIGN0eC5maWxsU3R5bGUgICA9IGNvbG9ycy5maWxsO1xuICAgIGN0eC5maWxsUmVjdChyeCwgcnksIHJ3LCByaCk7XG5cbiAgICAvLyBTb2xpZCBib3JkZXJcbiAgICBjdHguc3Ryb2tlU3R5bGUgPSBjb2xvcnMuc3Ryb2tlO1xuICAgIGN0eC5saW5lV2lkdGggICA9IDI7XG4gICAgY3R4LnN0cm9rZVJlY3QocngsIHJ5LCBydywgcmgpO1xuXG4gICAgLy8gQmFkZ2VcbiAgICBjb25zdCBsYWJlbCA9IGAke3IudHlwZX1gO1xuICAgIGN0eC5mb250ICAgICA9IFwiYm9sZCAxMHB4IHN5c3RlbS11aVwiO1xuICAgIGNvbnN0IHR3ICAgICA9IGN0eC5tZWFzdXJlVGV4dChsYWJlbCkud2lkdGggKyA4O1xuICAgIGN0eC5maWxsU3R5bGUgPSBjb2xvcnMuc3Ryb2tlO1xuICAgIGN0eC5maWxsUmVjdChyeCwgTWF0aC5tYXgoMCwgcnkgLSAxNyksIHR3LCAxNyk7XG4gICAgY3R4LmZpbGxTdHlsZSA9IGNvbG9ycy50ZXh0O1xuICAgIGN0eC5maWxsVGV4dChsYWJlbCwgcnggKyA0LCBNYXRoLm1heCgxMSwgcnkgLSAzKSk7XG4gIH1cbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBQSUkgYnJlYWtkb3duIHRhYmxlXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbmZ1bmN0aW9uIHJlbmRlclBJSVRhYmxlKHNlbnNpdGl2ZVJlZ2lvbnMpIHtcbiAgaWYgKHNlbnNpdGl2ZVJlZ2lvbnMubGVuZ3RoID09PSAwKSByZXR1cm47XG5cbiAgY29uc3QgYnlUeXBlID0ge307XG4gIGZvciAoY29uc3QgciBvZiBzZW5zaXRpdmVSZWdpb25zKSB7XG4gICAgKGJ5VHlwZVtyLnR5cGVdID8/PSBbXSkucHVzaChyKTtcbiAgfVxuXG4gIGxldCBodG1sID0gJzx0YWJsZSBzdHlsZT1cIndpZHRoOjEwMCU7Ym9yZGVyLWNvbGxhcHNlOmNvbGxhcHNlO2ZvbnQtc2l6ZToxMXB4O2ZvbnQtZmFtaWx5OnVpLW1vbm9zcGFjZSxTRk1vbm8tUmVndWxhcixNZW5sbyxtb25vc3BhY2VcIj4nO1xuICBodG1sICs9ICc8dHIgc3R5bGU9XCJib3JkZXItYm90dG9tOjFweCBzb2xpZCAjY2JkNWUxO2JhY2tncm91bmQ6I2Y4ZmFmY1wiPjx0aCBzdHlsZT1cInRleHQtYWxpZ246bGVmdDtwYWRkaW5nOjZweCA4cHg7Y29sb3I6IzQ3NTU2OTtmb250LXdlaWdodDo2MDBcIj5UeXBlPC90aD48dGggc3R5bGU9XCJ0ZXh0LWFsaWduOnJpZ2h0O3BhZGRpbmc6NnB4IDhweDtjb2xvcjojNDc1NTY5O2ZvbnQtd2VpZ2h0OjYwMFwiPkNvdW50PC90aD48dGggc3R5bGU9XCJ0ZXh0LWFsaWduOnJpZ2h0O3BhZGRpbmc6NnB4IDhweDtjb2xvcjojNDc1NTY5O2ZvbnQtd2VpZ2h0OjYwMFwiPkF2ZyBDb25mPC90aD48dGggc3R5bGU9XCJ0ZXh0LWFsaWduOnJpZ2h0O3BhZGRpbmc6NnB4IDhweDtjb2xvcjojNDc1NTY5O2ZvbnQtd2VpZ2h0OjYwMFwiPlNvdXJjZXM8L3RoPjwvdHI+JztcblxuICBmb3IgKGNvbnN0IFt0eXBlLCBycl0gb2YgT2JqZWN0LmVudHJpZXMoYnlUeXBlKSkge1xuICAgIGNvbnN0IGNvbG9yICAgPSBQSUlfQ09MT1JTW3R5cGVdPy5zdHJva2UgPz8gXCIjNjQ3NDhiXCI7XG4gICAgY29uc3QgZmlsbCAgICA9IFBJSV9DT0xPUlNbdHlwZV0/LmZpbGwgPz8gXCJyZ2JhKDEwMCwxMTYsMTM5LDAuMTUpXCI7XG4gICAgY29uc3QgYXZnQ29uZiA9IChyci5yZWR1Y2UoKHMsIHIpID0+IHMgKyByLmNvbmZpZGVuY2UsIDApIC8gcnIubGVuZ3RoICogMTAwKS50b0ZpeGVkKDApO1xuICAgIGNvbnN0IHNvdXJjZXMgPSBbLi4ubmV3IFNldChyci5tYXAoKHIpID0+IHIuc291cmNlKSldLmpvaW4oXCIsIFwiKTtcbiAgICBodG1sICs9IGA8dHIgc3R5bGU9XCJib3JkZXItYm90dG9tOjFweCBzb2xpZCAjZTJlOGYwXCI+XG4gICAgICA8dGQgc3R5bGU9XCJwYWRkaW5nOjZweCA4cHhcIj5cbiAgICAgICAgPHNwYW4gc3R5bGU9XCJkaXNwbGF5OmlubGluZS1ibG9jaztwYWRkaW5nOjJweCA2cHg7Ym9yZGVyLXJhZGl1czozcHg7YmFja2dyb3VuZDoke2ZpbGx9O2JvcmRlcjoxcHggc29saWQgJHtjb2xvcn07Y29sb3I6JHtjb2xvcn07Zm9udC13ZWlnaHQ6NzAwO2ZvbnQtc2l6ZToxMHB4XCI+JHt0eXBlfTwvc3Bhbj5cbiAgICAgIDwvdGQ+XG4gICAgICA8dGQgc3R5bGU9XCJ0ZXh0LWFsaWduOnJpZ2h0O3BhZGRpbmc6NnB4IDhweDtjb2xvcjojMGYxNzJhO2ZvbnQtd2VpZ2h0OjYwMFwiPiR7cnIubGVuZ3RofTwvdGQ+XG4gICAgICA8dGQgc3R5bGU9XCJ0ZXh0LWFsaWduOnJpZ2h0O3BhZGRpbmc6NnB4IDhweDtjb2xvcjojMzM0MTU1XCI+JHthdmdDb25mfSU8L3RkPlxuICAgICAgPHRkIHN0eWxlPVwidGV4dC1hbGlnbjpyaWdodDtwYWRkaW5nOjZweCA4cHg7Y29sb3I6IzY0NzQ4Yjtmb250LXNpemU6MTBweFwiPiR7c291cmNlc308L3RkPlxuICAgIDwvdHI+YDtcbiAgfVxuICBodG1sICs9IFwiPC90YWJsZT5cIjtcblxuICBwaWlUYWJsZS5pbm5lckhUTUwgICAgPSBodG1sO1xuICBwaWlUYWJsZS5zdHlsZS5kaXNwbGF5ID0gXCJibG9ja1wiO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIE1haW4gY2FudmFzIHJlbmRlcmVyXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbmFzeW5jIGZ1bmN0aW9uIHJlbmRlclJlc3VsdHMoc2NyZWVuc2hvdERhdGFVcmwsIGRldGVjdGlvbnMsIHNlbnNpdGl2ZVJlZ2lvbnMpIHtcbiAgY29uc3QgaW1nID0gbmV3IEltYWdlKCk7XG4gIGF3YWl0IG5ldyBQcm9taXNlKChyZXMsIHJlaikgPT4geyBpbWcub25sb2FkID0gcmVzOyBpbWcub25lcnJvciA9IHJlajsgaW1nLnNyYyA9IHNjcmVlbnNob3REYXRhVXJsOyB9KTtcblxuICBjb25zdCBtYXhXICA9IGNhbnZhcy5vZmZzZXRXaWR0aCB8fCA0MDA7XG4gIGNvbnN0IHNjYWxlID0gbWF4VyAvIGltZy5uYXR1cmFsV2lkdGg7XG4gIGNhbnZhcy53aWR0aCAgPSBtYXhXO1xuICBjYW52YXMuaGVpZ2h0ID0gTWF0aC5yb3VuZChpbWcubmF0dXJhbEhlaWdodCAqIHNjYWxlKTtcblxuICAvLyBTY3JlZW5zaG90XG4gIGN0eC5kcmF3SW1hZ2UoaW1nLCAwLCAwLCBjYW52YXMud2lkdGgsIGNhbnZhcy5oZWlnaHQpO1xuXG4gIC8vIExheWVyIDEgXHUyMDE0IHZpc2lvbiBjb250ZXh0IChmYWludClcbiAgZHJhd1Zpc2lvbkxheWVyKGRldGVjdGlvbnMsIHNjYWxlKTtcblxuICAvLyBMYXllciAyIFx1MjAxNCBQSUkgKHByb21pbmVudClcbiAgZHJhd1BJSUxheWVyKHNlbnNpdGl2ZVJlZ2lvbnMsIHNjYWxlKTtcblxuICBjYW52YXNXcmFwLnN0eWxlLmRpc3BsYXkgPSBcImJsb2NrXCI7XG4gIGxlZ2VuZEVsLnN0eWxlLmRpc3BsYXkgICA9IFwiZmxleFwiO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIEJ1dHRvbiBjbGljayBcdTIxOTIgcG9ydCBcdTIxOTIgYmFja2dyb3VuZCBleGVjdXRpb24gZmxvd1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5mdW5jdGlvbiBzdGFydEFuYWx5c2lzKGlzRGVtbyA9IGZhbHNlKSB7XG4gIGNvbnN0IG1vZGUgPSBpc0RlbW8gPyBcIkRlbW8gTW9kZVwiIDogXCJFeGVjdXRlXCI7XG4gIGNvbnNvbGUubG9nKGBbUG9wdXBdIHN0YXJ0QW5hbHlzaXMoJHttb2RlfSkgaW5pdGlhdGVkLiBDdXJyZW50IHN0YXRlOmAsIHtcbiAgICB0YXNrOiB0YXNrSW5wdXQgPyB0YXNrSW5wdXQudmFsdWUgOiBcIlwiLFxuICAgIHRpbWU6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKVxuICB9KTtcblxuICBhbmFseXplQnRuLmRpc2FibGVkID0gdHJ1ZTtcbiAgaWYgKGRlbW9CdG4pIGRlbW9CdG4uZGlzYWJsZWQgPSB0cnVlO1xuXG4gIHJlc2V0Q2FudmFzKCk7XG4gIHNldFBpcGVsaW5lU3RhZ2UoXCJjYXB0dXJlXCIpO1xuICBzZXRTdGF0dXMoZmFsc2UsIGBbSU5JVF0gU3RhcnRpbmcgJHttb2RlfS4uLiBDb25uZWN0aW5nIHRvIGJhY2tncm91bmQuLi5gKTtcblxuICBsZXQgcG9ydDtcbiAgdHJ5IHtcbiAgICBwb3J0ID0gY2hyb21lLnJ1bnRpbWUuY29ubmVjdCh7IG5hbWU6IFwiYW5hbHl6ZVwiIH0pO1xuICAgIGNvbnNvbGUubG9nKFwiW1BvcHVwXSBjaHJvbWUucnVudGltZS5jb25uZWN0IHBvcnQgZXN0YWJsaXNoZWQ6XCIsIHBvcnQpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBjb25zb2xlLmVycm9yKFwiW1BvcHVwIEVycm9yXVtQb3J0IENvbm5lY3Rpb25dOlwiLCBlcnIpO1xuICAgIHNldFN0YXR1cyh0cnVlLCBgW1BPUlQgRVJST1JdIENvbm5lY3Rpb24gZmFpbGVkOiAke2Vyci5tZXNzYWdlfWApO1xuICAgIGFuYWx5emVCdG4uZGlzYWJsZWQgPSBmYWxzZTtcbiAgICBpZiAoZGVtb0J0bikgZGVtb0J0bi5kaXNhYmxlZCA9IGZhbHNlO1xuICAgIHJldHVybjtcbiAgfVxuXG4gIGNvbnN0IGluc3RydWN0aW9uID0gdGFza0lucHV0ID8gdGFza0lucHV0LnZhbHVlLnRyaW0oKSA6IFwiXCI7XG4gIGNvbnN0IGluaXRpYWxQYXlsb2FkID0ge1xuICAgIHR5cGU6IGlzRGVtbyA/IFwiU1RBUlRfREVNT19SVU5cIiA6IFwiQU5BTFlaRV9TQ1JFRU5cIixcbiAgICBpbnN0cnVjdGlvbjogaW5zdHJ1Y3Rpb24gfHwgdW5kZWZpbmVkXG4gIH07XG5cbiAgdHJ5IHtcbiAgICBwb3J0LnBvc3RNZXNzYWdlKGluaXRpYWxQYXlsb2FkKTtcbiAgICBjb25zb2xlLmxvZyhcIltQb3B1cF0gRGlzcGF0Y2hlZCBpbml0aWFsIG1lc3NhZ2UgdG8gYmFja2dyb3VuZDpcIiwgaW5pdGlhbFBheWxvYWQpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBjb25zb2xlLmVycm9yKFwiW1BvcHVwIEVycm9yXVtQb3N0IE1lc3NhZ2VdOlwiLCBlcnIpO1xuICAgIHNldFN0YXR1cyh0cnVlLCBgW1BPU1QgRVJST1JdIEZhaWxlZCB0byBzZW5kIG1lc3NhZ2U6ICR7ZXJyLm1lc3NhZ2V9YCk7XG4gICAgYW5hbHl6ZUJ0bi5kaXNhYmxlZCA9IGZhbHNlO1xuICAgIGlmIChkZW1vQnRuKSBkZW1vQnRuLmRpc2FibGVkID0gZmFsc2U7XG4gICAgcmV0dXJuO1xuICB9XG5cbiAgcG9ydC5vbk1lc3NhZ2UuYWRkTGlzdGVuZXIoYXN5bmMgKG1zZykgPT4ge1xuICAgIGNvbnNvbGUubG9nKFwiW1BvcHVwXSBSZWNlaXZlZCBtZXNzYWdlIGZyb20gYmFja2dyb3VuZDpcIiwgbXNnLnR5cGUsIG1zZyk7XG4gICAgc3dpdGNoIChtc2cudHlwZSkge1xuICAgICAgY2FzZSBcIlNUQVRVU1wiOlxuICAgICAgICBzZXRTdGF0dXMoZmFsc2UsIG1zZy50ZXh0KTtcbiAgICAgICAgYnJlYWs7XG5cbiAgICAgIGNhc2UgXCJTVEFHRV9DSEFOR0VcIjpcbiAgICAgICAgc2V0UGlwZWxpbmVTdGFnZShtc2cuc3RhZ2UpO1xuICAgICAgICBzZXRTdGF0dXMoZmFsc2UsIGBbJHttc2cuc3RhZ2UudG9VcHBlckNhc2UoKX1dICR7bXNnLnRleHR9YCk7XG4gICAgICAgIGJyZWFrO1xuXG4gICAgICBjYXNlIFwiRE9NX1NDQU5fRE9ORVwiOlxuICAgICAgICBzZXRTdGF0dXMoZmFsc2UsIGBbRE9NXSBGb3VuZCAke21zZy5jb3VudH0gc2Vuc2l0aXZlIERPTSBmaWVsZChzKWApO1xuICAgICAgICBicmVhaztcblxuICAgICAgY2FzZSBcIk1PREVMX1BST0dSRVNTXCI6IHtcbiAgICAgICAgY29uc3QgcHJvZ3Jlc3NXcmFwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJtb2RlbExvYWRXcmFwXCIpO1xuICAgICAgICBjb25zdCBwcm9ncmVzc1BjdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwibW9kZWxMb2FkUGN0XCIpO1xuICAgICAgICBjb25zdCBwcm9ncmVzc0ZpbGUgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcIm1vZGVsTG9hZEZpbGVcIik7XG4gICAgICAgIGNvbnN0IHByb2dyZXNzQmFyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJtb2RlbExvYWRQcm9ncmVzc1wiKTtcbiAgICAgICAgaWYgKHByb2dyZXNzV3JhcCkgcHJvZ3Jlc3NXcmFwLnN0eWxlLmRpc3BsYXkgPSBcImJsb2NrXCI7XG4gICAgICAgIGNvbnN0IGZpbGVOYW1lID0gbXNnLmZpbGUgPyBtc2cuZmlsZS5zcGxpdChcIi9cIikucG9wKCkgOiBcIm1vZGVsIHdlaWdodHNcIjtcbiAgICAgICAgaWYgKHByb2dyZXNzRmlsZSkgcHJvZ3Jlc3NGaWxlLnRleHRDb250ZW50ID0gZmlsZU5hbWU7XG4gICAgICAgIGlmIChwcm9ncmVzc1BjdCkgcHJvZ3Jlc3NQY3QudGV4dENvbnRlbnQgPSBgJHttc2cucGVyY2VudCB8fCAwfSVgO1xuICAgICAgICBpZiAocHJvZ3Jlc3NCYXIpIHByb2dyZXNzQmFyLnZhbHVlID0gbXNnLnBlcmNlbnQgfHwgMDtcbiAgICAgICAgc2V0U3RhdHVzKGZhbHNlLCBgW01PREVMXSBEb3dubG9hZGluZyAke2ZpbGVOYW1lfSAoJHttc2cucGVyY2VudCB8fCAwfSUpLi4uYCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuXG4gICAgICBjYXNlIFwiTU9ERUxfUkVBRFlcIjoge1xuICAgICAgICBjb25zdCBwcm9ncmVzc1dyYXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcIm1vZGVsTG9hZFdyYXBcIik7XG4gICAgICAgIGlmIChwcm9ncmVzc1dyYXApIHByb2dyZXNzV3JhcC5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG4gICAgICAgIHNldFN0YXR1cyhmYWxzZSwgXCJbTU9ERUxdIE1vZGVsIGxvYWRlZCBhbmQgcmVhZHkgaW4gbWVtb3J5LlwiKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG5cbiAgICAgIGNhc2UgXCJNT0RFTF9FUlJPUlwiOiB7XG4gICAgICAgIGNvbnN0IHByb2dyZXNzV3JhcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwibW9kZWxMb2FkV3JhcFwiKTtcbiAgICAgICAgaWYgKHByb2dyZXNzV3JhcCkgcHJvZ3Jlc3NXcmFwLnN0eWxlLmRpc3BsYXkgPSBcIm5vbmVcIjtcbiAgICAgICAgY29uc29sZS5lcnJvcihcIltQb3B1cCBFcnJvcl1bTW9kZWwgTG9hZF06XCIsIG1zZy5lcnJvcik7XG4gICAgICAgIHNldFN0YXR1cyh0cnVlLCBgW01PREVMIEVSUk9SXSAke21zZy5lcnJvcn1gKTtcbiAgICAgICAgYW5hbHl6ZUJ0bi5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICAgICBpZiAoZGVtb0J0bikgZGVtb0J0bi5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cblxuICAgICAgY2FzZSBcIlBMQU5fU1RFUF9TVEFUVVNcIjoge1xuICAgICAgICAvLyBMaXZlIHBlci1zdGVwIHVwZGF0ZXMgYXMgZWFjaCBhY3Rpb24gZXhlY3V0ZXNcbiAgICAgICAgdXBzZXJ0UGxhblN0ZXAobXNnLnN0ZXBOdW0sIG1zZy50b3RhbFN0ZXBzLCBtc2cuc3RhdHVzLCBtc2cubWVzc2FnZSk7XG4gICAgICAgIHNldFN0YXR1cyhtc2cuc3RhdHVzID09PSBcImVycm9yXCIgPyB0cnVlIDogZmFsc2UsIG1zZy5tZXNzYWdlKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG5cbiAgICAgIGNhc2UgXCJQTEFOX1NVTU1BUllcIjoge1xuICAgICAgICAvLyBGaW5hbCBzdW1tYXJ5IGFmdGVyIGFsbCBwbGFuIHN0ZXBzIGFyZSBhdHRlbXB0ZWRcbiAgICAgICAgY29uc3QgaXNBbGxPayA9IG1zZy5mYWlsZWQgPT09IDA7XG4gICAgICAgIGNvbnN0IHN1bW1hcnlUZXh0ID0gbXNnLnRvdGFsID09PSAwXG4gICAgICAgICAgPyBgW0RPTkVdICR7bXNnLm1lc3NhZ2V9YFxuICAgICAgICAgIDogaXNBbGxPa1xuICAgICAgICAgICAgPyBgW0RPTkVdICR7bXNnLm1lc3NhZ2V9YFxuICAgICAgICAgICAgOiBgW1BBUlRJQUxdICR7bXNnLm1lc3NhZ2V9YDtcbiAgICAgICAgc2V0U3RhdHVzKCFpc0FsbE9rICYmIG1zZy5mYWlsZWQgPiAwLCBzdW1tYXJ5VGV4dCk7XG4gICAgICAgIC8vIFNob3cgc3VtbWFyeSByb3cgaW4gc3RlcCBsaXN0XG4gICAgICAgIHVwc2VydFBsYW5TdGVwKFwic3VtbWFyeVwiLCBtc2cudG90YWwsIFwic3VtbWFyeVwiLCBzdW1tYXJ5VGV4dCk7XG4gICAgICAgIGFuYWx5emVCdG4uZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgaWYgKGRlbW9CdG4pIGRlbW9CdG4uZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgYnJlYWs7XG4gICAgICB9XG5cbiAgICAgIGNhc2UgXCJBTkFMWVNJU19SRVNVTFRcIjoge1xuICAgICAgICBjb25zdCB7IGRldGVjdGlvbnMsIHNlbnNpdGl2ZVJlZ2lvbnMsIHNjcmVlbnNob3REYXRhVXJsLCBlbGFwc2VkLCBzZXJ2ZXJSZXN1bHQgfSA9IG1zZztcbiAgICAgICAgY29uc3QgcGlpQ291bnQgPSBzZW5zaXRpdmVSZWdpb25zPy5sZW5ndGggPz8gMDtcbiAgICAgICAgY29uc3QgcGxhblN0ZXBzID0gc2VydmVyUmVzdWx0Py5wbGFuPy5sZW5ndGggPz8gMDtcbiAgICAgICAgc2V0U3RhdHVzKFxuICAgICAgICAgIGZhbHNlLFxuICAgICAgICAgIGBbREVURUNURURdICR7cGlpQ291bnR9IFBJSSByZWdpb24ocykgaW4gJHtlbGFwc2VkIHx8IDB9bXMgXHUyMDE0IGV4ZWN1dGluZyAke3BsYW5TdGVwc30gc3RlcCBwbGFuXHUyMDI2YFxuICAgICAgICApO1xuICAgICAgICBzZXRQaXBlbGluZVN0YWdlKFwiYWN0XCIpO1xuICAgICAgICBpZiAoc2NyZWVuc2hvdERhdGFVcmwpIHtcbiAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgYXdhaXQgcmVuZGVyUmVzdWx0cyhzY3JlZW5zaG90RGF0YVVybCwgZGV0ZWN0aW9ucyA/PyBbXSwgc2Vuc2l0aXZlUmVnaW9ucyA/PyBbXSk7XG4gICAgICAgICAgfSBjYXRjaCAocmVuZGVyRXJyKSB7XG4gICAgICAgICAgICBjb25zb2xlLmVycm9yKFwiW1BvcHVwIEVycm9yXVtSZW5kZXIgUmVzdWx0c106XCIsIHJlbmRlckVycik7XG4gICAgICAgICAgICBzZXRTdGF0dXModHJ1ZSwgYFtSRU5ERVIgRVJST1JdICR7cmVuZGVyRXJyLm1lc3NhZ2V9YCk7XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIHJlbmRlclBJSVRhYmxlKHNlbnNpdGl2ZVJlZ2lvbnMgPz8gW10pO1xuICAgICAgICAvLyBCdXR0b25zIHN0YXkgZGlzYWJsZWQgdW50aWwgUExBTl9TVU1NQVJZIGlzIHJlY2VpdmVkXG4gICAgICAgIGlmIChwbGFuU3RlcHMgPT09IDApIHtcbiAgICAgICAgICBhbmFseXplQnRuLmRpc2FibGVkID0gZmFsc2U7XG4gICAgICAgICAgaWYgKGRlbW9CdG4pIGRlbW9CdG4uZGlzYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgICBicmVhaztcbiAgICAgIH1cblxuICAgICAgY2FzZSBcIk1FVFJJQ1NcIjoge1xuICAgICAgICAvLyBEYXRhIFJlZHVjdGlvbiBNZXRyaWNzIHBhbmVsXG4gICAgICAgIGNvbnN0IG1ldHJpY3NQYW5lbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwibWV0cmljc1BhbmVsXCIpO1xuICAgICAgICBpZiAoIW1ldHJpY3NQYW5lbCkgYnJlYWs7XG4gICAgICAgIG1ldHJpY3NQYW5lbC5zdHlsZS5kaXNwbGF5ID0gXCJibG9ja1wiO1xuXG4gICAgICAgIGNvbnN0IGZtdEJ5dGVzID0gKGIpID0+IGIgPj0gMTA0ODU3NlxuICAgICAgICAgID8gKGIgLyAxMDQ4NTc2KS50b0ZpeGVkKDIpICsgXCIgTUJcIlxuICAgICAgICAgIDogYiA+PSAxMDI0ID8gKGIgLyAxMDI0KS50b0ZpeGVkKDEpICsgXCIgS0JcIlxuICAgICAgICAgIDogYiArIFwiIEJcIjtcblxuICAgICAgICBjb25zdCByYXdFbCAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcIm1ldHJpYy1yYXdcIik7XG4gICAgICAgIGNvbnN0IHNlbnRFbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwibWV0cmljLXNlbnRcIik7XG4gICAgICAgIGNvbnN0IHJlZEVsICA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwibWV0cmljLXJlZHVjdGlvblwiKTtcbiAgICAgICAgY29uc3Qgc3VyRWwgID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJtZXRyaWMtc3VyZmFjZVwiKTtcbiAgICAgICAgY29uc3Qgbm90ZUVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJtZXRyaWMtbm90ZVwiKTtcblxuICAgICAgICBpZiAocmF3RWwpICByYXdFbC50ZXh0Q29udGVudCAgPSBmbXRCeXRlcyhtc2cucmF3X2J5dGVzKTtcbiAgICAgICAgaWYgKHNlbnRFbCkgc2VudEVsLnRleHRDb250ZW50ID0gZm10Qnl0ZXMobXNnLnNlbnRfYnl0ZXMpO1xuXG4gICAgICAgIC8vIEJ5dGUgcmVkdWN0aW9uXG4gICAgICAgIGNvbnN0IGJ5dGVSZWRQY3QgPSBtc2cucmVkdWN0aW9uX3BlcmNlbnQ7XG4gICAgICAgIGlmIChyZWRFbCkge1xuICAgICAgICAgIC8vIE5vdGU6IGVuY29kaW5nIEpTT04gb3ZlcmhlYWQgY2FuIG1ha2Ugc2VudF9ieXRlcyA+IHJhd19ieXRlcyAoSlBFRyA8IFBORylcbiAgICAgICAgICAvLyBSZXBvcnQgaG9uZXN0bHkgXHUyMDE0IHBvc2l0aXZlID0gc2F2ZWQsIG5lZ2F0aXZlID0gb3ZlcmhlYWQgYWRkZWRcbiAgICAgICAgICBpZiAoYnl0ZVJlZFBjdCA+PSAwKSB7XG4gICAgICAgICAgICByZWRFbC50ZXh0Q29udGVudCA9IGBcXHUyMjEyJHtieXRlUmVkUGN0LnRvRml4ZWQoMSl9JSBzZW50YDtcbiAgICAgICAgICAgIHJlZEVsLmNsYXNzTmFtZSA9IFwibWV0cmljLXZhbHVlIGdvb2RcIjtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgLy8gUGF5bG9hZCBpcyBsYXJnZXIgKGUuZy4gUE5HIGxvc3NsZXNzbHkgZXhwYW5kZWQgYnkgSlNPTiB3cmFwcGluZylcbiAgICAgICAgICAgIHJlZEVsLnRleHRDb250ZW50ID0gYCskeygtYnl0ZVJlZFBjdCkudG9GaXhlZCgxKX0lIG92ZXJoZWFkYDtcbiAgICAgICAgICAgIHJlZEVsLmNsYXNzTmFtZSA9IFwibWV0cmljLXZhbHVlIHdhcm5cIjtcbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvLyBQSUkgc3VyZmFjZSBhcmVhXG4gICAgICAgIGlmIChzdXJFbCkge1xuICAgICAgICAgIGlmIChtc2cucGlpX3JlZ2lvbnMgPiAwKSB7XG4gICAgICAgICAgICBzdXJFbC50ZXh0Q29udGVudCA9IGAke21zZy5waWlfc3VyZmFjZV9wZXJjZW50LnRvRml4ZWQoMSl9JSBhcmVhYDtcbiAgICAgICAgICAgIHN1ckVsLmNsYXNzTmFtZSA9IFwibWV0cmljLXZhbHVlIGdvb2RcIjtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc3VyRWwudGV4dENvbnRlbnQgPSBcIk4vQSAobm8gUElJKVwiO1xuICAgICAgICAgICAgc3VyRWwuY2xhc3NOYW1lID0gXCJtZXRyaWMtdmFsdWVcIjtcbiAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAobm90ZUVsKSB7XG4gICAgICAgICAgaWYgKG1zZy5waWlfcmVnaW9ucyA+IDApIHtcbiAgICAgICAgICAgIG5vdGVFbC50ZXh0Q29udGVudCA9IGAke21zZy5waWlfcmVnaW9uc30gc2Vuc2l0aXZlIHJlZ2lvbihzKSBjb3ZlcmluZyB+JHttc2cucGlpX3N1cmZhY2VfcGVyY2VudC50b0ZpeGVkKDIpfSUgb2YgaW1hZ2UgYXJlYSB3ZXJlIG5ldmVyIHRyYW5zbWl0dGVkIGluIHJlYWRhYmxlIGZvcm0uYDtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY29uc3Qgbm90ZSA9IGJ5dGVSZWRQY3QgPj0gMFxuICAgICAgICAgICAgICA/IGBSYXcgY2FwdHVyZTogJHtmbXRCeXRlcyhtc2cucmF3X2J5dGVzKX0gXFx1MjE5MiBzZW50IHBheWxvYWQ6ICR7Zm10Qnl0ZXMobXNnLnNlbnRfYnl0ZXMpfSAoJHtieXRlUmVkUGN0LnRvRml4ZWQoMSl9JSByZWR1Y3Rpb24gdmlhIHJlZGFjdGlvbiArIHNjaGVtYSBlbmNvZGluZykuYFxuICAgICAgICAgICAgICA6IGBOb3RlOiBKU09OIGVuY29kaW5nIGFkZHMgb3ZlcmhlYWQgdnMuIHJhdyBQTkcuIE5vIFBJSSB3YXMgZGV0ZWN0ZWQgb24gdGhpcyBwYWdlLmA7XG4gICAgICAgICAgICBub3RlRWwudGV4dENvbnRlbnQgPSBub3RlO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBicmVhaztcbiAgICAgIH1cblxuICAgICAgY2FzZSBcIkxFQUtfQ0hFQ0tcIjoge1xuICAgICAgICAvLyBSZWRhY3Rpb24gTGVhayBWZXJpZmljYXRpb24gcGFuZWxcbiAgICAgICAgY29uc3QgbGVha1BhbmVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJsZWFrUGFuZWxcIik7XG4gICAgICAgIGNvbnN0IGxlYWtUZXh0ICA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwibGVha1BhbmVsVGV4dFwiKTtcbiAgICAgICAgaWYgKCFsZWFrUGFuZWwpIGJyZWFrO1xuICAgICAgICBsZWFrUGFuZWwuc3R5bGUuZGlzcGxheSA9IFwiYmxvY2tcIjtcblxuICAgICAgICBsZWFrUGFuZWwuY2xhc3NOYW1lID0gXCJcIjsgLy8gY2xlYXIgb2xkIHN0YXRlIGNsYXNzZXNcbiAgICAgICAgaWYgKG1zZy53YXJuaW5nKSB7XG4gICAgICAgICAgbGVha1BhbmVsLmNsYXNzTGlzdC5hZGQoXCJ3YXJuXCIpO1xuICAgICAgICB9IGVsc2UgaWYgKG1zZy5wYXNzZWQpIHtcbiAgICAgICAgICBsZWFrUGFuZWwuY2xhc3NMaXN0LmFkZChcInBhc3NcIik7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgbGVha1BhbmVsLmNsYXNzTGlzdC5hZGQoXCJmYWlsXCIpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGxlYWtUZXh0KSBsZWFrVGV4dC50ZXh0Q29udGVudCA9IG1zZy5tZXNzYWdlO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cblxuICAgICAgY2FzZSBcIlBST01QVF9VU0VSX0lOUFVUXCI6IHtcbiAgICAgICAgLy8gSW5saW5lIGZhbGxiYWNrIHByb21wdCBmb3IgbWlzc2luZyB2YWx1ZXMgKFJlcXVpcmVtZW50IDQpXG4gICAgICAgIGNvbnN0IHByb21wdENhcmQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInVzZXJJbnB1dFByb21wdENhcmRcIik7XG4gICAgICAgIGNvbnN0IHRpdGxlRWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInByb21wdENhcmRUaXRsZVwiKTtcbiAgICAgICAgY29uc3QgaW5wdXRFbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKFwicHJvbXB0Q2FyZElucHV0XCIpO1xuICAgICAgICBjb25zdCBzYXZlQ2hlY2sgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChcInByb21wdENhcmRTYXZlRGVmYXVsdFwiKTtcbiAgICAgICAgY29uc3Qgc3VibWl0QnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJwcm9tcHRDYXJkU3VibWl0QnRuXCIpO1xuICAgICAgICBjb25zdCBza2lwQnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJwcm9tcHRDYXJkU2tpcEJ0blwiKTtcblxuICAgICAgICBpZiAocHJvbXB0Q2FyZCAmJiB0aXRsZUVsICYmIGlucHV0RWwpIHtcbiAgICAgICAgICBwcm9tcHRDYXJkLnN0eWxlLmRpc3BsYXkgPSBcImJsb2NrXCI7XG4gICAgICAgICAgdGl0bGVFbC50ZXh0Q29udGVudCA9IGBObyB2YWx1ZSBmb3VuZCBmb3IgJHttc2cuZmllbGRUeXBlIHx8IFwiZmllbGRcIn0gXHUyMDE0IGVudGVyIG9uZSBub3c/YDtcbiAgICAgICAgICBpbnB1dEVsLnZhbHVlID0gXCJcIjtcbiAgICAgICAgICBpbnB1dEVsLnBsYWNlaG9sZGVyID0gYEVudGVyICR7bXNnLmZpZWxkVHlwZSB8fCBcInZhbHVlXCJ9Li4uYDtcbiAgICAgICAgICBpbnB1dEVsLmZvY3VzKCk7XG5cbiAgICAgICAgICBjb25zdCBoYW5kbGVTdWJtaXQgPSAoKSA9PiB7XG4gICAgICAgICAgICBjb25zdCB2YWwgPSBpbnB1dEVsLnZhbHVlLnRyaW0oKTtcbiAgICAgICAgICAgIGNvbnN0IHNhdmVUb1ZhdWx0ID0gQm9vbGVhbihzYXZlQ2hlY2s/LmNoZWNrZWQpO1xuICAgICAgICAgICAgcHJvbXB0Q2FyZC5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG4gICAgICAgICAgICBjbGVhbnVwKCk7XG4gICAgICAgICAgICBwb3J0LnBvc3RNZXNzYWdlKHtcbiAgICAgICAgICAgICAgdHlwZTogXCJVU0VSX0lOUFVUX1BST1ZJREVEXCIsXG4gICAgICAgICAgICAgIHN0ZXBOdW06IG1zZy5zdGVwTnVtLFxuICAgICAgICAgICAgICB2YWx1ZTogdmFsLFxuICAgICAgICAgICAgICBzYXZlVG9WYXVsdCxcbiAgICAgICAgICAgICAgZmllbGRUeXBlOiBtc2cuZmllbGRUeXBlXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIHNldFN0YXR1cyhmYWxzZSwgYFByb3ZpZGVkIHZhbHVlIGZvciAke21zZy5maWVsZFR5cGV9OiBcIiR7dmFsfVwiIChzYXZlIGRlZmF1bHQ6ICR7c2F2ZVRvVmF1bHR9KWApO1xuICAgICAgICAgIH07XG5cbiAgICAgICAgICBjb25zdCBoYW5kbGVTa2lwID0gKCkgPT4ge1xuICAgICAgICAgICAgcHJvbXB0Q2FyZC5zdHlsZS5kaXNwbGF5ID0gXCJub25lXCI7XG4gICAgICAgICAgICBjbGVhbnVwKCk7XG4gICAgICAgICAgICBwb3J0LnBvc3RNZXNzYWdlKHtcbiAgICAgICAgICAgICAgdHlwZTogXCJVU0VSX0lOUFVUX1BST1ZJREVEXCIsXG4gICAgICAgICAgICAgIHN0ZXBOdW06IG1zZy5zdGVwTnVtLFxuICAgICAgICAgICAgICB2YWx1ZTogbnVsbCxcbiAgICAgICAgICAgICAgc2F2ZVRvVmF1bHQ6IGZhbHNlLFxuICAgICAgICAgICAgICBmaWVsZFR5cGU6IG1zZy5maWVsZFR5cGVcbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgc2V0U3RhdHVzKHRydWUsIGBTa2lwcGVkIHN0ZXAgZm9yICR7bXNnLmZpZWxkVHlwZX1gKTtcbiAgICAgICAgICB9O1xuXG4gICAgICAgICAgY29uc3QgY2xlYW51cCA9ICgpID0+IHtcbiAgICAgICAgICAgIHN1Ym1pdEJ0bj8ucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGhhbmRsZVN1Ym1pdCk7XG4gICAgICAgICAgICBza2lwQnRuPy5yZW1vdmVFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgaGFuZGxlU2tpcCk7XG4gICAgICAgICAgfTtcblxuICAgICAgICAgIHN1Ym1pdEJ0bj8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGhhbmRsZVN1Ym1pdCk7XG4gICAgICAgICAgc2tpcEJ0bj8uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGhhbmRsZVNraXApO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgICAgfVxuXG4gICAgICBjYXNlIFwiX1NURVA2X0NPTVBMRVRFXCI6IHtcbiAgICAgICAgLy8gU2FmZXR5IG5ldDogZmlyZWQgZnJvbSBiYWNrZ3JvdW5kLmpzJ3MgZmluYWxseSBibG9jayBcdTIwMTQgZW5zdXJlcyBidXR0b25zXG4gICAgICAgIC8vIGFyZSBhbHdheXMgcmUtZW5hYmxlZCBldmVuIGlmIGFuIGV4Y2VwdGlvbiBza2lwcGVkIFBMQU5fU1VNTUFSWS5cbiAgICAgICAgYW5hbHl6ZUJ0bi5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICAgICBpZiAoZGVtb0J0bikgZGVtb0J0bi5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cblxuICAgICAgY2FzZSBcIkVSUk9SXCI6IHtcbiAgICAgICAgY29uc29sZS5lcnJvcihcIltQb3B1cCBFcnJvcl1bUGlwZWxpbmUgU3RlcCBGYWlsZWRdOlwiLCBtc2cuc3RlcCwgbXNnLmVycm9yKTtcbiAgICAgICAgc2V0U3RhdHVzKHRydWUsIGBbRVJST1IgaW4gJHttc2cuc3RlcCB8fCBcIlBpcGVsaW5lXCJ9XSAke21zZy5lcnJvcn1gKTtcbiAgICAgICAgYW5hbHl6ZUJ0bi5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICAgICBpZiAoZGVtb0J0bikgZGVtb0J0bi5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG4gIH0pO1xuXG4gIHBvcnQub25EaXNjb25uZWN0LmFkZExpc3RlbmVyKCgpID0+IHtcbiAgICBjb25zdCBlcnIgPSBjaHJvbWUucnVudGltZS5sYXN0RXJyb3I7XG4gICAgaWYgKGVycikge1xuICAgICAgY29uc29sZS5lcnJvcihcIltQb3B1cCBFcnJvcl1bUG9ydCBEaXNjb25uZWN0ZWRdOlwiLCBlcnIubWVzc2FnZSk7XG4gICAgICBzZXRTdGF0dXModHJ1ZSwgYFtTVyBESVNDT05ORUNURURdIFNlcnZpY2Ugd29ya2VyIHRlcm1pbmF0ZWQ6ICR7ZXJyLm1lc3NhZ2V9YCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnNvbGUubG9nKFwiW1BvcHVwXSBQb3J0IGRpc2Nvbm5lY3RlZCBjbGVhbmx5LlwiKTtcbiAgICB9XG4gICAgYW5hbHl6ZUJ0bi5kaXNhYmxlZCA9IGZhbHNlO1xuICAgIGlmIChkZW1vQnRuKSBkZW1vQnRuLmRpc2FibGVkID0gZmFsc2U7XG4gIH0pO1xufVxuXG4vLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbi8vIENsaWNrIEhhbmRsZXJzIHdpdGggcmVxdWlyZWQgbG9nZ2luZ1xuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5hbmFseXplQnRuLmFkZEV2ZW50TGlzdGVuZXIoXCJjbGlja1wiLCAoKSA9PiB7XG4gIGNvbnNvbGUubG9nKFwiW1BvcHVwXSA+Pj4gRVhFQ1VURSBCVVRUT04gQ0xJQ0tFRCEgPDw8IFRpbWVzdGFtcDpcIiwgRGF0ZS5ub3coKSk7XG4gIHN0YXJ0QW5hbHlzaXMoZmFsc2UpO1xufSk7XG5cbmlmIChkZW1vQnRuKSB7XG4gIGRlbW9CdG4uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsICgpID0+IHtcbiAgICBjb25zb2xlLmxvZyhcIltQb3B1cF0gPj4+IERFTU8gTU9ERSBCVVRUT04gQ0xJQ0tFRCEgPDw8IFRpbWVzdGFtcDpcIiwgRGF0ZS5ub3coKSk7XG4gICAgc3RhcnRBbmFseXNpcyh0cnVlKTtcbiAgfSk7XG59XG4iXSwKICAibWFwcGluZ3MiOiAiO0FBa0JPLElBQU0sV0FBVyxPQUFPLE9BQU87QUFBQSxFQUNwQyxVQUFlO0FBQUEsRUFDZixPQUFlO0FBQUEsRUFDZixPQUFlO0FBQUEsRUFDZixNQUFlO0FBQUEsRUFDZixNQUFlO0FBQUEsRUFDZixNQUFlO0FBQUEsRUFDZixTQUFlO0FBQUEsRUFDZixLQUFlO0FBQUEsRUFDZixPQUFlO0FBQUEsRUFDZixNQUFlO0FBQUEsRUFDZixlQUFlO0FBQUEsRUFDZixXQUFlO0FBQ2pCLENBQUM7QUFHTSxJQUFNLGFBQWE7QUFBQSxFQUN4QixVQUFlLEVBQUUsTUFBTSx3QkFBMEIsUUFBUSxXQUFXLE1BQU0sT0FBTztBQUFBLEVBQ2pGLE9BQWUsRUFBRSxNQUFNLHdCQUEwQixRQUFRLFdBQVcsTUFBTSxPQUFPO0FBQUEsRUFDakYsT0FBZSxF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
