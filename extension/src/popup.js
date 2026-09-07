/**
 * popup.js — Popup script  (src/popup.js → built popup.js)
 *
 * v0.2: renders two overlay layers on the debug canvas:
 *   Layer 1 — Florence-2 detections (OD=green outline, OCR=blue outline)
 *   Layer 2 — PII sensitive regions (filled, colour-coded per type)
 *
 * Also shows a compact PII breakdown table below the canvas.
 */

import { PII_COLORS } from "./pii.js";

const analyzeBtn = document.getElementById("analyzeBtn");
const demoBtn    = document.getElementById("demoBtn");
const taskInput  = document.getElementById("taskInput");
const statusEl   = document.getElementById("statusText");
const canvasWrap = document.getElementById("canvasWrap");
const canvas     = document.getElementById("debugCanvas");
const legendEl   = document.getElementById("legend");
const piiTable   = document.getElementById("piiTable");
const modeSelect = document.getElementById("modeSelect");
const modeBadge  = document.getElementById("modeStatusBadge");
const modeDot    = document.getElementById("modeStatusDot");
const modeText   = document.getElementById("modeStatusText");
const openVaultBtn = document.getElementById("openVaultBtn");
const ctx        = canvas.getContext("2d");

if (openVaultBtn) {
  openVaultBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
  });
}

const SERVER_PROVIDER_URL = "http://localhost:3000/provider";

// ---------------------------------------------------------------------------
// Provider Mode Status & Switcher
// ---------------------------------------------------------------------------
function updateModeUI(mode, customText) {
  if (mode === "offline") {
    if (modeSelect) modeSelect.value = "offline";
    if (modeBadge) {
      modeBadge.style.background = "#f0fdf4";
      modeBadge.style.color = "#15803d";
      modeBadge.style.borderColor = "#bbf7d0";
    }
    if (modeDot) modeDot.style.background = "#16a34a";
    if (modeText) modeText.textContent = customText || "OFFLINE MODE (Local Ollama — no network required)";
  } else {
    if (modeSelect) modeSelect.value = "cloud";
    if (modeBadge) {
      modeBadge.style.background = "#e0f2fe";
      modeBadge.style.color = "#0369a1";
      modeBadge.style.borderColor = "#bae6fd";
    }
    if (modeDot) modeDot.style.background = "#0284c7";
    if (modeText) modeText.textContent = customText || "CLOUD MODE (Groq)";
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
      body: JSON.stringify({ mode }),
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
    // Revert UI to match server
    fetchProviderStatus();
  }
}

if (modeSelect) {
  modeSelect.addEventListener("change", (e) => {
    setProviderMode(e.target.value);
  });
}

// Check provider status on popup load
fetchProviderStatus();


const STAGES = ["capture", "detect", "redact", "send", "act"];

// ---------------------------------------------------------------------------
// Pipeline & Status helpers
// ---------------------------------------------------------------------------
function setPipelineStage(activeStage) {
  let passed = true;
  for (const stage of STAGES) {
    const el = document.getElementById(`stage-${stage}`);
    if (!el) continue;
    
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
    if (el) el.className = "stage";
  }
}

function setStatus(isError, text) {
  statusEl.style.display = "block";
  statusEl.className   = isError ? "error" : "";
  statusEl.textContent = text;
}

function resetCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  canvasWrap.style.display = "none";
  legendEl.style.display   = "none";
  piiTable.style.display   = "none";
  piiTable.innerHTML       = "";
  
  // Reset metrics panel
  const metricsPanel = document.getElementById("metricsPanel");
  if (metricsPanel) metricsPanel.style.display = "none";

  // Reset leak panel
  const leakPanel = document.getElementById("leakPanel");
  if (leakPanel) { leakPanel.style.display = "none"; leakPanel.className = ""; leakPanel.id = "leakPanel"; }
  const leakText = document.getElementById("leakPanelText");
  if (leakText) leakText.textContent = "Awaiting redaction…";
  
  resetPipeline();
  clearPlanSteps();
  
  const progressWrap = document.getElementById("modelLoadWrap");
  if (progressWrap) progressWrap.style.display = "none";
}

// ---------------------------------------------------------------------------
// Plan step tracker — shows live per-step status under the status bar
// ---------------------------------------------------------------------------
function clearPlanSteps() {
  const el = document.getElementById("planStepList");
  if (el) { el.innerHTML = ""; el.style.display = "none"; }
}

function upsertPlanStep(stepNum, totalSteps, status, message) {
  let listEl = document.getElementById("planStepList");
  if (!listEl) {
    listEl = document.createElement("div");
    listEl.id = "planStepList";
    listEl.style.cssText = [
      "margin-top:6px","border-radius:4px","overflow:hidden",
      "border:1px solid #e2e8f0","font-size:11px","font-family:monospace"
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

  const icons = { running: "⏳", ok: "✓", error: "✗", summary: "📋" };
  const colors = { running: "#64748b", ok: "#16a34a", error: "#dc2626", summary: "#0369a1" };
  const icon = icons[status] || "·";
  const color = colors[status] || "#334155";
  row.style.color = color;
  row.style.background = status === "error" ? "#fef2f2" : status === "ok" ? "#f0fdf4" : status === "summary" ? "#eff6ff" : "transparent";
  row.innerHTML = `<span style="flex-shrink:0;font-weight:bold">${icon}</span><span style="white-space:pre-wrap">${message}</span>`;
}


// ---------------------------------------------------------------------------
// Layer 1 — Florence-2 detections (faint outlines for context)
// ---------------------------------------------------------------------------
function drawVisionLayer(detections, scale) {
  for (const det of detections) {
    const [x, y, w, h] = det.bbox.map((v) => Math.round(v * scale));
    const isRegion = det.type === "region";
    ctx.lineWidth   = 1;
    ctx.strokeStyle = isRegion ? "rgba(34,197,94,0.55)" : "rgba(96,165,250,0.55)";
    ctx.strokeRect(x, y, w, h);
  }
}

// ---------------------------------------------------------------------------
// Layer 2 — PII sensitive regions (filled + labelled)
// ---------------------------------------------------------------------------
function drawPIILayer(sensitiveRegions, scale) {
  for (const r of sensitiveRegions) {
    const [rx, ry, rw, rh] = r.bbox.map((v) => Math.round(v * scale));
    const colors = PII_COLORS[r.type] ?? PII_COLORS.OTHER_PII;

    // Filled overlay
    ctx.fillStyle   = colors.fill;
    ctx.fillRect(rx, ry, rw, rh);

    // Solid border
    ctx.strokeStyle = colors.stroke;
    ctx.lineWidth   = 2;
    ctx.strokeRect(rx, ry, rw, rh);

    // Badge
    const label = `${r.type}`;
    ctx.font     = "bold 10px system-ui";
    const tw     = ctx.measureText(label).width + 8;
    ctx.fillStyle = colors.stroke;
    ctx.fillRect(rx, Math.max(0, ry - 17), tw, 17);
    ctx.fillStyle = colors.text;
    ctx.fillText(label, rx + 4, Math.max(11, ry - 3));
  }
}

// ---------------------------------------------------------------------------
// PII breakdown table
// ---------------------------------------------------------------------------
function renderPIITable(sensitiveRegions) {
  if (sensitiveRegions.length === 0) return;

  const byType = {};
  for (const r of sensitiveRegions) {
    (byType[r.type] ??= []).push(r);
  }

  let html = '<table style="width:100%;border-collapse:collapse;font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">';
  html += '<tr style="border-bottom:1px solid #cbd5e1;background:#f8fafc"><th style="text-align:left;padding:6px 8px;color:#475569;font-weight:600">Type</th><th style="text-align:right;padding:6px 8px;color:#475569;font-weight:600">Count</th><th style="text-align:right;padding:6px 8px;color:#475569;font-weight:600">Avg Conf</th><th style="text-align:right;padding:6px 8px;color:#475569;font-weight:600">Sources</th></tr>';

  for (const [type, rr] of Object.entries(byType)) {
    const color   = PII_COLORS[type]?.stroke ?? "#64748b";
    const fill    = PII_COLORS[type]?.fill ?? "rgba(100,116,139,0.15)";
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

  piiTable.innerHTML    = html;
  piiTable.style.display = "block";
}

// ---------------------------------------------------------------------------
// Main canvas renderer
// ---------------------------------------------------------------------------
async function renderResults(screenshotDataUrl, detections, sensitiveRegions) {
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = screenshotDataUrl; });

  const maxW  = canvas.offsetWidth || 400;
  const scale = maxW / img.naturalWidth;
  canvas.width  = maxW;
  canvas.height = Math.round(img.naturalHeight * scale);

  // Screenshot
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  // Layer 1 — vision context (faint)
  drawVisionLayer(detections, scale);

  // Layer 2 — PII (prominent)
  drawPIILayer(sensitiveRegions, scale);

  canvasWrap.style.display = "block";
  legendEl.style.display   = "flex";
}

// ---------------------------------------------------------------------------
// Button click → port → background execution flow
// ---------------------------------------------------------------------------
function startAnalysis(isDemo = false) {
  const mode = isDemo ? "Demo Mode" : "Execute";
  console.log(`[Popup] startAnalysis(${mode}) initiated. Current state:`, {
    task: taskInput ? taskInput.value : "",
    time: new Date().toISOString()
  });

  analyzeBtn.disabled = true;
  if (demoBtn) demoBtn.disabled = true;

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
    if (demoBtn) demoBtn.disabled = false;
    return;
  }

  const instruction = taskInput ? taskInput.value.trim() : "";
  const initialPayload = {
    type: isDemo ? "START_DEMO_RUN" : "ANALYZE_SCREEN",
    instruction: instruction || undefined
  };

  try {
    port.postMessage(initialPayload);
    console.log("[Popup] Dispatched initial message to background:", initialPayload);
  } catch (err) {
    console.error("[Popup Error][Post Message]:", err);
    setStatus(true, `[POST ERROR] Failed to send message: ${err.message}`);
    analyzeBtn.disabled = false;
    if (demoBtn) demoBtn.disabled = false;
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
        if (progressWrap) progressWrap.style.display = "block";
        const fileName = msg.file ? msg.file.split("/").pop() : "model weights";
        if (progressFile) progressFile.textContent = fileName;
        if (progressPct) progressPct.textContent = `${msg.percent || 0}%`;
        if (progressBar) progressBar.value = msg.percent || 0;
        setStatus(false, `[MODEL] Downloading ${fileName} (${msg.percent || 0}%)...`);
        break;
      }

      case "MODEL_READY": {
        const progressWrap = document.getElementById("modelLoadWrap");
        if (progressWrap) progressWrap.style.display = "none";
        setStatus(false, "[MODEL] Model loaded and ready in memory.");
        break;
      }

      case "MODEL_ERROR": {
        const progressWrap = document.getElementById("modelLoadWrap");
        if (progressWrap) progressWrap.style.display = "none";
        console.error("[Popup Error][Model Load]:", msg.error);
        setStatus(true, `[MODEL ERROR] ${msg.error}`);
        analyzeBtn.disabled = false;
        if (demoBtn) demoBtn.disabled = false;
        break;
      }

      case "PLAN_STEP_STATUS": {
        // Live per-step updates as each action executes
        upsertPlanStep(msg.stepNum, msg.totalSteps, msg.status, msg.message);
        setStatus(msg.status === "error" ? true : false, msg.message);
        break;
      }

      case "PLAN_SUMMARY": {
        // Final summary after all plan steps are attempted
        const isAllOk = msg.failed === 0;
        const summaryText = msg.total === 0
          ? `[DONE] ${msg.message}`
          : isAllOk
            ? `[DONE] ${msg.message}`
            : `[PARTIAL] ${msg.message}`;
        setStatus(!isAllOk && msg.failed > 0, summaryText);
        // Show summary row in step list
        upsertPlanStep("summary", msg.total, "summary", summaryText);
        analyzeBtn.disabled = false;
        if (demoBtn) demoBtn.disabled = false;
        break;
      }

      case "ANALYSIS_RESULT": {
        const { detections, sensitiveRegions, screenshotDataUrl, elapsed, serverResult } = msg;
        const piiCount = sensitiveRegions?.length ?? 0;
        const planSteps = serverResult?.plan?.length ?? 0;
        setStatus(
          false,
          `[DETECTED] ${piiCount} PII region(s) in ${elapsed || 0}ms — executing ${planSteps} step plan…`
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
        // Buttons stay disabled until PLAN_SUMMARY is received
        if (planSteps === 0) {
          analyzeBtn.disabled = false;
          if (demoBtn) demoBtn.disabled = false;
        }
        break;
      }

      case "METRICS": {
        // Data Reduction Metrics panel
        const metricsPanel = document.getElementById("metricsPanel");
        if (!metricsPanel) break;
        metricsPanel.style.display = "block";

        const fmtBytes = (b) => b >= 1048576
          ? (b / 1048576).toFixed(2) + " MB"
          : b >= 1024 ? (b / 1024).toFixed(1) + " KB"
          : b + " B";

        const rawEl  = document.getElementById("metric-raw");
        const sentEl = document.getElementById("metric-sent");
        const redEl  = document.getElementById("metric-reduction");
        const surEl  = document.getElementById("metric-surface");
        const noteEl = document.getElementById("metric-note");

        if (rawEl)  rawEl.textContent  = fmtBytes(msg.raw_bytes);
        if (sentEl) sentEl.textContent = fmtBytes(msg.sent_bytes);

        // Byte reduction
        const byteRedPct = msg.reduction_percent;
        if (redEl) {
          // Note: encoding JSON overhead can make sent_bytes > raw_bytes (JPEG < PNG)
          // Report honestly — positive = saved, negative = overhead added
          if (byteRedPct >= 0) {
            redEl.textContent = `\u2212${byteRedPct.toFixed(1)}% sent`;
            redEl.className = "metric-value good";
          } else {
            // Payload is larger (e.g. PNG losslessly expanded by JSON wrapping)
            redEl.textContent = `+${(-byteRedPct).toFixed(1)}% overhead`;
            redEl.className = "metric-value warn";
          }
        }

        // PII surface area
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
            const note = byteRedPct >= 0
              ? `Raw capture: ${fmtBytes(msg.raw_bytes)} \u2192 sent payload: ${fmtBytes(msg.sent_bytes)} (${byteRedPct.toFixed(1)}% reduction via redaction + schema encoding).`
              : `Note: JSON encoding adds overhead vs. raw PNG. No PII was detected on this page.`;
            noteEl.textContent = note;
          }
        }
        break;
      }

      case "LEAK_CHECK": {
        // Redaction Leak Verification panel
        const leakPanel = document.getElementById("leakPanel");
        const leakText  = document.getElementById("leakPanelText");
        if (!leakPanel) break;
        leakPanel.style.display = "block";

        leakPanel.className = ""; // clear old state classes
        if (msg.warning) {
          leakPanel.classList.add("warn");
        } else if (msg.passed) {
          leakPanel.classList.add("pass");
        } else {
          leakPanel.classList.add("fail");
        }

        if (leakText) leakText.textContent = msg.message;
        break;
      }

      case "PROMPT_USER_INPUT": {
        // Inline fallback prompt for missing values (Requirement 4)
        const promptCard = document.getElementById("userInputPromptCard");
        const titleEl = document.getElementById("promptCardTitle");
        const inputEl = document.getElementById("promptCardInput");
        const saveCheck = document.getElementById("promptCardSaveDefault");
        const submitBtn = document.getElementById("promptCardSubmitBtn");
        const skipBtn = document.getElementById("promptCardSkipBtn");

        if (promptCard && titleEl && inputEl) {
          promptCard.style.display = "block";
          titleEl.textContent = `No value found for ${msg.fieldType || "field"} — enter one now?`;
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
        // Safety net: fired from background.js's finally block — ensures buttons
        // are always re-enabled even if an exception skipped PLAN_SUMMARY.
        analyzeBtn.disabled = false;
        if (demoBtn) demoBtn.disabled = false;
        break;
      }

      case "ERROR": {
        console.error("[Popup Error][Pipeline Step Failed]:", msg.step, msg.error);
        setStatus(true, `[ERROR in ${msg.step || "Pipeline"}] ${msg.error}`);
        analyzeBtn.disabled = false;
        if (demoBtn) demoBtn.disabled = false;
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
    if (demoBtn) demoBtn.disabled = false;
  });
}

// ---------------------------------------------------------------------------
// Click Handlers with required logging
// ---------------------------------------------------------------------------
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
