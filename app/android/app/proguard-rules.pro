# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

# JNA's documented Android rules. JNA reflects over these classes and public members.
-dontwarn java.awt.*
-keep class com.sun.jna.* { *; }
-keep class * extends com.sun.jna.* { *; }
-keepclassmembers class * extends com.sun.jna.* { public *; }

# UniFFI calls these JNA Library interfaces by native symbol name. Neither the
# interface names nor their method names may be removed or obfuscated.
-keep interface uniffi.dpay_ffi.UniffiLib { *; }
-keep interface uniffi.dpay_ffi.IntegrityCheckingUniffiLib { *; }
