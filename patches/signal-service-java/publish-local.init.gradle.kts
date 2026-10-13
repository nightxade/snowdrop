// Gradle init script used by scripts/build-signal-cli.sh to publish the patched
// signal-service-java jar to a plain directory repo under this patch set's own .work/ tree,
// instead of the shared ~/.m2 (mavenLocal()) that every other Gradle/Maven project on this
// machine also resolves from. Keeping it in an init script — rather than adding a repository to
// signal-service-java's own build.gradle.kts — means the semantic patch (0001-*.patch) stays
// exactly the "unknown-fields hook" diff; this file is Snowdrop build plumbing, not part of the
// patched library's own source.
//
// Requires SNOWDROP_SIGNAL_SERVICE_REPO (a directory path) in the environment. Usage:
//   ./gradlew --init-script publish-local.init.gradle.kts :lib:libsignal-service:publish
allprojects {
    plugins.withId("maven-publish") {
        configure<PublishingExtension> {
            repositories {
                maven {
                    name = "SnowdropLocal"
                    url = uri(
                        System.getenv("SNOWDROP_SIGNAL_SERVICE_REPO")
                            ?: throw GradleException("SNOWDROP_SIGNAL_SERVICE_REPO must be set")
                    )
                }
            }
        }
    }
}
