module.exports = {
  preset: 'react-native',
  setupFiles: ['<rootDir>/jest.setup.js'],
  // react-native-qrcode-svg ships ESM (`export default`); transform it so jest can load it.
  transformIgnorePatterns: [
    'node_modules/(?!(react-native|@react-native|react-native-qrcode-svg|react-native-vision-camera)/)',
  ],
};
