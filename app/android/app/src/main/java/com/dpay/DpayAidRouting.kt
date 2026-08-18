package com.dpay

import android.app.Activity
import android.content.ComponentName
import android.nfc.NfcAdapter
import android.nfc.cardemulation.CardEmulation
import android.os.Build
import com.facebook.react.bridge.ReactApplicationContext

/**
 * Runtime repair for the OS's NFCC AID routing table — the failure mode proven live on Android 12
 * (2026-08-18): after an app update the HCE services re-register but their AIDs are never committed
 * to the routing table, so every reader SELECT is answered 6A82 by the OS itself and dpay code never
 * runs; the reader misreports "not a dpay phone". Only toggling NFC or rebooting used to repair it.
 *
 * Best-effort at arm time (the payer always has the app foreground then — the only moment a tap can
 * be answered anyway); a failure here never blocks arming:
 *   • API 34+: re-register the AID group, forcing a routing recommit for our service only.
 *   • All APIs: bind the foreground Activity as the preferred card service — while the payer is in
 *     the app, routing bypasses the possibly stale table. The OS drops the binding when the Activity
 *     leaves the foreground; [clear] removes it on disarm for hygiene.
 *
 * The hex strings passed in are parity-checked against the manifest <aid-filter> by
 * `just aid-parity` — a drifted one would REPLACE the good manifest group with a wrong AID.
 */
internal object DpayAidRouting {
    /** Re-commit routing for [service]/[aidHex]; returns the Activity bound as preferred, if any. */
    fun ensure(context: ReactApplicationContext, service: Class<*>, aidHex: String): Activity? {
        val adapter = NfcAdapter.getDefaultAdapter(context) ?: return null
        return try {
            val ce = CardEmulation.getInstance(adapter)
            val svc = ComponentName(context, service)
            if (Build.VERSION.SDK_INT >= 34 &&
                !ce.registerAidsForService(svc, CardEmulation.CATEGORY_OTHER, listOf(aidHex))
            ) {
                android.util.Log.w("dpay", "AID re-registration returned false for $aidHex")
            }
            val activity = context.currentActivity
            if (activity != null && ce.setPreferredService(activity, svc)) activity else null
        } catch (e: Throwable) {
            android.util.Log.w("dpay", "AID routing repair failed for $aidHex — degrading to the routing table", e)
            null
        }
    }

    /** Drop the preferred-service binding set by a successful [ensure]. */
    fun clear(activity: Activity?) {
        if (activity == null) return
        try {
            val adapter = NfcAdapter.getDefaultAdapter(activity) ?: return
            CardEmulation.getInstance(adapter).unsetPreferredService(activity)
        } catch (e: Throwable) {
            android.util.Log.w("dpay", "unsetPreferredService failed", e)
        }
    }
}
