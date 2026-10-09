import {NativeModules, Platform} from 'react-native';

/** The payment-complete beep (founder 2026-10-09): fire-and-forget sound at a payment's terminal
 *  success ONLY (QR settle, confirmed NFC tap), never on sign, submit or hand-off. An earlier
 *  chime would celebrate money that has not moved. Native plays a short notification tone through
 *  DpayBeep (ToneGenerator, no asset, no permission); web synthesizes a two-note A5→E6 blip via
 *  WebAudio. Every failure is swallowed by design: acoustic feedback must never become an error
 *  surface. */
export function beepPaymentComplete(): void {
  try {
    if (Platform.OS === 'web') {
      const g = globalThis as {
        AudioContext?: new () => AudioContextLike;
        webkitAudioContext?: new () => AudioContextLike;
      };
      const Ctx = g.AudioContext ?? g.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const now = ctx.currentTime;
      // A5 then E6: the two-note "done". Each note swells and decays; the second starts as the
      // first fades, so the pair reads as one confirmation, not two.
      [880, 1318.5].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const t0 = now + i * 0.12;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t0);
        osc.stop(t0 + 0.18);
      });
      setTimeout(() => {
        try {
          void ctx.close();
        } catch {
          // the context is done either way
        }
      }, 600);
      return;
    }
    const mod = (NativeModules as Record<string, {play?: () => void} | undefined>).DpayBeep;
    if (mod && typeof mod.play === 'function') mod.play();
  } catch {
    // best-effort by design
  }
}

/** The slice of WebAudio the beep uses (a full DOM lib import for two oscillators is not worth it). */
interface AudioContextLike {
  currentTime: number;
  destination: unknown;
  createOscillator: () => {
    type: string;
    frequency: {value: number};
    connect: (dest: unknown) => void;
    start: (t: number) => void;
    stop: (t: number) => void;
  };
  createGain: () => {
    gain: {
      setValueAtTime: (v: number, t: number) => void;
      exponentialRampToValueAtTime: (v: number, t: number) => void;
    };
    connect: (dest: unknown) => void;
  };
  close: () => Promise<void>;
}
