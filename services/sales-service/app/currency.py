"""ISO 4217 currency codes accepted on invoices.

An invoice has ONE currency and nothing here converts between currencies: the code is only checked to be a real three-letter ISO 4217
code, so a typo ("USS") is refused instead of silently creating an invoice nobody can reconcile. The list is deliberately plain
data - no exchange rates, no jurisdiction-specific rules.
"""

ISO_4217 = frozenset(
    """
    AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CUP CVE CZK
    DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF
    KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK
    PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX
    USD UYU UZS VES VND VUV WST XAF XCD XOF XPF YER ZAR ZMW ZWL
    """.split()
)


def is_known_currency(code: str) -> bool:
    return code in ISO_4217
