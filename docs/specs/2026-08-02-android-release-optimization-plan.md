# Android release optimization plan

Date: 2026-08-02

## Goal

Reduce the Play-delivered Android app size and preserve useful release diagnostics without weakening the RN -> Kotlin -> UniFFI/JNA -> Rust bridge. Keep the size work separate from the larger React Native/API 36 toolchain migration.

This plan has two phases:

1. **Phase A:** enable R8 code optimization/obfuscation and Android resource shrinking on the current supported RN 0.75.4 build.
2. **Phase B:** migrate the RN-owned Android toolchain to an API-36-supported release before the 2026-08-31 Play deadline.

Phase A does not depend on AGP 9 and should land first.

## Current state

- `app/android/app/build.gradle` declares `enableProguardInReleaseBuilds = false`, passes it to `minifyEnabled`, does not enable `shrinkResources`, and uses the non-optimizing `proguard-android.txt` defaults.
- `app/android/app/proguard-rules.pro` is empty.
- Hermes already compiles the JavaScript bundle. R8 only changes Java/Kotlin DEX and Android resources; it does not shrink Hermes bytecode or Rust/native libraries.
- `scripts/build-apk.sh` builds signed release APK and AAB artifacts for `arm64-v8a,x86_64`. Play already serves ABI-specific splits from the AAB. The direct APK contains both ABIs.
- RN 0.75.4 supplies AGP 8.5.0 through its included Gradle plugin build. Do not override that catalog or patch `node_modules` independently.
- JNA 5.14.0 does not supply Android consumer ProGuard rules. The generated UniFFI binding uses JNA reflection/native symbol lookup through `uniffi.dpay_ffi.UniffiLib` and `uniffi.dpay_ffi.IntegrityCheckingUniffiLib`.
- `scripts/play-upload.sh` preserves the exact verified AAB under `.dev/releases/play-$DPAY_VERSION_CODE/`, but does not currently preserve the matching R8 mapping.

Raw APK/AAB size is not the same as Play-delivered download or installed size. Play Console App Bundle Explorer is authoritative for device-specific savings.

## Phase A: R8 and resource shrinking

### 1. Record a baseline

Before editing the release configuration:

1. Run `just apk` with release signing configured.
2. Record the exact byte sizes of:
   - `deploy/dist/dpay.apk`
   - `app/android/app/build/outputs/bundle/release/app-release.aab`
3. Record Play App Bundle Explorer's download and installed-size estimates for at least the primary arm64 device configuration. Use the same device configuration for the post-change comparison.

Do not use raw AAB size alone as the success metric.

### 2. Enable the optimized release pipeline

Delete the `enableProguardInReleaseBuilds` variable and its stale comment. Change the release build type in `app/android/app/build.gradle` to:

```groovy
release {
    if (hasReleaseSigning) {
        signingConfig signingConfigs.release
    }
    minifyEnabled true
    shrinkResources true
    proguardFiles getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro"
}
```

Keep the existing signing logic and any unrelated release settings unchanged.

Do not add `android.enableR8`, `android.enableR8.fullMode`, `-ignorewarnings`, a global `-dontwarn`, or a blanket rule such as `-keep class com.dpay.** { *; }`. R8 is already the Android Gradle Plugin shrinker. Broad suppression/keep rules would hide real bridge defects or erase most of the benefit.

### 3. Protect JNA and generated UniFFI entry points

Add these rules to `app/android/app/proguard-rules.pro`:

```proguard
# JNA's documented Android rules. JNA reflects over these classes and public members.
-dontwarn java.awt.*
-keep class com.sun.jna.* { *; }
-keep class * extends com.sun.jna.* { *; }
-keepclassmembers class * extends com.sun.jna.* { public *; }

# UniFFI calls these JNA Library interfaces by native symbol name. Neither the
# interface names nor their method names may be removed or obfuscated.
-keep interface uniffi.dpay_ffi.UniffiLib { *; }
-keep interface uniffi.dpay_ffi.IntegrityCheckingUniffiLib { *; }
```

The `java.awt` warning suppression is the narrow exception from JNA's Android guidance; Android does not provide AWT. The JNA class rules protect JNA's reflection-based structures/callbacks. The two exact interface rules protect the generated native function names without keeping all dpay classes.

If a later UniFFI regeneration changes or adds JNA `Library` interface names, update these exact rules in the same change. Do not solve that drift with an application-wide keep.

Treat every other R8 missing-reference warning as a build blocker. Resolve a reproduced warning with the narrowest dependency-specific rule and a comment explaining why it is safe.

### 4. Preserve release diagnostics

After a successful release build, require these non-empty, build-specific outputs:

```text
app/android/app/build/outputs/mapping/release/mapping.txt
app/android/app/build/outputs/mapping/release/usage.txt
app/android/app/build/outputs/mapping/release/configuration.txt
```

Update `scripts/play-upload.sh` so it copies `mapping.txt` into the newly-created immutable `.dev/releases/play-$DPAY_VERSION_CODE/` directory beside the staged AAB before upload. Give it a versioned name such as `dpay-release-$DPAY_VERSION_CODE-mapping.txt`, fail if the source is absent or empty, and print its path in the completion summary.

The mapping is tied to the exact build and is needed to retrace obfuscated crashes. Keep staged release artifacts ignored; do not commit mappings. After internal upload, confirm Play Console shows a deobfuscation file for that version. If the publishing plugin does not upload it automatically, upload the staged mapping through the Play Console or add the plugin's supported mapping-upload path rather than inventing an unverified Gradle task.

### 5. Verify behavior

Run all of these gates against the optimized release:

```sh
just verify
just apk
just app
just ondevice
```

`just app` is mandatory because it launches the minified release APK and requires `DPAY_SELFCHECK PASS` through the real `NativeModules` -> Kotlin -> UniFFI/JNA -> `libdpay_ffi.so` path. `just ondevice` exercises the standalone native/UniFFI and NFC framing surface.

Also exercise these release-only behaviors on the emulator/device and then on Play internal testing:

- cold startup and identity/relay restore;
- QR scan/camera permission and request decoding;
- NFC reader mode, HCE service discovery, and native event delivery;
- authorization and withdrawal signing through the native bridge;
- settlement, receipt verification, and Ledger rendering;
- Play pre-launch report with no new crash or ANR.

Inspect `usage.txt` to ensure removal is plausible and inspect the AAB with App Bundle Explorer. The expected gain is useful but not dramatic because Hermes and Rust/native payloads are outside R8's main reach.

### 6. Acceptance and rollback

Accept Phase A when:

- every command and device behavior above passes;
- the three R8 diagnostic files exist and the mapping is preserved per release;
- there are no unexplained R8 warnings;
- Play's device-specific download or installed size improves, or the measured result is neutral with no regression and retained optimization/diagnostic value;
- the internal-track artifact has its matching deobfuscation mapping.

Block rollout for any launch crash, missing native symbol, JNA field/order error, native event loss, bridge self-check failure, or unexplained shrinker warning. First reproduce and add the narrowest justified keep rule. Disable R8/resource shrinking only if a reproduced failure cannot be corrected narrowly; never use a blanket app keep merely to make the build green.

## Optional direct-APK optimization

After Phase A, the direct-download APK path may produce an arm64-only APK while the Play AAB continues to include `arm64-v8a,x86_64`. This can reduce the sideload artifact but has no Play installed-size benefit because Play already performs ABI splitting. Keep an explicit x86_64 artifact or build path if emulator sideloading still depends on it. This is optional and must not delay Phase A.

## Phase B: API 36 toolchain migration

Treat this as a separate RN/platform migration, not as a shrinker setting change.

Evidence checked on 2026-08-02:

- the project is on RN 0.75.4, whose bundled Gradle plugin catalog pins AGP 8.5.0;
- the latest published stable RN and `@react-native/gradle-plugin` were 0.86.2;
- the RN 0.86.2 plugin tarball pins AGP 8.12.0 and Kotlin 2.1.20, not AGP 9;
- AGP 8.12 supports API 36;
- RN 0.86.2 requires React `^19.2.3`, `@types/react` `^19.1.1`, and Node `^20.19.4 || ^22.13.0 || ^24.3.0 || >=25`;
- the app currently sets `newArchEnabled=false`, while current RN releases require migration away from the legacy architecture.

Therefore:

1. Select a supported RN release whose own Android template/toolchain supports compile/target API 36. RN 0.86.2 with its bundled AGP 8.12.0 is the current published reference, not a mandatory hardcoded destination.
2. Plan and test the React/TypeScript/Node, new-architecture, native-module, `react-native-svg`, JNA, and generated UniFFI compatibility changes together.
3. Preserve release signing, application ID, versioning, Hermes, ABI selection, Play publishing, and the Phase A R8 rules/mapping retention.
4. Run `just verify`, `just apk`, `just app`, and `just ondevice`, then repeat all internal-track checks from Phase A.
5. Move to AGP 9 only when the selected RN release's supported template pins or explicitly supports it. Do not override RN's included-build AGP catalog or patch `node_modules` to force AGP 9.

AGP 9's newer optimized resource shrinking may provide a later incremental gain, but it is not required for R8, resource shrinking, obfuscation, or API 36 support. The migration is complete when the RN release build targets API 36 without an unsupported-compile-SDK warning and all release/device gates pass.

## Implementation scope

Phase A should normally touch only:

- `app/android/app/build.gradle`
- `app/android/app/proguard-rules.pro`
- `scripts/play-upload.sh`
- release documentation if output paths or operator steps change

Because these paths affect the Android release and native bridge, the outer-loop `just app` and `just ondevice` gates are required before merge.
