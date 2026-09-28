/**
 * NfcStatusRow — one case per NFC state, because the four states are the whole reason this row
 * takes `NfcStatus` and not a boolean.
 *
 * WHAT IS ACTUALLY BEING PINNED: that a user who cannot tap is told WHICH thing is wrong and what
 * to do instead, and that the three ways of not being able to tap say three DIFFERENT things.
 * Collapsed to `ready: boolean`, "NFC is switched off in settings" (fixable by the user), "this
 * phone has no NFC hardware" (not fixable) and "the probe failed" (unknown) render the same
 * sentence — which is the founder's 2026-08-29 rule broken in the smallest possible way, and the
 * defect this suite would catch if the collapse were ever reintroduced.
 *
 * Deliberately NOT re-tested here: the popup's open/close mechanics beyond one round trip, and the
 * row's use inside PayMode/SolPayMode (`PayMode.test.tsx` / `SolPayMode.test.tsx` already mount it
 * through those screens). The Receive-side ROUTING — which of the two NFC lines the merchant's
 * request screen shows — is pinned in `ReceiveMode.test.tsx`, not duplicated here.
 */
import {describe, test, expect, afterEach} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Platform, Text} from 'react-native';

import {NfcStatusRow} from '../components/NfcStatusRow';
import {S} from '../styles';
import {M} from '../i18n';
import type {NfcStatus} from '../lib/types';

/** Every rendered Text, flattened — the row's copy carries no testIDs of its own. */
function texts(tree: renderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).map(n => {
    const c = n.props.children;
    return typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => typeof x === 'string').join('') : '';
  });
}

function mount(nfcStatus: NfcStatus) {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(<NfcStatusRow nfcStatus={nfcStatus} testID="nfc-row" />);
  });
  return tree;
}

/** Open the "why" popup and return the body sentence it renders. Selected by the body STYLE rather
 *  than by position: the row's own "NFC not available" link is still on screen behind the modal, so
 *  a text-order heuristic reads the link instead of the explanation. */
function openReason(tree: renderer.ReactTestRenderer): string {
  const link = tree.root.findAll(n => n.props && n.props.accessibilityLabel === M.pay.whyNfcUnavailable)[0];
  act(() => { link.props.onPress(); });
  expect(texts(tree)).toContain(M.pay.nfcUnavailableTitle);
  const body = tree.root.findAllByType(Text).filter(n => n.props.style === S.nfcInfoBody);
  expect(body).toHaveLength(1);
  return String(body[0].props.children);
}

afterEach(() => { (Platform as {OS: string}).OS = 'ios'; });

describe('NfcStatusRow — one instruction per NFC state', () => {
  test('ready: the row invites a tap and offers no "why", because nothing is wrong', () => {
    const tree = mount('ready');
    expect(texts(tree)).toContain(M.pay.tapOrScanToPay);
    expect(tree.root.findAll(n => n.props && n.props.accessibilityLabel === M.pay.whyNfcUnavailable)).toHaveLength(0);
    // The fallback instruction belongs to the not-ready branch only — showing "scan instead" beside
    // a working radio would tell the user to do the slower thing for no reason.
    expect(texts(tree)).not.toContain(M.pay.nfcNotAvailable);
  });

  test('off: the radio is switched off, and the reason says to switch it on', () => {
    const tree = mount('off');
    expect(texts(tree)).toContain(M.pay.nfcNotAvailable);
    expect(openReason(tree)).toBe(M.nfc.reason.off);
  });

  test('unsupported: the phone has no NFC hardware — a different fact from a switch', () => {
    const tree = mount('unsupported');
    expect(texts(tree)).toContain(M.pay.nfcNotAvailable);
    expect(openReason(tree)).toBe(M.nfc.reason.unsupported);
  });

  test('unknown: the probe itself failed, and is not reported as an absent radio', () => {
    const tree = mount('unknown');
    expect(texts(tree)).toContain(M.pay.nfcNotAvailable);
    expect(openReason(tree)).toBe(M.nfc.reason.unknown);
  });

  test('the three not-ready reasons are three DIFFERENT sentences (the boolean collapse)', () => {
    const said = (['off', 'unsupported', 'unknown'] as const).map(s => openReason(mount(s)));
    expect(new Set(said).size).toBe(3);
    expect(said.every(s => s.length > 0)).toBe(true);
  });

  test('(web) no radio: the honest not-ready row with the unsupported reason, never a scan title', () => {
    // G1 (2026-09-28): the web branch used to render the scan title here, which duplicated the
    // ModeToggle's own "Scan to pay" segment on every send-capable surface. The row now states the
    // device fact (no NFC hardware) with the same treatment as a native phone without the radio,
    // and the scan phase carries its own carrier outside this component.
    (Platform as {OS: string}).OS = 'web';
    const tree = mount('unknown');
    expect(texts(tree)).toContain(M.pay.nfcNotAvailable);
    expect(openReason(tree)).toBe(M.nfc.reason.unsupported); // web 'unknown' IS the hardware fact
    expect(texts(tree)).not.toContain(M.pay.scanToPay);
  });

  test('(web) a probe that reports ready still renders the ready row (the seam is truth)', () => {
    (Platform as {OS: string}).OS = 'web';
    const tree = mount('ready');
    expect(texts(tree)).toContain(M.pay.tapOrScanToPay);
    expect(texts(tree)).not.toContain(M.pay.nfcNotAvailable);
  });
});
