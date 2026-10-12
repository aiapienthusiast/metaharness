// Disjoint instance-seed ranges, so that choosing what to train on can never see the instances it is later judged on.
//
// Every arena-environment task instance is a pure function of (family, difficulty, seed), so disjoint seed ranges give
// disjoint instances. Three roles:
//   heldout  [900_000, 910_000)    the powered test set; no training or cell selection may ever use these seeds
//   select   [910_000, 920_000)    learnability / difficulty-band measurements used to CHOOSE training cells
//   confirm  [920_000, 930_000)    untouched confirmation set: used only to judge pre-registered replication runs, never to pick anything
//   train    [2_000_000, 3_000_000) instances a training run may sample
// A cell-level choice made on `select` is then evaluated on `heldout`: the two never share an instance.
//
// A second, stricter test holds out whole families (cross-family transfer, which is what the arena's private tasks demand).
export const SPLITS = Object.freeze({
  heldout: [900_000, 910_000],
  select: [910_000, 920_000],
  confirm: [920_000, 930_000],
  train: [2_000_000, 3_000_000],
});

/** 'heldout' | 'select' | 'confirm' | 'train' | null for a seed. */
export function seedSplit(seed) {
  if (!Number.isInteger(seed)) return null;
  for (const [name, [lo, hi]] of Object.entries(SPLITS)) if (seed >= lo && seed < hi) return name;
  return null;
}

/** Throw unless every seed belongs to `split`. */
export function assertSeedsIn(split, seeds) {
  if (!(split in SPLITS)) throw new Error(`unknown split ${split}`);
  for (const s of seeds) {
    if (seedSplit(s) !== split) throw new Error(`seed ${s} is not in the ${split} range [${SPLITS[split][0]}, ${SPLITS[split][1]})`);
  }
}

/** The instance seeds a benchmark config will use (each call covers seedStep consecutive seeds). */
export function configSeeds(c) {
  const seeds = [];
  for (let b = 0; b < c.blocks; b += 1) for (let k = 0; k < c.seedStep; k += 1) seeds.push(c.seedBase + c.seedStep * b + k);
  return seeds;
}

/** Hold out whole families: returns {train, heldout}. Throws on an unknown or empty split. */
export function splitFamilies(families, heldOut) {
  const unknown = heldOut.filter((f) => !families.includes(f));
  if (unknown.length) throw new Error(`unknown held-out families: ${unknown.join(', ')}`);
  const train = families.filter((f) => !heldOut.includes(f));
  if (!train.length || !heldOut.length) throw new Error('family split needs at least one train and one held-out family');
  return { train, heldout: [...heldOut] };
}
