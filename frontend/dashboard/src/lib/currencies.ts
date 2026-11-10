// Every currency an organization may choose as its default: the ISO 4217 codes the Organization Service accepts (app/currencies.py: ISO_4217), with their
// names, so the first-time setup and Settings offer the same complete list. Plain data: no rates, no conversion. The list is fixed (not read from the
// browser's runtime) so the server and the browser always render the same options. The Organization Service is the final judge; a test compares the
// two lists.

export const CURRENCIES: readonly (readonly [code: string, name: string])[] = [
  ["AED", "UAE Dirham"], ["AFN", "Afghan Afghani"], ["ALL", "Albanian Lek"], ["AMD", "Armenian Dram"], ["ANG", "Netherlands Antillean Guilder"], ["AOA", "Angolan Kwanza"],
  ["ARS", "Argentine Peso"], ["AUD", "Australian Dollar"], ["AWG", "Aruban Florin"], ["AZN", "Azerbaijani Manat"], ["BAM", "Bosnia-Herzegovina Convertible Mark"],
  ["BBD", "Barbadian Dollar"], ["BDT", "Bangladeshi Taka"], ["BGN", "Bulgarian Lev"], ["BHD", "Bahraini Dinar"], ["BIF", "Burundian Franc"], ["BMD", "Bermudian Dollar"],
  ["BND", "Brunei Dollar"], ["BOB", "Bolivian Boliviano"], ["BRL", "Brazilian Real"], ["BSD", "Bahamian Dollar"], ["BTN", "Bhutanese Ngultrum"], ["BWP", "Botswana Pula"],
  ["BYN", "Belarusian Ruble"], ["BZD", "Belize Dollar"], ["CAD", "Canadian Dollar"], ["CDF", "Congolese Franc"], ["CHF", "Swiss Franc"], ["CLP", "Chilean Peso"],
  ["CNY", "Chinese Yuan"], ["COP", "Colombian Peso"], ["CRC", "Costa Rican Colón"], ["CUP", "Cuban Peso"], ["CVE", "Cape Verdean Escudo"], ["CZK", "Czech Koruna"],
  ["DJF", "Djiboutian Franc"], ["DKK", "Danish Krone"], ["DOP", "Dominican Peso"], ["DZD", "Algerian Dinar"], ["EGP", "Egyptian Pound"], ["ERN", "Eritrean Nakfa"],
  ["ETB", "Ethiopian Birr"], ["EUR", "Euro"], ["FJD", "Fijian Dollar"], ["FKP", "Falkland Islands Pound"], ["GBP", "British Pound Sterling"], ["GEL", "Georgian Lari"],
  ["GHS", "Ghanaian Cedi"], ["GIP", "Gibraltar Pound"], ["GMD", "Gambian Dalasi"], ["GNF", "Guinean Franc"], ["GTQ", "Guatemalan Quetzal"], ["GYD", "Guyanese Dollar"],
  ["HKD", "Hong Kong Dollar"], ["HNL", "Honduran Lempira"], ["HTG", "Haitian Gourde"], ["HUF", "Hungarian Forint"], ["IDR", "Indonesian Rupiah"], ["ILS", "Israeli New Shekel"],
  ["INR", "Indian Rupee"], ["IQD", "Iraqi Dinar"], ["IRR", "Iranian Rial"], ["ISK", "Icelandic Króna"], ["JMD", "Jamaican Dollar"], ["JOD", "Jordanian Dinar"],
  ["JPY", "Japanese Yen"], ["KES", "Kenyan Shilling"], ["KGS", "Kyrgyzstani Som"], ["KHR", "Cambodian Riel"], ["KMF", "Comorian Franc"], ["KPW", "North Korean Won"],
  ["KRW", "South Korean Won"], ["KWD", "Kuwaiti Dinar"], ["KYD", "Cayman Islands Dollar"], ["KZT", "Kazakhstani Tenge"], ["LAK", "Lao Kip"], ["LBP", "Lebanese Pound"],
  ["LKR", "Sri Lankan Rupee"], ["LRD", "Liberian Dollar"], ["LSL", "Lesotho Loti"], ["LYD", "Libyan Dinar"], ["MAD", "Moroccan Dirham"], ["MDL", "Moldovan Leu"],
  ["MGA", "Malagasy Ariary"], ["MKD", "Macedonian Denar"], ["MMK", "Myanmar Kyat"], ["MNT", "Mongolian Tögrög"], ["MOP", "Macanese Pataca"], ["MRU", "Mauritanian Ouguiya"],
  ["MUR", "Mauritian Rupee"], ["MVR", "Maldivian Rufiyaa"], ["MWK", "Malawian Kwacha"], ["MXN", "Mexican Peso"], ["MYR", "Malaysian Ringgit"], ["MZN", "Mozambican Metical"],
  ["NAD", "Namibian Dollar"], ["NGN", "Nigerian Naira"], ["NIO", "Nicaraguan Córdoba"], ["NOK", "Norwegian Krone"], ["NPR", "Nepalese Rupee"], ["NZD", "New Zealand Dollar"],
  ["OMR", "Omani Rial"], ["PAB", "Panamanian Balboa"], ["PEN", "Peruvian Sol"], ["PGK", "Papua New Guinean Kina"], ["PHP", "Philippine Peso"], ["PKR", "Pakistani Rupee"],
  ["PLN", "Polish Złoty"], ["PYG", "Paraguayan Guaraní"], ["QAR", "Qatari Riyal"], ["RON", "Romanian Leu"], ["RSD", "Serbian Dinar"], ["RUB", "Russian Ruble"],
  ["RWF", "Rwandan Franc"], ["SAR", "Saudi Riyal"], ["SBD", "Solomon Islands Dollar"], ["SCR", "Seychellois Rupee"], ["SDG", "Sudanese Pound"], ["SEK", "Swedish Krona"],
  ["SGD", "Singapore Dollar"], ["SHP", "Saint Helena Pound"], ["SLE", "Sierra Leonean Leone"], ["SOS", "Somali Shilling"], ["SRD", "Surinamese Dollar"],
  ["SSP", "South Sudanese Pound"], ["STN", "São Tomé and Príncipe Dobra"], ["SVC", "Salvadoran Colón"], ["SYP", "Syrian Pound"], ["SZL", "Swazi Lilangeni"],
  ["THB", "Thai Baht"], ["TJS", "Tajikistani Somoni"], ["TMT", "Turkmenistani Manat"], ["TND", "Tunisian Dinar"], ["TOP", "Tongan Paʻanga"], ["TRY", "Turkish Lira"],
  ["TTD", "Trinidad and Tobago Dollar"], ["TWD", "New Taiwan Dollar"], ["TZS", "Tanzanian Shilling"], ["UAH", "Ukrainian Hryvnia"], ["UGX", "Ugandan Shilling"],
  ["USD", "US Dollar"], ["UYU", "Uruguayan Peso"], ["UZS", "Uzbekistani Som"], ["VES", "Venezuelan Bolívar"], ["VND", "Vietnamese Dong"], ["VUV", "Vanuatu Vatu"],
  ["WST", "Samoan Tala"], ["XAF", "Central African CFA Franc"], ["XCD", "East Caribbean Dollar"], ["XOF", "West African CFA Franc"], ["XPF", "CFP Franc"],
  ["YER", "Yemeni Rial"], ["ZAR", "South African Rand"], ["ZMW", "Zambian Kwacha"], ["ZWL", "Zimbabwean Dollar"],
];

export const CURRENCY_CODES: string[] = CURRENCIES.map(([code]) => code);

const NAMES = new Map<string, string>(CURRENCIES.map(([code, name]) => [code, name]));

/** "USD — US Dollar" (just the code for one that is not in the list). */
export const currencyLabel = (code: string): string => (NAMES.has(code) ? `${code} — ${NAMES.get(code)}` : code);

export const isKnownCurrency = (code: unknown): code is string => typeof code === "string" && NAMES.has(code);

/** What the first-time setup may send: exactly one of the listed codes (capitals; nothing else is a currency). */
export function checkCurrency(value: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof value !== "string" || !NAMES.has(value)) return { ok: false, message: "Choose your currency from the list." };
  return { ok: true, value };
}
