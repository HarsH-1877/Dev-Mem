/** Small, provider-neutral guards for hook boundaries. Hooks must never make a
 * malformed host payload or unavailable local state fatal to the host agent. */
export interface SafeHookPayload {
  session_id: string;
  cwd?: string;
  hook_event_name: string;
  [key: string]: unknown;
}

export function parseHookPayload(
  input: string,
  expectedEvents: readonly string[],
  adapter: string,
): SafeHookPayload | null {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch (error) {
    console.error(`[dev-mem/${adapter}] Ignoring malformed hook JSON: ${(error as Error).message}`);
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    console.error(`[dev-mem/${adapter}] Ignoring hook payload: expected an object`);
    return null;
  }
  const payload = value as Record<string, unknown>;
  if (typeof payload.session_id !== "string" || payload.session_id.trim() === "") {
    console.error(`[dev-mem/${adapter}] Ignoring hook payload: missing string session_id`);
    return null;
  }
  if (typeof payload.hook_event_name !== "string" || !expectedEvents.includes(payload.hook_event_name)) {
    console.error(`[dev-mem/${adapter}] Ignoring hook payload: unsupported hook_event_name`);
    return null;
  }
  if (payload.cwd !== undefined && (typeof payload.cwd !== "string" || payload.cwd.trim() === "")) {
    console.error(`[dev-mem/${adapter}] Ignoring hook payload: cwd must be a non-empty string`);
    return null;
  }
  return payload as SafeHookPayload;
}

export function recordFor(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function stringFor(value: unknown, fallback = "unknown"): string {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

export function numberFor(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
