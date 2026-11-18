"""
Short fixed-seed random walks (journeys/fuzz.py), so the gate is deterministic. Longer or other
walks: `npm run journeys -- --fuzz --seed N --steps M` (or `--seeds A-B`, and `--mode NAME`).
"""
import fuzz
from harness import journey

STEPS = 12


def walk(seed, mode='standard'):
    def run(page):
        fuzz.fuzz(page, seed, STEPS, mode)

    run.__name__ = f'fuzz_seed_{seed}' if mode == 'standard' else f'fuzz_{mode}_seed_{seed}'
    run.__doc__ = f'A random walk of {STEPS} user actions and live events (seed {seed}, mode {mode}) that keeps every invariant.'
    return journey(query='journeyCatchUp=held', settings=fuzz.MODES[mode])(run)


for _seed in (1, 2, 3):
    walk(_seed)
for _seed, _mode in ((4, 'vim'), (5, 'tui'), (6, 'compact'), (7, 'theme')):
    walk(_seed, _mode)
