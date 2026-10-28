#!/usr/bin/env python3
"""Emit reachability-metadata.json for the classes this patch set adds to the reflection
surface of signal-cli (Jackson-serialised JSON-RPC result types, protobuf messages).

Upstream ships reflection metadata for its own types, but it lists some of them method by
method, which goes stale as soon as a patch adds a record component. Every class in the
scanned packages is therefore re-registered in full, and the Json* types also as arrays
(Jackson instantiates them).

usage: gen-native-metadata.py <signal-cli-src> <out.json>
Run after a Gradle build: it scans the compiled classes under build/classes/java/main."""
import json
import os
import sys

src, out = sys.argv[1], sys.argv[2]
roots = [f"{src}/build/classes/java/main", f"{src}/lib/build/classes/java/main"]
pkgs = ["org/asamk/signal/json/", "org/asamk/signal/manager/api/", "org/asamk/signal/manager/history/",
        "org/asamk/signal/commands/", "org/thoughtcrime/securesms/backup/v2/proto/"]
entries = {}
for root in roots:
    for p in pkgs:
        for dp, _, fs in os.walk(os.path.join(root, p)):
            for f in fs:
                if not f.endswith(".class") or f in ("package-info.class", "module-info.class"):
                    continue
                n = os.path.relpath(os.path.join(dp, f), root)[:-6].replace("/", ".")
                if n.endswith("Test"):
                    continue
                entries[n] = {"type": n, "allDeclaredFields": True, "allDeclaredMethods": True,
                              "allDeclaredConstructors": True}
for n in list(entries):
    if n.startswith("org.asamk.signal.json.") or "$Json" in n:
        entries[n + "[]"] = {"type": n + "[]"}
json.dump({"reflection": [entries[k] for k in sorted(entries)]}, open(out, "w"), indent=1)
print(len(entries), "reflection entries ->", out)
