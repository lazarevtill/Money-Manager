plugins {
    id("com.android.application") version "8.13.1" apply false
    // 2.3.x is a FLOOR, not a preference: litertlm-android 0.15.0 ships Kotlin metadata
    // version 2.3.0, and a 2.1.x compiler reads only up to 2.2.0. Verified by build failure.
    id("org.jetbrains.kotlin.android") version "2.3.0" apply false
}
