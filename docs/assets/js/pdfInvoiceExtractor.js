/**
 * pdfInvoiceExtractor.js — Focus One Rehab Services Invoice PDF Extractor
 *
 * PURPOSE: Extract "Total Charges" invoice summary pages from PDFs.
 * ONE FILE TYPE = ONE PDF (e.g. all "Invoice" PDFs uploaded together).
 *
 * Invoice page layout (repeats every N pages for each facility/month):
 *
 *   Focus One Rehab Services
 *   [address]
 *   Total Charges
 *   FACILITY:  [facility name]
 *   Month:  [YYYY Month]
 *
 *   Medicare Part A
 *     Med A    PT $  x,xxx.xx
 *              OT $  x,xxx.xx
 *              ST $    xxx.xx
 *     HMO A    PT $  -
 *              OT $  -
 *              ST $  -
 *     Total                   $  xx,xxx.xx
 *
 *   HMO Skilled
 *     Physical Therapy        $  -
 *     ...
 *     Total                   $  -
 *
 *   Medicare Part B
 *     Physical Therapy        $  x,xxx.xx
 *     Occupational Therapy    $  x,xxx.xx
 *     Speech Therapy          $  x,xxx.xx
 *     Total                   $  xx,xxx.xx
 *
 *   HMO Part B
 *     ...
 *
 *   Private and Medical
 *     Physical Therapy        $  xx.xx
 *     ...
 *     Total                   $  xx.xx
 *     Optima                  $  xx.xx
 *
 *   Subtotal                  $  xx,xxx.xx
 *   GROUP TREATMENT               0
 *   Total of All Therapy      $  xx,xxx.xx
 *
 * OUTPUT CSV columns:
 *   Facility, Month, Section, SubType, PT, OT, ST, SectionTotal, Notes
 *
 * Where:
 *   Section    = "Medicare Part A" | "HMO Skilled" | "Medicare Part B" | "HMO Part B" | "Private and Medical" | "Summary"
 *   SubType    = "Med A" | "HMO A" | "Physical Therapy" | etc.
 *   PT/OT/ST   = dollar amounts (number, blank if not applicable)
 *   SectionTotal = the "Total" line for that section
 *   Notes      = Optima, Group Treatment, etc.
 */
(function (window) {
  'use strict';

  var LINE_Y_TOLERANCE = 4;

  // ── Text extraction ──────────────────────────────────────────────────────

  async function getPageTextItems(pdfDoc, pageNum) {
    var page = await pdfDoc.getPage(pageNum);
    var vp   = page.getViewport({ scale: 1 });
    var tc   = await page.getTextContent();
    var h    = vp.height;
    var items = [];
    for (var i = 0; i < tc.items.length; i++) {
      var it = tc.items[i];
      var str = (it.str || '').trim();
      if (!str) continue;
      items.push({
        x:    it.transform[4],
        y:    h - it.transform[5],
        text: str
      });
    }
    return items;
  }

  function groupIntoLines(items) {
    if (!items.length) return [];
    var sorted = items.slice().sort(function (a, b) {
      if (Math.abs(a.y - b.y) <= LINE_Y_TOLERANCE) return a.x - b.x;
      return a.y - b.y;
    });
    var lines = [];
    var cur   = [sorted[0]];
    var curY  = sorted[0].y;
    for (var i = 1; i < sorted.length; i++) {
      if (Math.abs(sorted[i].y - curY) <= LINE_Y_TOLERANCE) {
        cur.push(sorted[i]);
      } else {
        lines.push(cur);
        cur  = [sorted[i]];
        curY = sorted[i].y;
      }
    }
    lines.push(cur);
    return lines;
  }

  function lineFullText(line) {
    return line.map(function (t) { return t.text; }).join(' ');
  }

  // ── Dollar value parsing ─────────────────────────────────────────────────

  function parseDollar(str) {
    if (!str) return '';
    var s = str.replace(/[$,\s]/g, '');
    if (s === '-' || s === '') return '';
    var n = parseFloat(s);
    return isNaN(n) ? '' : n;
  }

  // Find all dollar-looking tokens in a line
  function extractDollarsFromLine(line) {
    var vals = [];
    for (var i = 0; i < line.length; i++) {
      var t = line[i].text;
      // dollar amounts: optional $, digits, commas, decimals; also standalone "-"
      if (/^\$?[\d,]+\.\d{2}$/.test(t) || t === '-') {
        vals.push(parseDollar(t));
      }
    }
    return vals;
  }

  // ── Invoice page detection ────────────────────────────────────────────────

  function isInvoicePageStart(lines) {
    for (var i = 0; i < Math.min(lines.length, 8); i++) {
      var txt = lineFullText(lines[i]);
      if (/total\s+charges/i.test(txt)) return true;
    }
    return false;
  }

  function extractFacilityMonth(lines) {
    var facility = '';
    var month    = '';
    for (var i = 0; i < Math.min(lines.length, 15); i++) {
      var txt = lineFullText(lines[i]);
      var fm  = txt.match(/facility\s*[:\s]+(.+)/i);
      if (fm) facility = fm[1].trim();
      var mm  = txt.match(/month\s*[:\s]+(.+)/i);
      if (mm) month = mm[1].trim();
      if (facility && month) break;
    }
    return { facility: facility, month: month };
  }

  // ── Section name detection ────────────────────────────────────────────────

  var SECTION_PATTERNS = [
    { key: 'Medicare Part A',      re: /^medicare\s+part\s+a$/i },
    { key: 'HMO Skilled',          re: /^hmo\s+skilled$/i },
    { key: 'Medicare Part B',      re: /^medicare\s+part\s+b$/i },
    { key: 'HMO Part B',           re: /^hmo\s+part\s+b$/i },
    { key: 'Private and Medical',  re: /^(private\s+and\s+medical|non.rehab|non-rehab)/i },
  ];

  function detectSection(txt) {
    for (var i = 0; i < SECTION_PATTERNS.length; i++) {
      if (SECTION_PATTERNS[i].re.test(txt.trim())) return SECTION_PATTERNS[i].key;
    }
    return null;
  }

  // ── Parse one invoice page ────────────────────────────────────────────────

  /**
   * Parse a single invoice page's lines into structured rows.
   * Returns an array of row objects:
   *   { facility, month, section, subType, pt, ot, st, sectionTotal, notes }
   */
  function parseInvoicePage(lines, facility, month) {
    var rows           = [];
    var currentSection = '';
    var medABucket     = { pt: '', ot: '', st: '' }; // accumulates Med A PT/OT/ST lines
    var hmoABucket     = { pt: '', ot: '', st: '' };
    var medAMode       = false; // true while reading Med A rows
    var hmoAMode       = false;

    function pushRow(section, subType, pt, ot, st, total, notes) {
      rows.push({
        facility:     facility,
        month:        month,
        section:      section,
        subType:      subType,
        pt:           pt     !== undefined ? pt     : '',
        ot:           ot     !== undefined ? ot     : '',
        st:           st     !== undefined ? st     : '',
        sectionTotal: total  !== undefined ? total  : '',
        notes:        notes  || ''
      });
    }

    for (var L = 0; L < lines.length; L++) {
      var line = lines[L];
      var txt  = lineFullText(line).trim();
      var txLower = txt.toLowerCase();

      // Skip header lines
      if (/focus\s+one\s+rehab|total\s+charges|^\d{4}\s+[a-z]+\s+street/i.test(txt)) continue;
      if (/facility\s*:/i.test(txt) || /month\s*:/i.test(txt)) continue;

      // Section header?
      var sec = detectSection(txt);
      if (sec) {
        // Flush any pending Med A / HMO A buckets before switching section
        if (medAMode && (medABucket.pt !== '' || medABucket.ot !== '' || medABucket.st !== '')) {
          pushRow(currentSection, 'Med A', medABucket.pt, medABucket.ot, medABucket.st, '', '');
          medABucket = { pt: '', ot: '', st: '' };
        }
        if (hmoAMode && (hmoABucket.pt !== '' || hmoABucket.ot !== '' || hmoABucket.st !== '')) {
          pushRow(currentSection, 'HMO A', hmoABucket.pt, hmoABucket.ot, hmoABucket.st, '', '');
          hmoABucket = { pt: '', ot: '', st: '' };
        }
        medAMode = false; hmoAMode = false;
        currentSection = sec;
        continue;
      }

      if (!currentSection) continue;

      var dollars = extractDollarsFromLine(line);

      // ── Medicare Part A: "Med A" and "HMO A" sub-rows with PT/OT/ST ──
      if (currentSection === 'Medicare Part A') {
        if (/^med\s*a$/i.test(txt)) { medAMode = true; hmoAMode = false; continue; }
        if (/^hmo\s*a$/i.test(txt)) {
          // Flush Med A
          if (medABucket.pt !== '' || medABucket.ot !== '' || medABucket.st !== '') {
            pushRow(currentSection, 'Med A', medABucket.pt, medABucket.ot, medABucket.st, '', '');
            medABucket = { pt: '', ot: '', st: '' };
          }
          medAMode = false; hmoAMode = true; continue;
        }
        if (/^pt$/i.test(txt) && dollars.length >= 1) {
          if (medAMode)  medABucket.pt = dollars[0];
          if (hmoAMode)  hmoABucket.pt = dollars[0];
          continue;
        }
        if (/^ot$/i.test(txt) && dollars.length >= 1) {
          if (medAMode)  medABucket.ot = dollars[0];
          if (hmoAMode)  hmoABucket.ot = dollars[0];
          continue;
        }
        if (/^st$/i.test(txt) && dollars.length >= 1) {
          if (medAMode)  medABucket.st = dollars[0];
          if (hmoAMode)  hmoABucket.st = dollars[0];
          continue;
        }
        if (/^total$/i.test(txt) && dollars.length >= 1) {
          // Flush HMO A before total
          if (hmoABucket.pt !== '' || hmoABucket.ot !== '' || hmoABucket.st !== '') {
            pushRow(currentSection, 'HMO A', hmoABucket.pt, hmoABucket.ot, hmoABucket.st, '', '');
            hmoABucket = { pt: '', ot: '', st: '' };
          }
          medAMode = false; hmoAMode = false;
          pushRow(currentSection, 'TOTAL', '', '', '', dollars[0], '');
          continue;
        }
      }

      // ── HMO Skilled / Medicare Part B / HMO Part B / Private and Medical ──
      // Rows: "Physical Therapy", "Occupational Therapy", "Speech Therapy"
      if (/^physical\s+therapy$/i.test(txt) && dollars.length >= 1) {
        pushRow(currentSection, 'Physical Therapy', dollars[0], '', '', '', '');
        continue;
      }
      if (/^occupational\s+therapy$/i.test(txt) && dollars.length >= 1) {
        pushRow(currentSection, 'Occupational Therapy', '', dollars[0], '', '', '');
        continue;
      }
      if (/^speech\s+therapy$/i.test(txt) && dollars.length >= 1) {
        pushRow(currentSection, 'Speech Therapy', '', '', dollars[0], '', '');
        continue;
      }
      if (/^total$/i.test(txt) && dollars.length >= 1) {
        pushRow(currentSection, 'TOTAL', '', '', '', dollars[0], '');
        continue;
      }

      // ── Optima (special line in Private and Medical) ──
      if (/^optima$/i.test(txt) && dollars.length >= 1) {
        pushRow(currentSection, 'Optima', '', '', '', dollars[0], 'Optima');
        continue;
      }

      // ── Summary lines ──
      if (/^subtotal$/i.test(txt) && dollars.length >= 1) {
        pushRow('Summary', 'Subtotal', '', '', '', dollars[0], '');
        continue;
      }
      if (/group\s+treatment/i.test(txt)) {
        var gtVal = dollars.length >= 1 ? dollars[0] : (txt.match(/\d+/) ? txt.match(/\d+/)[0] : '0');
        pushRow('Summary', 'Group Treatment', '', '', '', gtVal, 'Group Treatment');
        continue;
      }
      if (/total\s+of\s+all\s+therapy/i.test(txt) && dollars.length >= 1) {
        pushRow('Summary', 'Total of All Therapy', '', '', '', dollars[0], '');
        continue;
      }
    }

    return rows;
  }

  // ── Full PDF extraction ────────────────────────────────────────────────────

  /**
   * Extract all invoice pages from a PDF.
   * Returns Promise<{ fileName, rows: [ row, ... ] }>
   */
  async function extractInvoicePdf(pdfDoc, fileName) {
    var numPages = pdfDoc.numPages;
    var allRows  = [];

    var pageLines = [];
    for (var p = 1; p <= numPages; p++) {
      var items = await getPageTextItems(pdfDoc, p);
      pageLines.push(groupIntoLines(items));
    }

    // Detect invoice page boundaries: each page that has "Total Charges" header
    // is a new invoice. Pages without it continue/belong to the same report but
    // for this format every page IS a separate invoice (facility + month).
    for (var pg = 0; pg < pageLines.length; pg++) {
      var lines = pageLines[pg];
      if (!isInvoicePageStart(lines)) continue;

      var meta = extractFacilityMonth(lines);
      var rows = parseInvoicePage(lines, meta.facility, meta.month);
      for (var r = 0; r < rows.length; r++) allRows.push(rows[r]);
    }

    return { fileName: fileName, rows: allRows };
  }

  // ── CSV export ─────────────────────────────────────────────────────────────

  var CSV_HEADERS = ['Facility', 'Month', 'Section', 'Sub-Type', 'PT ($)', 'OT ($)', 'ST ($)', 'Section Total ($)', 'Notes'];

  function escapeCsv(v) {
    if (v === null || v === undefined) return '';
    v = String(v).trim();
    if (/[",\n\r]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
    return v;
  }

  function rowsToCsv(rows) {
    var lines = [CSV_HEADERS.map(escapeCsv).join(',')];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      lines.push([
        r.facility, r.month, r.section, r.subType,
        r.pt, r.ot, r.st, r.sectionTotal, r.notes
      ].map(escapeCsv).join(','));
    }
    return lines.join('\r\n');
  }

  /**
   * Combine results from multiple PDFs into a single rows array.
   */
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
