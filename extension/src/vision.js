/**
 * vision.js — Florence-2 visual perception core
 *
 * Requires: @huggingface/transformers >= 3.1.0
 * Model:    onnx-community/Florence-2-base  (~350 MB, cached in IndexedDB after first download)
 *
 * Exports:
 *   detectDevice()             → "webgpu" | "wasm"
 *   loadModel(onProgress?)     → loads processor + model
 *   analyzeImage(dataUrl)      → { detections, elapsed }
 *
 * Detection schema:
 *   { bbox: [x, y, w, h], type: "region" | "text", label_or_text: string }
 */

import {
  Florence2ForConditionalGeneration,
  AutoProcessor,
  RawImage,
  env,
} from "@huggingface/transformers";

const MODEL_ID = "onnx-community/Florence-2-base";

let _model     = null;
let _processor = null;
let _device    = null;
let _loading   = null; // Promise — prevent concurrent load calls

// ---------------------------------------------------------------------------
// WebGPU detection with graceful WASM fallback
// ---------------------------------------------------------------------------
export async function detectDevice() {
  // navigator.gpu is undefined in service workers; offscreen docs have full DOM
  if (typeof navigator === "undefined" || !navigator.gpu) {
    console.warn(
      "[Vision] WebGPU unavailable in this context. " +
      "Falling back to WASM. Expect ~10–50× slower inference."
    );
    return "wasm";
  }
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      console.warn("[Vision] No WebGPU adapter found. Falling back to WASM.");
      return "wasm";
    }
    // Log adapter info if available (Chrome 121+)
    const info = typeof adapter.requestAdapterInfo === "function"
      ? await adapter.requestAdapterInfo()
      : {};
    console.log(
      `[Vision] WebGPU adapter: ${info.vendor ?? "?"} / ${info.device ?? "unknown"}`
    );
    return "webgpu";
  } catch (err) {
    console.warn(`[Vision] WebGPU requestAdapter() threw: ${err.message}. Using WASM.`);
    return "wasm";
  }
}

// ---------------------------------------------------------------------------
// Model loading
// ---------------------------------------------------------------------------
export async function loadModel(onProgress) {
  if (_model && _processor) return; // already loaded
  if (_loading) return _loading;    // already in progress — share the promise

  _loading = _doLoad(onProgress);
  await _loading;
}

async function _doLoad(onProgress) {
  // Point ONNX Runtime WASM to the files we copied into extension/wasm/
  // chrome.runtime.getURL returns a chrome-extension:// URL accessible from extension pages
  env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("wasm/");
  // Disable multi-threading (requires SharedArrayBuffer + COOP/COEP which extension pages don't have)
  env.backends.onnx.wasm.numThreads = 1;

  // Allow fetching model weights from HuggingFace Hub; cache in browser IndexedDB
  env.allowRemoteModels = true;
  env.useBrowserCache   = true;

  _device = await detectDevice();

  // fp32 is the safest dtype and works for both WebGPU and WASM.
  // NOTE: if the onnx-community/Florence-2-base repo publishes fp16 shards,
  // switch to dtype:"fp16" when device==="webgpu" for ~2× memory savings.
  const dtype = "fp32";

  console.info(`[Vision] Loading ${MODEL_ID}  device=${_device}  dtype=${dtype}`);
  console.info("[Vision] First load: ~350 MB from HuggingFace — cached in IndexedDB afterward.");

  _processor = await AutoProcessor.from_pretrained(MODEL_ID, {
    progress_callback: onProgress,
  });

  _model = await Florence2ForConditionalGeneration.from_pretrained(MODEL_ID, {
    dtype,
    device: _device,
    progress_callback: onProgress,
  });

  console.log(`[Vision] Florence-2-base ready on ${_device}.`);
}

// ---------------------------------------------------------------------------
// Run a single Florence-2 task token on an image data URL
// ---------------------------------------------------------------------------
async function _runTask(imageDataUrl, task) {
  const image  = await RawImage.fromURL(imageDataUrl);
  const inputs = await _processor(image, task);

  // Florence-2 is an encoder-decoder; generate() returns only the decoder tokens
  const generatedIds = await _model.generate({
    ...inputs,
    max_new_tokens: 512,
    do_sample:      false,
    num_beams:      3,
  });

  // Decode — include special tokens so post_process_generation can strip the task prefix
  const generatedText = _processor.batch_decode(generatedIds, {
    skip_special_tokens: false,
  })[0];

  // Post-process: denormalise bounding boxes into pixel coordinates
  const parsed = _processor.post_process_generation(
    generatedText,
    task,
    [image.width, image.height],
  );

  return { parsed, imageWidth: image.width, imageHeight: image.height };
}

// ---------------------------------------------------------------------------
// Parse <OD> output → unified detection objects
// ---------------------------------------------------------------------------
function _parseOD(parsed) {
  const od = parsed["<OD>"];
  if (!od?.bboxes) return [];
  return od.bboxes.map((bbox, i) => ({
    bbox: [
      Math.round(bbox[0]),
      Math.round(bbox[1]),
      Math.round(bbox[2] - bbox[0]),   // x1,y1,x2,y2 → x,y,w,h
      Math.round(bbox[3] - bbox[1]),
    ],
    type:          "region",
    label_or_text: od.labels?.[i] ?? "object",
  }));
}

// ---------------------------------------------------------------------------
// Parse <OCR_WITH_REGION> output → unified detection objects
// ---------------------------------------------------------------------------
function _parseOCR(parsed) {
  const ocr = parsed["<OCR_WITH_REGION>"];
  if (!ocr?.quad_boxes) return [];
  return ocr.quad_boxes.map((quad, i) => {
    // quad = [x1,y1, x2,y2, x3,y3, x4,y4] — four corners of the text quad
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    const x  = Math.min(...xs);
    const y  = Math.min(...ys);
    const w  = Math.max(...xs) - x;
    const h  = Math.max(...ys) - y;
    return {
      bbox:          [Math.round(x), Math.round(y), Math.round(w), Math.round(h)],
      type:          "text",
      label_or_text: ocr.labels?.[i] ?? "",
    };
  });
}

// ---------------------------------------------------------------------------
// Public API: run both tasks, merge, log, return
// ---------------------------------------------------------------------------
export async function analyzeImage(imageDataUrl, onProgress) {
  await loadModel(onProgress);

  const t0 = Date.now();
  let odDetections  = [];
  let ocrDetections = [];

  // ── Object Detection ─────────────────────────────────────────────────────
  try {
    const { parsed } = await _runTask(imageDataUrl, "<OD>");
    odDetections = _parseOD(parsed);
    console.log(`[Vision] <OD>: ${odDetections.length} region(s) found.`);
  } catch (err) {
    console.error("[Vision] <OD> task failed:", err);
  }

  // ── OCR with Region ───────────────────────────────────────────────────────
  try {
    const { parsed } = await _runTask(imageDataUrl, "<OCR_WITH_REGION>");
    ocrDetections = _parseOCR(parsed);
    console.log(`[Vision] <OCR_WITH_REGION>: ${ocrDetections.length} text span(s) found.`);
  } catch (err) {
    console.error("[Vision] <OCR_WITH_REGION> task failed:", err);
  }

  const detections = [...odDetections, ...ocrDetections];
  const elapsed    = Date.now() - t0;

  // Required output: JSON array logged to extension console
  console.log(
    `[Vision] Combined detections (${elapsed} ms):\n` +
    JSON.stringify(detections, null, 2)
  );

  return { detections, elapsed };
}
