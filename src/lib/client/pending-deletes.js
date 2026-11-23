/**
 * Optimistic deletes waiting on an Undo toast (UX-SPEC 6.2). The id is hidden
 * from lists immediately; the DELETE request fires when the toast expires.
 */
const pending = new Set();
const listeners = new Set();
const EMPTY = [];
let snapshot = EMPTY;

function emit() {
  snapshot = Array.from(pending);
  for (const l of listeners) l();
}

/** @param {string} id */
export function markPendingDelete(id) {
  pending.add(id);
  emit();
}

/** @param {string} id */
export function clearPendingDelete(id) {
  pending.delete(id);
  emit();
}

/** @param {() => void} cb */
export function subscribePendingDeletes(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** @returns {string[]} stable snapshot for useSyncExternalStore */
export function getPendingDeletes() {
  return snapshot;
}

export function getServerPendingDeletes() {
  return EMPTY;
}
