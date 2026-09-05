/**
 * AgentRequestV1 — Versioned Payload Schema
 * Shared between /extension and /server.
 *
 * payload: {
 *   version: "1.0",
 *   task_instruction: string,       // e.g. "fill out this signup form"
 *   redacted_image: string,         // base64 PNG
 *   manifest: [
 *     { region_id: string, bbox: [x,y,w,h], type: string, redaction_style: string, confidence: number }
 *   ],
 *   dom_summary: [                  // lightweight, non-sensitive DOM hints only
 *     { element_id: string, tag: string, role: string, bbox: [x,y,w,h] }
 *   ]
 * }
 *
 * NOTE: The `manifest` array is how the server knows to treat masked regions as 
 * opaque-by-design rather than guessing. It tells the backend VLM exactly where PII 
 * was masked and what type of data it was, so the VLM treats those blocks as intentional 
 * masks rather than missing UI elements.
 */

function validateAgentRequestV1(payload) {
  if (!payload || typeof payload !== "object") throw new Error("Payload must be an object");
  if (payload.version !== "1.0") throw new Error("Invalid or missing version, expected '1.0'");
  if (typeof payload.task_instruction !== "string") throw new Error("task_instruction must be a string");
  if (typeof payload.redacted_image !== "string") throw new Error("redacted_image must be a string");

  if (!Array.isArray(payload.manifest)) throw new Error("manifest must be an array");
  for (const m of payload.manifest) {
    if (typeof m.region_id !== "string") throw new Error("manifest[].region_id must be a string");
    if (!Array.isArray(m.bbox) || m.bbox.length !== 4) throw new Error("manifest[].bbox must be an array of 4 numbers");
    if (typeof m.type !== "string") throw new Error("manifest[].type must be a string");
    if (typeof m.redaction_style !== "string") throw new Error("manifest[].redaction_style must be a string");
    if (typeof m.confidence !== "number") throw new Error("manifest[].confidence must be a number");
  }

  if (!Array.isArray(payload.dom_summary)) throw new Error("dom_summary must be an array");
  for (const d of payload.dom_summary) {
    if (typeof d.element_id !== "string") throw new Error("dom_summary[].element_id must be a string");
    if (typeof d.tag !== "string") throw new Error("dom_summary[].tag must be a string");
    if (typeof d.role !== "string") throw new Error("dom_summary[].role must be a string");
    if (!Array.isArray(d.bbox) || d.bbox.length !== 4) throw new Error("dom_summary[].bbox must be an array of 4 numbers");
  }

  return true;
}

module.exports = { validateAgentRequestV1 };
