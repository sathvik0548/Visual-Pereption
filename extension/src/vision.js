/**
 * vision.js — Florence-2 visual perception core
 *
 * Requires: @huggingface/transformers >= 3.1.0
 * Model:    onnx-community/Florence-2-base-ft  (fine-tuned, mixed quantization)
 *
 *   dtype breakdown (per-component):
 *     embed_tokens         → fp16  (~2 MB,  fast, lossless for embeddings)
 *     vision_encoder       → fp16  (~25 MB, minimal quality loss)
 *     encoder_model        → q4    (~15 MB, 4-bit, encoder not perf-sensitive)
 *     decoder_model_merged → q4    (~55 MB, 4-bit, biggest win)
 *   Total on-disk: ~97 MB vs ~350 MB for full fp32 Florence-2-base
 *
 *   Detection quality: comparable to fp32 for OD + OCR region detection
 *   (fine-tune helps spatial grounding; quantization mostly affects captioning)
 *
 * Exports:
 *   detectDevice()             → "webgpu" | "wasm"
 *   loadModel(onProgress?)     → loads processor + model (cached after first run)
 *   analyzeImage(dataUrl)      → { detections, elapsed }
 *
 * Detection schema:
 *   { bbox: [x, y, w, h], type: "region" | "text", label_or_text: string }
 *
 * Timing log schema (all emitted via console.log to extension DevTools):
 *   [Vision] T_MODEL_LOAD_START  — model load kicked off
 *   [Vision] T_MODEL_READY       — model fully in memory
 *   [Vision] T_ANALYZE_START     — inference begin (per call)
 *   [Vision] T_ANALYZE_END       — inference end   (per call)
 */

import {
  Florence2ForConditionalGeneration,
  AutoProcessor,
  RawImage,
  env,
} from "@huggingface/transformers";

// ---------------------------------------------------------------------------
// Model config — use the fine-tuned variant with mixed quantization
// ---------------------------------------------------------------------------

/**
 * Florence-2-base-ft: fine-tuned on region description / grounding tasks.
 * The -ft variant is preferred over plain -base because it produces better
 * bounding-box accuracy for <OD> and <OCR_WITH_REGION> tasks.
 */
const MODEL_ID = "onnx-community/Florence-2-base-ft";

/**
 * Per-component dtype map.
 *
 * Rationale:
 *   - embed_tokens: tiny tensor, fp16 has zero observable quality loss
 *   - vision_encoder: DaViT image encoder; fp16 keeps spatial accuracy high
 *   - encoder_model: bridge encoder; q4 is safe because it's not autoregressive
 *   - decoder_model_merged: largest component; q4 saves ~130 MB vs fp32
 *
 * Combined savings: ~250 MB vs full fp32. Deserialization from IndexedDB
 * cache takes ~2–3s instead of ~8–12s for fp32.
 */
const MODEL_DTYPE = {
  embed_tokens:         "fp16",
  vision_encoder:       "fp16",
  encoder_model:        "q4",
  decoder_model_merged: "q4",
};

let _model     = null;
let _processor = null;
let _device    = null;
let _loading   = null; // Promise — prevents concurrent load calls

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
// Model loading — singleton, with timing instrumentation
// ---------------------------------------------------------------------------
export async function loadModel(onProgress) {
  if (_model && _processor) return; // already loaded — instant no-op
  if (_loading) return _loading;    // load already in progress — share promise

  _loading = _doLoad(onProgress);
  await _loading;
}

async function _doLoad(onProgress) {
  // ── Timing marker ────────────────────────────────────────────────────────
  const loadStart = Date.now();
  console.log(`[Vision] T_MODEL_LOAD_START  t=0ms  model=${MODEL_ID}`);
  console.log(`[Vision] dtype config: ${JSON.stringify(MODEL_DTYPE)}`);
  console.log("[Vision] First load: ~97 MB from HuggingFace — cached in IndexedDB afterward.");

  // ── ONNX Runtime WASM setup ──────────────────────────────────────────────
  // Point to the local copies we built into extension/wasm/ so the extension
  // page can load them without needing extra CSP permissions.
  env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("wasm/");
  // Single-threaded: SharedArrayBuffer is blocked in extension pages (COOP/COEP)
  env.backends.onnx.wasm.numThreads = 1;

  env.allowRemoteModels = true;
  env.useBrowserCache   = true;   // cache in IndexedDB — skips download on reload

  _device = await detectDevice();
  console.log(`[Vision] Target device: ${_device}`);

  // ── Load processor (tokenizer + image processor) ─────────────────────────
  _processor = await AutoProcessor.from_pretrained(MODEL_ID, {
    progress_callback: onProgress,
  });
  console.log(`[Vision] Processor ready  (+${Date.now() - loadStart}ms)`);

  // ── Load model with per-component quantization ───────────────────────────
  _model = await Florence2ForConditionalGeneration.from_pretrained(MODEL_ID, {
    dtype:  MODEL_DTYPE,
    device: _device,
    progress_callback: onProgress,
  });

  const loadEnd = Date.now();
  console.log(
    `[Vision] T_MODEL_READY  t=${loadEnd - loadStart}ms  ` +
    `device=${_device}  dtype=mixed(fp16+q4)`
  );
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

  // ── Timing marker ────────────────────────────────────────────────────────
  const t0 = Date.now();
  console.log(`[Vision] T_ANALYZE_START  t=0ms`);

  let odDetections  = [];
  let ocrDetections = [];

  // ── Object Detection ─────────────────────────────────────────────────────
  try {
    const { parsed } = await _runTask(imageDataUrl, "<OD>");
    odDetections = _parseOD(parsed);
    console.log(`[Vision] <OD>: ${odDetections.length} region(s) found  (+${Date.now() - t0}ms)`);
  } catch (err) {
    console.error("[Vision] <OD> task failed:", err);
  }

  // ── OCR with Region ───────────────────────────────────────────────────────
  try {
    const { parsed } = await _runTask(imageDataUrl, "<OCR_WITH_REGION>");
    ocrDetections = _parseOCR(parsed);
    console.log(`[Vision] <OCR_WITH_REGION>: ${ocrDetections.length} text span(s) found  (+${Date.now() - t0}ms)`);
  } catch (err) {
    console.error("[Vision] <OCR_WITH_REGION> task failed:", err);
  }

  const detections = [...odDetections, ...ocrDetections];
  const elapsed    = Date.now() - t0;

  // ── Timing marker ────────────────────────────────────────────────────────
  console.log(`[Vision] T_ANALYZE_END  elapsed=${elapsed}ms  detections=${detections.length}`);

  // Required output: JSON array logged to extension console
  console.log(
    `[Vision] Combined detections (${elapsed} ms):\n` +
    JSON.stringify(detections, null, 2)
  );

  return { detections, elapsed };
}
