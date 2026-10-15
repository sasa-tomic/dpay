// Typed jest stub for `react-native-webview` (the Mt Pelerin in-app embed, 2026-10-15).
//
// The embed loads the venue's widget inside the app; under jest there is no native webview
// module (and the flow tier runs the app against a real relay with NO browser). This
// moduleNameMapper stub (`^react-native-webview$` → this file, wired in jest.config.js) makes
// every jest project resolve the specifier here — the real native module is never loaded, so
// adding the dependency cannot break the offline tiers (the walletconnect-stub pattern).
//
// The stub renders a MARKER VIEW carrying the embed URL as its testID (flow tests assert the
// embed by its full tokenized URL) plus the URL as visible text (so `bodyText`/`waitForText`
// assertions can check `widget.mtpelerin.com` and the reviewed parameters without building
// the exact string). The wrapping sheet adds the stable `mtp-widget-embed` container testID.
//
// Type fidelity: tsc still resolves the REAL react-native-webview types for production code
// (it ignores moduleNameMapper), so `MtpWidgetEmbed`'s `<WebView …/>` usage is checked against
// the genuine surface. Lives under `__stubs__/` (NOT `__tests__/`) so jest's default testMatch
// does not pick it up as a suite.
import React from 'react';
import {Text, View} from 'react-native';

type WebViewStubProps = {
  source?: {uri?: string};
  testID?: string;
  style?: unknown;
  // The embed passes the real module's loading props through; the stub renders instantly and
  // ignores them. Structural (not `any`): unknown extra props stay a type error here.
  startInLoadingState?: boolean;
  onError?: unknown;
  renderLoading?: unknown;
  javaScriptEnabled?: boolean;
  domStorageEnabled?: boolean;
};

export function WebView({source, testID: _nativeTestID}: WebViewStubProps) {
  const uri = typeof source?.uri === 'string' ? source.uri : '';
  return (
    <View testID={uri} accessibilityLabel={uri}>
      <Text testID="mtp-widget-embed-url">{uri}</Text>
    </View>
  );
}

export default WebView;
