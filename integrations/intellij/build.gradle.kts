// skillsmith for IntelliJ (5i): knowledge at the code, tasks and agent jobs of the branch,
// "save as knowledge", code anchors, snippets, run errors → errorsmith.
// Build: ./gradlew buildPlugin  →  build/distributions/skillsmith-intellij-<version>.zip
// Install: Settings → Plugins → ⚙ → Install Plugin from Disk…
// Without Maven Central / JetBrains repos at work: build at home, or use an installed IDE:
//   ./gradlew buildPlugin -PlocalIde="/Applications/IntelliJ IDEA.app"
import org.jetbrains.intellij.platform.gradle.TestFrameworkType

plugins {
    id("org.jetbrains.kotlin.jvm") version "2.1.10"
    id("org.jetbrains.intellij.platform") version "2.5.0"
}

group = "de.skillsmith"
version = providers.gradleProperty("pluginVersion").get()

kotlin {
    jvmToolchain(17)
}

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        val localIde = providers.gradleProperty("localIde").orNull
        if (localIde != null) local(localIde) else intellijIdeaCommunity(providers.gradleProperty("platformVersion").get())
        testFramework(TestFrameworkType.Platform)
    }
}

intellijPlatform {
    pluginConfiguration {
        ideaVersion {
            sinceBuild = "243"
            untilBuild = provider { null }
        }
    }
    buildSearchableOptions = false
    instrumentCode = false
}
