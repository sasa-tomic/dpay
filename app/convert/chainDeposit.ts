// chainDeposit — the CHAIN route's phase-1 deposit leg (2026-09-28): build + verify + sign
// ONE Solana transfer that funds a cefi venue's order, frozen as the record's `solanaLeg`
// (the same leg vocabulary every Solana record carries). The engine submits the identical
// bytes; nothing here ever broadcasts.
//
// Fail-closed posture, the IC prepare's own bar: the venue's deposit address shape is READ
// off the chain before anything signs — a Token-program owner means the venue issued a
// direct token account (plain transfer into it), the System program (or a never-created
// wallet address) means a wallet whose Associated Token Account the tx derives — and an
// unreadable or foreign-owned account refuses the signature rather than guessing. The
// sender side proves its own ATA exists and holds the exact amount before the bytes are
// built. dpay never holds the funds: the transfer is the user's own signature moving their
// own asset to the venue's own address.
import bs58 from 'bs58';
import {loadRpcForSend} from '../solana';
import {
  assembleMessage,
  base58Decode32,
  buildMemoInstruction,
  buildSolTransferInstruction,
  extractSignedTxParts,
  signTransaction,
  bytesEqual,
} from '../solana/tx';
import {
  buildCreateAtaIdempotentInstruction,
  buildSplTransferInstruction,
  decodeSplTokenAmount,
  deriveAta,
  SOL_ATA_SETUP_MIN_LAMPORTS,
  SOL_FEE_LAMPORTS,
  TOKEN_PROGRAM_ADDRESS,
} from '../solana/spl';
import {solanaRpcUrls} from '../config/constants';
import {base64ToBytes} from '../lib/base64';
import {utf8ToBytes} from '../lib/base64url';
import {bytesToHex} from '../lib/format';
import {deriveSolanaKeypair} from '../solana/identity';
import {M} from '../i18n';
import {solAssetOfMint} from '../config/swap';
import {WRAPPED_SOL_MINT_ADDRESS} from '../solana/tokens';

const SYSTEM_PROGRAM_ADDRESS = '11111111111111111111111111111111';

/** The frozen phase-1 deposit leg: the signed bytes + their Solana identity + the venue-
 *  declared death of the blockhash (identical fields to a Jupiter leg). */
export type ChainDepositLeg = {
  signedTxHex: string;
  signature: string;
  lastValidBlockHeight: number;
  /** The chain's own fee quote for THIS message (lamports), when readable. */
  feeLamports: string | null;
};

/** Build, verify, and sign the venue-deposit transfer. NOTHING broadcasts: the caller
 *  freezes the returned leg into the record and the engine submits it.
 *
 *  `depositMint` is the WRAPPED-SOL mint for a native SOL deposit (the registry's stable
 *  id — the venue rows' own convention). `depositMemo`, when the venue issued one, rides
 *  the tx as an SPL Memo instruction. */
export async function buildChainDepositLeg(args: {
  secretHex: string;
  /** The cefi venue id — the deposit address's own provenance (attribution in errors). */
  cefiVenueId: string;
  depositAddress: string;
  depositMint: string;
  amountRaw: string;
  depositMemo?: string;
}): Promise<ChainDepositLeg> {
  const amount = BigInt(args.amountRaw);
  if (amount <= 0n) throw new Error(M.convert.errors.quoteUnavailable('deposit'));
  // The venue's deposit address must BE a Solana pubkey — a non-base58 string (a venue
  // answering in another chain's shape) refuses with the order copy, never the raw
  // decoder error: this gate fires after the order exists, and the user-facing word is
  // ours, not bs58's.
  let depositBytes: Uint8Array;
  try {
    depositBytes = bs58.decode(args.depositAddress);
  } catch {
    throw new Error(M.convert.errors.quoteUnavailable('order'));
  }
  if (depositBytes.length !== 32) {
    throw new Error(M.convert.errors.quoteUnavailable('order'));
  }
  const rpc = await loadRpcForSend();
  const {seed, publicKey} = deriveSolanaKeypair(args.secretHex);
  const senderAddress = bs58.encode(publicKey);
  let depositOwner: string;
  try {
    const [info] = await rpc.getMultipleAccounts(solanaRpcUrls(), [args.depositAddress]);
    depositOwner = info == null ? SYSTEM_PROGRAM_ADDRESS : info.owner;
  } catch {
    throw new Error(M.convert.errors.chainDepositUnreadable);
  }
  const isNativeSol = args.depositMint === WRAPPED_SOL_MINT_ADDRESS;
  const instructions = [];
  if (isNativeSol) {
    if (depositOwner !== SYSTEM_PROGRAM_ADDRESS) {
      throw new Error(M.convert.errors.chainDepositUnreadable);
    }
    // Sender gate: lamports for the transfer + the base fee, read before the signature.
    const lamports = await rpc.getBalance(solanaRpcUrls(), senderAddress).catch(() => null);
    if (lamports == null || BigInt(lamports) < amount + SOL_FEE_LAMPORTS) {
      throw new Error(M.convert.errors.chainSenderShort(inSymOf(args.depositMint)));
    }
    instructions.push(buildSolTransferInstruction(publicKey, base58Decode32(args.depositAddress), amount));
  } else {
    const senderAta = deriveAta(senderAddress, args.depositMint);
    let senderInfo = null;
    let depositShape: 'token' | 'wallet' | null = null;
    try {
      const reads = depositOwner === TOKEN_PROGRAM_ADDRESS
        ? await rpc.getMultipleAccounts(solanaRpcUrls(), [bs58.encode(senderAta)])
        : await rpc.getMultipleAccounts(solanaRpcUrls(), [
            bs58.encode(deriveAta(args.depositAddress, args.depositMint)),
            bs58.encode(senderAta),
          ]);
      if (depositOwner === TOKEN_PROGRAM_ADDRESS) {
        depositShape = 'token';
        senderInfo = reads[0] ?? null;
      } else if (depositOwner === SYSTEM_PROGRAM_ADDRESS) {
        depositShape = 'wallet';
        senderInfo = reads[1] ?? null;
      } else {
        throw new Error('foreign-owner');
      }
    } catch (e) {
      if (e instanceof Error && e.message === 'foreign-owner') {
        throw new Error(M.convert.errors.chainDepositUnreadable);
      }
      throw new Error(M.convert.errors.chainDepositUnreadable);
    }
    if (senderInfo == null || senderInfo.data == null) {
      throw new Error(M.convert.errors.chainSenderEmpty(inSymOf(args.depositMint)));
    }
    const held = decodeSplTokenAmount(base64ToBytes(senderInfo.data[0]), args.depositMint);
    if (held < amount) {
      throw new Error(M.convert.errors.chainSenderShort(inSymOf(args.depositMint)));
    }
    if (depositShape === 'token') {
      instructions.push(buildSplTransferInstruction(
        senderAta, base58Decode32(args.depositAddress), publicKey, amount,
      ));
    } else {
      // A wallet address: the venue's ATA is derived from it and created idempotently in
      // the SAME tx when missing (the sender pays the one-time rent — the send surface's
      // own founder-approved convention), then the transfer lands in the derived account.
      const destAta = deriveAta(args.depositAddress, args.depositMint);
      let destExists: boolean;
      try {
        const [destInfo] = await rpc.getMultipleAccounts(solanaRpcUrls(), [bs58.encode(destAta)]);
        destExists = destInfo != null;
      } catch {
        throw new Error(M.convert.errors.chainDepositUnreadable);
      }
      if (!destExists) {
        const lamports = await rpc.getBalance(solanaRpcUrls(), senderAddress).catch(() => null);
        if (lamports == null || BigInt(lamports) < SOL_ATA_SETUP_MIN_LAMPORTS) {
          throw new Error(M.convert.errors.chainRentShort(inSymOf(args.depositMint)));
        }
        instructions.push(buildCreateAtaIdempotentInstruction(
          publicKey, destAta, base58Decode32(args.depositAddress), base58Decode32(args.depositMint),
        ));
      }
      instructions.push(buildSplTransferInstruction(senderAta, destAta, publicKey, amount));
    }
  }
  if (args.depositMemo != null && args.depositMemo.length > 0) {
    instructions.push(buildMemoInstruction(utf8ToBytes(args.depositMemo)));
  }
  const {blockhash, lastValidBlockHeight} = await rpc.getLatestBlockhash(solanaRpcUrls());
  const message = assembleMessage(publicKey, instructions, base58Decode32(blockhash));
  const signed = signTransaction(message, seed);
  const parts = extractSignedTxParts(signed);
  if (parts == null || !bytesEqual(parts.feePayer, publicKey)) {
    throw new Error(M.convert.errors.quoteUnavailable('shape'));
  }
  let feeLamports: string | null = null;
  try {
    const {quoteSolMessageFee} = await import('../solana');
    const fee = await quoteSolMessageFee(message);
    feeLamports = fee != null ? fee.toString(10) : null;
  } catch {
    feeLamports = null; // an unreadable fee is not a refusal — the line just stays absent
  }
  return {
    signedTxHex: bytesToHex(signed),
    signature: bs58.encode(parts.signature),
    lastValidBlockHeight,
    feeLamports,
  };
}

/** The deposit asset's display symbol — the registry's own names (mint-keyed). */
function inSymOf(mint: string): string {
  return solAssetOfMint(mint)?.symbol ?? mint.slice(0, 4);
}
