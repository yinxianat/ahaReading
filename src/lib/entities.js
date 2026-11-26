/**
 * HTML entity decoding, shared by the server's extractors and the reader (Markdown text
 * from `marked` keeps entities like &amp; as written). Pure, no imports, client-safe.
 */

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  mdash: "—", ndash: "–", hellip: "…", lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”", bdquo: "„",
  laquo: "«", raquo: "»", lsaquo: "‹", rsaquo: "›", middot: "·", bull: "•", deg: "°", times: "×", divide: "÷",
  copy: "©", reg: "®", trade: "™", sect: "§", para: "¶", dagger: "†", Dagger: "‡", prime: "′", Prime: "″",
  euro: "€", pound: "£", yen: "¥", cent: "¢", plusmn: "±", frac12: "½", frac14: "¼", frac34: "¾",
  larr: "←", rarr: "→", uarr: "↑", darr: "↓", harr: "↔", le: "≤", ge: "≥", ne: "≠", asymp: "≈", minus: "−",
  iexcl: "¡", iquest: "¿", shy: "", zwj: "", zwnj: "",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", Aacute: "Á", Eacute: "É",
  agrave: "à", egrave: "è", ograve: "ò", acirc: "â", ecirc: "ê", ocirc: "ô", auml: "ä", euml: "ë",
  ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß", ccedil: "ç", ntilde: "ñ", oslash: "ø", aring: "å",
};

/**
 * Decode HTML entities (named subset + all numeric forms).
 * @param {string} text
 * @returns {string}
 */
export function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      // Reject surrogates, out-of-range and NUL — they'd produce invalid strings.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�";
      return String.fromCodePoint(code);
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : match;
  });
}
