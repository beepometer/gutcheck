plugins {
    kotlin("jvm") version "2.0.21"
}
repositories { mavenCentral() }
dependencies {
    testImplementation(platform("org.junit:junit-bom:5.8.2"))
    testImplementation("org.junit.jupiter:junit-jupiter")
}
tasks.test { useJUnitPlatform() }
kotlin { jvmToolchain(17) }
