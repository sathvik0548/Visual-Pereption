/**
 * face.js — BlazeFace wrapper for the offscreen document
 *
 * Tries WebGPU backend first; falls back to WebGL.
 * Model weights (~370 KB) are fetched from Google Cloud Storage on first run
 * and cached in the browser cache.
 *
 * Exports:
 *   loadFaceModel()           — pre-load (call once for warm starts)
 *   detectFaces(dataUrl)      → Array<{ bbox:[x,y,w,h], confidence:number }>
 */

import * as blazeface from "@tensorflow-models/blazeface";
// Import backends — esbuild includes both; the right one is activated at runtime
import "@tensorflow/tfjs-backend-webgpu";
import "@tensorflow/tfjs-backend-webgl";
import * as tf from "@tensorflow/tfjs-core";

let _model  = null;
let _loading = null;

// ---------------------------------------------------------------------------
// Backend selection (mirrors vision.js's detectDevice pattern)
// ---------------------------------------------------------------------------
async function pickBackend() {
  // Try WebGPU first
  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        await tf.setBackend("webgpu");
        await tf.ready();
        console.log("[Face] TF.js backend: webgpu");
        return;
      }
    } catch (_) {}
  }
  // Fallback to WebGL
  await tf.setBackend("webgl");
  await tf.ready();
  console.warn("[Face] WebGPU unavailable for BlazeFace — using WebGL fallback.");
}

// ---------------------------------------------------------------------------
// Load the BlazeFace model (idempotent, shared promise)
// ---------------------------------------------------------------------------
export async function loadFaceModel() {
  if (_model) return _model;
  if (_loading) return _loading;

  _loading = (async () => {
    await pickBackend();
    console.log("[Face] Loading BlazeFace model (TensorFlow.js @tensorflow-models/blazeface v0.1.0)…");
    _model = await blazeface.load({
      maxFaces: 20,
      scoreThreshold: 0.85, // Raised from 0.75 to prevent false positives in logos/decorations
    });
    console.log("[Face] BlazeFace ready with scoreThreshold 0.85.");
    return _model;
  })();

  return _loading;
}

// ---------------------------------------------------------------------------
// Detect faces constrained strictly to actual <img>, <video>, or <canvas> DOM elements
// ---------------------------------------------------------------------------
export async function detectFaces(imageDataUrl, mediaRegions = []) {
  console.log("[Face] ================= detectFaces INVOKED =================");
  console.log("[Face] Model: BlazeFace via TensorFlow.js (@tensorflow-models/blazeface v0.1.0)");
  console.log("[Face] Acceptance Threshold: 0.85");
  console.log(`[Face] DOM Media Elements (<img>, <video>, <canvas>) received: ${mediaRegions.length}`, mediaRegions);

  // SANITY CONSTRAINT: Only run face detection on regions of the screenshot that
  // correspond to actual <img>, <video>, or <canvas> elements in the DOM.
  // A decorative CSS gradient, SVG banner, or styled text block is NOT photo content.
  if (!mediaRegions || mediaRegions.length === 0) {
    console.log("[Face] ✓ SANITY CONSTRAINT ENFORCED: 0 media elements (<img>, <video>, <canvas>) found in DOM. Skipping face detection completely (Zero false positives guaranteed).");
    return [];
  }

  const model = await loadFaceModel();

  // Load screenshot into an Image element
  const img = new Image();
  await new Promise((res, rej) => {
    img.onload  = res;
    img.onerror = rej;
    img.src     = imageDataUrl;
  });

  const fullCanvas = document.createElement("canvas");
  fullCanvas.width  = img.naturalWidth;
  fullCanvas.height = img.naturalHeight;
  const fullCtx = fullCanvas.getContext("2d");
  fullCtx.drawImage(img, 0, 0);

  const detectedFaces = [];

  // Iterate over each actual media element in the DOM
  for (const media of mediaRegions) {
    const [mx, my, mw, mh] = media.bbox || [];
    if (!mw || !mh || mw < 24 || mh < 24) continue;

    // Crop the media region onto an isolated canvas
    const mediaCanvas = document.createElement("canvas");
    mediaCanvas.width = mw;
    mediaCanvas.height = mh;
    const mctx = mediaCanvas.getContext("2d");
    mctx.drawImage(fullCanvas, mx, my, mw, mh, 0, 0, mw, mh);

    console.log(`[Face] Running BlazeFace inference on DOM media element <${media.tag} id="${media.id}"> bbox=[${mx}, ${my}, ${mw}, ${mh}]...`);
    const predictions = await model.estimateFaces(mediaCanvas, false /* returnTensors */);

    console.log(`[Face] BlazeFace returned ${predictions.length} raw prediction(s) for <${media.tag} id="${media.id}">`);

    for (let i = 0; i < predictions.length; i++) {
      const pred = predictions[i];
      const [x1, y1] = pred.topLeft;
      const [x2, y2] = pred.bottomRight;
      const w = x2 - x1;
      const h = y2 - y1;

      // Extract real confidence probability
      let prob = 0;
      if (Array.isArray(pred.probability) || pred.probability instanceof Float32Array) {
        prob = pred.probability[0];
      } else if (typeof pred.probability === "number") {
        prob = pred.probability;
      }

      console.log(`[Face] RAW MODEL OUTPUT [Detection #${i} on <${media.tag} id="${media.id}">]:`, {
        localBbox: [Math.round(x1), Math.round(y1), Math.round(w), Math.round(h)],
        confidenceScore: +prob.toFixed(4),
        rawProbability: pred.probability,
        threshold: 0.85
      });

      // 1. Confidence threshold check
      if (prob < 0.85) {
        console.log(`[Face] Rejected detection #${i}: score ${prob.toFixed(4)} is below threshold 0.85`);
        continue;
      }

      // 2. Aspect ratio check (human face aspect ratio is upright ~0.60 to ~1.35)
      const aspect = w / h;
      if (aspect < 0.55 || aspect > 1.45) {
        console.warn(`[Face] Rejected detection #${i}: unnatural aspect ratio ${aspect.toFixed(2)} (${w}x${h})`);
        continue;
      }

      // Map back to global screenshot physical coordinates
      const globalBbox = [
        Math.round(mx + x1),
        Math.round(my + y1),
        Math.round(w),
        Math.round(h)
      ];

      console.log(`[Face] ✓ ACCEPTED FACE DETECTION in <${media.tag}>: globalBbox=[${globalBbox.join(",")}], confidence=${prob.toFixed(4)}`);

      detectedFaces.push({
        bbox:       globalBbox,
        confidence: +prob.toFixed(4),
      });
    }
  }

  console.log(`[Face] Total confirmed faces after media constraint & thresholding: ${detectedFaces.length}`);
  return detectedFaces;
}
