// Shared Solana address constants. Lives in its own module so tx.ts and spl.ts can both reference
// the System Program address without a tx.ts↔spl.ts import cycle (spl.ts already imports the
// message-assembly primitives from tx.ts).

/** System Program (transfers + account/rent machinery — a create-ATA account, not a signer). */
export const SYSTEM_PROGRAM_ADDRESS = '11111111111111111111111111111111';
