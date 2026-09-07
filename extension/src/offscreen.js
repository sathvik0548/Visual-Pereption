/**
 * offscreen.js — Offscreen Document script  (src/offscreen.js → built offscreen.js)
 *
 * Startup:
 *   - Pre-loads Florence-2 model (on offscreen open)
 *   - Pre-loads BlazeFace model (in parallel, best-effort)
 *
 * Keep-Alive:
 *   - Sends a PING to background.js every 20s to prevent Chrome from GC-ing it.
 *
 * On RUN_INFERENCE message:
 *   1. analyzeImage()           → ocrDetections[] + odDetections[]
 *   2. detectFaces()            → faceDetections[]
 *   3. detectSensitiveRegions() → sensitiveRegions[]
 *   4. sendResponse({ success, detections, sensitiveRegions, screenshotDataUrl, elapsed })
 */

import { analyzeImage, loadModel } from "./vision.js";
import { detectFaces, loadFaceModel } from "./face.js";
import { detectSensitiveRegions } from "./pii.js";

// ── Timing marker ────────────────────────────────────────────────────────
console.log(`[Offscreen] T_OFFSCREEN_OPEN  t=0ms`);

// ---------------------------------------------------------------------------
// Keep-Alive Ping Loop (prevents MV3 from killing offscreen document)
// ---------------------------------------------------------------------------
setInterval(() => {
  chrome.runtime.sendMessage({ type: "OFFSCREEN_KEEPALIVE" }).catch(() => {});
}, 20000);

// ---------------------------------------------------------------------------
// Warm-start — load both models as soon as the offscreen document opens
// ---------------------------------------------------------------------------
const progressCb = (progress) => {
  if (progress?.status === "progress" && progress?.name) {
    const file = progress.name;
    const loaded = progress.loaded ?? 0;
    const total = progress.total ?? 0;
    let percent = 0;
    if (total > 0) percent = Math.round((loaded / total) * 100);

    chrome.runtime.sendMessage({
      type: "MODEL_PROGRESS",
      file,
      loaded,
      total,
      percent,
    }).catch(() => {});
  }
};

// Florence-2 (primary) — required
const visionReady = loadModel(progressCb)
  .then(() => {
    console.log(`[Offscreen] T_MODEL_READY  (Florence-2)`);
    chrome.runtime.sendMessage({ type: "MODEL_READY", cached: true }).catch(() => {});
  })
  .catch((err) => {
    console.error("[Offscreen] Florence-2 load failed:", err);
    chrome.runtime.sendMessage({ type: "MODEL_ERROR", error: err.message }).catch(() => {});
  });

// BlazeFace (secondary) — face detection, non-fatal if it fails
const faceReady = loadFaceModel()
  .then(() => console.log("[Offscreen] T_MODEL_READY  (BlazeFace)"))
  .catch((err) => console.warn("[Offscreen] BlazeFace load failed:", err.message));

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "PING") {
    sendResponse({ ok: true }); // respond to background ping if any
    return false;
  }

  // ── VERIFY_REDACTION: geometric pixel-sample check (Bug fix: service workers
  //    have no Image/canvas — offscreen document has full window context) ─────
  if (message.type === "VERIFY_REDACTION") {
    const { redactedDataUrl, sensitiveRegions } = message.payload ?? {};
    if (!redactedDataUrl || !sensitiveRegions || sensitiveRegions.length === 0) {
      sendResponse({ ok: true, leakers: [], checked: 0 });
      return true;
    }
    (async () => {
      try {
        const leakers = await new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            try {
              const cv = new OffscreenCanvas(img.width, img.height);
              const ctx = cv.getContext("2d");
              ctx.drawImage(img, 0, 0);
              const found = [];
              for (const r of sensitiveRegions) {
                const [rx, ry, rw, rh] = r.bbox;
                const cx = Math.round(rx + rw / 2);
                const cy = Math.round(ry + rh / 2);
                if (cx < 0 || cy < 0 || cx >= img.width || cy >= img.height) continue;
                const px = ctx.getImageData(cx, cy, 1, 1).data; // [R, G, B, A]
                // Near-black = R+G+B < 30; anything brighter is a potential leak
                if (px[0] + px[1] + px[2] >= 30) {
                  found.push({ ...r, center_pixel: [px[0], px[1], px[2]] });
                }
              }
              resolve(found);
            } catch (e) {
              console.warn("[Offscreen] OffscreenCanvas pixel check failed:", e.message);
              resolve([]); // treat as clean if canvas unavailable
            }
          };
          img.onerror = () => resolve([]);
          img.src = redactedDataUrl;
        });
        sendResponse({ ok: true, leakers, checked: sensitiveRegions.length });
      } catch (err) {
        console.error("[Offscreen] VERIFY_REDACTION error:", err);
        sendResponse({ ok: false, error: err.message, leakers: [], checked: 0 });
      }
    })();
    return true; // keep channel open for async response
  }

  if (message.type !== "RUN_INFERENCE") return false;

  const { screenshotDataUrl, domRegions, mediaRegions } = message.payload ?? {};

  if (!screenshotDataUrl) {
    sendResponse({ success: false, error: "No screenshot data URL provided." });
    return true;
  }

  (async () => {
    try {
      // ── 1. Wait for Florence-2 (required) ─────────────────────────────
      await visionReady;

      // ── 2. Run Florence-2 OD + OCR ────────────────────────────────────
      const { detections, elapsed } = await analyzeImage(screenshotDataUrl);

      // ── 3. Run BlazeFace (media-constrained; only on actual <img>/<video>/<canvas>) ──
      let faceDetections = [];
      try {
        await faceReady;
        faceDetections = await detectFaces(screenshotDataUrl, mediaRegions ?? []);
      } catch (err) {
        console.warn("[Offscreen] Face detection skipped:", err.message);
      }

      // ── 4. PII detection across all three passes ───────────────────────
      const sensitiveRegions = detectSensitiveRegions({
        domRegions:     domRegions ?? [],
        ocrDetections:  detections,
        faceDetections,
      });

      sendResponse({
        success: true,
        detections,
        sensitiveRegions,
        screenshotDataUrl,
        elapsed,
      });
    } catch (err) {
      console.error("[Offscreen] Inference error:", err);
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true; // keep channel open for async response
});

console.log("[Offscreen] Listeners registered, preload started.");
