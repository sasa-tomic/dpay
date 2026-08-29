import {Pressable, Text, View} from 'react-native';
import {C} from '../config/palette';
import {S} from '../styles';
import {useCopyFeedback} from '../hooks/useCopyFeedback';
import {IconCopy} from './icons';
import {InstrLine} from './InstrLine';
import {M} from '../i18n';

/**
 * "Already on the Internet Computer?" — the plain-transfer receive route, shared by the family
 * deposit sheets (founder 2026-08-29: useful practical instructions on every funding step). Every
 * chain-key asset is ALSO an ICRC-1 ledger token: anyone already holding ckBTC/ckUSDC/ckETH on the
 * IC can transfer it straight to THIS user's principal — no Bitcoin/Ethereum hop, no minter wait,
 * no gas. The symbol MUST be the ledger token symbol (ckBTC, never BTC — plain BTC cannot be sent
 * to an IC principal), so the caller passes it from the catalog descriptor. The parent sheet's
 * existing ledger watch detects such a transfer as a normal baseline delta.
 */
export function IcrcAccountSection({symbol, principal}: {symbol: string; principal: string | null}) {
  const {copied, copy} = useCopyFeedback();
  return (
    <View testID="ic-also-section" style={S.instrCard}>
      <Text style={S.depositStatusTitle}>{M.deposit.icrc.alsoTitle}</Text>
      <InstrLine runs={M.deposit.icrc.alsoBody(symbol)} />
      {principal != null ? (
        <>
          <Text testID="ic-also-address" style={S.sheetAddr} selectable={true}>{principal}</Text>
          <Pressable
            testID="btn-ic-also-copy"
            accessibilityRole="button"
            accessibilityLabel={copied === 'clipboard' ? M.deposit.addressCopied : copied === 'shared' ? M.deposit.addressShared : M.deposit.ck.copyDepositAddress}
            style={[S.primaryWide, S.depositCopy]}
            onPress={() => { void copy(principal); }}>
            <IconCopy size={18} color={C.brandInk}/>
            <Text style={S.primaryText}>{copied === 'clipboard' ? M.deposit.copied : copied === 'shared' ? M.deposit.shared : M.deposit.copyAddress}</Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}
