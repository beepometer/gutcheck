// Root build script: no root-level plugins to apply — the AGP + Kotlin plugin versions are
// declared directly in app/build.gradle.kts and resolved via settings.gradle.kts's
// pluginManagement repositories. Present because androidWorkCopy() (test/jvm-e2e.test.mjs)
// unconditionally copies settings.gradle.kts, build.gradle.kts, and gradle.properties from the
// project root into the work copy.
