// Under the New Architecture (RN 0.82+, `newArchEnabled=true`), `react-native-get-random-values`
// is auto-linked via its `codegenConfig` (TurboModule registration through BaseReactPackage), so
// no manual project-config override is needed here.
//
// History: under the LEGACY architecture (RN 0.75 + `newArchEnabled=false`), the module's
// `codegenConfig` suppressed its old-style android autolinking (platforms.android came back null
// from `react-native config`), and the TurboModule runtime was not active either, so the module
// was entirely absent from the APK and `crypto.getRandomValues` threw at call-time. The previous
// override force-included the android sourceDir. That override is now HARMFUL under New Arch
// (it would bypass codegen and cause a double-registration / missing-TurboModule error), so it
// has been removed.
module.exports = {};
