// Flow-tier after-env setup: registers the per-test lifecycle (AsyncStorage.clear, seam resets,
// the fail-closed fetch-failure assertion). Lifecycle hooks exist only AFTER jest's test
// framework is installed, so this is a setupFilesAfterEnv file — NOT a setupFile.
require('./__tests__/flow/harness/setupFlow').installFlowLifecycle();
