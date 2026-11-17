"""
Short fixed-seed random walks (journeys/fuzz.py), so the gate is deterministic. Longer or other
walks: `npm run journeys -- --fuzz --seed N --steps M` (or `--seeds A-B`).
"""
import fuzz
from harness import journey

STEPS = 12


def walk(seed):
    def run(page):
        fuzz.fuzz(page, seed, STEPS)

    run.__name__ = f'fuzz_seed_{seed}'
    run.__doc__ = f'A random walk of {STEPS} user actions and live events (seed {seed}) that keeps every invariant.'
    return journey(query='journeyCatchUp=held')(run)


for _seed in (1, 2, 3):
    walk(_seed)
