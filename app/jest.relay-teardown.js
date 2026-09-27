// Flow-project globalTeardown — kill the detached relay-staging child's whole process GROUP
// (child + relay grandchild), SIGTERM first, SIGKILL backstop. Idempotent: a missing group is
// the normal case when setup never ran or the child already died.
module.exports = async function globalRelayTeardown() {
  const pid = Number(process.env.DPAY_JEST_RELAY_CHILD_PID);
  if (!Number.isInteger(pid) || pid <= 0) return;
  const term = () => { try { process.kill(-pid, 'SIGTERM'); } catch {} };
  const kill = () => { try { process.kill(-pid, 'SIGKILL'); } catch {} };
  term();
  // Bounded grace — a wedged relay must not hang jest's exit.
  await new Promise((r) => setTimeout(r, 1500));
  kill();
  // eslint-disable-next-line no-console
  console.log(`[jest-relay] relay group ${pid} stopped`);
  delete process.env.DPAY_JEST_RELAY_CHILD_PID;
};
