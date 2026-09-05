/**
 * offscreen.js — Offscreen Document script  (src/offscreen.js → built offscreen.js)
 *
 * v0.2: integrates BlazeFace face detection + PII detection alongside Florence-2.
 *
 * Startup:
 *   - Pre-loads Florence-2 model
 *   - Pre-loads BlazeFace model (in parallel, best-effort)
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

// ---------------------------------------------------------------------------
// Warm-start — load both models as soon as the offscreen document opens
// ---------------------------------------------------------------------------
console.log("[Offscreen] Document open — pre-loading models…");

const progressCb = (progress) => {
  if (progress?.status === "progress" && progress?.name) {
    chrome.runtime.sendMessage({
      type:   "MODEL_PROGRESS",
      file:   progress.name,
      loaded: progress.loaded,
      total:  progress.total,
    }).catch(() => {});
  }
};

// Florence-2 (primary) — required
const visionReady = loadModel(progressCb)
  .then(() => {
    console.log("[Offscreen] Florence-2 ready.");
    chrome.runtime.sendMessage({ type: "MODEL_READY" }).catch(() => {});
  })
  .catch((err) => {
    console.error("[Offscreen] Florence-2 load failed:", err);
    chrome.runtime.sendMessage({ type: "MODEL_ERROR", error: err.message }).catch(() => {});
  });

// BlazeFace (secondary) — face detection, non-fatal if it fails
const faceReady = loadFaceModel()
  .then(() => console.log("[Offscreen] BlazeFace ready."))
  .catch((err) => console.warn("[Offscreen] BlazeFace load failed (faces won't be detected):", err.message));

// ---------------------------------------------------------------------------
// Message handler — RUN_INFERENCE
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "RUN_INFERENCE") return;

  const { screenshotDataUrl, domRegions } = message.payload ?? {};

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

      // ── 3. Run BlazeFace (best-effort; don't fail the whole pipeline) ──
      let faceDetections = [];
      try {
        await faceReady;
        faceDetections = await detectFaces(screenshotDataUrl);
        console.log(`[Offscreen] BlazeFace: ${faceDetections.length} face(s).`);
      } catch (err) {
        console.warn("[Offscreen] Face detection skipped:", err.message);
      }

      // ── 4. PII detection across all three passes ───────────────────────
      const sensitiveRegions = detectSensitiveRegions({
        domRegions:     domRegions ?? [],
        ocrDetections:  detections,   // Florence-2 OCR spans
        faceDetections,
      });

      sendResponse({
        success: true,
        detections,        // full Florence-2 output (OD + OCR)
        sensitiveRegions,  // merged PII regions
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

console.log("[Offscreen] Listener registered.");
