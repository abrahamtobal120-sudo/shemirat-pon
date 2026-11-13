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
        versionCode = 2
        versionName = "0.2.0"
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
    testImplementation("junit:junit:4.13.2")
}
