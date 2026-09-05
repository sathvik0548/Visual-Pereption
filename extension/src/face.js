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
    console.log("[Face] Loading BlazeFace model…");
    _model = await blazeface.load({
      maxFaces: 20,   // reasonable upper bound for a screenshot
      scoreThreshold: 0.75,
    });
    console.log("[Face] BlazeFace ready.");
    return _model;
  })();

  return _loading;
}

// ---------------------------------------------------------------------------
// Detect faces on a screenshot data URL
// ---------------------------------------------------------------------------
export async function detectFaces(imageDataUrl) {
  const model = await loadFaceModel();

  // Load into an Image element
  const img = new Image();
  await new Promise((res, rej) => {
    img.onload  = res;
    img.onerror = rej;
    img.src     = imageDataUrl;
  });

  // Draw onto a regular canvas in the offscreen document's DOM
  const canvas    = document.createElement("canvas");
  canvas.width    = img.naturalWidth;
  canvas.height   = img.naturalHeight;
  canvas.getContext("2d").drawImage(img, 0, 0);

  const predictions = await model.estimateFaces(canvas, false /* returnTensors */);

  return predictions.map((pred) => {
    const [x1, y1] = pred.topLeft;
    const [x2, y2] = pred.bottomRight;
    return {
      bbox:       [Math.round(x1), Math.round(y1), Math.round(x2 - x1), Math.round(y2 - y1)],
      confidence: +(pred.probability?.[0] ?? 0.9).toFixed(3),
    };
  });
}
