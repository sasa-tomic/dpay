// Jest setup: mock the native-backed modules that aren't available under node/jsdom so <App/>
// renders in the test harness. AsyncStorage ships an official mock; vision-camera is stubbed via
// the root __mocks__ directory.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
