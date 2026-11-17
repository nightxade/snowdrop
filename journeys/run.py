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
    page = harness.Page(base_url, entry['query'])
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', required=True)
    ap.add_argument('names', nargs='*')
    args = ap.parse_args()

    harness.require_display()
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
