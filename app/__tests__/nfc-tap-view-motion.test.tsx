/**
 * NfcTapView — phase render smoke for the J5 motion system (fake timers, Walkthrough.test.tsx
 * pattern). Pins the ONE-beat-per-phase mount contract (each phase renders exactly its own
 * motion element and never another phase's) and the honest-money rule: the campaign language
 * appears ONLY on the gated offline-peak success — pending/declined/error must stay calm and
 * free of any settled mark (the dpay stamp ring was dropped by founder directive 2026-08-24).
 * Phase title/sub textContent stays byte-stable (e2e contracts are pinned by
 * nfc-tap-view.test.ts; this suite renders the component itself).
 */
import React from 'react';
import {describe, expect, test, jest, beforeEach, afterEach} from '@jest/globals';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import {NfcTapView} from '../components/NfcTapView';
import type {NfcTapPhase} from '../hooks/useNfcTapState';

let tree: renderer.ReactTestRenderer;
// Host-node-only matcher: RN's View/Text are forwardRef wrappers, so props.testID matches BOTH
// the logical component fiber and its host fiber — count host elements exactly once (the
// Walkthrough.test.tsx unique-testID pattern, made structural).
const find = (id: string) => tree.root.findAll(n => n.props.testID === id && typeof n.type === 'string');
const mount = async (phase: NfcTapPhase, props: Partial<Parameters<typeof NfcTapView>[0]> = {}) => {
  await act(async () => {
    tree = renderer.create(
      <NfcTapView phase={phase} reason={null} role="card" testID="nfc-status"
        formattedAmt="∂25.00" networkLabel="IC" onClose={() => {}} {...props} />,
    );
  });
};

describe('NfcTapView J5 motion — one beat per phase', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { act(() => tree?.unmount()); jest.useRealTimers(); });

  test('listening: breathing ring present, nothing else moves', async () => {
    await mount('listening');
    expect(find('tap-breath')).toHaveLength(1);
    expect(find('tap-progress')).toHaveLength(0);
    expect(find('tap-key-beat')).toHaveLength(0);
    expect(find('tap-ellipsis')).toHaveLength(0);
    expect(find('nfc-status').length).toBeGreaterThan(0);
  });

  test('linking/exchanging/settling: itinerary line at 1/2/3 lit segments, no breath', async () => {
    await mount('linking');
    expect(find('tap-progress')).toHaveLength(1);
    expect(find('tap-progress-seg-1')).toHaveLength(1);
    expect(find('tap-progress-seg-2')).toHaveLength(0);
    expect(find('tap-progress-seg-3')).toHaveLength(0);
    expect(find('tap-breath')).toHaveLength(0);

    await act(async () => { tree.update(<NfcTapView phase="exchanging" reason={null} role="card" testID="nfc-status" formattedAmt="∂25.00" networkLabel="IC" onClose={() => {}} />); });
    expect(find('tap-progress')).toHaveLength(1);
    expect(find('tap-progress-seg-1')).toHaveLength(1);
    expect(find('tap-progress-seg-2')).toHaveLength(1);
    expect(find('tap-progress-seg-3')).toHaveLength(0);

    await act(async () => { tree.update(<NfcTapView phase="settling" reason={null} role="card" testID="nfc-status" formattedAmt="∂25.00" networkLabel="IC" onClose={() => {}} />); });
    expect(find('tap-progress-seg-1')).toHaveLength(1);
    expect(find('tap-progress-seg-2')).toHaveLength(1);
    expect(find('tap-progress-seg-3')).toHaveLength(1);
  });

  test('awaitingApproval (reader): the key beat replaces the spinner line (held at 2 segments)', async () => {
    await mount('awaitingApproval');
    expect(find('tap-key-beat')).toHaveLength(1);
    expect(find('tap-progress')).toHaveLength(1);
    expect(find('tap-progress-seg-3')).toHaveLength(0);
  });

  test('exchanging (card): the read-only send hint rides the status, not a button', async () => {
    await mount('exchanging');
    const text = tree.root.findAllByType(Text).map(t => String(t.props.children)).join(' ');
    expect(text).toContain('Hold the phones together to send');
    expect(text).toContain('Paying ∂25.00 on IC');
  });

  test('success: no breath/progress/ellipsis — the badge + title carry it', async () => {
    await mount('success');
    expect(find('tap-breath')).toHaveLength(0);
    expect(find('tap-progress')).toHaveLength(0);
    expect(find('tap-ellipsis')).toHaveLength(0);
    // The confirmed amount rides the title (byte-stable contract).
    const title = tree.root.findAllByType(Text).map(t => t.props.children).join(' ');
    expect(title).toContain('Paid ✓ ∂25.00');
  });

  test('HONESTY: pending/declined/error carry NO campaign line and NO settled mark — ever', async () => {
    await mount('pending');
    for (const phase of ['pending', 'declined', 'error'] as NfcTapPhase[]) {
      await act(async () => { tree.update(<NfcTapView phase={phase} reason={null} role="card" testID="nfc-status" formattedAmt="∂25.00" networkLabel="IC" onClose={() => {}} />); });
      expect(find('offline-peak')).toHaveLength(0);
      const text = tree.root.findAllByType(Text).map(t => String(t.props.children)).join(' ');
      expect(text).not.toContain("Don't need it");
      expect(text).not.toContain('settled');
    }
  });

  test('pending: deliberate stillness — the unhurried ellipsis, no line, no breath', async () => {
    await mount('pending');
    expect(find('tap-ellipsis')).toHaveLength(1);
    expect(find('tap-progress')).toHaveLength(0);
    expect(find('tap-breath')).toHaveLength(0);
    expect(find('tap-shake')).toHaveLength(0);
  });

  test('declined/error: the restrained shake-settle wraps the badge, then stillness', async () => {
    await mount('declined');
    expect(find('tap-shake')).toHaveLength(1);
    await act(async () => { tree.update(<NfcTapView phase="error" reason={null} role="card" testID="nfc-status" formattedAmt="∂25.00" networkLabel="IC" onClose={() => {}} />); });
    expect(find('tap-shake')).toHaveLength(1);
  });

  test('the offline peak mounts ABOVE the success badge only when the caller gates it on', async () => {
    await mount('success', {offlinePeak: true});
    expect(find('offline-peak')).toHaveLength(1);
    // During the moment: the campaign line is present (byte-exact, single-sourced constant).
    const during = tree.root.findAllByType(Text).map(t => String(t.props.children)).join(' ');
    expect(during).toContain("Signal? Don't need it.");
    // Auto-settles into the remnant on the same timer (deterministic e2e catch): the wrapper
    // testID PERSISTS (mounted-but-settled) and the remnant mark appears.
    await act(async () => { jest.advanceTimersByTime(2500); });
    expect(find('offline-peak')).toHaveLength(1);
    expect(find('first-offline-stamp')).toHaveLength(1);
  });

  test('the campaign moment is GONE by settle time: remnant carries no campaign line', async () => {
    await mount('success', {offlinePeak: true});
    await act(async () => { jest.advanceTimersByTime(2500); });
    const text = tree.root.findAllByType(Text).map(t => String(t.props.children)).join(' ');
    expect(text).toContain('paid with no signal');
    expect(text).not.toContain("Signal? Don't need it.");
  });
});
