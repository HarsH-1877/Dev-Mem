/**
 * Knowledge lifecycle state machine (spec §5.3).
 *
 * Product V1 (§13) uses a simplified flow: observed → active → stale.
 * The store still models the full chain so verify/supersede work is not a
 * schema migration later.
 */
export const LIFECYCLE_STATES = [
  "observed",
  "verified",
  "active",
  "superseded",
  "stale",
] as const;

export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export const ALLOWED_TRANSITIONS: Record<LifecycleState, readonly LifecycleState[]> =
  {
    observed: ["verified", "active", "superseded", "stale"],
    verified: ["active", "superseded", "stale"],
    active: ["superseded", "stale"],
    superseded: [],
    stale: ["verified", "active", "superseded"],
  };

export function isLifecycleState(value: string): value is LifecycleState {
  return (LIFECYCLE_STATES as readonly string[]).includes(value);
}

export function canTransition(
  from: LifecycleState,
  to: LifecycleState,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertTransition(
  from: LifecycleState,
  to: LifecycleState,
): void {
  if (from === to) {
    return;
  }
  if (!canTransition(from, to)) {
    throw new Error(`Invalid lifecycle transition: ${from} → ${to}`);
  }
}
