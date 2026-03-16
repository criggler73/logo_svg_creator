/**
 * pdfInvoiceExtractor.js — Focus One Rehab Services Invoice PDF Extractor
 *
 * PURPOSE: Extract "Total Charges" invoice summary pages from PDFs.
 * ONE FILE TYPE = ONE PDF (e.g. all Invoice PDFs for different months).
 *
 * Invoice page layout (each page = one facility/month):
 *
 *   Focus One Rehab Services
 *   [address]
 *   Total Charges
 *   FACILITY:  [facility name]
 *   Month:  [YYYY Month]
 *
 *   Medicare Part A
 *     Med A    PT  $  16,945.78      ← "Med A" and "PT" on the SAME line
 *              OT  $  16,281.20      ← "OT" alone on its own line
 *              ST  $   1,939.20
 *     HMO A    PT  $   3,587.52      ← "HMO A" and "PT" on the SAME line
 *              OT  $   3,667.31
 *              ST  $     484.80
 *     Total               $  42,905.81
 *
 *   HMO Skilled
 *     Physical Therapy    $   5,010.00
 *     Occupational Therapy$   4,980.00
 *     Speech Therapy      $     210.00
 *     Total               $  10,200.00
 *
 *   Medicare Part B  ...
 *   Non-rehab / Medical  ...
 *   HMO Part B  ...
 *
 *   Optima                    $50
 *   Total of All Therapy  $  59,344.67
 *
 * KEY PDF QUIRK: "Med A  PT  $  16,945.78" is ONE visual line.
 *   PDF.js emits tokens: ["Med A", "PT", "$", "16,945.78"]
 *   → tok0 = "Med A", and PT is detected on the same line.
 *
 * OUTPUT CSV columns:
 *   Facility | Month | Section | Sub-Type | Modality | Amount ($)
 */
(function (window) {
  'use strict';

  var LINE_Y_TOLERANCE = 4;

  /* ── Text extraction ─────────────────────────────────────────────────── */

  async function getPageTextItems(pdfDoc, pageNum) {
    var page = await pdfDoc.getPage(pageNum);
    var vp   = page.getViewport({ scale: 1 });
    var tc   = await page.getTextContent();
    var h    = vp.height;
    var out  = [];
    for (var i = 0; i < tc.items.length; i++) {
      var it  = tc.items[i];
      var str = (it.str || '').trim();
      if (!str) continue;
      out.push({ x: it.transform[4], y: h - it.transform[5], text: str });
    }
    return out;
  }

  /* Group raw items into visual lines (same y ± tolerance), left-to-right */
  function groupIntoLines(items) {
    if (!items.length) return [];
    var sorted = items.slice().sort(function (a, b) {
      return Math.abs(a.y - b.y) <= LINE_Y_TOLERANCE ? a.x - b.x : a.y - b.y;
    });
    var lines = [];
    var cur = [sorted[0]], curY = sorted[0].y;
    for (var i = 1; i < sorted.length; i++) {
      if (Math.abs(sorted[i].y - curY) <= LINE_Y_TOLERANCE) {
        cur.push(sorted[i]);
      } else {
        lines.push(cur);
        cur = [sorted[i]];
        curY = sorted[i].y;
      }
    }
    lines.push(cur);
    return lines;
  }

  /* Join all token texts in a line */
  function lineText(line) {
    return line.map(function (t) { return t.text; }).join(' ');
  }

  /* First token text of a line */
  function firstToken(line) {
    return line.length ? line[0].text.trim() : '';
  }

  /* Check whether a token with given index exists in line */
  function tokenAt(line, idx) {
    return (idx < line.length) ? line[idx].text.trim() : '';
  }

  /* ── Dollar parsing ──────────────────────────────────────────────────── */

  /*
   * Extract a clean dollar string from a raw token.
   * Returns a STRING (not a number) so that "16,281.20" → "16281.20"
   * and trailing zeros are preserved.
   * Returns null for "-" or empty.
   */
  function parseDollarStr(str) {
    if (!str) return null;
    var s = str.replace(/[$,\s]/g, '');
    if (s === '-' || s === '') return null;
    /* Validate it looks like a number */
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
    /* Ensure 2 decimal places when a decimal point is present */
    if (s.indexOf('.') !== -1) {
      var parts = s.split('.');
      /* Pad or truncate to exactly 2 decimal digits */
      s = parts[0] + '.' + (parts[1] + '00').slice(0, 2);
    }
    return s;
  }

  /*
   * Find the LAST numeric-looking token in a line.
   * Returns a formatted string like "16281.20" or null.
   */
  function extractAmount(line) {
    for (var i = line.length - 1; i >= 0; i--) {
      var t = line[i].text.trim();
      /* Matches: "16,945.78"  "$16,945.78"  "$50"  "50"  but NOT "$" alone */
      if (/^\$?[\d,]+(\.\d+)?$/.test(t)) {
        return parseDollarStr(t);
      }
      if (t === '-') return null; /* explicit dash = blank/zero */
    }
    return null;
  }

  /* ── Invoice page detection ─────────────────────────────────────────── */

  function isInvoicePageStart(lines) {
    for (var i = 0; i < Math.min(lines.length, 10); i++) {
      if (/total\s+charges/i.test(lineText(lines[i]))) return true;
    }
    return false;
  }

  function extractFacilityMonth(lines) {
    var facility = '', month = '';
    for (var i = 0; i < Math.min(lines.length, 20); i++) {
      var txt = lineText(lines[i]);
      var fm  = txt.match(/facility\s*[:\s]+(.+)/i);
      if (fm && !facility) facility = fm[1].trim();
      var mm  = txt.match(/month\s*[:\s]+(.+)/i);
      if (mm && !month)    month    = mm[1].trim();
      if (facility && month) break;
    }
    return { facility: facility, month: month };
  }

  /* ── Section detection ───────────────────────────────────────────────── */

  var SECTIONS = [
    { key: 'Medicare Part A',     re: /^medicare\s+part\s+a$/i },
    { key: 'HMO Skilled',         re: /^hmo\s+skilled$/i },
    { key: 'Medicare Part B',     re: /^medicare\s+part\s+b$/i },
    { key: 'HMO Part B',          re: /^hmo\s+part\s+b$/i },
    { key: 'Non-rehab / Medical', re: /^(non.rehab|private\s+and\s+medical)/i },
  ];

  function detectSection(txt) {
    var t = txt.trim();
    for (var i = 0; i < SECTIONS.length; i++) {
      if (SECTIONS[i].re.test(t)) return SECTIONS[i].key;
    }
    return null;
  }

  /* ── Parse one invoice page ─────────────────────────────────────────── */

  /*
   * KEY INSIGHT from real PDF output:
   *
   *   "Med A  PT  $  16,945.78"  arrives as tokens: ["Med A", "PT", "$", "16,945.78"]
   *       → tok0="Med A", tok1="PT" — both on the SAME line, with the amount.
   *
   *   "OT  $  16,281.20"  arrives as tokens: ["OT", "$", "16,281.20"]
   *       → tok0="OT" on its own line.
   *
   *   "HMO A  PT  $  3,587.52"  same pattern as Med A line.
   *
   * So we must check BOTH tok0 AND tok1 when inside Medicare Part A.
   */
  function parseInvoicePage(lines, facility, month) {
    var rows    = [];
    var section = '';
    var subType = ''; /* "Med A" or "HMO A" — persists across OT/ST continuation lines */

    function push(sec, sub, modality, amount) {
      rows.push({
        facility: facility,
        month:    month,
        section:  sec,
        subType:  sub,
        modality: modality,
        amount:   (amount !== null && amount !== undefined) ? amount : ''
      });
    }

    for (var L = 0; L < lines.length; L++) {
      var line = lines[L];
      var full = lineText(line).trim();
      var tok0 = firstToken(line);
      var tok1 = tokenAt(line, 1);

      /* ── Skip page header lines ── */
      if (!full) continue;
      if (/focus\s+one\s+rehab/i.test(full))   continue;
      if (/total\s+charges/i.test(full))        continue;
      if (/^\d+\s+\w+.*street/i.test(full))     continue;
      if (/facility\s*:/i.test(full))           continue;
      if (/month\s*:/i.test(full))              continue;
      if (/northridge|paso\s+robles/i.test(full)) continue; /* address line variants */

      /* ── Section header? ── */
      var sec = detectSection(full);
      if (sec) {
        section = sec;
        subType = '';
        continue;
      }

      /* ── Before any section is detected ── */
      if (!section) continue;

      var amount = extractAmount(line);

      /* ══════════════════════════════════════════════════════
       * Medicare Part A — handles combined "Med A PT $xx" lines
       * as well as continuation "OT $xx" / "ST $xx" lines.
       * ══════════════════════════════════════════════════════ */
      if (section === 'Medicare Part A') {

        /* "Med A  PT  $  16,945.78"  → tok0="Med A", tok1="PT" */
        if (/^med\s*a$/i.test(tok0)) {
          subType = 'Med A';
          if (/^pt$/i.test(tok1)) { push(section, subType, 'PT', amount); continue; }
          continue; /* "Med A" alone (shouldn't happen but guard) */
        }

        /* "HMO A  PT  $  3,587.52"  → tok0="HMO A", tok1="PT" */
        if (/^hmo\s*a$/i.test(tok0)) {
          subType = 'HMO A';
          if (/^pt$/i.test(tok1)) { push(section, subType, 'PT', amount); continue; }
          continue;
        }

        /* Continuation lines: tok0 is "OT" or "ST" alone */
        if (/^pt$/i.test(tok0)) { push(section, subType, 'PT', amount); continue; }
        if (/^ot$/i.test(tok0)) { push(section, subType, 'OT', amount); continue; }
        if (/^st$/i.test(tok0)) { push(section, subType, 'ST', amount); continue; }

        if (/^total$/i.test(tok0)) {
          push(section, 'TOTAL', '', amount);
          subType = '';
          continue;
        }
        continue; /* skip unrecognised lines inside Part A */
      }

      /* ══════════════════════════════════════════════════════
       * All other sections: PT / OT / ST named rows + Total
       * ══════════════════════════════════════════════════════ */

      /* Strip trailing dollar/amount to isolate the label */
      var label = full.replace(/\s*\$[\s\d,.\-]+$/, '').replace(/\s*-\s*$/, '').trim();

      if (/^physical\s+therapy$/i.test(label)) {
        push(section, 'Physical Therapy', 'PT', amount);
        continue;
      }
      if (/^occupational\s+therapy$/i.test(label)) {
        push(section, 'Occupational Therapy', 'OT', amount);
        continue;
      }
      if (/^speech\s*therapy$/i.test(label)) {
        push(section, 'Speech Therapy', 'ST', amount);
        continue;
      }
      if (/^total$/i.test(tok0)) {
        push(section, 'TOTAL', '', amount);
        continue;
      }

      /* ── Optima ── */
      if (/^optima$/i.test(tok0)) {
        /* Optima amount sometimes has no decimal: "$50" */
        push('Summary', 'Optima', '', amount);
        continue;
      }

      /* ── Summary lines ── */
      if (/^subtotal$/i.test(tok0)) {
        push('Summary', 'Subtotal', '', amount);
        continue;
      }
      if (/group\s+treatment/i.test(full)) {
        var gtAmt = amount;
        if (gtAmt === null) {
          var m = full.match(/(\d+)\s*$/);
          gtAmt = m ? m[1] : '0';
        }
        push('Summary', 'Group Treatment', '', gtAmt);
        continue;
      }
      if (/total\s+of\s+all\s+therapy/i.test(full)) {
        push('Summary', 'Total of All Therapy', '', amount);
        continue;
      }
    }

    return rows;
  }

  /* ── Full PDF extraction ─────────────────────────────────────────────── */

  async function extractInvoicePdf(pdfDoc, fileName) {
    var allRows = [];

    for (var p = 1; p <= pdfDoc.numPages; p++) {
      var items = await getPageTextItems(pdfDoc, p);
      var lines = groupIntoLines(items);

      if (!isInvoicePageStart(lines)) continue;

      var meta = extractFacilityMonth(lines);
      var rows = parseInvoicePage(lines, meta.facility, meta.month);
      for (var r = 0; r < rows.length; r++) allRows.push(rows[r]);
    }

    return { fileName: fileName, rows: allRows };
  }

  /* ── CSV export ──────────────────────────────────────────────────────── */

  var CSV_HEADERS = ['Facility', 'Month', 'Section', 'Sub-Type', 'Modality', 'Amount ($)'];

  function escapeCsv(v) {
    if (v === null || v === undefined) return '';
    v = String(v).trim();
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }

  function rowsToCsv(rows) {
    var out = [CSV_HEADERS.map(escapeCsv).join(',')];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      out.push([r.facility, r.month, r.section, r.subType, r.modality, r.amount]
               .map(escapeCsv).join(','));
    }
    return out.join('\r\n');
  }

  function combineResults(results) {
    var all = [];
    for (var i = 0; i < results.length; i++) {
      var rows = results[i].rows || [];
      for (var r = 0; r < rows.length; r++) all.push(rows[r]);
    }
    return all;
  }

  window.PdfInvoiceExtractor = {
    extractInvoicePdf: extractInvoicePdf,
    combineResults:    combineResults,
    rowsToCsv:         rowsToCsv,
    CSV_HEADERS:       CSV_HEADERS
  };

})(window);
