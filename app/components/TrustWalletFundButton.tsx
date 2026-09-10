import {useState} from 'react';
import {Pressable, Text, Platform, Linking} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';
import {trustWalletSendUrl, type TrustWalletAsset} from '../trustwallet';
import {IconExternalLink} from './icons';
import {M} from '../i18n';

/** The asset name spoken in the a11y hint. Fixed ids are self-describing; an SPL mint is not (a
 *  base58 pubkey is no symbol), so the caller supplies the token's symbol via `assetName`. */
function assetLabelOf(asset: TrustWalletAsset, assetName?: string): string {
  if (assetName) return assetName;
  if (asset === 'BTC') return 'BTC';
  if (asset === 'SOL') return 'SOL';
  return 'SPL token';
}

/**
 * TrustWalletFundButton — one-tap "Fund from Trust Wallet" (2026-08-17 plan).
 *
 * The SAME ghost-tier secondary on every eligible My-address surface (DepositSheet = mainnet
 * BTC; SolanaReceiveSheet = mainnet SOL + USDC) — the same-surfaces hard rule: this is an
 * Add-money entry point, uniform across eligible rails; ineligible rails simply don't render
 * it (the caller owns eligibility — see isTrustWalletFundableBtc / isSolanaDevnet).
 *
 * Android-only: web keeps the WalletConnect story (a browser tab would dead-end the funding
 * funnel, and the e2e harness never sees this button by construction — jest owns its
 * coverage). Fire-and-forget: `Linking.openURL` opens Trust's send screen pre-filled; there
 * is no return callback, and the deposit polling on each surface reconciles the outcome. A
 * throw is treated as transient with honest copy (Trust absent → the https link itself
 * already routes to a download landing, so an openURL failure is not the not-installed case).
 * Static chrome (no motion) — matches the sibling ghost buttons, so no reduced-motion branch.
 */
export function TrustWalletFundButton({asset, address, assetName}: {asset: TrustWalletAsset; address: string; assetName?: string}) {
  const [failed, setFailed] = useState(false);
  if (Platform.OS !== 'android') return null;
  const open = () => {
    setFailed(false);
    Linking.openURL(trustWalletSendUrl(asset, address)).catch(() => setFailed(true));
  };
  return (
    <>
      <Pressable
        testID="btn-trust-fund"
        style={S.ghostBtn}
        onPress={open}
        accessibilityRole="button"
        accessibilityLabel={M.deposit.trust.fund}
        accessibilityHint={M.deposit.trust.fundHint(assetLabelOf(asset, assetName))}
        accessibilityState={{disabled: false}}>
        <IconExternalLink size={16} color={C.sub} />
        <Text style={S.ghostBtnText}>{M.deposit.trust.fund}</Text>
      </Pressable>
      {failed ? <Text testID="trust-fund-err" style={S.err}>{M.deposit.trust.err}</Text> : null}
    </>
  );
}
