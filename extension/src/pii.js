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
  PASSWORD:      "PASSWORD",
  EMAIL:         "EMAIL",
  PHONE:         "PHONE",
  CARD:          "CARD",
  FACE:          "FACE",
  NAME:          "NAME",
  AADHAAR:       "AADHAAR",
  PAN:           "PAN",
  GSTIN:         "GSTIN",
  IFSC:          "IFSC",
  INDIAN_MOBILE: "INDIAN_MOBILE",
  OTHER_PII:     "OTHER_PII",
});

// Rendering colours used by popup and test harness (exported for reuse)
export const PII_COLORS = {
  PASSWORD:      { fill: "rgba(220,38,38,0.35)",   stroke: "#ef4444", text: "#fff" },
  EMAIL:         { fill: "rgba(234,88,12,0.35)",   stroke: "#f97316", text: "#fff" },
  PHONE:         { fill: "rgba(202,138,4,0.35)",   stroke: "#eab308", text: "#000" },
  CARD:          { fill: "rgba(219,39,119,0.35)",  stroke: "#ec4899", text: "#fff" },
  FACE:          { fill: "rgba(8,145,178,0.35)",   stroke: "#06b6d4", text: "#fff" },
  NAME:          { fill: "rgba(147,51,234,0.35)",  stroke: "#a855f7", text: "#fff" },
  AADHAAR:       { fill: "rgba(234,88,12,0.35)",   stroke: "#ea580c", text: "#fff" }, // Saffron / Deep Orange
  PAN:           { fill: "rgba(16,185,129,0.35)",  stroke: "#10b981", text: "#fff" }, // Emerald
  GSTIN:         { fill: "rgba(99,102,241,0.35)",  stroke: "#6366f1", text: "#fff" }, // Indigo
  IFSC:          { fill: "rgba(14,165,233,0.35)",  stroke: "#0ea5e9", text: "#fff" }, // Cyan / Sky
  INDIAN_MOBILE: { fill: "rgba(234,179,8,0.35)",  stroke: "#ca8a04", text: "#000" }, // Amber Gold
  OTHER_PII:     { fill: "rgba(100,116,139,0.35)", stroke: "#64748b", text: "#fff" },
};

// ── Verhoeff Algorithm Tables ───────────────────────────────────────────────
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]
];

const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8]
];

export function verhoeffCheck(raw) {
  if (typeof raw !== "string") return false;
  const digits = raw.replace(/\D/g, "");
  if (!digits) return false;
  let c = 0;
  const reversed = digits.split("").reverse().map(Number);
  for (let i = 0; i < reversed.length; i++) {
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][reversed[i]]];
  }
  return c === 0;
}

// ── Structural Validators ───────────────────────────────────────────────────

/**
 * AADHAAR: exactly 12 digits, first digit 1-9 excluding leading 0/1 (i.e. starts with 2-9),
 * commonly grouped in 4s (e.g. "XXXX XXXX XXXX" or "XXXXXXXXXXXX").
 */
export function validateAadhaar(raw) {
  if (typeof raw !== "string") return false;
  const cleaned = raw.replace(/[\s\-]/g, "");
  if (!/^\d{12}$/.test(cleaned)) return false;
  const first = cleaned.charAt(0);
  if (first === "0" || first === "1") return false;
  return true;
}

/**
 * PAN: exactly 10 characters matching pattern [A-Z]{5}[0-9]{4}[A-Z]{1}
 */
export function validatePAN(raw) {
  if (typeof raw !== "string") return false;
  const cleaned = raw.trim().toUpperCase();
  if (cleaned.length !== 10) return false;
  return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(cleaned);
}

/**
 * GSTIN: 15 characters, first 2 digits are a valid state code (01-38),
 * characters 3-12 structurally match a PAN.
 */
export function validateGSTIN(raw) {
  if (typeof raw !== "string") return false;
  const cleaned = raw.trim().toUpperCase();
  if (cleaned.length !== 15) return false;
  const stateCodeStr = cleaned.slice(0, 2);
  if (!/^\d{2}$/.test(stateCodeStr)) return false;
  const stateCode = parseInt(stateCodeStr, 10);
  if (stateCode < 1 || stateCode > 38) return false;
  const panPart = cleaned.slice(2, 12);
  if (!validatePAN(panPart)) return false;
  const tail = cleaned.slice(12, 15);
  return /^[0-9A-Z]Z[0-9A-Z]$/.test(tail) || /^[0-9A-Z]{3}$/.test(tail);
}

/**
 * IFSC: 11 characters, pattern [A-Z]{4}0[A-Z0-9]{6} (5th character strictly '0')
 */
export function validateIFSC(raw) {
  if (typeof raw !== "string") return false;
  const cleaned = raw.trim().toUpperCase();
  if (cleaned.length !== 11) return false;
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(cleaned);
}

/**
 * INDIAN_MOBILE: 10 digits starting with 6, 7, 8, or 9, optionally prefixed +91, 91, or 0
 */
export function validateIndianMobile(raw) {
  if (typeof raw !== "string") return false;
  const cleaned = raw.trim().replace(/[\s\-\(\)]/g, "");
  return /^(?:\+91|91|0)?[6-9]\d{9}$/.test(cleaned);
}

// ── Luhn algorithm for cards ────────────────────────────────────────────────
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
    // Highest-priority source (DOM > OCR > vision)
    const priority = ["dom", "ocr_regex", "vision"];
    // Specific Indian types prioritized over generic fallback types
    const typePriority = [
      PII_TYPE.PASSWORD,
      PII_TYPE.CARD,
      PII_TYPE.AADHAAR,
      PII_TYPE.GSTIN,
      PII_TYPE.PAN,
      PII_TYPE.IFSC,
      PII_TYPE.INDIAN_MOBILE,
      PII_TYPE.EMAIL,
      PII_TYPE.PHONE,
      PII_TYPE.FACE,
      PII_TYPE.NAME,
      PII_TYPE.OTHER_PII,
    ];

    cluster.sort((a, b) => {
      const srcDiff = priority.indexOf(a.source) - priority.indexOf(b.source);
      if (srcDiff !== 0) return srcDiff;
      return typePriority.indexOf(a.type) - typePriority.indexOf(b.type);
    });

    const maxConf = Math.max(...cluster.map((r) => r.confidence));
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
function passDOM(domRegions) {
  return (domRegions ?? []).map((r) => ({
    bbox:       r.bbox,
    type:       r.type,
    confidence: r.confidence ?? 1.0,
    source:     "dom",
  }));
}

// ── Pass 2 — OCR-regex with Structural Validation ───────────────────────────
function passOCR(ocrDetections) {
  const hits = [];

  for (const det of ocrDetections ?? []) {
    if (det.type !== "text") continue;
    const text = det.label_or_text ?? "";
    const bbox = det.bbox;

    // 1. GSTIN (15 chars) — tested before PAN so PAN is not isolated from a GSTIN
    const gstinMatches = text.matchAll(/\b(0[1-9]|[12][0-9]|3[0-8])[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}\b/gi);
    for (const m of gstinMatches) {
      if (validateGSTIN(m[0])) {
        hits.push({
          bbox, source: "ocr_regex", matched: m[0].toUpperCase(),
          type:       PII_TYPE.GSTIN,
          confidence: 0.96,
        });
      }
    }

    // 2. PAN (10 chars)
    const panMatches = text.matchAll(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/gi);
    for (const m of panMatches) {
      const isPartOfGstin = hits.some(h => h.type === PII_TYPE.GSTIN && h.matched?.includes(m[0].toUpperCase()));
      if (!isPartOfGstin && validatePAN(m[0])) {
        hits.push({
          bbox, source: "ocr_regex", matched: m[0].toUpperCase(),
          type:       PII_TYPE.PAN,
          confidence: 0.94,
        });
      }
    }

    // 3. AADHAAR (12 digits, grouped or raw, first digit 2-9)
    const aadhaarMatches = text.matchAll(/\b[2-9]\d{3}[\s\-]?[0-9]{4}[\s\-]?[0-9]{4}\b/g);
    for (const m of aadhaarMatches) {
      if (validateAadhaar(m[0])) {
        const vValid = verhoeffCheck(m[0]);
        hits.push({
          bbox, source: "ocr_regex", matched: m[0].trim(),
          verhoeffValid: vValid,
          type:          PII_TYPE.AADHAAR,
          confidence:    vValid ? 0.96 : 0.91,
        });
      }
    }

    // 4. IFSC (11 chars, 5th digit '0')
    const ifscMatches = text.matchAll(/\b[A-Z]{4}0[A-Z0-9]{6}\b/gi);
    for (const m of ifscMatches) {
      if (validateIFSC(m[0])) {
        hits.push({
          bbox, source: "ocr_regex", matched: m[0].toUpperCase(),
          type:       PII_TYPE.IFSC,
          confidence: 0.94,
        });
      }
    }

    // 5. INDIAN_MOBILE
    const mobileMatches = text.matchAll(/(?:(?:\+91|0)[\s\-]?)?[6-9]\d{4}[\s\-]?\d{5}\b|(?:\+91[\s\-]?)?[6-9]\d{9}\b|\b[6-9]\d{9}\b/g);
    for (const m of mobileMatches) {
      if (validateIndianMobile(m[0])) {
        hits.push({
          bbox, source: "ocr_regex", matched: m[0].trim(),
          type:       PII_TYPE.INDIAN_MOBILE,
          confidence: 0.92,
        });
      }
    }

    // 6. EMAIL
    const emailMatches = text.matchAll(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g);
    for (const m of emailMatches) {
      hits.push({
        bbox, source: "ocr_regex", matched: m[0],
        type:       PII_TYPE.EMAIL,
        confidence: 0.95,
      });
    }

    // 7. Generic PHONE (if not already matched as INDIAN_MOBILE)
    const phoneMatches = text.matchAll(/(?:(?:\+91|0091|0)[\s\-]?)?[6-9]\d{9}|(?:\+\d{1,3}[\s\-]?)?\(?\d{2,4}\)?[\s\-]?\d{3,4}[\s\-]?\d{4}/g);
    for (const m of phoneMatches) {
      const digits = m[0].replace(/\D/g, "");
      if (digits.length >= 10) {
        const alreadyMobile = hits.some(h => h.type === PII_TYPE.INDIAN_MOBILE && h.matched?.includes(digits.slice(-10)));
        if (!alreadyMobile) {
          hits.push({
            bbox, source: "ocr_regex", matched: m[0].trim(),
            type:       PII_TYPE.PHONE,
            confidence: 0.82,
          });
        }
      }
    }

    // 8. CARD number with Luhn verification
    const cardMatches = text.matchAll(/\b(?:\d{4}[\s\-]?){3}\d{4}\b|\b\d{15,16}\b/g);
    for (const m of cardMatches) {
      const digits = m[0].replace(/\D/g, "");
      if (digits.length >= 15) {
        const valid = luhnCheck(digits);
        hits.push({
          bbox, source: "ocr_regex", matched: m[0], luhnValid: valid,
          type:       PII_TYPE.CARD,
          confidence: valid ? 0.93 : 0.72,
        });
      }
    }
  }

  return hits;
}

// ── Pass 3 — Face detections (from BlazeFace) ───────────────────────────────
function passFace(faceDetections) {
  return (faceDetections ?? [])
    .filter((f) => {
      const [x, y, w, h] = f.bbox || [];
      if (!w || !h || w < 24 || h < 24) return false;
      const aspect = w / h;
      if (aspect < 0.55 || aspect > 1.40) return false;
      return (f.confidence ?? 0) >= 0.85;
    })
    .map((f) => ({
      bbox:       f.bbox,
      type:       PII_TYPE.FACE,
      confidence: +Number(f.confidence).toFixed(4),
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
  console.log("[PII] === detectSensitiveRegions INVOKED ===");
  console.log(`[PII] Raw Inputs -> domRegions: ${(domRegions ?? []).length}, ocrDetections: ${(ocrDetections ?? []).length}, faceDetections: ${(faceDetections ?? []).length}`);

  const domHits  = passDOM(domRegions);
  const ocrHits  = passOCR(ocrDetections);
  const faceHits = passFace(faceDetections);

  console.log(`[PII] [Source 1: DOM Pass] Raw output (${domHits.length} items):`, domHits);
  console.log(`[PII] [Source 2: OCR Pass] Raw output (${ocrHits.length} items):`, ocrHits);
  console.log(`[PII] [Source 3: Vision/Face Pass] Raw output (${faceHits.length} items):`, faceHits);

  const all = [...domHits, ...ocrHits, ...faceHits];
  console.log(`[PII] Combined unmerged candidates (${all.length} total from DOM + OCR + Vision):`, all);

  const result = mergeRegions(all);

  console.log(
    `[PII] Final merged sensitive region(s): ${result.length}` +
    ` (dom:${domHits.length}, ocr:${ocrHits.length}, face:${faceHits.length})\n` +
    JSON.stringify(result, null, 2)
  );

  return result;
}

