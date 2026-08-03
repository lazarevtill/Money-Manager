package dev.moneymanager.gates

/**
 * Deterministic amount_text -> integer minor units.
 *
 * This exists because V0 proved the model cannot be trusted to do the conversion: on
 * "$1.250.000,00" (COP) Gemma 4 E4B returned 1250000 instead of 125000000 — a 100x
 * under-report, silent, and in the currency `app-layers.md` §4.3 had already singled out.
 *
 * §4.3's rule is therefore not a precaution, it is a measured requirement: the model emits
 * `amount_text` verbatim and a `currency_guess`; THIS code produces the number.
 *
 * Ambiguity is returned, never guessed. "1.299" in a Mexican receipt is genuinely undecidable
 * between 1299 and 1.299 without more context, and a wrong guess is a 100x error.
 */
object MoneyNormaliser {

    /** ISO 4217 exponents for the currencies in scope. Not a full table by design. */
    private val EXPONENTS = mapOf(
        "MXN" to 2, "BRL" to 2, "COP" to 2, "USD" to 2, "EUR" to 2,
        "ARS" to 2, "PEN" to 2, "UYU" to 2,
        "CLP" to 0, "PYG" to 0, "JPY" to 0, "VND" to 0, "KRW" to 0,
        "BHD" to 3, "KWD" to 3, "TND" to 3, "JOD" to 3
    )

    sealed interface Result {
        data class Ok(val minorUnits: Long, val exponent: Int) : Result
        data class Ambiguous(val reason: String, val candidates: List<Long>) : Result
        data class Invalid(val reason: String) : Result
    }

    fun exponentFor(currency: String): Int? = EXPONENTS[currency.uppercase()]

    fun toMinorUnits(amountText: String, currency: String): Result {
        val exp = exponentFor(currency)
            ?: return Result.Invalid("unknown currency exponent for '$currency'")

        // Strip everything that is not a digit or a separator: currency symbols, codes,
        // NBSPs, stray spaces. Keep '-' only if leading.
        val negative = amountText.trim().startsWith("-")
        val cleaned = amountText.filter { it.isDigit() || it == '.' || it == ',' }
        if (cleaned.isEmpty()) return Result.Invalid("no digits in '$amountText'")

        val dots = cleaned.count { it == '.' }
        val commas = cleaned.count { it == ',' }

        val decimalSep: Char? = when {
            // Both present: the RIGHTMOST is the decimal separator. Unambiguous.
            dots > 0 && commas > 0 -> if (cleaned.lastIndexOf('.') > cleaned.lastIndexOf(',')) '.' else ','
            // Neither: a bare integer.
            dots == 0 && commas == 0 -> null
            else -> {
                val sep = if (dots > 0) '.' else ','
                val count = if (dots > 0) dots else commas
                val tail = cleaned.substringAfterLast(sep)
                when {
                    // Repeated separator can only be grouping: 1.250.000
                    count > 1 -> null
                    // A 0-decimal currency has no decimal separator, so it must be grouping.
                    exp == 0 -> null
                    // Exactly `exp` trailing digits -> decimal. 89,90 with exp 2.
                    tail.length == exp -> sep
                    // Exactly 3 trailing digits -> grouping. 45.990.
                    tail.length == 3 -> null
                    else -> return Result.Invalid(
                        "cannot classify separator '$sep' with $tail.length trailing digits in '$amountText'"
                    )
                }
            }
        }

        // The genuinely undecidable case §4.3 names: one separator, exactly 3 trailing digits,
        // on a 2-decimal currency. "1.299" is 1299 or 1.299 and nothing in the string says which.
        if (decimalSep == null && exp == 2 && (dots + commas) == 1) {
            val sep = if (dots == 1) '.' else ','
            val tail = cleaned.substringAfterLast(sep)
            if (tail.length == 3) {
                val asGrouped = cleaned.replace(sep.toString(), "").toLongOrNull()
                val asDecimal = cleaned.substringBeforeLast(sep).toLongOrNull()
                if (asGrouped != null && asDecimal != null) {
                    return Result.Ambiguous(
                        "single '$sep' with 3 trailing digits on a 2-decimal currency",
                        listOf(asGrouped * pow10(exp), asDecimal * pow10(exp) + tail.toLong())
                    )
                }
            }
        }

        val digitsOnly: String
        val fraction: String
        if (decimalSep == null) {
            digitsOnly = cleaned.filter { it.isDigit() }
            fraction = ""
        } else {
            digitsOnly = cleaned.substringBeforeLast(decimalSep).filter { it.isDigit() }
            fraction = cleaned.substringAfterLast(decimalSep).filter { it.isDigit() }
        }
        if (fraction.length > exp) {
            return Result.Invalid("$fraction has more than $exp decimal places for $currency")
        }

        val major = (if (digitsOnly.isEmpty()) "0" else digitsOnly).toLongOrNull()
            ?: return Result.Invalid("major part not a number in '$amountText'")
        val minorPart = fraction.padEnd(exp, '0').ifEmpty { "0" }.toLong()
        val total = major * pow10(exp) + minorPart

        // The schema's hard bound: op-sqlite reads every integer through a double.
        if (total > 9007199254740991L) return Result.Invalid("exceeds 2^53-1")

        return Result.Ok(if (negative) -total else total, exp)
    }

    private fun pow10(n: Int): Long {
        var r = 1L
        repeat(n) { r *= 10 }
        return r
    }
}
