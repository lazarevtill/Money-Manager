package dev.moneymanager.gates

import android.opengl.EGL14
import android.opengl.GLES20
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Content
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.Message
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import kotlin.system.measureTimeMillis

/**
 * Weeks 1-2 gates. See docs/plan/2026-08-03-weeks-1-2-gate-runbook.md.
 *
 * These run as INSTRUMENTED tests, not an adb-shell CLI, deliberately: SELinux domain, app
 * memory limits and GPU driver context all differ in app context, and the runbook requires at
 * least one green V29 reproduced from an installed APK. A CLI-only green does not transfer.
 *
 * Model is NOT bundled (3.66 GB, and Gemma weights are licence-gated). Push it first:
 *   adb push gemma-4-E4B-it.litertlm \
 *     /sdcard/Android/data/dev.moneymanager.gates/files/model.litertlm
 * That path is writable by adb and readable by the app with no runtime permission.
 *
 * Results land as JSON next to the model and are pulled with:
 *   adb pull /sdcard/Android/data/dev.moneymanager.gates/files/gate-results.json
 */
@RunWith(AndroidJUnit4::class)
class GateTests {

    private val ctx = InstrumentationRegistry.getInstrumentation().targetContext
    private val filesDir: File get() = ctx.getExternalFilesDir(null)!!
    private val modelFile: File get() = File(filesDir, "model.litertlm")

    /** Every result carries provenance, or it is not usable later (runbook §1, R-ENG-1). */
    private fun provenance(backend: String) = JSONObject().apply {
        put("litertlm_version", LITERTLM_VERSION)
        put("model_file", modelFile.name)
        put("model_sha256_prefix", modelSha256Prefix())
        put("model_bytes", modelFile.length())
        put("backend", backend)
        put("soc_manufacturer", android.os.Build.SOC_MANUFACTURER)
        put("soc_model", android.os.Build.SOC_MODEL)
        put("device", android.os.Build.MODEL)
        put("android_sdk", android.os.Build.VERSION.SDK_INT)
        put("gl_renderer", glRenderer())
        put("gl_version", glVersion())
        put("page_size", pageSize())
        put("thermal", thermalSnapshot())
    }

    /**
     * Thermal and power state. The runbook requires this and the harness did not capture it,
     * which made the first V29 attempt uninterpretable: max performance mode had been set by
     * hand, and nothing in the result recorded that.
     *
     * A sustained-load gate that does not record thermal state cannot distinguish "the GPU
     * driver is fine" from "the device throttled so hard it never got stressed".
     */
    private fun thermalSnapshot(): JSONObject = JSONObject().apply {
        val pm = ctx.getSystemService(android.os.PowerManager::class.java)
        // 0 NONE · 1 LIGHT · 2 MODERATE · 3 SEVERE · 4 CRITICAL · 5 EMERGENCY · 6 SHUTDOWN
        put("thermal_status", runCatching { pm.currentThermalStatus }.getOrDefault(-1))
        put("power_save_mode", runCatching { pm.isPowerSaveMode }.getOrDefault(false))
        put(
            "sustained_perf_supported",
            runCatching { pm.isSustainedPerformanceModeSupported }.getOrDefault(false)
        )
        put("battery_temp_c", batteryTempC())
        put("uptime_ms", android.os.SystemClock.elapsedRealtime())
    }

    /** Battery temperature in tenths of a degree C, per BatteryManager. */
    private fun batteryTempC(): Double = runCatching {
        val i = ctx.registerReceiver(
            null, android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED)
        )
        (i?.getIntExtra(android.os.BatteryManager.EXTRA_TEMPERATURE, -1) ?: -1) / 10.0
    }.getOrDefault(-1.0)

    private fun requireModel() = assumeTrue(
        "Model absent at ${modelFile.absolutePath} — push it before running the gates.",
        modelFile.exists() && modelFile.length() > 0
    )

    private fun engine(backend: Backend): Engine =
        Engine(EngineConfig(modelPath = modelFile.absolutePath, backend = backend))
            .also { it.initialize() }

    // ---------------------------------------------------------------- device profile

    /**
     * Not a gate. Captures the device profile and proves the provenance path works.
     *
     * Deliberately does NOT call requireModel(): every other test skips without the model, so
     * until one runs, none of the provenance code has ever executed. EGL context creation
     * inside an instrumented test is exactly the kind of thing that fails silently — finding
     * that out during a device session, with a 3.66 GB model already pushed, wastes the session.
     *
     * Run this first on any new device. It answers "is this device slot A or slot B" from
     * GL_RENDERER rather than from the model number, which is the ground truth.
     */
    @Test
    fun deviceProfile() {
        val p = provenance("n/a")
        val out = JSONObject().put("gate", "device-profile").put("provenance", p)
            .put("model_present", modelFile.exists())
            .put("model_path", modelFile.absolutePath)
        record(out)

        val renderer = p.optString("gl_renderer")
        assert(!renderer.startsWith("unavailable")) {
            "GL_RENDERER unreadable ($renderer) — provenance would be blank for every gate result"
        }
        assert(p.optLong("page_size") > 0) { "PAGE_SIZE unreadable" }
        // Mali means slot A (V29 is meaningful); Adreno means slot B (V29 cannot run here).
        android.util.Log.i("GATES", "DEVICE PROFILE: $p")
    }

    // ---------------------------------------------------------------- V34

    /**
     * V34 — false-ready smoke. Does the engine report ready when a model section failed to mmap?
     * A known-answer inference after every init, failing closed (#2545). This is not only a
     * spike: it becomes invariant R-ENG-2 in the shipped app.
     */
    @Test
    fun v34_knownAnswerSmoke() {
        requireModel()
        val out = JSONObject().put("gate", "V34").put("provenance", provenance("CPU"))
        engine(Backend.CPU()).use { eng ->
            eng.createConversation().use { conv ->
                val reply = conv.sendMessage(
                    "Reply with exactly one word and nothing else: the capital city of France."
                ).text()
                out.put("reply", reply)
                val ok = reply.contains("Paris", ignoreCase = true)
                out.put("pass", ok)
                record(out)
                assert(ok) { "Engine reported ready but failed a known-answer smoke: '$reply'" }
            }
        }
    }

    // ---------------------------------------------------------------- V13

    /**
     * V13 — clone independence. Two concurrent conversations must not share mutable state.
     * If they do, a background re-extraction would corrupt a foreground one.
     */
    @Test
    fun v13_cloneIndependence() {
        requireModel()
        val out = JSONObject().put("gate", "V13").put("provenance", provenance("CPU"))
        engine(Backend.CPU()).use { eng ->
            eng.createConversation().use { a ->
                eng.createConversation().use { b ->
                    a.sendMessage("Remember the number 41. Reply OK.")
                    val bReply =
                        b.sendMessage("What number were you asked to remember? If none, say NONE.").text()
                    // b must NOT know about 41 — leakage means shared state.
                    val leaked = bReply.contains("41")
                    out.put("b_reply", bReply).put("leaked", leaked).put("pass", !leaked)
                    record(out)
                    assert(!leaked) { "Conversation state leaked between clones: '$bReply'" }
                }
            }
        }
    }

    // ---------------------------------------------------------------- V0

    /**
     * V0 — digit fidelity. PASS/FAIL, not a score: anything below 100% exact on amount and date
     * means silent corruption in production. Fixtures live in DigitFixtures.
     */
    @Test
    fun v0_digitFidelity_cpu() = runDigitFidelity(Backend.CPU(), "CPU")

    @Test
    fun v0_digitFidelity_gpu() = runDigitFidelity(Backend.GPU(), "GPU")

    private fun runDigitFidelity(backend: Backend, label: String) {
        requireModel()
        val out = JSONObject().put("gate", "V0").put("provenance", provenance(label))
        val failures = JSONArray()
        var exact = 0
        engine(backend).use { eng ->
            for (f in DigitFixtures.all) {
                eng.createConversation().use { conv ->
                    val reply = conv.sendMessage(DigitFixtures.prompt(f.input)).text()
                    val p = DigitFixtures.parseAndNormalise(reply, f.currency)
                    if (p.minorUnits == f.expectedAmount) exact++
                    else failures.put(
                        JSONObject().put("input", f.input)
                            .put("expected", f.expectedAmount)
                            .put("got", p.minorUnits)
                            .put("amount_text", p.amountText)
                            .put("currency", p.currency)
                            // Separates "the model misread the digits" from "our normaliser
                            // could not classify them" — different bugs, different owners.
                            .put("note", p.note)
                            .put("raw", reply)
                    )
                }
            }
        }
        out.put("total", DigitFixtures.all.size).put("exact", exact).put("failures", failures)
        out.put("pass", exact == DigitFixtures.all.size)
        record(out)
        assert(exact == DigitFixtures.all.size) {
            "V0 is pass/fail: $exact/${DigitFixtures.all.size} exact on $label. " +
                "Any miss is silent corruption in production."
        }
    }

    // ---------------------------------------------------------------- V29

    /**
     * V29 — Mali multi-turn GPU stability. The gate that decides the product's shape.
     *
     * NOTE ON READING THE RESULT: #2421 reports CL_INVALID_COMMAND_QUEUE on Mali-G715 /
     * Tensor G4. A green on Mali-G78 (Exynos 2100) licenses a G78-class allowlist entry ONLY.
     * It does not close V29 and does not license "GPU everywhere". A red here is more
     * informative than a green.
     *
     * Method: 3 cold starts x (20 fresh conversations + 20 turns within one conversation) = 120.
     */
    @Test
    fun v29_maliMultiTurnGpu() {
        requireModel()
        val out = JSONObject().put("gate", "V29").put("provenance", provenance("GPU"))
        val rssSamples = JSONArray()
        var turns = 0
        var firstError: String? = null

        outer@ for (coldStart in 1..COLD_STARTS) {
            try {
                engine(Backend.GPU()).use { eng ->
                    repeat(FRESH_TURNS) {
                        eng.createConversation().use { c -> c.sendMessage(DigitFixtures.all[it % DigitFixtures.all.size].let { f -> DigitFixtures.prompt(f.input) }) }
                        turns++
                    }
                    eng.createConversation().use { conv ->
                        repeat(MULTI_TURNS) { i ->
                            conv.sendMessage(DigitFixtures.prompt(DigitFixtures.all[i % DigitFixtures.all.size].input))
                            turns++
                            // Checkpoint to a separate file every turn. The first V29 attempt
                            // wrote only on completion, so when the device vanished mid-run the
                            // entire result was lost and the gate came back inconclusive.
                            // A gate that can run for 20 minutes must leave evidence as it goes.
                            checkpoint(turns, coldStart, null)
                            // Sample per turn: RSS answers "does it leak", thermal answers
                            // "was it actually under load or did the device throttle away
                            // the stress this gate exists to apply".
                            rssSamples.put(
                                JSONObject().put("turn", turns).put("rss_kb", rssKb())
                                    .put("thermal", thermalSnapshot())
                            )
                        }
                    }
                }
            } catch (t: Throwable) {
                firstError = "coldStart=$coldStart turn=$turns ${t::class.java.simpleName}: ${t.message}"
                checkpoint(turns, coldStart, firstError)
                break@outer
            }
        }

        val expected = COLD_STARTS * (FRESH_TURNS + MULTI_TURNS)
        out.put("turns_completed", turns).put("turns_expected", expected)
            .put("rss_samples", rssSamples).put("first_error", firstError)
            .put("pass", turns == expected && firstError == null)
        record(out)

        assert(firstError == null) { "V29 GPU fault: $firstError" }
        assert(turns == expected) { "V29 incomplete: $turns/$expected turns" }
    }

    // ---------------------------------------------------------------- helpers

    /**
     * sendMessage returns a Message, not a String — the published quickstart is simplified.
     * A reply is a list of Content parts; concatenate the text ones.
     */
    private fun Message.text(): String =
        contents.contents.filterIsInstance<Content.Text>().joinToString("") { it.text }

    /**
     * Crash-survivable progress marker for long gates. Overwrites a single small file rather
     * than appending, so it stays cheap enough to call every turn. Read it after any run that
     * does not produce a verdict — it distinguishes "died at turn 3" from "device unplugged at
     * turn 118", which are completely different findings.
     */
    private fun checkpoint(turns: Int, coldStart: Int, error: String?) {
        runCatching {
            File(filesDir, "v29-progress.json").writeText(
                JSONObject()
                    .put("turns_completed", turns)
                    .put("cold_start", coldStart)
                    .put("error", error)
                    .put("thermal", thermalSnapshot())
                    .put("rss_kb", rssKb())
                    .toString()
            )
        }
    }

    private fun record(o: JSONObject) {
        val f = File(filesDir, "gate-results.json")
        val arr = if (f.exists()) JSONArray(f.readText()) else JSONArray()
        arr.put(o)
        f.writeText(arr.toString(2))
        android.util.Log.i("GATES", o.toString())
    }

    private fun modelSha256Prefix(): String = try {
        val md = java.security.MessageDigest.getInstance("SHA-256")
        modelFile.inputStream().use { ins ->
            val buf = ByteArray(1 shl 20)
            var read = 0
            var total = 0L
            // Hash the first 64 MB only — enough to distinguish artifacts without a
            // multi-minute full pass over 3.66 GB on every run.
            while (total < 64L * 1024 * 1024 && ins.read(buf).also { read = it } > 0) {
                md.update(buf, 0, read); total += read
            }
        }
        md.digest().joinToString("") { "%02x".format(it) }.take(16)
    } catch (t: Throwable) { "unavailable" }

    private fun rssKb(): Long = try {
        File("/proc/self/status").readLines()
            .firstOrNull { it.startsWith("VmRSS:") }
            ?.filter { it.isDigit() }?.toLongOrNull() ?: -1
    } catch (t: Throwable) { -1 }

    private fun pageSize(): Long = try {
        android.system.Os.sysconf(android.system.OsConstants._SC_PAGESIZE)
    } catch (t: Throwable) { -1 }

    private fun glRenderer() = withGl { GLES20.glGetString(GLES20.GL_RENDERER) ?: "unknown" }
    private fun glVersion() = withGl { GLES20.glGetString(GLES20.GL_VERSION) ?: "unknown" }

    /** Minimal offscreen EGL context purely to read the renderer string for provenance. */
    private fun withGl(block: () -> String): String = try {
        val dpy = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
        EGL14.eglInitialize(dpy, IntArray(1), 0, IntArray(1), 0)
        val cfgs = arrayOfNulls<android.opengl.EGLConfig>(1)
        EGL14.eglChooseConfig(
            dpy,
            intArrayOf(
                EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
                EGL14.EGL_SURFACE_TYPE, EGL14.EGL_PBUFFER_BIT, EGL14.EGL_NONE
            ),
            0, cfgs, 0, 1, IntArray(1), 0
        )
        val ctxGl = EGL14.eglCreateContext(
            dpy, cfgs[0], EGL14.EGL_NO_CONTEXT,
            intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE), 0
        )
        val surf = EGL14.eglCreatePbufferSurface(
            dpy, cfgs[0], intArrayOf(EGL14.EGL_WIDTH, 1, EGL14.EGL_HEIGHT, 1, EGL14.EGL_NONE), 0
        )
        EGL14.eglMakeCurrent(dpy, surf, surf, ctxGl)
        val result = block()
        EGL14.eglDestroySurface(dpy, surf)
        EGL14.eglDestroyContext(dpy, ctxGl)
        EGL14.eglTerminate(dpy)
        result
    } catch (t: Throwable) { "unavailable: ${t.message}" }

    companion object {
        const val LITERTLM_VERSION = "0.15.0"
        const val COLD_STARTS = 3
        const val FRESH_TURNS = 20
        const val MULTI_TURNS = 20
    }
}
