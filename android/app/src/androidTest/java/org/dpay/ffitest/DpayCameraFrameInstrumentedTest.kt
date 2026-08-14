package org.dpay.ffitest

import android.content.Context
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Device gate for the FRAME half of the camera pipeline: asserts ImageAnalysis frames actually
 * FLOW from the back camera — the exact class of the emulator/field bug where the session
 * opens, the preview surface exists, yet 0 frames reach the analyzer ("scanner opens but never
 * scans", vision-camera logging invokeOnAverageFpsChanged(0.0) forever).
 *
 * Mirrors the react-native-vision-camera stack: CameraX 1.5.0-alpha03 ImageAnalysis +
 * ProcessCameraProvider on the BACK lens. If the camera HAL/AVD config is broken this goes RED
 * with an explicit count, instead of shipping a scanner that never fires.
 */
@RunWith(AndroidJUnit4::class)
class DpayCameraFrameInstrumentedTest {

    private class TestOwner : LifecycleOwner {
        private val registry = LifecycleRegistry(this)
        override fun getLifecycle(): Lifecycle = registry
        fun start() {
            registry.currentState = Lifecycle.State.RESUMED
        }
        fun destroy() {
            registry.currentState = Lifecycle.State.DESTROYED
        }
    }

    @Test
    fun backCameraDeliversAnalysisFrames() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        // CAMERA is a runtime permission; adopt shell identity so the target process can open
        // the camera without UI permission dialogs in the instrumented run.
        instrumentation.uiAutomation.adoptShellPermissionIdentity()
        val context: Context = instrumentation.targetContext
        val owner = TestOwner()
        val frames = AtomicInteger(0)
        val analysisExecutor: ExecutorService = Executors.newSingleThreadExecutor()
        val analysisRef = arrayOfNulls<ImageAnalysis>(1)
        try {
            instrumentation.runOnMainSync { owner.start() }
            val providerFuture = ProcessCameraProvider.getInstance(context)
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
            analysisRef[0] = analysis
            analysis.setAnalyzer(analysisExecutor) { _: ImageProxy -> frames.incrementAndGet() }
            instrumentation.runOnMainSync {
                val provider = providerFuture.get(20, TimeUnit.SECONDS)
                provider.unbindAll()
                provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, Preview.Builder().build(), analysis)
            }

            // A working camera delivers tens of frames/sec; even a slow emulator must produce
            // several within 15s. 0 frames == the silent-scanner bug class, fail loud.
            Thread.sleep(15_000)
            val count = frames.get()
            assertTrue(
                "back camera delivered 0 ImageAnalysis frames in 15s — the scanner would open " +
                    "but never fire (check AVD hw.camera.* config / camera HAL)",
                count > 0
            )
        } finally {
            analysisRef[0]?.clearAnalyzer()
            analysisExecutor.shutdown()
            instrumentation.runOnMainSync { owner.destroy() }
        }
    }
}
