// node-anvil project globalTeardown — kill the detached staging child's whole process GROUP
// (child + anvil + relay), SIGTERM first (the child's handler stops the pair gracefully),
// SIGKILL backstop. Idempotent: a missing group is the normal case when setup never ran or the
// child already died. The staged pair also cannot outlive this process via the child's own
// sync `exit` SIGKILL backstop (stage-child.mjs) — three layers, no orphans.
module.exports = async function globalNodeAnvilTeardown() {
  if (process.env.DPAY_NODE_ANVIL !== '1') return;
  const pid = Number(process.env.DPAY_NODE_ANVIL_CHILD_PID);
  if (!Number.isInteger(pid) || pid <= 0) return;
  const term = () => { try { process.kill(-pid, 'SIGTERM'); } catch {} };
  const kill = () => { try { process.kill(-pid, 'SIGKILL'); } catch {} };
  term();
  // Bounded grace — a wedged anvil must not hang jest's exit.
  await new Promise((r) => setTimeout(r, 1500));
  kill();
  // eslint-disable-next-line no-console
  console.log('[node-anvil] staged chain + relay group stopped');
  delete process.env.DPAY_NODE_ANVIL_CHILD_PID;
};
