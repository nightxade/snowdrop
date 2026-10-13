# signal-service-java unknown-fields hook

Base: [Turasa/libsignal-service-java](https://github.com/Turasa/libsignal-service-java), tag
`v2.15.3_unofficial_153`, commit `d1b477f1339a1aaf2de4c8a6dff9ef52851fe3b0` (GPG-signed by AsamK,
verified). This is the exact source for the jar signal-cli v0.14.8 depends on: its coordinate is
`com.github.turasa:signal-service-java:2.15.3_unofficial_153`, published from this repository's
`:lib:libsignal-service` Gradle module (its `build.gradle.kts` sets `publications.mavenJava.pom.
artifactId = "signal-service-java"`). Confirmed against the cached jar's own POM
(`~/.gradle/caches/modules-2/files-2.1/com.github.turasa/signal-service-java/2.15.3_unofficial_153/
.../signal-service-java-2.15.3_unofficial_153.pom`): groupId, artifactId, version, licence
(`GPLv3`), and the three listed developers (Moxie Marlinspike, Sebastian Scheibner, Tilman
Hoffbauer) match this tag's own POM declaration verbatim. (signal-cli's own `libs.versions.toml`
actually depends on the sibling `com.github.turasa:signal-network` artifact from the same
repository, which in turn depends on `signal-service-java` at the same version — see "Why
`signal-network` and not `signal-service-java` directly" below.)

Licence: GPL-3.0 (this repository's root `LICENSE`; the two upstream files this patch touches
each carry the header `Licensed according to the LICENSE file in this repository`, the
convention this repo uses for its older, Open-Whisper-Systems-era GPLv3 files). The new test file
added by this patch carries the same header. No new runtime source files are added — the patch
only extends two existing classes — so no new SPDX header conventions were needed.

## What this patch adds

A single, generic extension point, unrelated to any specific feature:
`SignalServiceDataMessage` gains an optional `unknownFields: ByteString` (Wire's own
`okio.ByteString`), settable via `Builder#withUnknownFields(ByteString?)`. Where this library
builds the outgoing `DataMessage` proto
(`SignalServiceMessageSender.createDataMessage`), it merges those bytes in via Wire's own public
`Message.Builder#addUnknownFields(ByteString)` — the same mechanism Wire itself uses internally
to round-trip any field a consumer's `.proto` doesn't declare. This library doesn't parse or
otherwise care what's in those bytes; callers (signal-cli's own patch 0013) are responsible for
encoding valid proto field-tag-prefixed bytes.

This alone is enough for a downstream caller to attach an arbitrary extra proto field — by field
number — to an outgoing `DataMessage`, without this library knowing the field number or payload
shape. See `patches/signal-cli/README.md`'s "Custom emoji" section for the field this unlocks
(field 9000, a `SnowdropExtension` submessage).

Receiving a message with an unknown field needs **no change here**: signal-cli already has
access to the raw, pre-`SignalServiceContent`-conversion `Content`/`DataMessage` Wire proto
(`SignalServiceCipherResult#getContent()`, used in `IncomingMessageHandler.validate`), and that
proto's own `unknownFields()` accessor is already public — Wire's decoder collects it during
normal decoding regardless of this patch. Only the _send_ side needed a hook, since every public
multi-recipient/group send path takes the high-level `SignalServiceDataMessage`, which had no
unknown-field slot before this patch.

Files touched:

- `lib/libsignal-service/build.gradle.kts` — bumps only this module's own published version to
  `2.15.3_unofficial_153-snowdrop.1`. Its sibling modules (`core:network`, `core:util-jvm`,
  `core:models-jvm`), which this module depends on, keep the stock upstream version and are
  resolved from the normal `com.github.turasa` Maven coordinates — this patch republishes only
  the one jar it actually touches.
- `lib/libsignal-service/src/main/java/.../api/messages/SignalServiceDataMessage.kt` — the new
  field and builder method.
- `lib/libsignal-service/src/main/java/.../api/SignalServiceMessageSender.java` — the 4-line
  merge-in at the end of `createDataMessage`.
- `lib/libsignal-service/src/test/java/.../api/messages/SignalServiceDataMessageUnknownFieldsTest.kt`
  (new) — covers the builder plumbing and a real Wire encode/decode round trip through
  `addUnknownFields`/`ADAPTER.encode`/`ADAPTER.decode`.

## Why `signal-network` and not `signal-service-java` directly

signal-cli's `gradle/libs.versions.toml` declares `com.github.turasa:signal-network` (not
`signal-service-java`) as its one direct dependency on this repository; `signal-network`'s own
POM depends on `signal-service-java` at the same pinned version. The dependency substitution in
`patches/signal-cli`'s build wiring (see that patch set's README) only needs to retarget the
`signal-service-java` coordinate — `signal-network` itself is untouched and keeps resolving
normally from Maven Central.

## Building and publishing the patched jar

Requires JDK 25 and network access (Gradle resolves this repo's own dependencies from Maven
Central as usual). `scripts/build-signal-cli.sh` (repo root) drives this automatically; to do it
by hand:

```sh
git clone https://github.com/Turasa/libsignal-service-java.git
cd libsignal-service-java
git checkout --detach d1b477f1339a1aaf2de4c8a6dff9ef52851fe3b0
git apply /path/to/snowdrop/patches/signal-service-java/0001-snowdrop-unknown-fields-hook.patch

export JAVA_HOME=/path/to/jdk-25
export SNOWDROP_SIGNAL_SERVICE_REPO=/path/to/a/local/maven/repo/dir

./gradlew --no-daemon :lib:libsignal-service:test
./gradlew --no-daemon \
  --init-script /path/to/snowdrop/patches/signal-service-java/publish-local.init.gradle.kts \
  :lib:libsignal-service:publishAllPublicationsToSnowdropLocalRepository
```

This publishes the jar, sources, javadoc and Gradle module metadata to
`$SNOWDROP_SIGNAL_SERVICE_REPO/com/github/turasa/signal-service-java/2.15.3_unofficial_153-snowdrop.1/`
— a plain directory repo under this patch set's own work tree
(`patches/signal-service-java/.work/m2repo` when driven by `scripts/build-signal-cli.sh`), never
the shared `~/.m2` (`mavenLocal()`), so this never leaks into unrelated Gradle/Maven builds on the
same machine. `publish-local.init.gradle.kts` is what adds that directory as a publishing
target — it's Snowdrop build plumbing, kept out of the semantic patch, since it configures
`PublishingExtension` from the outside rather than editing this module's own `build.gradle.kts`.

`patches/signal-cli`'s own `lib/build.gradle.kts` patch then points at this jar: set
`SNOWDROP_SIGNAL_SERVICE_VERSION=2.15.3_unofficial_153-snowdrop.1` and
`SNOWDROP_SIGNAL_SERVICE_REPO` (the same directory) when building signal-cli, and its Gradle
dependency substitution does the rest. See `patches/signal-cli/README.md`.

### Pinned checksums for three POMs (`0002`)

This repository's Gradle build has dependency verification enabled
(`gradle/verification-metadata.xml`). With Gradle 9.4.1, resolving the buildscript/plugin and test
classpaths pulls in three transitive POMs the checked-in metadata has no checksums for
(`com.google.guava:guava-parent:32.1.3-jre`, `org.jetbrains.kotlinx:kotlinx-coroutines-bom:1.6.4`,
`org.junit:junit-bom:5.8.2`); this happens on a clean, unpatched checkout too.
`0002-pin-missing-pom-checksums.patch` adds their SHA-256s, after checking each file against
Maven Central's published SHA-1. Verification stays strict: any other missing or mismatched
checksum still fails the build.

## Verification performed

- `./gradlew :lib:libsignal-service:test` (strict dependency verification): full
  module suite, 637 tests, 0 failures, 0 errors, 7 skipped (includes the 3 new tests in
  `SignalServiceDataMessageUnknownFieldsTest`).
- Published the jar to a scratch local repo and inspected the generated POM: confirms the jar
  gets the bumped version while `core-network`/`util-jvm`/`models-jvm` stay at the stock
  `2.15.3_unofficial_153`.
- Not verified: an actual send/receive round trip against Signal's servers (no test account
  available in this environment) — covered instead by `patches/signal-cli`'s own tests and the
  `scripts/build-signal-cli.sh --test` run, and ultimately by the user's own real-phone check
  that official Signal clients show only the message text.
