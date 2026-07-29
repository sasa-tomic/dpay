// Jest mock for react-native-vision-camera — the native module isn't available under node/jsdom, so
// the real package throws "camera-module-not-found" on import. Provide inert stubs for the hooks /
// component the app uses so <App/> renders in the test harness.
module.exports = {
  Camera: () => null,
  useCameraDevice: () => ({id: 'back', position: 'back', devices: []}),
  useCameraPermission: () => ({hasPermission: false, requestPermission: () => Promise.resolve(false)}),
  useCodeScanner: (opts) => ({codeScannerOptions: opts ?? {codeTypes: ['qr']}, onCodeScanned: () => {}}),
};
