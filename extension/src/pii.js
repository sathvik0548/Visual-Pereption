/**
 * pii.js — PII (Personally Identifiable Information) Detection Module
 *
 * detectSensitiveRegions({ domRegions, ocrDetections, faceDetections })
 *   → SensitiveRegion[]
 *
 * SensitiveRegion schema:
 *   {
 *     bbox:       [x, y, w, h],          // pixel coords matching the screenshot
 *     type:       PII_TYPE.*,
 *     confidence: number,                  // 0–1
 *     source:     "dom"|"ocr_regex"|"vision"|"dom+ocr_regex",
 *     matched?:   string,                  // the matched text snippet (debug)
 *     luhnValid?: boolean,                 // for CARD type
 *   }
 */

// ── PII type constants ──────────────────────────────────────────────────────
export const PII_TYPE = Object.freeze({
  PASSWORD:  "PASSWORD",
  EMAIL:     "EMAIL",
  PHONE:     "PHONE",
  CARD:      "CARD",
  FACE:      "FACE",
  NAME:      "NAME",
  OTHER_PII: "OTHER_PII",
});

// Rendering colours used by popup and test harness (exported for reuse)
export const PII_COLORS = {
  PASSWORD:  { fill: "rgba(220,38,38,0.35)",   stroke: "#ef4444", text: "#fff" },
  EMAIL:     { fill: "rgba(234,88,12,0.35)",   stroke: "#f97316", text: "#fff" },
  PHONE:     { fill: "rgba(202,138,4,0.35)",   stroke: "#eab308", text: "#000" },
  CARD:      { fill: "rgba(219,39,119,0.35)",  stroke: "#ec4899", text: "#fff" },
  FACE:      { fill: "rgba(8,145,178,0.35)",   stroke: "#06b6d4", text: "#fff" },
  NAME:      { fill: "rgba(147,51,234,0.35)",  stroke: "#a855f7", text: "#fff" },
  OTHER_PII: { fill: "rgba(100,116,139,0.35)", stroke: "#64748b", text: "#fff" },
};

// ── Regex patterns ──────────────────────────────────────────────────────────
const PATTERNS = {
  EMAIL: {
    re: () => /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
    baseConfidence: 0.95,
  },
  PHONE: {
    // Indian mobile (+91 / 0 / raw) and generic international (E.164-like)
    re: () => /(?:(?:\+91|0091|0)[\s\-]?)?[6-9]\d{9}|(?:\+\d{1,3}[\s\-]?)?\(?\d{2,4}\)?[\s\-]?\d{3,4}[\s\-]?\d{4}/g,
    baseConfidence: 0.82,
    minDigits: 10,
  },
  CARD: {
    // 16-digit with optional space/hyphen separators, or raw 15-16 digits
    re: () => /\b(?:\d{4}[\s\-]?){3}\d{4}\b|\b\d{15,16}\b/g,
    baseConfidence: 0.72,   // boosted to 0.92 when Luhn passes
    minDigits: 15,
  },
};

// ── Luhn algorithm ──────────────────────────────────────────────────────────
function luhnCheck(raw) {
  const digits = raw.replace(/\D/g, "").split("").reverse().map(Number);
  if (digits.length < 15) return false;
  const sum = digits.reduce((acc, d, i) => {
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    return acc + d;
  }, 0);
  return sum % 10 === 0;
}

// ── IoU helper ──────────────────────────────────────────────────────────────
function iou(a, b) {
  const [ax, ay, aw, ah] = a.bbox;
  const [bx, by, bw, bh] = b.bbox;
  const ix = Math.max(ax, bx);
  const iy = Math.max(ay, by);
  const iw = Math.min(ax + aw, bx + bw) - ix;
  const ih = Math.min(ay + ah, by + bh) - iy;
  if (iw <= 0 || ih <= 0) return 0;
  const intersection = iw * ih;
  const union = aw * ah + bw * bh - intersection;
  return union > 0 ? intersection / union : 0;
}

// ── Merge overlapping detections ────────────────────────────────────────────
// Regions with IoU ≥ IOU_THRESHOLD are merged: union bbox, boosted confidence.
const IOU_THRESHOLD = 0.25;

function mergeRegions(regions) {
  const merged = [];
  const used   = new Set();

  for (let i = 0; i < regions.length; i++) {
    if (used.has(i)) continue;
    const cluster = [regions[i]];
    used.add(i);

    for (let j = i + 1; j < regions.length; j++) {
      if (used.has(j)) continue;
      if (iou(regions[i], regions[j]) >= IOU_THRESHOLD) {
        cluster.push(regions[j]);
        used.add(j);
      }
    }

    if (cluster.length === 1) {
      merged.push(cluster[0]);
      continue;
    }

    // Union bounding box across all cluster members
    const xs    = cluster.flatMap((r) => [r.bbox[0], r.bbox[0] + r.bbox[2]]);
    const ys    = cluster.flatMap((r) => [r.bbox[1], r.bbox[1] + r.bbox[3]]);
    const minX  = Math.min(...xs), minY = Math.min(...ys);
    const maxX  = Math.max(...xs), maxY = Math.max(...ys);

    const sources = [...new Set(cluster.map((r) => r.source))];
    // Highest-priority type wins (DOM > OCR > vision)
    const priority = ["dom", "ocr_regex", "vision"];
    cluster.sort((a, b) => priority.indexOf(a.source) - priority.indexOf(b.source));

    const maxConf = Math.max(...cluster.map((r) => r.confidence));
    // Each additional agreeing source boosts confidence by 0.08, capped at 1
    const boosted = Math.min(1, maxConf + (sources.length - 1) * 0.08);

    merged.push({
      bbox:       [minX, minY, maxX - minX, maxY - minY],
      type:       cluster[0].type,
      confidence: +boosted.toFixed(3),
      source:     sources.length === 1 ? sources[0] : sources.join("+"),
      _cluster:   cluster.map(({ type, source, confidence }) => ({ type, source, confidence })),
    });
  }

  return merged;
}

// ── Pass 1 — DOM scan results ───────────────────────────────────────────────
// domRegions come pre-scaled (×devicePixelRatio) from the content script.
function passDOM(domRegions) {
  return (domRegions ?? []).map((r) => ({
    bbox:       r.bbox,
    type:       r.type,
    confidence: r.confidence ?? 1.0,
    source:     "dom",
  }));
}

// ── Pass 2 — OCR-regex ──────────────────────────────────────────────────────
function passOCR(ocrDetections) {
  const hits = [];

  for (const det of ocrDetections ?? []) {
    if (det.type !== "text") continue;
    const text = det.label_or_text ?? "";
    const bbox = det.bbox;

    // Email
    for (const m of text.matchAll(PATTERNS.EMAIL.re())) {
      hits.push({
        bbox, source: "ocr_regex", matched: m[0],
        type:       PII_TYPE.EMAIL,
        confidence: PATTERNS.EMAIL.baseConfidence,
      });
    }

    // Phone (require ≥ minDigits actual digits to avoid false-positives)
    for (const m of text.matchAll(PATTERNS.PHONE.re())) {
      const digits = m[0].replace(/\D/g, "");
      if (digits.length >= PATTERNS.PHONE.minDigits) {
        hits.push({
          bbox, source: "ocr_regex", matched: m[0].trim(),
          type:       PII_TYPE.PHONE,
          confidence: PATTERNS.PHONE.baseConfidence,
        });
      }
    }

    // Card number with Luhn verification
    for (const m of text.matchAll(PATTERNS.CARD.re())) {
      const digits = m[0].replace(/\D/g, "");
      if (digits.length >= PATTERNS.CARD.minDigits) {
        const valid = luhnCheck(digits);
        hits.push({
          bbox, source: "ocr_regex", matched: m[0], luhnValid: valid,
          type:       PII_TYPE.CARD,
          confidence: valid ? 0.93 : PATTERNS.CARD.baseConfidence,
        });
      }
    }
  }

  return hits;
}

// ── Pass 3 — Face detections (from BlazeFace) ───────────────────────────────
function passFace(faceDetections) {
  return (faceDetections ?? []).map((f) => ({
    bbox:       f.bbox,
    type:       PII_TYPE.FACE,
    confidence: +(f.confidence ?? 0.9).toFixed(3),
    source:     "vision",
  }));
}

// ── Public API ──────────────────────────────────────────────────────────────
/**
 * detectSensitiveRegions
 *
 * @param {object} params
 * @param {Array}  params.domRegions     — from content.js SCAN_DOM (pre-DPR-scaled)
 * @param {Array}  params.ocrDetections  — from Florence-2 analyzeImage()
 * @param {Array}  params.faceDetections — from face.js detectFaces()
 * @returns {SensitiveRegion[]}
 */
export function detectSensitiveRegions({ domRegions, ocrDetections, faceDetections }) {
  const domHits  = passDOM(domRegions);
  const ocrHits  = passOCR(ocrDetections);
  const faceHits = passFace(faceDetections);

  const all    = [...domHits, ...ocrHits, ...faceHits];
  const result = mergeRegions(all);

  console.log(
    `[PII] ${result.length} sensitive region(s)` +
    `  (dom:${domHits.length}  ocr:${ocrHits.length}  face:${faceHits.length})\n` +
    JSON.stringify(result, null, 2)
  );

  return result;
}
