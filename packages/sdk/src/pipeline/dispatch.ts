/**
 * §5.5: a host-side, monotonic per-call cell recording how far the governed
 * call got. `initializing` = session/handshake traffic started (never
 * counts as dispatch). `dispatched` = the write that submits the governed
 * `tools/call` body is about to be attempted — BEFORE the write, because a
 * failure inside it may have transmitted part or all of the body (§7).
 * Nothing ever lowers the cell. Read at settle time by the invoker and by
 * the manager's direct arm; never an error field, so it survives every
 * wrapping and replacement error.
 */
export type DispatchState = "none" | "initializing" | "dispatched";

export interface DispatchCell {
  readonly state: DispatchState;
  advance(to: DispatchState): void;
}

const ORDER: Record<DispatchState, number> = { none: 0, initializing: 1, dispatched: 2 };

export function createDispatchCell(): DispatchCell {
  let state: DispatchState = "none";
  return {
    get state() {
      return state;
    },
    advance(to) {
      if (ORDER[to] > ORDER[state]) state = to;
    },
  };
}
