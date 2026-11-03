package ai.vani.app

import android.content.Context
import com.github.csukuangfj.piper.phonemize.piperPhonemizeInitialize
import com.github.csukuangfj.piper.phonemize.piperPhonemizeText
import com.k2fsa.sherpa.onnx.GenerationConfig

/** Offline text frontend for the four-voice Paradee/Kokoro-compatible pack. */
internal object ParadeeFrontend {
    @Volatile private var initialized = false

    @Synchronized
    private fun initialize(ctx: Context) {
        if (!initialized) {
            piperPhonemizeInitialize(ctx.applicationContext)
            initialized = true
        }
    }

    private fun british(sid: Int) = sid == 1 || sid == 3

    /** Build a phoneme-input GenerationConfig, bypassing any large lexicon in
     *  the downloadable pack. Each chunk stays below Paradee's 512-token cap. */
    fun config(ctx: Context, text: String, sid: Int, speed: Float): GenerationConfig {
        initialize(ctx)
        val voice = if (british(sid)) "en-gb" else "en-us"
        val result = piperPhonemizeText(text, voice)
            ?: throw IllegalStateException("Could not phonemize text")
        val chunks = try {
            val out = mutableListOf<IntArray>()
            for (i in 0 until result.numSentences) {
                val phonemes = ParadeePhonemes.convert(result.getPhonemes(i), british(sid))
                var begin = 0
                while (begin < phonemes.size) {
                    var end = minOf(begin + 480, phonemes.size)
                    if (end < phonemes.size) {
                        val space = (end - 1 downTo begin + 1).firstOrNull { phonemes[it] == 32 }
                        if (space != null) end = space + 1
                    }
                    out.add(phonemes.copyOfRange(begin, end))
                    begin = end
                }
            }
            out.toTypedArray()
        } finally {
            result.close()
        }
        return GenerationConfig(
            silenceScale = 0.2f,
            sid = sid.coerceIn(0, 3),
            speed = speed.coerceIn(0.5f, 2.0f),
            phonemeCodepoints = chunks,
        )
    }
}
