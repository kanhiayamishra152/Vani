package ai.vani.app

/**
 * Convert eSpeak IPA into the symbols Paradee was trained on.
 * Adapted from Paradee's Apache-2.0 web/misaki.js and the Apache-2.0
 * Paradee-1.2-Android adapter. Piper returns decomposed Unicode code points,
 * so handle decomposed ç and syllabic markers before emitting code points.
 */
internal object ParadeePhonemes {
    private val replacements = listOf(
        "ʔˌn̩" to "ʔn", "ʔn̩" to "ʔn", "aɪ" to "I", "aʊ" to "W",
        "dʒ" to "ʤ", "eɪ" to "A", "e" to "A", "tʃ" to "ʧ", "ɔɪ" to "Y",
        "ʲo" to "jo", "ʲə" to "jə", "ʲ" to "", "ɚ" to "əɹ", "r" to "ɹ",
        "x" to "k", "ç" to "k", "ɬ" to "l", "̃" to ""
    )
    private val syllabic = Regex("(\\S)̩")
    private val finalSchwaL = Regex("əl(?=[\\s;:,.!?—…\\x22“”()]|$)")
    private val schwa = Regex("ɐ")
    private val wordDelimiters = ";:,.!?—…“”()"
    private fun isBoundary(c: Char): Boolean = c.isWhitespace() || c in wordDelimiters || c == '"'
    private val britishThe = Regex("(^|\\s)ðɪ(?=\\s|$)")

    fun convert(phonemes: IntArray, british: Boolean): IntArray {
        var text = String(phonemes, 0, phonemes.size)
            .replace("c\u0327", "ç")
            .replace("\u0361", "")
        if (british) text = text.replace("eə", "ɛː")
        for ((from, to) in replacements) text = text.replace(from, to)
        text = syllabic.replace(text) { "ᵊ" + it.groupValues[1] }.replace("̩", "")
        text = finalSchwaL.replace(text, "ᵊl")
        val beforeSchwaConversion = text
        text = schwa.replace(beforeSchwaConversion) { match ->
            val start = match.range.first
            val wordStart = start == 0 || isBoundary(beforeSchwaConversion[start - 1])
            val next = start + 1
            val wordEnd = next == beforeSchwaConversion.length || isBoundary(beforeSchwaConversion[next])
            val britishAn = british && next < beforeSchwaConversion.length && beforeSchwaConversion[next] == 'n' &&
                (next + 1 == beforeSchwaConversion.length || isBoundary(beforeSchwaConversion[next + 1]))
            if (wordStart && (wordEnd || britishAn)) "ɐ" else "ə"
        }
        if (british) {
            text = text.replace("iə", "ɪə").replace("əʊ", "Q")
            text = britishThe.replace(text) { it.groupValues[1] + "ði" }
        } else {
            text = text.replace("oʊ", "O").replace("ɜːɹ", "ɜɹ").replace("ɜː", "ɜɹ")
                .replace("ɪə", "iə").replace("ː", "")
        }
        text = text.replace("o", "ɔ").replace("ɾ", "T").replace("ʔ", "t")
        val result = IntArray(text.codePointCount(0, text.length))
        var offset = 0
        for (i in result.indices) {
            val cp = Character.codePointAt(text, offset)
            result[i] = cp
            offset += Character.charCount(cp)
        }
        return result
    }
}
