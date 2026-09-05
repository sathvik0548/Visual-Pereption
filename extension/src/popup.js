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
const statusEl   = document.getElementById("status");
const canvasWrap = document.getElementById("canvasWrap");
const canvas     = document.getElementById("debugCanvas");
const legendEl   = document.getElementById("legend");
const piiTable   = document.getElementById("piiTable");
const ctx        = canvas.getContext("2d");

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------
function setStatus(type, text) {
  statusEl.className   = type;
  statusEl.textContent = text;
}

function resetCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  canvasWrap.style.display = "none";
  legendEl.style.display   = "none";
  piiTable.style.display   = "none";
  piiTable.innerHTML       = "";
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

  let html = '<table style="width:100%;border-collapse:collapse;font-size:11px">';
  html += '<tr style="border-bottom:1px solid #2a2a3a"><th style="text-align:left;padding:3px 6px;color:#6b6b85">Type</th><th style="text-align:right;color:#6b6b85">Count</th><th style="text-align:right;color:#6b6b85">Avg conf</th><th style="text-align:right;color:#6b6b85">Sources</th></tr>';

  for (const [type, rr] of Object.entries(byType)) {
    const color   = PII_COLORS[type]?.stroke ?? "#999";
    const avgConf = (rr.reduce((s, r) => s + r.confidence, 0) / rr.length * 100).toFixed(0);
    const sources = [...new Set(rr.map((r) => r.source))].join(", ");
    html += `<tr style="border-bottom:1px solid #1a1a2e">
      <td style="padding:4px 6px"><span style="color:${color};font-weight:700">${type}</span></td>
      <td style="text-align:right;padding:4px 6px;color:#e2e2e9">${rr.length}</td>
      <td style="text-align:right;padding:4px 6px;color:#e2e2e9">${avgConf}%</td>
      <td style="text-align:right;padding:4px 6px;color:#6b6b85;font-size:10px">${sources}</td>
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
// Button click → port → background
// ---------------------------------------------------------------------------
const demoBtn    = document.getElementById("demoBtn");
const taskInput  = document.getElementById("taskInput");

function startAnalysis(isDemo) {
  analyzeBtn.disabled = true;
  if(demoBtn) demoBtn.disabled = true;
  resetCanvas();
  setStatus("loading", isDemo ? "⏳ Starting Auto-Run Loop…" : "⏳ Connecting…");

  const instruction = taskInput?.value || "Analyze the current screen and detect PII";

  const port = chrome.runtime.connect({ name: "analyze" });
  port.postMessage({ type: isDemo ? "START_DEMO_RUN" : "ANALYZE_SCREEN", instruction });

  port.onMessage.addListener(async (msg) => {
    switch (msg.type) {
      case "STATUS":
        setStatus("loading", msg.text);
        break;

      case "DOM_SCAN_DONE":
        setStatus("loading", `🔍 Found ${msg.count} sensitive DOM field(s) — running models…`);
        break;

      case "MODEL_PROGRESS": {
        const name = msg.file?.split("/").pop() ?? "model";
        const pct  = (msg.total && msg.total > 0)
          ? ` ${Math.round((msg.loaded / msg.total) * 100)}%`
          : "";
        setStatus("loading", `⬇ Downloading ${name}…${pct}`);
        break;
      }

      case "MODEL_READY":
        setStatus("loading", "✅ Model loaded — running inference…");
        break;

      case "MODEL_ERROR":
        setStatus("error", `❌ Model error: ${msg.error}`);
        analyzeBtn.disabled = false;
        if(demoBtn) demoBtn.disabled = false;
        break;

      case "ANALYSIS_RESULT": {
        const { detections, sensitiveRegions, screenshotDataUrl, elapsed } = msg;
        const piiCount = sensitiveRegions?.length ?? 0;

        setStatus(
          piiCount > 0 ? "error" : "success",
          piiCount > 0
            ? `🔒 ${piiCount} PII region(s) detected in ${elapsed} ms`
            : `✅ No PII detected — ${elapsed} ms`
        );

        if (screenshotDataUrl) {
          await renderResults(screenshotDataUrl, detections ?? [], sensitiveRegions ?? []);
        }
        renderPIITable(sensitiveRegions ?? []);
        console.log("[Popup] Sensitive regions:", sensitiveRegions);
        analyzeBtn.disabled = false;
        if(demoBtn) demoBtn.disabled = false;
        break;
      }

      case "ERROR":
        setStatus("error", `❌ ${msg.error}`);
        analyzeBtn.disabled = false;
        if(demoBtn) demoBtn.disabled = false;
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    if (chrome.runtime.lastError) setStatus("error", "❌ Service worker disconnected.");
    analyzeBtn.disabled = false;
    if(demoBtn) demoBtn.disabled = false;
  });
}

analyzeBtn.addEventListener("click", () => startAnalysis(false));
if(demoBtn) demoBtn.addEventListener("click", () => startAnalysis(true));
