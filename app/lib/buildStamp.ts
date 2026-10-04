// The APK's build identity, read by lib/updateCheck.ts to decide "is there a newer version?".
//
// GENERATED-PLACEHOLDER: scripts/build-apk.sh overwrites this file with the real build commit
// (the SHA it is building) for the duration of a release APK build and restores this committed
// placeholder in its EXIT trap, so the tree is always clean afterwards. The web bundle and every
// dev/test build therefore ship the EMPTY string.
//
// EMPTY = a dev/test build with no build identity: the update check stays SILENT (nothing to
// compare against), by design — see updateAvailable().
export const BUILD_COMMIT = '';
