// react-native-get-random-values declares `codegenConfig` in its package.json, which suppresses
// old-style android autolinking (platforms.android comes back null from `react-native config`).
// With newArchEnabled=false the TurboModule runtime isn't active either, so the module is entirely
// absent from the APK → crypto.getRandomValues throws at call-time. Force-include the android
// sourceDir so the gradle plugin links it as a regular native module.
module.exports = {
  dependencies: {
    'react-native-get-random-values': {
      platforms: {
        android: {
          sourceDir: '../node_modules/react-native-get-random-values/android',
          packageImportPath: 'import org.linusu.RNGetRandomValuesPackage;',
          packageInstance: 'new RNGetRandomValuesPackage()',
        },
      },
    },
  },
};
