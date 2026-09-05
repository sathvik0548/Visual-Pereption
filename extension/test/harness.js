/**
 * harness.js — PII Detection Test Harness
 *
 * Imports pii.js DIRECTLY (no bundler needed — pii.js has zero external deps).
 * Accessible as a Chrome extension page:
 *   chrome-extension://<ID>/test/harness.html
 *
 * Tests three scenarios with synthetic screenshots drawn via Canvas 2D API:
 *   1. Login form    — DOM + OCR email/password
 *   2. Email page    — OCR email, phone, card number (Luhn-valid)
 *   3. Video call    — Face detections + OCR name/email in captions
 */

import { detectSensitiveRegions, PII_COLORS, PII_TYPE } from "../src/pii.js";

// ── Fixture definitions ─────────────────────────────────────────────────────
const W = 760, H = 427;  // 16:9 canvas size

const FIXTURES = [
  // ── 1. Login form ──────────────────────────────────────────────────────
  {
    name:    "Login Form",
    draw(ctx) {
      // Background
      ctx.fillStyle = "#1e1b2e"; ctx.fillRect(0, 0, W, H);
      // Card
      roundRect(ctx, 230, 60, 300, 300, 16, "#2d2a42");
      // Heading
      ctx.fillStyle = "#fff"; ctx.font = "bold 22px system-ui";
      ctx.fillText("Sign In", 330, 115);
      // Email label + field
      ctx.fillStyle = "#a0a0b8"; ctx.font = "12px system-ui";
      ctx.fillText("Email address", 245, 155);
      inputBox(ctx, 245, 165, 270, 38, "#131124", "john.doe@example.com", "#9090cc");
      // Password label + field
      ctx.fillText("Password", 245, 225);
      inputBox(ctx, 245, 235, 270, 38, "#131124", "••••••••••••", "#9090cc");
      // Button
      roundRect(ctx, 245, 295, 270, 42, 8, "#7c3aed");
      ctx.fillStyle = "#fff"; ctx.font = "bold 14px system-ui";
      ctx.fillText("Sign In", 348, 321);
      // Forgot
      ctx.fillStyle = "#7c5fc8"; ctx.font = "12px system-ui";
      ctx.fillText("Forgot password?", 319, 370);
    },
    domRegions: [
      { bbox: [490, 330, 540, 76],  type: PII_TYPE.EMAIL,    confidence: 1.0, source: "dom" },
      { bbox: [490, 470, 540, 76],  type: PII_TYPE.PASSWORD, confidence: 1.0, source: "dom" },
    ],
    ocrDetections: [
      { bbox: [490, 330, 450, 40], type: "text", label_or_text: "john.doe@example.com" },
      { bbox: [490, 470, 540, 40], type: "text", label_or_text: "••••••••••••"         },
      { bbox: [660, 228, 160, 60], type: "text", label_or_text: "Sign In"              },
      { bbox: [638, 740, 335, 48], type: "text", label_or_text: "Forgot password?"     },
    ],
    faceDetections: [],
  },

  // ── 2. Email + PII visible page ───────────────────────────────────────
  {
    name:    "Email / PII Visible Page",
    draw(ctx) {
      // White background
      ctx.fillStyle = "#f8fafc"; ctx.fillRect(0, 0, W, H);
      // Nav bar
      ctx.fillStyle = "#1e40af"; ctx.fillRect(0, 0, W, 48);
      ctx.fillStyle = "#fff"; ctx.font = "bold 16px system-ui";
      ctx.fillText("Company Portal", 20, 30);
      // Article
      ctx.fillStyle = "#1e293b"; ctx.font = "bold 18px system-ui";
      ctx.fillText("Contact & Billing Information", 30, 90);
      // Lines of text containing PII
      const lines = [
        "Primary contact: alice.nguyen@company.co.in",
        "Support line:    +91 98765 43210",
        "Billing card:    4532 1234 5678 9012",
        "Alt card:        3714 496353 98431  (Amex)",
        "Address:         12, MG Road, Bengaluru 560001",
        "Secondary:       bob@example.org  / +1 (415) 555-0143",
      ];
      ctx.font = "13px monospace";
      lines.forEach((l, i) => {
        ctx.fillStyle = i % 2 === 0 ? "#1e293b" : "#334155";
        ctx.fillText(l, 30, 130 + i * 42);
      });
    },
    domRegions: [],
    ocrDetections: [
      { bbox: [244, 214, 760, 32], type: "text", label_or_text: "Primary contact: alice.nguyen@company.co.in" },
      { bbox: [244, 256, 720, 32], type: "text", label_or_text: "Support line:    +91 98765 43210"           },
      { bbox: [244, 298, 760, 32], type: "text", label_or_text: "Billing card:    4532 1234 5678 9012"       },
      { bbox: [244, 340, 760, 32], type: "text", label_or_text: "Alt card:        3714 496353 98431"         },
      { bbox: [244, 382, 700, 32], type: "text", label_or_text: "Address:         12, MG Road, Bengaluru"    },
      { bbox: [244, 424, 840, 32], type: "text", label_or_text: "Secondary: bob@example.org / +1 4155550143" },
    ],
    faceDetections: [],
  },

  // ── 3. Video call thumbnail ───────────────────────────────────────────
  {
    name:    "Video Call Thumbnail",
    draw(ctx) {
      ctx.fillStyle = "#111827"; ctx.fillRect(0, 0, W, H);
      // Two video tiles
      drawFaceTile(ctx,  10, 20, 365, 360, "#1f2937", "#60a5fa", "JS");
      drawFaceTile(ctx, 385, 20, 365, 360, "#1f2937", "#a78bfa", "AN");
      // Name labels
      ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fillRect(10, 340, 365, 40);
      ctx.fillRect(385, 340, 365, 40);
      ctx.fillStyle = "#fff"; ctx.font = "13px system-ui";
      ctx.fillText("John Smith", 28, 366);
      ctx.fillText("alice.nguyen@corp.com", 400, 366);
      // Recording badge
      ctx.fillStyle = "#ef4444"; ctx.beginPath(); ctx.arc(730, 415, 7, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.font = "11px system-ui"; ctx.fillText("REC", 740, 420);
    },
    domRegions: [],
    ocrDetections: [
      { bbox: [56,  680, 290, 56], type: "text", label_or_text: "John Smith"              },
      { bbox: [800, 680, 540, 56], type: "text", label_or_text: "alice.nguyen@corp.com"   },
    ],
    // Mock BlazeFace output (coordinates are in the synthetic screenshot pixel space)
    faceDetections: [
      { bbox: [ 80, 50, 230, 260], confidence: 0.97 },
      { bbox: [450, 50, 240, 260], confidence: 0.94 },
    ],
  },
];

// ── Canvas drawing helpers ──────────────────────────────────────────────────
function roundRect(ctx, x, y, w, h, r, fill) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x+w, y,   x+w, y+r);
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x+w, y+h, x+w-r, y+h);
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y+h, x, y+h-r);
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x+r, y);
  ctx.closePath();
  ctx.fillStyle = fill; ctx.fill();
}

function inputBox(ctx, x, y, w, h, bg, text, textColor) {
  roundRect(ctx, x, y, w, h, 6, bg);
  ctx.strokeStyle = "#4c4870"; ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.fillStyle = textColor; ctx.font = "13px monospace";
  ctx.fillText(text, x + 10, y + h / 2 + 5);
}

function drawFaceTile(ctx, x, y, w, h, bg, accentColor, initials) {
  roundRect(ctx, x, y, w, h, 10, bg);
  // Head circle
  ctx.beginPath();
  ctx.arc(x + w / 2, y + h / 2 - 20, 70, 0, Math.PI * 2);
  ctx.fillStyle = accentColor + "33"; ctx.fill();
  ctx.strokeStyle = accentColor; ctx.lineWidth = 3; ctx.stroke();
  // Initials
  ctx.fillStyle = accentColor; ctx.font = "bold 32px system-ui";
  ctx.textAlign = "center";
  ctx.fillText(initials, x + w / 2, y + h / 2 - 2);
  ctx.textAlign = "left";
}

// ── PII overlay renderer ────────────────────────────────────────────────────
function drawPIIOverlay(ctx, regions, scaleX, scaleY) {
  for (const r of regions) {
    const [rx, ry, rw, rh] = r.bbox;
    const x = rx * scaleX, y = ry * scaleY, w = rw * scaleX, h = rh * scaleY;
    const colors = PII_COLORS[r.type] ?? PII_COLORS.OTHER_PII;

    ctx.fillStyle   = colors.fill;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = colors.stroke;
    ctx.lineWidth   = 2;
    ctx.strokeRect(x, y, w, h);

    // Label badge
    const label    = `${r.type} (${(r.confidence * 100).toFixed(0)}%)`;
    ctx.font       = "bold 10px system-ui";
    const tw       = ctx.measureText(label).width + 8;
    ctx.fillStyle  = colors.stroke;
    ctx.fillRect(x, Math.max(0, y - 18), tw, 18);
    ctx.fillStyle  = colors.text;
    ctx.fillText(label, x + 4, Math.max(12, y - 4));
  }
}

// ── Log panel renderer ──────────────────────────────────────────────────────
function renderLog(el, regions) {
  const byType = {};
  for (const r of regions) {
    (byType[r.type] ??= []).push(r);
  }
  const html = regions.length === 0
    ? '<span style="color:#64748b">No PII detected.</span>'
    : Object.entries(byType)
        .map(([type, rr]) => {
          const color = PII_COLORS[type]?.stroke ?? "#999";
          return `<div><span style="color:${color};font-weight:700">${type} ×${rr.length}</span> — ` +
            rr.map((r) =>
              `conf=${(r.confidence * 100).toFixed(0)}% src=${r.source}` +
              (r.matched ? ` "${r.matched}"` : "") +
              (r.luhnValid === true ? " ✓Luhn" : r.luhnValid === false ? " ✗Luhn" : "")
            ).join(" | ") + "</div>";
        }).join("");

  el.innerHTML = `<strong style="color:#e2e8f0">${regions.length} region(s)</strong><br>${html}`;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function run() {
  for (const fixture of FIXTURES) {
    const section  = document.getElementById(`section-${FIXTURES.indexOf(fixture)}`);
    if (!section) continue;

    const canvas = section.querySelector("canvas");
    const logEl  = section.querySelector(".log");
    const ctx    = canvas.getContext("2d");

    canvas.width  = W;
    canvas.height = H;
    canvas.style.width  = "100%";
    canvas.style.height = "auto";

    // 1. Draw the synthetic screenshot
    fixture.draw(ctx);

    // 2. Run PII detection with mock inputs
    const regions = detectSensitiveRegions({
      domRegions:     fixture.domRegions,
      ocrDetections:  fixture.ocrDetections,
      faceDetections: fixture.faceDetections,
    });

    // 3. Overlay PII regions (coords are in "double-DPR" space relative to W×H)
    //    The fixture coords were crafted for 2× the canvas CSS pixel dimensions.
    drawPIIOverlay(ctx, regions, W / (W * 2), H / (H * 2));

    // 4. Render text log
    renderLog(logEl, regions);
  }
}

document.addEventListener("DOMContentLoaded", run);
