#!/usr/bin/env python3
"""
Runs the user journeys (journeys/test_*.py) against a served journey build.

    python3 journeys/run.py --url http://127.0.0.1:4173/ [name ...]

Each journey gets a fresh webview. One line per journey; a failure prints the
journeys/ line that failed and saves a screenshot under journeys/shots/.
Exit status is non-zero if any journey failed.
"""
import argparse
import importlib.util
import sys
import time
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))

import harness  # noqa: E402


def load_journeys():
    for path in sorted(HERE.glob('test_*.py')):
        spec = importlib.util.spec_from_file_location(path.stem, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    return harness.JOURNEYS


def failing_line(exc):
    """The journey-file line (and its source) the failure came from."""
    for frame in reversed(traceback.extract_tb(exc.__traceback__)):
        if Path(frame.filename).name.startswith('test_'):
            return f'{Path(frame.filename).name}:{frame.lineno}: {frame.line}'
    return 'unknown step'


def is_the_known_failure(entry, exc, where):
    """A known-bug journey fails the way it is known to: an expectation that does not hold,
    at the step it names. A script error, a missing element, a page error or a timeout
    anywhere else is a different failure and counts as one."""
    return isinstance(exc, harness.ExpectationFailed) and entry['fails_at'] in where


def run_one(entry, base_url, shots):
    page = harness.Page(base_url, entry['query'], entry.get('settings'), entry.get('notifications', False), entry.get('microphone'))
    failure = None
    try:
        page.open()
        entry['fn'](page)
        errors = page.page_errors()
        if errors:
            raise harness.JourneyFailure(f'the page reported errors: {errors[:3]}')
    except Exception as exc:  # noqa: BLE001 - every failure is a failed journey
        failure = (failing_line(exc), str(exc) or exc.__class__.__name__, exc)
        shots.mkdir(parents=True, exist_ok=True)
        shot = shots / f'{entry["name"]}.png'
        failure += (shot if page.shot(shot) else None,)
    finally:
        page.close()
    return failure


def run_fuzz(args):
    """`--fuzz`: seeded random walks, one fresh webview per seed. Every seed runs, even after one fails;
    each failure is printed with its replay command. Returns 1 if any seed failed."""
    import fuzz

    seeds = list(args.seed or [])
    if args.seeds:
        try:
            low, high = (int(part) for part in args.seeds.split('-'))
        except ValueError:
            low = high = None
        if low is None or low > high:
            print(f'--seeds expects a range A-B with A <= B (for example 8-12), got {args.seeds!r}')
            return 2
        seeds += range(low, high + 1)
    if not seeds:
        seeds = [1]
    shots = HERE / 'shots'
    failed = 0
    for seed in seeds:
        t0 = time.monotonic()
        skipped = []
        try:
            mode = fuzz.mode_for(args.mode, seed)
        except ValueError as e:
            print(e)
            return 2
        entry = {
            'name': f'fuzz_seed_{seed}',
            'query': 'journeyCatchUp=held',
            'settings': fuzz.MODES[mode],
            'fn': lambda page, s=seed, m=mode: skipped.append(fuzz.fuzz(page, s, args.steps, m)),
        }
        failure = run_one(entry, args.url, shots)
        took = time.monotonic() - t0
        if failure is None:
            print(f'PASS  fuzz seed {seed}, {args.steps} steps, mode {mode}  ({took:.1f}s)', flush=True)
            if skipped:
                done = skipped[0]
                print(f'      skipped actions: {sum(done["skips"].values())}', flush=True)
                print('      ran: ' + ', '.join(f'{k} {v}' for k, v in sorted(done['walked'].items())), flush=True)
            continue
        failed += 1
        _where, why, _exc, shot = failure
        print(f'FAIL  fuzz seed {seed}, {args.steps} steps, mode {mode}  ({took:.1f}s)', flush=True)
        print(f'      {why}')
        if shot:
            print(f'      screenshot: {shot}')
    print(f'{len(seeds) - failed} of {len(seeds)} seeds passed', flush=True)
    return 1 if failed else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', required=True)
    ap.add_argument('names', nargs='*')
    ap.add_argument('--fuzz', action='store_true', help='run the random walk (journeys/fuzz.py) instead of the journeys')
    ap.add_argument('--seed', type=int, action='append', help='fuzz: a seed (repeat for several)')
    ap.add_argument('--seeds', help='fuzz: a range of seeds, A-B (inclusive)')
    ap.add_argument('--mode', default='standard', help='fuzz: standard, vim, tui, compact, theme, or seed (one of them by the seed)')
    ap.add_argument('--steps', type=int, default=300, help='fuzz: steps per seed (default 300)')
    args = ap.parse_args()

    harness.require_display()
    if args.fuzz:
        if args.names:
            print(f'--fuzz runs random walks, not journeys; journey names were given: {", ".join(args.names)}')
            return 2
        return run_fuzz(args)
    journeys = load_journeys()
    known = {j['name'] for j in journeys}
    unknown = [n for n in args.names if n not in known]
    if unknown:
        print(f'unknown journey(s): {", ".join(unknown)}; known: {", ".join(sorted(known))}')
        return 2
    selected = [j for j in journeys if not args.names or j['name'] in args.names]

    shots = HERE / 'shots'
    failed = 0
    still_known = 0
    started = time.monotonic()
    for entry in selected:
        t0 = time.monotonic()
        failure = run_one(entry, args.url, shots)
        took = time.monotonic() - t0
        known = entry['known_bug']
        if failure is not None:
            where, why, exc, shot = failure
        if failure is None and known is None:
            print(f'PASS  {entry["name"]}  ({took:.1f}s)', flush=True)
        elif failure is None:
            failed += 1
            print(f'FAIL  {entry["name"]}  ({took:.1f}s)', flush=True)
            print(f'      it passes now: remove its known_bug marker ({known})')
        elif known is not None and is_the_known_failure(entry, exc, where):
            still_known += 1
            print(f'KNOWN {entry["name"]}  ({took:.1f}s)  {known}', flush=True)
            print(f'      still failing at {where}')
        else:
            failed += 1
            print(f'FAIL  {entry["name"]}  ({took:.1f}s)', flush=True)
            if known is not None:
                print(f'      a known bug ({known}), but not failing the way it is known to:')
                print(f'      expected an expectation failing at a line with {entry["fails_at"]!r}')
            print(f'      at {where}')
            print(f'      {why}')
            if shot:
                print(f'      screenshot: {shot}')
    total = time.monotonic() - started
    passed = len(selected) - failed - still_known
    print(f'{passed} passed, {failed} failed, {still_known} known bugs in {total:.1f}s', flush=True)
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
