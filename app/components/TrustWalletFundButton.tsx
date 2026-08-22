import {useState} from 'react';
import {Pressable, Text, Platform, Linking} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';
import {trustWalletSendUrl, type TrustWalletAsset} from '../trustwallet';
import {IconExternalLink} from './icons';

/** The asset name spoken in the a11y hint (SOL-USDC is a USDC send on Solana). */
const ASSET_LABEL: Record<TrustWalletAsset, string> = {BTC: 'BTC', SOL: 'SOL', 'SOL-USDC': 'USDC'};

/**
 * TrustWalletFundButton — one-tap "Fund from Trust Wallet" (2026-08-17 plan).
 *
 * The SAME ghost-tier secondary on every eligible My-address surface (DepositSheet = mainnet
 * BTC; SolanaReceiveSheet = mainnet SOL + USDC) — the same-surfaces hard rule: this is an
 * Add-money entry point, uniform across eligible rails; ineligible rails simply don't render
 * it (the caller owns eligibility — see isTrustWalletFundableBtc / IS_SOLANA_DEVNET).
 *
 * Android-only: web keeps the WalletConnect story (a browser tab would dead-end the funding
 * funnel, and the e2e harness never sees this button by construction — jest owns its
 * coverage). Fire-and-forget: `Linking.openURL` opens Trust's send screen pre-filled; there
 * is no return callback, and the deposit polling on each surface reconciles the outcome. A
 * throw is treated as transient with honest copy (Trust absent → the https link itself
 * already routes to a download landing, so an openURL failure is not the not-installed case).
 * Static chrome (no motion) — matches the sibling ghost buttons, so no reduced-motion branch.
 */
export function TrustWalletFundButton({asset, address}: {asset: TrustWalletAsset; address: string}) {
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
        accessibilityLabel="Fund from Trust Wallet"
        accessibilityHint={`Opens Trust Wallet to send ${ASSET_LABEL[asset]} to your dpay address`}
        accessibilityState={{disabled: false}}>
        <IconExternalLink size={16} color={C.sub} />
        <Text style={S.ghostBtnText}>Fund from Trust Wallet</Text>
      </Pressable>
      {failed ? <Text testID="trust-fund-err" style={S.err}>Couldn't open Trust Wallet. Try again.</Text> : null}
    </>
  );
}
