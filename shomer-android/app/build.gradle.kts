plugins { id("com.android.application") }

// Release signing: set SHOMER_KEYSTORE (path), SHOMER_KEYSTORE_PASSWORD, SHOMER_KEY_ALIAS and
// SHOMER_KEY_PASSWORD. Without them, assembleRelease produces an unsigned APK.
val keystorePath: String? = System.getenv("SHOMER_KEYSTORE")?.takeIf { it.isNotBlank() }

android {
    namespace = "dev.shomer.android"
    compileSdk = 35
    defaultConfig {
        applicationId = "dev.shomer.android"
        minSdk = 26
        targetSdk = 35
        versionCode = 3
        versionName = "0.3.0"
        // Real phones (ARM) plus the 64-bit emulator; drops 32-bit x86 to keep the APK smaller.
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64") }
    }
    // The image filter uses the same ONNX models as Shomer Web, taken straight from shomer-web/models.
    sourceSets {
        getByName("main") { assets.srcDirs("src/main/assets", "../../shomer-web/models") }
    }
    // Stored uncompressed so they can be copied/mapped quickly.
    androidResources { noCompress += "onnx" }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    signingConfigs {
        if (keystorePath != null) {
            create("release") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("SHOMER_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("SHOMER_KEY_ALIAS")
                keyPassword = System.getenv("SHOMER_KEY_PASSWORD")
            }
        }
    }
    buildTypes {
        release {
            if (keystorePath != null) signingConfig = signingConfigs.getByName("release")
        }
    }
}

dependencies {
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.20.0")
    testImplementation("junit:junit:4.13.2")
}
