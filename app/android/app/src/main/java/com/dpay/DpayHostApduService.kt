package com.dpay

import android.nfc.cardemulation.HostApduService
import android.os.Bundle

/**
 * The payer-side NFC card. Android routes APDUs addressed to dpay's AID (see res/xml/apduservice.xml,
 * registered under category "other" so there is no clash with Google Wallet's payment AIDs) to this
 * service, which is a thin loop over the shared core's [FfiCardSession] via [DpayNfc].
 *
 * `processCommandApdu` must return quickly and never throw — [DpayNfc.onCardApdu] guarantees both.
 */
class DpayHostApduService : HostApduService() {
    override fun processCommandApdu(commandApdu: ByteArray?, extras: Bundle?): ByteArray {
        val cmd = commandApdu ?: return byteArrayOf(0x67, 0x00) // wrong length
        return DpayNfc.onCardApdu(cmd)
    }

    override fun onDeactivated(reason: Int) {
        DpayNfc.onCardDeactivated()
    }
}
