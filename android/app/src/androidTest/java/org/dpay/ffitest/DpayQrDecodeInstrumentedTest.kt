package org.dpay.ffitest

import android.graphics.BitmapFactory
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Device gate for the QR SCAN half of the camera pipeline — the piece `just verify` is structurally
 * blind to (the browser e2e shims the camera entirely).
 *
 * DpayQrDecodeInstrumentedTest decodes a bundled QR bitmap with the EXACT MLKit barcode API that
 * react-native-vision-camera's CodeScannerPipeline uses on-device (BarcodeScanning.getClient with
 * QR_FORMAT, InputImage.fromMediaImage path mirrored by fromBitmap). If the MLKit native model is
 * missing/broken on this device (the class of bug where the scanner "opens but never scans"), this
 * test goes RED with an explicit error instead of silently timing out.
 *
 * The camera HAL/preview half (frames actually flowing from the sensor) is covered by the emulator
 * camera config (hw.camera.back) + the DPAY_QR_CAM diagnostic in the app; MLKit decode is the
 * deterministic half and is fully testable without a live sensor.
 */
@RunWith(AndroidJUnit4::class)
class DpayQrDecodeInstrumentedTest {

    @Test
    fun mlKitDecodesBundledQr() {
        val instr = InstrumentationRegistry.getInstrumentation()
        val bitmap = instr.context.assets.open("testqr.png").use { BitmapFactory.decodeStream(it) }
        assertTrue("bundled testqr.png failed to decode as a bitmap", bitmap != null)

        val options = BarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .build()
        val scanner = BarcodeScanning.getClient(options)

        val latch = CountDownLatch(1)
        val result = arrayOfNulls<List<Barcode>>(1)
        val err = arrayOfNulls<Exception>(1)
        scanner.process(InputImage.fromBitmap(bitmap, 0))
            .addOnSuccessListener { barcodes ->
                result[0] = barcodes
                latch.countDown()
            }
            .addOnFailureListener { e ->
                err[0] = e
                latch.countDown()
            }

        assertTrue(
            "MLKit barcode scan did not complete within 20s — the MLKit model is likely " +
                "missing/unavailable on this device (scanner would open but never fire onCodeScanned)",
            latch.await(20, TimeUnit.SECONDS)
        )
        err[0]?.let { throw IllegalStateException("MLKit barcode scan failed on-device: ${it.message}", it) }

        val barcodes = result[0].orEmpty()
        assertTrue(
            "MLKit found no QR in the bundled bitmap (expected payload 'dpay:req:v2:TESTQRSCENE')",
            barcodes.isNotEmpty()
        )
        assertEquals(
            "decoded QR payload mismatch",
            "dpay:req:v2:TESTQRSCENE",
            barcodes.first().rawValue
        )
        scanner.close()
    }
}
