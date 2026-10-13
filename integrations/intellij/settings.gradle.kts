rootProject.name = "skillsmith-intellij"

plugins {
    // resolves the JDK toolchain when Java 17 is not installed (Foojay)
    id("org.gradle.toolchains.foojay-resolver-convention") version "0.9.0"
}
