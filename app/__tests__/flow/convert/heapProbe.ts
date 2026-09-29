/**
 * heapProbe.ts — the per-test RSS/heap line (DPAY_FLOW_HEAP_PROBE=1), kept from the
 * 2026-09-29 unbounded-growth investigation, moved out of the old consolidated flows.test.tsx so
 * every per-flow file in this lane carries it with one call. gc() is forced (--expose-gc) so
 * heapUsed is the RETAINED set, not churn; getActiveResources() counts event-loop-rooted handles
 * (a leaked poll chain would root its whole tree, invisible to GC).
 * DPAY_FLOW_HEAP_SAMPLE=1 prints the top allocation stacks per test (programmatic inspector
 * session); DPAY_FLOW_SNAPSHOT_AT="3,7" writes v8 heap snapshots after those tests.
 */
import {afterAll, afterEach, expect} from '@jest/globals';

export function installHeapProbe(): void {
  if (process.env.DPAY_FLOW_HEAP_PROBE !== '1') return;
  const snapAt = (process.env.DPAY_FLOW_SNAPSHOT_AT ?? '').split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  let testIndex = 0;
  let session: import('node:inspector').Session | null = null;
  type SampleNode = {callFrame: {functionName: string; url: string; lineNumber: number}; selfSize: number; children?: SampleNode[]};
  type SampledProfile = {head: SampleNode};
  afterEach(async () => {
    const gg = globalThis as unknown as {gc?: () => void};
    gg.gc?.();
    gg.gc?.();
    const mu = process.memoryUsage();
    const mb = (n: number): string => (n / 1048576).toFixed(0);
    const mounts = ((globalThis as unknown as {__DPAY_FLOW_ACTIVE_MOUNTS__?: unknown[]}).__DPAY_FLOW_ACTIVE_MOUNTS__ ?? []).length;
    const name = (expect.getState().currentTestName ?? '?').replace(/^.*?flow /, 'flow ').slice(0, 40);
    const byType: Record<string, number> = {};
    const resources: Array<{constructor?: {name?: string}; _idleTimeout?: unknown}> =
      ((process as unknown as {getActiveResources?: () => unknown[]}).getActiveResources?.() ?? []) as Array<{constructor?: {name?: string}; _idleTimeout?: unknown}>;
    for (const r of resources) {
      const k = r.constructor?.name ?? 'unknown';
      byType[k] = (byType[k] ?? 0) + 1;
    }
    console.log(`[HEAP] ${name.padEnd(42)} rss=${mb(mu.rss)}MB heap=${mb(mu.heapUsed)}MB ext=${mb(mu.external)}MB ab=${mb(mu.arrayBuffers ?? 0)}MB liveMounts=${mounts} handles=${JSON.stringify(byType)}`);
    // Allocation-site sampling (programmatic inspector session — no --inspect needed): the top
    // allocation stacks per test window name exactly WHAT grows, without GB-scale snapshots.
    if (process.env.DPAY_FLOW_HEAP_SAMPLE === '1') {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const inspector = require('node:inspector') as typeof import('node:inspector');
      const post = (m: string, p?: Record<string, unknown>): Promise<any> =>
        new Promise((res, rej) => session!.post(m as never, p as never, (e: Error | null, r?: unknown) => (e ? rej(e) : res(r))));
      if (session === null) {
        session = new inspector.Session();
        session.connect();
        await post('HeapProfiler.enable');
      } else {
        try {
          const {profile} = await post('HeapProfiler.stopSampling') as {profile: SampledProfile};
          const flat: Array<{path: string; self: number}> = [];
          const walk = (n: SampleNode, trail: string[]): void => {
            const cf = n.callFrame;
            const frame = `${cf.functionName || '(anon)'}@${(cf.url || '').replace(/^.*\/(app|node_modules)\//, '$1/')}:${cf.lineNumber}`;
            const next = [...trail.slice(-7), frame];
            if (n.selfSize > 0) flat.push({path: next.join(' <- '), self: n.selfSize});
            for (const c of n.children ?? []) walk(c, next);
          };
          walk(profile.head, []);
          flat.sort((a, b) => b.self - a.self);
          const top = flat.slice(0, 8).map((f) => `      ${(f.self / 1048576).toFixed(1)}MB  ${f.path}`);
          console.log(`[ALLOC] after ${name.trim().slice(0, 44)} — top allocation stacks this test:\n${top.join('\n') || '      (no samples)'}`);
        } catch (e) {
          console.log(`[ALLOC] sampler stop failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      await post('HeapProfiler.startSampling', {samplingInterval: 262144});
      /* eslint-enable @typescript-eslint/no-require-imports */
    }
    testIndex += 1;
    if (snapAt.includes(testIndex)) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const v8 = require('node:v8') as typeof import('node:v8');
      const file = `/home/sat/projects/dpay/tmp/heap-${String(testIndex).padStart(2, '0')}.heapsnapshot`;
      console.log(`[HEAP] writing snapshot ${file}`);
      v8.writeHeapSnapshot(file);
    }
  });
  // The inspector session is an open handle — left connected it keeps the jest worker alive
  // past the suite ("worker failed to exit gracefully"). Close it with the file.
  afterAll(async () => {
    try { session?.disconnect(); } catch { /* already gone */ }
    session = null;
  });
}
