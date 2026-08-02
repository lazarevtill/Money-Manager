plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.moneymanager.gates"
    compileSdk = 36
    ndkVersion = "28.2.13676358"   // r28+: 16 KB ELF alignment is the linker default (V26)

    defaultConfig {
        applicationId = "dev.moneymanager.gates"
        minSdk = 31
        targetSdk = 36
        versionCode = 1
        versionName = "0.1"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        ndk { abiFilters += "arm64-v8a" }
    }

    buildTypes {
        // Gates run against a debuggable build so instrumentation can attach.
        // V29 still requires one green reproduced from an INSTALLED APK, not adb shell.
        getByName("debug") { isMinifyEnabled = false }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // LiteRT-LM ships prebuilt .so; never let the build strip or recompress them.
    packaging {
        jniLibs {
            useLegacyPackaging = false   // uncompressed + page-aligned in the APK
            keepDebugSymbols += "**/*.so"
        }
    }
}

// Kotlin 2.3 removed the kotlinOptions DSL — compilerOptions is the only form that compiles.
kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation("com.google.ai.edge.litertlm:litertlm-android:0.15.0")
    implementation("androidx.core:core-ktx:1.15.0")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
}
