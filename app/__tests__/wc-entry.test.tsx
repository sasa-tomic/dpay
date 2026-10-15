/**
 * WcEntrySheet - the WalletConnect entry + connected-dapps surface (founder directive
 * 2026-10-15: WalletConnect needs more than opening wc: - discoverability, instructions, and a
 * way to see and drop live sessions).
 *
 *   - `connectedAppOf` extracts the row facts from a settled session (topic, the dApp's own
 *     metadata name/url, the CAIP-2 chains across namespaces) without trusting any of them.
 *   - The sheet renders one row per session: name (url when the name is absent), the chain
 *     names through the review sheet's own `wcChainName`, and Disconnect per row - pressed with
 *     the session's TOPIC, disabled only while that topic's disconnect is in flight.
 *   - The empty state is NO section at all (the instruction block above is the empty state -
 *     the copy law: no empty-section chrome), and a loading list renders nothing either.
 *   - The failed-disconnect line renders under the list with the retry one tap away; the scan
 *     button is the sheet's primary action and closes it over the live camera.
 */
import {describe, test, expect, jest} from '@jest/globals';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {Text} from 'react-native';
import {WcEntrySheet, connectedAppOf, type WcConnectedApp} from '../components/WcEntrySheet';
import {M} from '../i18n';
import type {WcSession} from '../walletkit';

const SOL_CHAIN = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

function fakeSession(topic: string, name: string | null, chains: string[]): WcSession {
  return {
    topic,
    peer: {metadata: {name, url: 'https://app.example.invalid', icons: []}},
    namespaces: {eip155: {chains, accounts: [`${chains[0]}:0xabc`]}},
  } as unknown as WcSession;
}

function textOf(children: unknown): string {
  if (children == null || typeof children === 'boolean') return '';
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(textOf).join('');
  const el = children as {props?: {children?: unknown}};
  return el.props ? textOf(el.props.children) : '';
}

function texts(tree: renderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).map((n) => textOf(n.props.children));
}

type SheetProps = Parameters<typeof WcEntrySheet>[0];

function mountSheet(props: Partial<SheetProps> = {}): renderer.ReactTestRenderer {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <WcEntrySheet
        sessions={null}
        busyTopic={null}
        failed={false}
        onScan={() => {}}
        onDisconnect={() => {}}
        onClose={() => {}}
        {...props}
      />,
    );
  });
  return tree;
}

function byTestID(tree: renderer.ReactTestRenderer, id: string): Array<renderer.ReactTestInstance> {
  return tree.root.findAll((n) => n.props.testID === id);
}

/** The node (host trees carry a testID on more than one fiber; presence + [0] is the house
 *  convention - PayMode.test.tsx's helpers), or undefined. */
function firstByTestID(tree: renderer.ReactTestRenderer, id: string): renderer.ReactTestInstance | undefined {
  return byTestID(tree, id)[0];
}

describe('connectedAppOf - the row facts of a settled session', () => {
  test('topic + metadata name/url + the chains across namespaces', () => {
    const row = connectedAppOf(fakeSession('t1', 'Example App', ['eip155:1', 'eip155:42161']));
    expect(row).toEqual({topic: 't1', name: 'Example App', url: 'https://app.example.invalid', chains: ['eip155:1', 'eip155:42161']});
  });

  test('a session with no metadata name keeps the url and never lies', () => {
    const row = connectedAppOf(fakeSession('t2', null, ['eip155:1']));
    expect(row.name).toBe('');
    expect(row.url).toBe('https://app.example.invalid');
  });
});

describe('WcEntrySheet', () => {
  const ROWS: WcConnectedApp[] = [
    {topic: 't1', name: 'Example App', url: 'https://app.example.invalid', chains: ['eip155:1', 'eip155:42161']},
    {topic: 't2', name: '', url: 'https://other.example.invalid', chains: [SOL_CHAIN]},
  ];

  test('sessions render as rows: name, the chain NAMES, Disconnect per row', () => {
    const tree = mountSheet({sessions: ROWS});
    expect(texts(tree)).toContain(M.pay.wc.sessionsTitle);
    expect(texts(tree)).toContain('Example App');
    expect(texts(tree)).toContain('https://other.example.invalid'); // the no-name fallback
    expect(texts(tree)).toContain('Ethereum, Arbitrum One'); // wcChainName, not raw CAIP-2
    expect(texts(tree)).toContain('Solana');
    expect(firstByTestID(tree, 'wc-session-t1')).toBeDefined();
    expect(firstByTestID(tree, 'wc-session-t2')).toBeDefined();
    expect(firstByTestID(tree, 'btn-wc-disconnect-t1')).toBeDefined();
    expect(firstByTestID(tree, 'btn-wc-disconnect-t2')).toBeDefined();
  });

  test('Disconnect presses with the session topic; only the busy topic is disabled', () => {
    const onDisconnect = jest.fn<(topic: string) => void>();
    const tree = mountSheet({sessions: ROWS, busyTopic: 't2', onDisconnect});
    const busy = firstByTestID(tree, 'btn-wc-disconnect-t2')!;
    expect(busy.props.disabled).toBe(true);
    expect(busy.props.accessibilityState).toEqual({disabled: true});
    const free = firstByTestID(tree, 'btn-wc-disconnect-t1')!;
    expect(free.props.disabled).toBe(false);
    act(() => {
      free.props.onPress();
    });
    expect(onDisconnect).toHaveBeenCalledWith('t1');
  });

  test('empty sessions render NO list section (the instructions are the empty state); loading renders nothing either', () => {
    expect(texts(mountSheet({sessions: []}))).not.toContain(M.pay.wc.sessionsTitle);
    expect(texts(mountSheet({sessions: null}))).not.toContain(M.pay.wc.sessionsTitle);
  });

  test('a failed disconnect states the retry under the list; success renders no line', () => {
    const failed = mountSheet({sessions: ROWS, failed: true});
    const line = firstByTestID(failed, 'wc-disconnect-failed');
    expect(line).toBeDefined();
    expect(line!.props.children).toBe(M.pay.wc.disconnectFailed);
    expect(byTestID(mountSheet({sessions: ROWS, failed: false}), 'wc-disconnect-failed')).toHaveLength(0);
  });

  test('the scan button is the primary action and closes over the live camera', () => {
    const onScan = jest.fn<() => void>();
    const tree = mountSheet({onScan});
    expect(firstByTestID(tree, 'btn-wc-entry-scan')).toBeDefined();
    expect(texts(tree)).toContain(M.pay.wc.entryScan);
    act(() => {
      firstByTestID(tree, 'btn-wc-entry-scan')!.props.onPress();
    });
    expect(onScan).toHaveBeenCalledTimes(1);
  });

  test('the instruction block carries exactly the four facts, each stated once', () => {
    const lines = texts(mountSheet({sessions: ROWS}));
    for (const key of ['entryWhat', 'entryHow', 'entryHonest', 'entryDisconnect'] as const) {
      expect(lines.filter((t) => t === M.pay.wc[key])).toHaveLength(1);
    }
    expect(texts(mountSheet({})).filter((t) => t === M.pay.wc.connectEntry)).toHaveLength(1); // title, not duplicated
  });
});
