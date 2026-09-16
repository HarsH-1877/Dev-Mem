import type { Evidence } from "./types.js";

const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function validateEvidence(evidence: Evidence): void {
  if (typeof evidence.commit !== "string" || evidence.commit.trim() === "") {
    throw new Error("evidence.commit is required");
  }
  if (!Array.isArray(evidence.files) || evidence.files.length < 1) {
    throw new Error("evidence.files is required and must contain at least one path");
  }
  if (evidence.files.some((f) => typeof f !== "string" || f.trim() === "")) {
    throw new Error("evidence.files must be non-empty strings");
  }
  if (evidence.diff_ref !== undefined && typeof evidence.diff_ref !== "string") {
    throw new Error("evidence.diff_ref must be a string when present");
  }
  if (evidence.test_ref !== undefined && typeof evidence.test_ref !== "string") {
    throw new Error("evidence.test_ref must be a string when present");
  }
  if (evidence.symbols !== undefined) {
    if (
      !Array.isArray(evidence.symbols) ||
      evidence.symbols.some((s) => typeof s !== "string")
    ) {
      throw new Error("evidence.symbols must be an array of strings when present");
    }
  }
  if (typeof evidence.session_id !== "string" || evidence.session_id.trim() === "") {
    throw new Error("evidence.session_id is required");
  }
  if (typeof evidence.agent !== "string" || evidence.agent.trim() === "") {
    throw new Error("evidence.agent is required");
  }
  if (typeof evidence.timestamp !== "string" || !ISO_8601.test(evidence.timestamp)) {
    throw new Error("evidence.timestamp must be ISO-8601");
  }
  if (
    typeof evidence.confidence !== "number" ||
    Number.isNaN(evidence.confidence) ||
    evidence.confidence < 0 ||
    evidence.confidence > 1
  ) {
    throw new Error("evidence.confidence must be a number in [0.0, 1.0]");
  }
}

/** Persist only the §5.4 fields, dropping extras. */
export function normalizeEvidence(evidence: Evidence): Evidence {
  validateEvidence(evidence);
  const normalized: Evidence = {
    commit: evidence.commit,
    files: [...evidence.files],
    session_id: evidence.session_id,
    agent: evidence.agent,
    timestamp: evidence.timestamp,
    confidence: evidence.confidence,
  };
  if (evidence.diff_ref !== undefined) {
    normalized.diff_ref = evidence.diff_ref;
  }
  if (evidence.test_ref !== undefined) {
    normalized.test_ref = evidence.test_ref;
  }
  if (evidence.symbols !== undefined) {
    normalized.symbols = [...evidence.symbols];
  }
  return normalized;
}
