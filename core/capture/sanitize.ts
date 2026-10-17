import type { CaptureEvent } from "./events.js";

const SECRET_PATTERNS: RegExp[] = [
  // Anthropic API keys
  /\bsk-ant-api\d{2}-[a-zA-Z0-9_-]{20,}\b/g,
  // OpenAI / similar sk- keys
  /\bsk-[a-zA-Z0-9_-]{16,}\b/g,
  // Google / Gemini API keys
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  // GitHub tokens (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_)
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  // AWS Access Key ID
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Slack tokens
  /\bxox[baprs]-[0-9a-zA-Z-]{10,}\b/g,
  // Bearer tokens in headers
  /(Bearer\s+)(?:[A-Za-z0-9\-_=]+\.[A-Za-z0-9\-_=]+\.?[A-Za-z0-9\-_.+/=]*|[A-Za-z0-9._~+/=-]{16,})/gi,
  // Common ENV assignments of secrets/passwords/tokens
  /((?:[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|AUTH|PRIVATE_KEY|CLIENT_SECRET)[A-Za-z0-9_]*)\s*[=:]\s*)(?!\[REDACTED)(?:'[^']*'|"[^"]*"|[^\s'"]+)/gi,
];

/**
 * Redacts <private>...</private> blocks and common API keys/tokens from text.
 */
export function sanitizeText(input: string): string {
  if (!input || typeof input !== "string") return input;
  let out = input.replace(/<private>[\s\S]*?<\/private>/gi, "[REDACTED_PRIVATE]");
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (_match, prefix) =>
      typeof prefix === "string" ? `${prefix}[REDACTED_SECRET]` : "[REDACTED_SECRET]"
    );
  }
  return out;
}

/**
 * Returns a cloned event with all free-text fields scrubbed of secrets.
 * Ensures the original event object and its array fields are not mutated.
 */
export function sanitizeEvent<T extends CaptureEvent>(event: T): T {
  if (!event || typeof event !== "object") return event;
  const clone: any = { ...event };
  if (typeof clone.command === "string") clone.command = sanitizeText(clone.command);
  if (Array.isArray(clone.args)) {
    clone.args = clone.args.map((a: any) => (typeof a === "string" ? sanitizeText(a) : a));
  }
  if (typeof clone.stdout === "string") clone.stdout = sanitizeText(clone.stdout);
  if (typeof clone.stderr === "string") clone.stderr = sanitizeText(clone.stderr);
  if (typeof clone.diff === "string") clone.diff = sanitizeText(clone.diff);
  if (typeof clone.staged_diff === "string") clone.staged_diff = sanitizeText(clone.staged_diff);
  if (typeof clone.output_summary === "string") clone.output_summary = sanitizeText(clone.output_summary);
  if (typeof clone.error_message === "string") clone.error_message = sanitizeText(clone.error_message);
  if (typeof clone.prompt === "string") clone.prompt = sanitizeText(clone.prompt);
  if (Array.isArray(clone.recent_commits)) {
    clone.recent_commits = clone.recent_commits.map((c: any) =>
      c && typeof c === "object" && typeof c.subject === "string"
        ? { ...c, subject: sanitizeText(c.subject) }
        : c
    );
  }
  return clone as T;
}
