/**
 * @format
 */

// WalletConnect v2 polyfills — MUST be the first imports (before any app code) so the globals they
// install (crypto.getRandomValues, Buffer, TextEncoder, ...) are in place before the WC SDK or any
// consumer reads them. MC8 U6.4. Order matters: get-random-values first (compat/relies on it).
import 'react-native-get-random-values';
import '@walletconnect/react-native-compat';

import {AppRegistry} from 'react-native';
import App from './App';
import {name as appName} from './app.json';

AppRegistry.registerComponent(appName, () => App);
