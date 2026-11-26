/**
 * Build small, real PDF and .docx files at runtime for upload tests (no binary
 * fixtures in the repo). Used by tests/document-import.test.js, tests/api-upload.test.js
 * and e2e/upload.spec.mjs.
 */
import JSZip from "jszip";
import zlib from "node:zlib";

// WinAnsi encoding: escape PDF string syntax, and write the bullet as its WinAnsi code (0x95).
const pdfString = (s) => `(${String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/•/g, "\\225")})`;

/**
 * A text PDF. Each page is a list of lines {text, y, size?} (y from the bottom, 792 = top).
 * Keep lines under ~85 characters at 12 pt: pdf.js drops text that runs off the page.
 * @param {Array<Array<{text:string, y:number, size?:number}>>} pages
 * @param {{title?: string, encrypt?: boolean}} [options]
 * @returns {Uint8Array}
 */
export function makePdf(pages, { title, encrypt = false } = {}) {
  const objs = [];
  const add = (s) => objs.push(s);
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"); // 1
  const firstContent = 2;
  const firstPage = firstContent + pages.length;
  const pagesId = firstPage + pages.length;
  for (const lines of pages) {
    const ops = lines.map((l) => `BT /F1 ${l.size || 12} Tf 72 ${l.y} Td ${pdfString(l.text)} Tj ET`).join("\n");
    add(`<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`);
  }
  pages.forEach((_, i) =>
    add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${firstContent + i} 0 R /Resources << /Font << /F1 1 0 R >> >> >>`)
  );
  add(`<< /Type /Pages /Kids [${pages.map((_, i) => `${firstPage + i} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const catalogId = objs.length;
  let infoId = null;
  if (title) {
    add(`<< /Title ${pdfString(title)} >>`);
    infoId = objs.length;
  }
  let encryptId = null;
  if (encrypt) {
    // Standard handler, revision 2, with O/U values no empty password matches.
    add(`<< /Filter /Standard /V 1 /R 2 /Length 40 /P -4 /O <${"ab".repeat(32)}> /U <${"cd".repeat(32)}> >>`);
    encryptId = objs.length;
  }

  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  const extras = `${infoId ? ` /Info ${infoId} 0 R` : ""}${encryptId ? ` /Encrypt ${encryptId} 0 R /ID [<${"01".repeat(16)}> <${"01".repeat(16)}>]` : ""}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R${extras} >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(out);
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * A minimal .docx. Blocks: {heading: "text", level?: 1|2} | {p: "text", footnote?: "text"} |
 * {bullet: "text"} | {title: "text"} | {subtitle: "text"} (Word's Title / Subtitle styles).
 * @param {Array<{heading?:string, level?:number, p?:string, footnote?:string, bullet?:string, title?:string, subtitle?:string}>} blocks
 * @param {{extraFiles?: Object<string,string|Uint8Array>, omitDocument?: boolean}} [options]
 * @returns {Promise<Uint8Array>}
 */
export async function makeDocx(blocks, { extraFiles = {}, omitDocument = false } = {}) {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
  );
  const footnotes = [];
  const paragraph = (b) => {
    if (b.title) return `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>${esc(b.title)}</w:t></w:r></w:p>`;
    if (b.subtitle) return `<w:p><w:pPr><w:pStyle w:val="Subtitle"/></w:pPr><w:r><w:t>${esc(b.subtitle)}</w:t></w:r></w:p>`;
    if (b.footnote) {
      footnotes.push(b.footnote);
      const id = footnotes.length;
      return `<w:p><w:r><w:t xml:space="preserve">${esc(b.p)}</w:t></w:r><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${id}"/></w:r></w:p>`;
    }
    if (b.heading) return `<w:p><w:pPr><w:pStyle w:val="Heading${b.level || 1}"/></w:pPr><w:r><w:t>${esc(b.heading)}</w:t></w:r></w:p>`;
    if (b.bullet) return `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${esc(b.bullet)}</w:t></w:r></w:p>`;
    // {p, strong, after}: a paragraph with a bold run in the middle.
    if (b.strong) return `<w:p><w:r><w:t xml:space="preserve">${esc(b.p)}</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>${esc(b.strong)}</w:t></w:r><w:r><w:t xml:space="preserve">${esc(b.after || "")}</w:t></w:r></w:p>`;
    return `<w:p><w:r><w:t xml:space="preserve">${esc(b.p)}</w:t></w:r></w:p>`;
  };
  if (!omitDocument) {
    zip.file(
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${blocks.map(paragraph).join("")}</w:body></w:document>`
    );
    const footnoteRel = footnotes.length
      ? `<Relationship Id="rFoot" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>`
      : "";
    zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${footnoteRel}</Relationships>`);
    if (footnotes.length) {
      zip.file(
        "word/footnotes.xml",
        `<?xml version="1.0" encoding="UTF-8"?><w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${footnotes
          .map((t, i) => `<w:footnote w:id="${i + 1}"><w:p><w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p></w:footnote>`)
          .join("")}</w:footnotes>`
      );
    }
    zip.file(
      "word/numbering.xml",
      `<?xml version="1.0" encoding="UTF-8"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`
    );
  }
  for (const [name, content] of Object.entries(extraFiles)) zip.file(name, content);
  return new Uint8Array(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
}

/** A paragraph of filler prose long enough to pass the "has readable text" check. */
export const PROSE = "Eventual consistency means replicas converge once updates stop.";

/**
 * A .docx whose word/document.xml is `xmlBytes` of tiny paragraphs: honest sizes, a few KB
 * compressed, but millions of XML elements (the QA4-1 "DOM bomb").
 * @param {number} xmlBytes
 * @returns {Promise<Uint8Array>}
 */
export async function makeDenseDocx(xmlBytes) {
  const unit = "<w:p><w:r><w:t>ab</w:t></w:r></w:p>";
  const body = `<w:p><w:r><w:t xml:space="preserve">${PROSE}</w:t></w:r></w:p>` + unit.repeat(Math.ceil(xmlBytes / unit.length));
  const zip = await JSZip.loadAsync(await makeDocx([{ p: PROSE }]));
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  return new Uint8Array(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
}

/**
 * A one-page PDF whose content stream is one line of text followed by `decodedMB` of
 * spaces, Flate-compressed (~1 KB per MB): the QA4-2 "Flate bomb".
 * @param {number} decodedMB
 * @returns {Promise<Uint8Array>}
 */
export async function makeFlateBombPdf(decodedMB) {
  const deflate = zlib.createDeflate({ level: 9 });
  const out = [];
  deflate.on("data", (c) => out.push(c));
  const done = new Promise((resolve, reject) => {
    deflate.on("end", resolve);
    deflate.on("error", reject);
  });
  deflate.write(Buffer.from(`BT /F1 12 Tf 72 700 Td (${PROSE}) Tj ET\n`));
  // The same 1 MB buffer each time: the queue holds references, not copies.
  const spaces = Buffer.alloc(1024 * 1024, 0x20);
  for (let i = 0; i < decodedMB; i++) deflate.write(spaces);
  deflate.end();
  await done;
  const stream = Buffer.concat(out);
  const objs = [
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    Buffer.concat([Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`), stream, Buffer.from("\nendstream")]),
    Buffer.from("<< /Type /Page /Parent 4 0 R /MediaBox [0 0 612 792] /Contents 2 0 R /Resources << /Font << /F1 1 0 R >> >> >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from("<< /Type /Catalog /Pages 4 0 R >>"),
  ];
  const parts = [Buffer.from("%PDF-1.4\n")];
  let length = parts[0].length;
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(length);
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from("\nendobj\n")]);
    parts.push(b);
    length += b.length;
  });
  parts.push(
    Buffer.from(
      `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 5 0 R >>\nstartxref\n${length}\n%%EOF`
    )
  );
  return new Uint8Array(Buffer.concat(parts));
}
