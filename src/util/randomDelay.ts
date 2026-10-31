// Minimum delay between two reloads, same floor the popup enforces.
export const MIN_RANDOM_DELAY = 5000;

export type RandomizeOptions = {
  randomizeInterval: boolean;
  randomizeSpread: number;
};

export const randomizeSpreadOptions = [0.1, 0.15, 0.25, 0.5];

/**
 * Returns the delay (ms) until the next reload.
 * When randomizing: base * (1 + uniform(-spread, +spread)), never below
 * MIN_RANDOM_DELAY. When not randomizing: the base delay, untouched.
 */
export const computeDelay = (
  base: number,
  options: RandomizeOptions,
  rng: () => number = Math.random
): number => {
  if (!options.randomizeInterval) {
    return base;
  }

  const factor = 1 + (rng() * 2 - 1) * options.randomizeSpread;

  return Math.max(MIN_RANDOM_DELAY, Math.round(base * factor));
};
