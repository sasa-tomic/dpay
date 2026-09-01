module.exports = {
  root: true,
  extends: '@react-native',
  overrides: [
    {
      // Jest's own `setupFiles` entry (jest.config.js). It is executed BY Jest, in Node, before any
      // test module, so `jest` and the ES2020 `globalThis` really are defined here — @react-native's
      // config just never says so: it grants the jest env only to `*.{spec,test}.*` and
      // `__tests__`/`__mocks__`, and its base env is `es6`. `no-undef` was therefore reporting three
      // globals that exist rather than a defect. Naming the real environment keeps the rule at full
      // strength on this file instead of disabling it.
      files: ['jest.setup.js'],
      env: {jest: true, node: true, es2020: true},
    },
  ],
};
