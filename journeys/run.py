#!/usr/bin/env python3
"""
Runs the user journeys (journeys/test_*.py) against a served journey build.

    python3 journeys/run.py --url http://127.0.0.1:4173/ [name ...]

Each journey gets a fresh webview. One line per journey; a failure prints the
journeys/ line that failed and saves a screenshot under journeys/shots/.
`--jobs N` (default 4) runs N journeys at once, each worker its own WebKit.
Exit status is non-zero if any journey failed.
"""
import argparse
import importlib.util
import json
import os
import selectors
import subprocess
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


def timed(entry, base_url, shots):
    t0 = time.monotonic()
    failure = run_one(entry, base_url, shots)
    return failure, time.monotonic() - t0


def outcome(entry, failure, took):
    """(name, 'pass' | 'fail' | 'known', seconds, the lines to print) for one journey run."""
    name, known = entry['name'], entry['known_bug']
    if failure is None and known is None:
        return name, 'pass', took, [f'PASS  {name}  ({took:.1f}s)']
    if failure is None:
        return name, 'fail', took, [f'FAIL  {name}  ({took:.1f}s)', f'      it passes now: remove its known_bug marker ({known})']
    where, why, exc, shot = failure
    if known is not None and is_the_known_failure(entry, exc, where):
        return name, 'known', took, [f'KNOWN {name}  ({took:.1f}s)  {known}', f'      still failing at {where}']
    lines = [f'FAIL  {name}  ({took:.1f}s)']
    if known is not None:
        lines += [f'      a known bug ({known}), but not failing the way it is known to:',
                  f'      expected an expectation failing at a line with {entry["fails_at"]!r}']
    lines += [f'      at {where}', f'      {why}']
    if shot:
        lines.append(f'      screenshot: {shot}')
    return name, 'fail', took, lines


# ---------------------------------------------------------------- parallel runs

TIMINGS = HERE / 'shots' / 'timings.json'
RESULT = '@@journey-result '


def remember_timings(took_by_name):
    """Keeps how long each journey took, so the next parallel run starts the slow ones first."""
    try:
        known = json.loads(TIMINGS.read_text()) if TIMINGS.exists() else {}
        known.update({name: round(took, 1) for name, took in took_by_name.items()})
        TIMINGS.parent.mkdir(parents=True, exist_ok=True)
        TIMINGS.write_text(json.dumps(known, indent=1, sort_keys=True))
    except (OSError, ValueError):
        pass


def slowest_first(selected):
    try:
        known = json.loads(TIMINGS.read_text())
    except (OSError, ValueError):
        known = {}
    return sorted(selected, key=lambda entry: -known.get(entry['name'], 5.0))


def run_parallel(selected, base_url, jobs):
    """`jobs` worker processes (each its own WebKit, pages ephemeral as always) take journeys from one
    queue, slowest first; results are yielded as they finish."""
    queue = [entry['name'] for entry in slowest_first(selected)]
    workers = []
    for _ in range(jobs):
        proc = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), '--url', base_url, '--worker'],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
        )
        workers.append(proc)
    busy = {}
    selector = selectors.DefaultSelector()

    def hand_out(proc):
        if queue:
            busy[proc] = queue.pop(0)
            proc.stdin.write(busy[proc] + '\n')
            proc.stdin.flush()
        else:
            busy.pop(proc, None)
            proc.stdin.close()
            selector.unregister(proc.stdout)

    for proc in workers:
        selector.register(proc.stdout, selectors.EVENT_READ, proc)
        hand_out(proc)
    pending = {proc: b'' for proc in workers}
    try:
        while busy:
            for key, _ in selector.select():
                proc = key.data
                chunk = os.read(proc.stdout.fileno(), 65536)
                if not chunk:
                    name = busy.pop(proc, None)
                    selector.unregister(proc.stdout)
                    if name:
                        yield name, 'fail', 0.0, [f'FAIL  {name}', '      the worker running it exited']
                    continue
                *lines, pending[proc] = (pending[proc] + chunk).split(b'\n')
                for raw in lines:
                    line = raw.decode()
                    if line.startswith(RESULT):
                        yield tuple(json.loads(line[len(RESULT):]))
                        hand_out(proc)
                    else:
                        print(line, flush=True)
    finally:
        for proc in workers:
            if proc.stdin and not proc.stdin.closed:
                proc.stdin.close()
            proc.wait()


def worker(base_url):
    """`--worker`: runs the journeys named on stdin, one per line, and reports each on stdout."""
    by_name = {entry['name']: entry for entry in load_journeys()}
    shots = HERE / 'shots'
    for line in sys.stdin:
        entry = by_name[line.strip()]
        result = outcome(entry, *timed(entry, base_url, shots))
        print(RESULT + json.dumps(result), flush=True)
    return 0



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
    ap.add_argument('--jobs', type=int, default=int(os.environ.get('JOURNEY_JOBS', '4')),
                    help='journeys run at once, each in its own WebKit (default 4, or $JOURNEY_JOBS; 1 runs them in turn)')
    ap.add_argument('--worker', action='store_true', help=argparse.SUPPRESS)
    args = ap.parse_args()

    harness.require_display()
    if args.worker:
        return worker(args.url)
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
    started = time.monotonic()
    jobs = max(1, min(args.jobs, len(selected)))
    if jobs > 1:
        results = run_parallel(selected, args.url, jobs)
    else:
        results = (outcome(entry, *timed(entry, args.url, shots)) for entry in selected)
    failed = still_known = 0
    took_by_name = {}
    for name, kind, took, lines in results:
        took_by_name[name] = took
        failed += kind == 'fail'
        still_known += kind == 'known'
        print('\n'.join(lines), flush=True)
    total = time.monotonic() - started
    remember_timings(took_by_name)
    passed = len(selected) - failed - still_known
    print(f'{passed} passed, {failed} failed, {still_known} known bugs in {total:.1f}s', flush=True)
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
