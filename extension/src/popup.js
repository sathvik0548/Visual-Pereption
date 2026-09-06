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
const ctx        = canvas.getContext("2d");

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
  
  resetPipeline();
  
  const progressWrap = document.getElementById("modelLoadWrap");
  if (progressWrap) progressWrap.style.display = "none";
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

// Defined below startAnalysis


// Defined below startAnalysis


analyzeBtn.addEventListener("click", () => startAnalysis(false));
if(demoBtn) demoBtn.addEventListener("click", () => startAnalysis(true));
