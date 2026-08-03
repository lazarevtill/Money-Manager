package dev.moneymanager.gates

import org.json.JSONObject

/**
 * V0 fixtures. Real-shaped bank notification strings with known-correct amounts.
 *
 * Chosen to stress the two things that actually break: LATAM decimal convention (dot for
 * thousands, comma for decimals — the exact inverse of US style) and exponent-0 currencies
 * where a trailing ",00" would be a 100x error if misread.
 *
 * Expected values are INTEGER MINOR UNITS, matching the schema invariant. Never a float.
 */
object DigitFixtures {

    data class Fixture(
        val input: String,
        val expectedAmount: Long,   // minor units
        val currency: String,
        val note: String = ""
    )

    /**
     * The model returns JSON only. The schema is described in the prompt because a
     * constrained-decoding grammar constrains sampling but is NOT injected into the prompt —
     * the model otherwise has no idea what it is filling in.
     */
    fun prompt(notification: String): String = """
        Extract the transaction from the bank message below.

        Reply with ONLY a JSON object, no prose, no markdown fence:
        {"amount_text": "<the amount EXACTLY as written>", "currency_guess": "<ISO 4217 code>"}

        Copy amount_text verbatim from the message, including any dots and commas.
        Do NOT convert it, do NOT reformat it, do NOT do arithmetic. Omit the currency
        symbol. Example: for "$1.234,56" reply with "1.234,56".

        <bank_message>
        $notification
        </bank_message>
    """.trimIndent()

    val all: List<Fixture> = listOf(
        // --- LATAM decimal convention: dot groups thousands, comma is the decimal ---
        Fixture(
            "BBVA: Compra por \$1.234,56 en OXXO CENTRO con tarjeta terminada en 4821.",
            123456, "MXN", "dot=thousands, comma=decimal — inverse of US"
        ),
        Fixture(
            "Nubank: Compra aprovada de R\$ 89,90 em PADARIA SAO JOAO.",
            8990, "BRL", "comma decimal, no thousands separator"
        ),
        Fixture(
            "Bancolombia: Compra por \$1.250.000,00 en ALMACEN EXITO.",
            125000000, "COP", "two thousands groups — a dropped group is a 1000x error"
        ),

        // --- 0-decimal currency: a trailing ,00 misread as decimals is a 100x error ---
        Fixture(
            "Banco de Chile: Compra por \$45.990 en JUMBO COSTANERA.",
            45990, "CLP", "exponent 0 — must NOT become 4599000"
        ),

        // --- US convention, same symbol, different meaning ---
        Fixture(
            "Chase: \$1,234.56 purchase at WHOLE FOODS MKT.",
            123456, "USD", "comma=thousands, dot=decimal"
        ),

        // --- digits adjacent to other digits, the classic confusion source ---
        Fixture(
            "Santander: Compra \$99,00 en FARMACIA 24H, tarjeta *1234, folio 567890.",
            9900, "MXN", "card digits and folio must not be read as the amount"
        ),
        Fixture(
            "Itau: Compra de R\$ 1.099,00 em MAGAZINE LUIZA parcelada em 3x de R\$ 366,33.",
            109900, "BRL", "installments present — total, not the instalment"
        ),

        // --- small amounts, where a dropped leading digit is easy to miss ---
        Fixture(
            "Nubank: Compra aprovada de R\$ 7,50 em CAFE EXPRESSO.",
            750, "BRL", "single-digit major unit"
        ),
        Fixture(
            "BBVA: Cargo por \$0,99 en APP STORE.",
            99, "MXN", "sub-unit amount"
        ),

        // --- large amount, near where careless parsing overflows or truncates ---
        Fixture(
            "Bancolombia: Transferencia por \$12.500.000,00 recibida.",
            1250000000, "COP", "large COP value — exercises the wide end of the range"
        )
    )

    /**
     * Parse the model's reply, then normalise DETERMINISTICALLY.
     *
     * V0 measures two separable things and reports which one failed:
     *   1. transcription - did the model copy the digits correctly?
     *   2. normalisation - does our code turn that text into the right minor units?
     *
     * Only the first is the model's job. §4.3 forbids the model doing the second, and V0's
     * first run is why: asked for a number, Gemma 4 E4B returned 1250000 for
     * "$1.250.000,00" COP instead of 125000000.
     */
    data class Parsed(val amountText: String?, val currency: String?, val minorUnits: Long?, val note: String)

    fun parseAndNormalise(reply: String, expectedCurrency: String): Parsed {
        val obj = try {
            val start = reply.indexOf('{'); val end = reply.lastIndexOf('}')
            if (start < 0 || end <= start) null else JSONObject(reply.substring(start, end + 1))
        } catch (t: Throwable) { null } ?: return Parsed(null, null, null, "unparseable JSON")

        val text = obj.optString("amount_text", "").ifBlank { null }
            ?: return Parsed(null, obj.optString("currency_guess", null), null, "no amount_text")
        val cur = obj.optString("currency_guess", "").ifBlank { null } ?: expectedCurrency

        return when (val r = MoneyNormaliser.toMinorUnits(text, cur)) {
            is MoneyNormaliser.Result.Ok -> Parsed(text, cur, r.minorUnits, "ok")
            is MoneyNormaliser.Result.Ambiguous -> Parsed(text, cur, null, "ambiguous: ${r.reason}")
            is MoneyNormaliser.Result.Invalid -> Parsed(text, cur, null, "invalid: ${r.reason}")
        }
    }
}
