// Flow-tier setup entry (flow-project setupFiles, BEFORE jest.setup.js so the Platform mock is
// registered before react-native is ever required). The real installer lives with the harness:
require('./__tests__/flow/harness/setupFlow').installFlowEnvironment();
