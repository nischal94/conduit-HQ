/**
 * Per-namespace serialization for source provisioning (Codex ARC F2).
 *
 * `source.provision` and `source.revalidate` run OUTSIDE the execution
 * queue — the queue admits sandbox work, and these are bounded onboarding
 * fetches, not guest code. The connection dispatcher fires each frame's
 * handler without awaiting the previous one (`connection.ts`), and the store
 * is shared across every connection, so two source requests naming the SAME
 * namespace can run concurrently. That is an anti-oracle race:
 *
 *   1. a slow `revalidate` reads the stored row (url A, credential ref N)
 *      and reveals credential N, then stalls on its upstream fetch;
 *   2. a concurrent `provision --replace` retargets the namespace N→B,
 *      committing (destination B, fresh secret S_B);
 *   3. the stale `revalidate` completes and commits (destination A) — pairing
 *      the row's now-current credential material with the OLD destination.
 *
 * The §3.3.1 anti-oracle property (a stored credential is only ever sent to
 * the destination it is bound to) holds only if the whole
 * read→reveal→fetch→commit sequence for one namespace is atomic against
 * other sequences for that same namespace. There is no schema-level CAS
 * available (and adding one would be a schema change, which is off the
 * table), so the serialization lives here, in the one process that owns the
 * database.
 *
 * The lock is a chain of promises keyed by namespace: each `run` for a
 * namespace awaits the previous run for that namespace before starting, and
 * the map entry is deleted once the chain for a key drains, so an
 * unbounded set of one-shot namespaces cannot leak entries. Different
 * namespaces never contend — the race is strictly intra-namespace, so
 * serializing across namespaces would be a needless throughput cost.
 *
 * Zero new dependencies: this is a `Map<string, Promise>` chain, nothing
 * more.
 */
export interface SourceLock {
  /**
   * Runs `fn` while holding the lock for `key`, releasing it (and freeing
   * the map entry when no waiter remains) whether `fn` resolves or rejects.
   */
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export function createSourceLock(): SourceLock {
  // The tail of each namespace's chain. A key is present iff a run for it is
  // in flight or queued; it is removed once its chain fully drains.
  const tails = new Map<string, Promise<unknown>>();

  return {
    async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      // The predecessor for this key, if any. We wait on it but SWALLOW its
      // outcome: this run must proceed after the previous one FINISHES,
      // regardless of whether it succeeded — a predecessor's rejection is
      // its own caller's concern, never a reason to fail or skip this run.
      const predecessor = tails.get(key);

      // A deferred that resolves when THIS run completes; it becomes the new
      // tail so the next run for the key waits on it.
      let release!: () => void;
      const mine = new Promise<void>((resolve) => {
        release = resolve;
      });
      tails.set(key, mine);

      if (predecessor !== undefined) {
        try {
          await predecessor;
        } catch {
          // Predecessor's failure is not ours; we only needed it to finish.
        }
      }

      try {
        return await fn();
      } finally {
        release();
        // Free the entry ONLY if no later run has since replaced the tail —
        // otherwise we would drop a live chain and let a queued run start
        // early. Reference identity is the check: if `mine` is still the
        // tail, this was the last run for the key.
        if (tails.get(key) === mine) {
          tails.delete(key);
        }
      }
    },
  };
}
