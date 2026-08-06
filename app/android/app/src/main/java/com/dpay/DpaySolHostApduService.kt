package com.dpay

import android.nfc.cardemulation.HostApduService
import android.os.Bundle

/**
 * The SOL payer-side NFC card. Android routes APDUs addressed to the SOL AID (see
 * res/xml/solapduservice.xml) to this service, which is a thin loop over [DpaySolNfc] — pure Kotlin
 * transport, no Rust core. `processCommandApdu` must return quickly and never throw; [DpaySolNfc]
 * guarantees both.
 */
class DpaySolHostApduService : HostApduService() {
    override fun processCommandApdu(commandApdu: ByteArray?, extras: Bundle?): ByteArray {
        val cmd = commandApdu ?: return byteArrayOf(0x67, 0x00) // wrong length
        return DpaySolNfc.onCardApdu(cmd)
    }

    override fun onDeactivated(reason: Int) {
        DpaySolNfc.onCardDeactivated()
    }
}
