/**
 * Flow-driver shim — the 1:1 jest twin of the `e2e/harness/driver.mjs` method set flows call, so
 * ported flows need minimal edits (same names, same async API, same failure intents). A driver is
 * bound to ONE mounted react-test-renderer tree; `mount.tsx` creates it and rebinds it on remount.
 *
 * Dropped on purpose (spec 1.2): `eval` (every __DPAY_TEST_* seam is a plain globalThis read in
 * jest), `screenshot` (no pixels), `navigate/pageURL` (the location stub owns the URL surface).
 */
import renderer from 'react-test-renderer';
import {act} from 'react-test-renderer';
import {keydownHandlers, allowRequestFailuresFrom, type FetchRecord, fetchFailureRecords} from './setupFlow';
import {scaled as budgetScaled} from './budget';

type Node = renderer.ReactTestInstance;
/**
 * `unscaled: true` keeps the caller's window byte-exact — the NEGATIVE/refusal class (asserting an
 * error text shows, a surface must NOT complete, a tolerated-absence probe whose happy path IS
 * absence). The app must refuse fast; a stretched refusal bound only delays catching a real bug.
 * Everything else — the positive transition waits — is stretched by the host-load budget
 * (harness/budget.ts) at THIS boundary, so every flow file's literal window inherits the scaling
 * without a per-call-site edit.
 */
type WaitOpts = {timeoutMs?: number; label?: string; unscaled?: boolean};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The effective window: budget-scaled unless the caller pins it (`unscaled`). */
function windowOf(opts: WaitOpts, fallbackMs: number): number {
  const base = opts.timeoutMs ?? fallbackMs;
  return opts.unscaled === true ? base : budgetScaled(base);
}

export class Driver {
  /** Rebound by mount.tsx on every mount/remount — the driver outlives single trees. */
  private treeRef: {current: renderer.ReactTestRenderer | null} = {current: null};
  /** Fetched-but-failed requests observed during this driver's test (fail-closed teardown data). */
  fetchFailures: FetchRecord[] = [];
  allowRequestFailuresFrom = allowRequestFailuresFrom;

  bindTree(tree: renderer.ReactTestRenderer): void {
    this.treeRef.current = tree;
  }

  private tree(): renderer.ReactTestRenderer {
    const t = this.treeRef.current;
    if (!t) throw new Error('[driver] no mounted tree — call mountApp() first');
    return t;
  }

  private findAll(pred: (n: Node) => boolean): Node[] {
    try {
      return this.tree().root.findAll(pred);
    } catch {
      return []; // an unmounted tree (mid-remount) — callers' wait loops retry
    }
  }

  findAllByTestID(testID: string): Node[] {
    return this.findAll((n) => n.props && n.props.testID === testID);
  }

  /** Find a node by RN testID, polling until it exists (the findByTestID wait semantics). */
  async findByTestID(testID: string, opts: WaitOpts = {}): Promise<Node> {
    const timeoutMs = windowOf(opts, 5_000);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hits = this.findAllByTestID(testID);
      if (hits.length > 0) return hits[0];
      if (Date.now() > deadline) {
        throw new Error(`[driver] element testID=${testID} not found within ${timeoutMs}ms`);
      }
      await sleep(10);
    }
  }

  async click(testID: string, opts: WaitOpts = {}): Promise<void> {
    const node = await this.findByTestID(testID, opts);
    // Pressable/Pressable-like props carry onPress directly (the app's convention — the same
    // press idiom every existing component test uses).
    const onPress = node.props.onPress as ((...a: unknown[]) => void) | undefined;
    if (typeof onPress !== 'function') {
      throw new Error(`[driver] testID=${testID} has no onPress to press`);
    }
    // SYNC act: async act awaits the app's perpetual poll/timer chains (measured 21s on one
    // press); sync act flushes the press's state update and returns immediately. The driver's
    // wait loops own all async settling.
    act(() => {
      onPress(node.props.onPressParam);
    });
  }

  async type(testID: string, text: string, opts: WaitOpts = {}): Promise<void> {
    const node = await this.findByTestID(testID, opts);
    const onChangeText = node.props.onChangeText as ((t: string) => void) | undefined;
    if (typeof onChangeText !== 'function') {
      throw new Error(`[driver] testID=${testID} has no onChangeText to type into`);
    }
    act(() => { onChangeText(text); });
  }

  readInputValue(testID: string): string {
    const hits = this.findAllByTestID(testID);
    if (hits.length === 0) throw new Error(`[driver] readInputValue: no node testID=${testID}`);
    return String(hits[0].props.value ?? '');
  }

  /** A single prop off the first node matching testID (null when absent — safe probes). */
  propOf(testID: string, prop: string): unknown {
    const hits = this.findAllByTestID(testID);
    return hits.length === 0 ? null : hits[0].props[prop];
  }

  /** readText that returns null instead of throwing when the node is absent. */
  readTextSafe(testID: string): string | null {
    return this.findAllByTestID(testID).length === 0 ? null : this.readText(testID);
  }

  /** "The node exists AND its text names `needle`" — the re-render-safe tap verifier. */
  isReadTextSafe(testID: string, needle: string): boolean {
    return this.readTextSafe(testID)?.includes(needle) === true;
  }

  async typeByPlaceholder(placeholder: string, text: string, opts: WaitOpts = {}): Promise<void> {
    const timeoutMs = windowOf(opts, 5_000);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hits = this.findAll((n) => n.props && n.props.placeholder === placeholder);
      const node = hits.find((n) => typeof n.props.onChangeText === 'function');
      if (node) {
        act(() => { (node.props.onChangeText as (t: string) => void)(text); });
        return;
      }
      if (Date.now() > deadline) {
        throw new Error(`[driver] input with placeholder "${placeholder}" not found within ${timeoutMs}ms`);
      }
      await sleep(10);
    }
  }

  /** Walk the subtree under `testID`, joining every Text string (the readText contract). */
  readText(testID: string): string {
    const hits = this.findAllByTestID(testID);
    if (hits.length === 0) throw new Error(`[driver] readText: no node testID=${testID}`);
    const found: string[] = [];
    const walk = (n: Node): void => {
      for (const c of n.children) {
        if (typeof c === 'string') found.push(c);
        else walk(c);
      }
    };
    walk(hits[0]);
    return found.join('');
  }

  bodyText(): string {
    const found: string[] = [];
    const walk = (n: Node): void => {
      for (const c of n.children) {
        if (typeof c === 'string') found.push(c);
        else walk(c);
      }
    };
    try {
      walk(this.tree().root);
    } catch { /* unmounted mid-remount — empty snapshot this tick */ }
    return found.join('');
  }

  /** Poll until bodyText contains `text` (substring match — the e2e waitForText contract). */
  async waitForText(text: string, opts: WaitOpts = {}): Promise<boolean> {
    const timeoutMs = windowOf(opts, 5_000);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.bodyText().includes(text)) return true;
      if (Date.now() > deadline) return false;
      await sleep(10);
    }
  }

  /** Poll a tree predicate until truthy (the generic condition wait; `label` names the wait).
   *  A THROWING predicate is a harness bug — it surfaces immediately, never retries. */
  async waitForFunction(fn: () => unknown, opts: WaitOpts = {}): Promise<void> {
    const timeoutMs = windowOf(opts, 5_000);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (Boolean(fn())) return;
      if (Date.now() > deadline) {
        throw new Error(`[driver] condition never held within ${timeoutMs}ms: ${opts.label ?? '(unlabelled)'}`);
      }
      await sleep(10);
    }
  }

  async waitGone(testID: string, opts: WaitOpts = {}): Promise<void> {
    const timeoutMs = windowOf(opts, 3_000);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.findAllByTestID(testID).length === 0) return;
      if (Date.now() > deadline) {
        throw new Error(`[driver] testID=${testID} still present after ${timeoutMs}ms`);
      }
      await sleep(10);
    }
  }

  isPresent(testID: string): boolean {
    return this.findAllByTestID(testID).length > 0;
  }

  /** Two consecutive identical bodyText snapshots 50ms apart — "the surface stopped moving". */
  async waitAtRest(testID: string, opts: WaitOpts = {}): Promise<void> {
    const timeoutMs = windowOf(opts, 8_000);
    const deadline = Date.now() + timeoutMs;
    if (!this.isPresent(testID)) {
      throw new Error(`[driver] waitAtRest: testID=${testID} is not mounted`);
    }
    let prev = this.readText(testID);
    for (;;) {
      await sleep(50);
      const now = this.readText(testID);
      if (now === prev) return;
      prev = now;
      if (Date.now() > deadline) {
        throw new Error(`[driver] testID=${testID} never came to rest within ${timeoutMs}ms`);
      }
    }
  }

  /** Give React `n` rendered-frame-equivalents (16ms each) of real time, inside act. */
  async settleFrames(n = 3): Promise<void> {
    await sleep(16 * n);
  }

  /** Dispatch a keydown to every handler the app registered (the useHotkeys surface). */
  pressKey(key: string): void {
    const handlers = keydownHandlers();
    if (handlers.length === 0) {
      throw new Error(`[driver] pressKey(${key}): no keydown handlers registered`);
    }
    for (const fn of handlers) {
      act(() => { fn({key}); });
    }
  }

  async clearStorage(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AsyncStorage = require('@react-native-async-storage/async-storage') as {clear: () => Promise<void>};
    await AsyncStorage.clear();
  }

  /** Records the app's observed-but-undeclared fetch failures (teardown asserts them). */
  collectFetchFailures(): FetchRecord[] {
    this.fetchFailures = fetchFailureRecords();
    return this.fetchFailures;
  }

  // --- background/foreground (flows 160/17): AppState is the one code path (useAppActive). -----
  // The RN preset's AppState mock records addEventListener calls as a jest.fn — replaying the
  // registered 'change' handlers with a status IS the platform event, no new mock needed.
  async background(): Promise<void> {
    emitAppState('background');
  }

  async foreground(): Promise<void> {
    emitAppState('active');
  }

  /** Browser Back: the location stub rewinds one entry and fires popstate (the app's own
   *  useWalletHistory listener applies the URL). */
  historyBack(): void {
    (globalThis as unknown as {history: {back: () => void}}).history.back();
  }
}

function emitAppState(state: string): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const AppState = require('react-native') as {
    AppState: {addEventListener: {mock?: {calls: Array<[string, (s: string) => void]>}}};
  };
  act(() => {
    for (const call of AppState.AppState.addEventListener.mock?.calls ?? []) {
      if (call[0] === 'change') call[1](state);
    }
  });
}
