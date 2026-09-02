import {DpayCore} from './native';

/**
 * On-device diagnostic log — a file that outlives the walk home.
 *
 * WHY. Everything this app reports goes to `console.*`, which on Android means logcat: an
 * in-memory rolling buffer, readable only while a cable is attached. That is fine at a desk and
 * useless for the case that matters most — a real payment at a real till, half an hour from any
 * computer, where the one thing worth knowing is what the payment provider answered AFTER the money
 * moved. By the time the phone is plugged back in, the buffer may have rolled and the answer is
 * gone. `DpayCore.appendLog` writes to a file instead (`/sdcard/Android/data/<pkg>/files/dpay.log`,
 * reachable over `adb pull` without root, no runtime permission, rotated at 2 MB).
 *
 * WHAT IT CAPTURES. `console.warn` and `console.error` are MIRRORED, not replaced: the original
 * console still runs first, so logcat, Metro and the e2e harness's console assertions all behave
 * exactly as before. This module adds a destination; it removes none. `console.log` is deliberately
 * NOT captured — it is chatty (render traffic, poll ticks) and would push the rare, valuable lines
 * out of a rotated file. Anything that matters is a warn or an error, and if something important is
 * only a `log`, the fix is to make it a warn.
 *
 * WHAT IT MUST NEVER DO. Fail loudly, block, or be depended upon. It sits beside money paths that
 * are already one-shot and irreversible, so a logger that can throw or stall is strictly worse than
 * no logger: it would convert a diagnostic into a new failure mode on the exact path it exists to
 * explain. Every write is fire-and-forget and every error is swallowed HERE (the native side
 * swallows too, and resolves false rather than rejecting). This is the one place in this codebase
 * where swallowing is correct, and it is correct only because nothing may ever read back a
 * guarantee that a line was written.
 *
 * PRIVACY. The file stays on the device — nothing is uploaded, and there is no telemetry channel
 * here. It holds what the app already prints to logcat, which is diagnostics and never a seed:
 * `warnMoney` below is the only deliberate addition, and its callers pass provider answers and
 * block indexes, never key material.
 */

/** One in-memory generation of the log, so a build without the native method (the web wallet, an
 *  older APK) still has something to show, and so tests can assert what would have been written. */
const buffer: string[] = [];
const BUFFER_MAX = 500;

let installed = false;

/** ISO-8601 UTC to the millisecond. UTC, not local: a log correlated against a ledger block or a
 *  provider's `expiration` is being read beside timestamps that are already UTC, and a local
 *  timezone silently reintroduces the skew `parseProviderInstant` exists to refuse. */
function stamp(): string {
  return new Date().toISOString();
}

function write(level: string, parts: unknown[]): void {
  const line = `${stamp()} ${level} ${parts.map(p => (p instanceof Error ? `${p.message}` : typeof p === 'string' ? p : safeJson(p))).join(' ')}`;
  buffer.push(line);
  if (buffer.length > BUFFER_MAX) buffer.shift();
  // Fire-and-forget. NOT awaited anywhere, by design: a payment must never wait on a log write, and
  // a rejected promise here must never surface as an unhandled rejection on the money path.
  try {
    void DpayCore.appendLog?.(line)?.catch?.(() => {});
  } catch {
    // The native module is absent (web wallet / older build). The in-memory buffer is the whole log.
  }
}

/** JSON that cannot throw — a circular or exotic value becomes a marker rather than an exception
 *  raised from inside a logger. */
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return '[unserialisable]';
  }
}

/**
 * Mirror `console.warn`/`console.error` into the file. Idempotent, and safe to call before the
 * native module exists.
 *
 * Called once at startup (`App.tsx`). It patches rather than wraps the call sites because the value
 * of this log is precisely the lines nobody remembered to add: the money paths already warn on
 * every refusal, every unusable provider answer and every indefinite outcome, and those warnings
 * are the diagnostics worth keeping.
 */
export function installLogSink(): void {
  if (installed) return;
  installed = true;
  const warn = console.warn.bind(console);
  const error = console.error.bind(console);
  console.warn = (...args: unknown[]) => { warn(...args); write('WARN ', args); };
  console.error = (...args: unknown[]) => { error(...args); write('ERROR', args); };
  write('INFO ', ['log sink installed']);
}

/**
 * Record a money-path fact that is NOT an error — the ones a post-mortem needs and a console would
 * never carry, because nothing went wrong: which asset was picked, which quote, which block index
 * was submitted. Routed through `console.warn` on purpose rather than straight to the file, so a
 * developer watching logcat sees the same story the file will tell.
 */
export function logMoney(message: string): void {
  console.warn(`money: ${message}`);
}

/** The in-memory tail, newest last. For tests and for any future in-app diagnostics screen. */
export function logTail(): string[] {
  return [...buffer];
}
