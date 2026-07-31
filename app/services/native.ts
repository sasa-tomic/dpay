import {NativeModules} from 'react-native';
import type {DpayCoreApi, DpayNfcApi} from '../lib/types';

// Single destructuring point for the native-module bindings (constraint §0.4): the shims mutate
// `NativeModules` before App evaluates (entry.tsx imports shims first), and this module is imported
// transitively by App, so the read order is identical to the prior inline destructure.
export const {DpayCore, DpayNfc} = NativeModules as {DpayCore: DpayCoreApi; DpayNfc: DpayNfcApi};
