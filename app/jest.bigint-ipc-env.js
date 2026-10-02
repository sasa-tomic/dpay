// The jest worker's test environment, one hook added: a BigInt-safe worker IPC net.
//
// WHY (the masked-failure class, 2026-10-02): jest-runner forks test workers with
// `serialization: 'json'` (jest-runner/build/index.js forkOptions) and jest 29.7 has no
// serialization safety net on the worker→parent channel (jest 30 added packMessage). A FAILING
// `expect(BigInt).toBe(BigInt)` throws a JestAssertionError whose matcherResult carries the RAW
// BigInt actual/expected; jest-circus ships that error object verbatim in `failureDetails` on
// BOTH the per-test `test-case-result` IPC event and the final suite result (processChild
// reportSuccess). Node's JSON channel serializer then throws
// "TypeError: Do not know how to serialize a BigInt" OUTSIDE any test: the suite dies as
// "Test suite failed to run" with only the serialization error, and the REAL assertion failure
// never reaches the reporter (observed 2026-10-02: flow convert 187/194/209 died opaquely under
// worker runs, membership racy per run). This module runs in the worker's REAL module context
// (jest-runner requires the test environment outside the VM; setup files only ever see jest's
// COPY of process, jest-util createProcessObject, so they cannot install this). The net wraps
// the real `process.send` once per worker: a payload the JSON serializer refuses is re-sent
// through a BigInt-stringifying replacer, so the suite fails HONESTLY with its real diff.
// Only the machine-readable matcherResult changes shape (BigInt → "123n" text); failureMessages
// (the printed diff) are prebuilt strings and never re-shaped. In-band runs and the jest parent
// process have no `process.send` and skip the install.
'use strict';

const nodeEnvironment = require('jest-environment-node');

function installBigIntIpcNet(proc) {
  if (proc == null || typeof proc.send !== 'function' || proc.__DPAY_IPC_BIGINT_NET__ === true) return;
  proc.__DPAY_IPC_BIGINT_NET__ = true;
  const boundSend = proc.send.bind(proc);
  proc.send = function bigintSafeSend(msg, ...rest) {
    try {
      return boundSend(msg, ...rest);
    } catch (e) {
      if (!/BigInt/.test(String((e && e.message) || ''))) throw e;
      const packed = JSON.parse(JSON.stringify(msg, (_k, v) => (typeof v === 'bigint' ? v.toString() + 'n' : v)));
      proc.stderr.write(
        '[jest.bigint-ipc] BigInt in worker IPC payload - packed so the real failure reports (the masked-failure class: convert 187/194/209, 2026-10-02)\n',
      );
      return boundSend(packed, ...rest);
    }
  };
}

// Install at require time (the worker's real context) AND at construction time (a recycled
// worker re-requires per file; the flag makes the second install a no-op).
installBigIntIpcNet(process);

module.exports = class BigIntIpcEnvironment extends nodeEnvironment.TestEnvironment {
  constructor(...args) {
    super(...args);
    installBigIntIpcNet(process);
  }
};
