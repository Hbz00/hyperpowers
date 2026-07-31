/**
 * The shape of a dispatch tree, from metas already in hand.
 *
 * This is the one pure graph walk in the codebase, and it is separate from `transcript.mjs` on
 * purpose: every export there takes a `transcriptPath` and does its own I/O, whereas the caller
 * that needs this one — `statusline.mjs`, on a 5 s tick — must take **liveness from the payload**
 * and only *parentage* from disk. The harness's task map is ground truth about what is running;
 * `subagents/` accumulates a meta file for every agent ever dispatched and never prunes them, so a
 * directory walk would report a finished run's agents as busy. `childAgents()` in `transcript.mjs`
 * stays what it is (one level, from disk, for the hook that has no payload to consult).
 *
 * Splitting it this way also makes it the only unit here testable without a filesystem.
 */

/**
 * Every descendant of `rootId`, breadth-first, with its depth **relative to the root**.
 *
 * Relative rather than absolute (`meta.spawnDepth`) because the walk already knows it and cannot be
 * wrong about it: a root that is not at depth 1 — §S13's impostor director was at 3 — still gets a
 * correctly-levelled tree. `spawnDepth` remains the right field for asking *"is this agent allowed
 * to be the director"*, which is a different question and lives in `config.mjs`.
 *
 * `seen` is not decoration. `metaById` is parsed from files this process does not write, and a
 * `parentAgentId` cycle — two metas naming each other, a truncated write, a reused id — would spin
 * a 5 s-budgeted renderer forever. The set makes termination structural rather than assumed.
 *
 * @param {Map<string, object|null>} metaById live agent id → its meta (null where unreadable)
 * @param {string} rootId
 * @returns {Array<{agentId: string, meta: object, depth: number}>} depth 1 = a direct child
 */
export function descendantsOf(metaById, rootId) {
  if (!(metaById instanceof Map) || !rootId) return [];

  const byParent = new Map();
  for (const [agentId, meta] of metaById) {
    const parent = meta?.parentAgentId;
    if (!parent) continue;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push({ agentId, meta });
  }

  const out = [];
  const seen = new Set([rootId]);
  let frontier = [rootId];
  let depth = 0;
  while (frontier.length) {
    depth += 1;
    const next = [];
    for (const parent of frontier) {
      for (const child of byParent.get(parent) ?? []) {
        if (seen.has(child.agentId)) continue;
        seen.add(child.agentId);
        out.push({ ...child, depth });
        next.push(child.agentId);
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * Group descendants into one bucket per relative depth, ordered from the root outwards.
 *
 * The roster renders *by level* and not by parent, and that is a truth claim rather than a
 * simplification: attributing a grandchild to one of two live coordinators would require a path the
 * walk deliberately does not carry, and guessing it would put a confident wrong parentage on screen.
 * "These are running one level below you, these two levels below" is exactly what the metas prove.
 */
export function byDepth(descendants) {
  const levels = new Map();
  for (const entry of descendants) {
    if (!levels.has(entry.depth)) levels.set(entry.depth, []);
    levels.get(entry.depth).push(entry);
  }
  return [...levels.entries()].sort((a, b) => a[0] - b[0]).map(([depth, entries]) => ({ depth, entries }));
}

/**
 * `['2×implementer', 'test']` — identical kinds folded into a count, in a stable order.
 *
 * Sorted, because the panel redraws every 5 s and `Object.values()` over the payload's task map
 * carries no ordering guarantee: an unsorted roster would reshuffle itself between ticks and read as
 * activity that is not happening.
 */
export function foldKinds(kinds) {
  const counts = new Map();
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([kind, n]) => (n > 1 ? `${n}×${kind}` : kind));
}
