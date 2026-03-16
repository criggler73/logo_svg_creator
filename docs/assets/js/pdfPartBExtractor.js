/**
 * pdfPartBExtractor.js — Focus One Rehab: Medicare Part B / HMO Part B Extractor
 *
 * PDF STRUCTURE (one section per page):
 *
 *   L000-L001  Focus One Rehab Services / address
 *   L002-L003  Phone / Fax
 *   L004       FACILITY:  California Post Acute
 *   L005       MONTH      2023 June
 *   L006       MEDICARE PART "B"   — or —   HMO PART B     ← section title
 *   L007       PATIENT NAME  PT  OT  ST  AMOUNT  AMOUNT  DATE   ← col header line 1
 *   L008       BILL  PD  PD                                      ← col header line 2 (skip)
 *   L009+      Patient data rows:
 *              [Name](x~60)  [$]  [pt_amt]  [$]  [ot_amt]  [$]  [st_amt]  [$]  [amt_bill]  [amt_pd]?  [date_pd]?
 *   ...        Blank padding rows: [$]  [-]  only — skip
 *   L-2        TOTAL  [$] [pt] [$] [ot] [$] [st] [$] [amt_bill]
 *   L-1        80% of Charges  (or 75% of Charges)  [$] [pt] [$] [ot] [$] [st] [$] [amt]
 *
 * KEY TOKEN QUIRKS:
 *   - Dollar sign and number are always separate tokens: [$](x=174)  [1,152.68](x=211)
 *     → mergeTokens() collapses them into [$1,152.68]
 *   - ST column sometimes absent from a row (no $ token in that x-range) — treat as blank
 *   - Amount PD and Date PD are usually blank
 *   - x-positions of columns vary between pages — use positional ordering after mergeTokens,
 *     not fixed x thresholds
 *
 * OUTPUT CSV COLUMNS:
 *   Facility, Month, Section, Record Type, Patient Name,
 *   PT ($), OT ($), ST ($), Amount Bill, Amount PD, Date PD
 *
 *   Record Type: Patient | Total | Percentage Summary
 */
(function (window) {
  'use strict';

  var Y_TOL = 4;

  /* ── Text helpers ──────────────────────────────────────────────────────── */

  async function getPageItems(pdfDoc, pageNum) {
    var page = await pdfDoc.getPage(pageNum);
    var vp   = page.getViewport({ scale: 1 });
    var tc   = await page.getTextContent();
    var h    = vp.height;
    var out  = [];
    tc.items.forEach(function (it) {
      var s = (it.str || '').trim();
      if (s) out.push({ x: it.transform[4], y: h - it.transform[5], text: s });
    });
    return out;
  }

  function groupLines(items) {
    if (!items.length) return [];
    var sorted = items.slice().sort(function (a, b) {
      return Math.abs(a.y - b.y) <= Y_TOL ? a.x - b.x : a.y - b.y;
    });
    var lines = [], cur = [sorted[0]], cy = sorted[0].y;
    for (var i = 1; i < sorted.length; i++) {
      if (Math.abs(sorted[i].y - cy) <= Y_TOL) { cur.push(sorted[i]); }
      else { lines.push(cur); cur = [sorted[i]]; cy = sorted[i].y; }
    }
    lines.push(cur);
    return lines;
  }

  function ltext(line) { return line.map(function (t) { return t.text; }).join(' '); }

  /* ── Dollar helpers ────────────────────────────────────────────────────── */

  function fmt$(s) {
    if (!s) return '';
    var v = s.replace(/[$,\s]/g, '');
    if (v === '-' || v === '') return '';
    if (!/^\d+(\.\d+)?$/.test(v)) return '';
    if (v.indexOf('.') < 0) { v = v + '.00'; }
    else { var p = v.split('.'); v = p[0] + '.' + (p[1] + '00').slice(0, 2); }
    return v;
  }

  /* Merge split dollar tokens: [$](x) [123.45](x+n) → [$123.45] */
  function mergeTokens(line) {
    var merged = [];
    for (var i = 0; i < line.length; i++) {
      var t = line[i].text.trim();
      if (t === '$' && i + 1 < line.length) {
        var next = line[i + 1].text.trim();
        if (/^[\d,]+(\.\d+)?$/.test(next) || next === '-') {
          merged.push({ x: line[i].x, y: line[i].y, text: '$' + next });
          i++;
          continue;
        }
      }
      merged.push(line[i]);
    }
    return merged;
  }

  /* True if line has only blank/zero/dash tokens and no patient name */
  function isBlankPaddingRow(line) {
    var m = mergeTokens(line);
    /* A blank padding row has no text-name token — all tokens are $ or $- */
    return m.every(function (tk) {
      var t = tk.text.trim();
      return !t || /^\$-?$/.test(t) || t === '-';
    });
  }

  /* ── Row factory ───────────────────────────────────────────────────────── */

  var CSV_HEADERS = [
    'Facility', 'Month', 'Section', 'Record Type', 'Patient Name',
    'PT ($)', 'OT ($)', 'ST ($)', 'Amount Bill', 'Amount PD', 'Date PD'
  ];

  function makeRow(fac, mon, sec, rt, name) {
    return {
      facility: fac || '', month: mon || '', section: sec || '',
      recordType: rt || '', patientName: name || '',
      pt: '', ot: '', st: '', amountBill: '', amountPd: '', datePd: ''
    };
  }

  /* ── Parse one data/summary line ────────────────────────────────────────
   *
   * After mergeTokens the line looks like:
   *   [Name]  [$pt]  [$ot]  [$st]  [$amtBill]  [$amtPd]?  [datePd]?
   *
   * The name token is always at x < ~200 (left-aligned).
   * Dollar values are right-aligned in their columns.
   * We use positional order: collect all merged $xxx tokens left-to-right,
   * then assign PT=dolls[0], OT=dolls[1], ST=dolls[2], AmtBill=dolls[3].
   *
   * For TOTAL / percentage rows the name token is the label text.
   */
  function parseDataLine(line, fac, mon, sec, rt) {
    var m = mergeTokens(line);

    /* Split into name portion and dollar/value portion */
    var nameEnd = m.length;
    for (var i = 0; i < m.length; i++) {
      var t = m[i].text.trim();
      if (/^\$/.test(t) || (/^\d[\d,]*(\.\d+)?$/.test(t) && !/-/.test(t) && m[i].x > 100)) {
        nameEnd = i; break;
      }
    }
    var nameParts = m.slice(0, nameEnd).map(function (tk) { return tk.text.trim(); });
    var name = nameParts.join(' ').trim();
    if (!name) return null;

    var rest = m.slice(nameEnd);
    var dolls = [];
    var dates  = [];
    rest.forEach(function (tk) {
      var t = tk.text.trim();
      if (/^\$[\d,]+(\.\d+)?$/.test(t) || t === '$-') {
        dolls.push(fmt$(t));
      } else if (/^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}$/.test(t) || /^[A-Z][a-z]{2}-\d{2}$/.test(t)) {
        dates.push(t);
      }
      /* Plain number (Amount PD sometimes appears without $) */
      else if (/^\d[\d,]*(\.\d+)?$/.test(t)) {
        dolls.push(fmt$(t));
      }
    });

    var row = makeRow(fac, mon, sec, rt, name);
    /*
     * Column assignment: PT, OT, ST, AmountBill
     * HMO Part B pages often omit the ST column entirely, leaving only 3 dollar values.
     * Standard pages have 4+ dollar values (PT, OT, ST, AmountBill).
     * Detect by count: if exactly 3 values and section contains 'HMO', or
     * more reliably: if total dollar tokens < 4, treat last one as AmountBill.
     */
    if (dolls.length >= 4) {
      row.pt         = dolls[0] || '';
      row.ot         = dolls[1] || '';
      row.st         = dolls[2] || '';
      row.amountBill = dolls[3] || '';
      row.amountPd   = dolls[4] || '';
    } else if (dolls.length === 3) {
      /* 3 values: PT, OT, AmountBill (ST absent — common in HMO Part B) */
      row.pt         = dolls[0] || '';
      row.ot         = dolls[1] || '';
      row.st         = '';
      row.amountBill = dolls[2] || '';
    } else if (dolls.length === 2) {
      /* Only one modality + total */
      row.pt         = dolls[0] || '';
      row.amountBill = dolls[1] || '';
    } else if (dolls.length === 1) {
      row.amountBill = dolls[0] || '';
    }
    row.datePd = dates[0] || '';
    return row;
  }

  /* ── Main per-PDF parser ─────────────────────────────────────────────── */

  async function extractPartBPdf(pdfDoc, fileName) {
    /* Build page-level month/facility index (same approach as Part A extractor) */
    var pageLines    = [];
    var pageMonth    = [];
    var pageFacility = [];
    var lastFac = '', lastMon = '';

    for (var p = 1; p <= pdfDoc.numPages; p++) {
      var lines = groupLines(await getPageItems(pdfDoc, p));
      pageLines.push(lines);
      var fac = '', mon = '', sec = '';
      lines.forEach(function (l) {
        var tx = ltext(l).trim();
        var fm = tx.match(/^facility\s*:\s*(.+)/i);
        if (fm) fac = fm[1].trim();
        var mm = tx.match(/^month\s+(.+)/i);
        if (mm) mon = mm[1].trim();
      });
      if (fac) lastFac = fac;
      if (mon) lastMon = mon;
      pageFacility[p - 1] = lastFac;
      pageMonth[p - 1]    = lastMon;
    }

    var allRows = [];

    for (var pi = 0; pi < pageLines.length; pi++) {
      var pgLines  = pageLines[pi];
      var facility = pageFacility[pi];
      var month    = pageMonth[pi];
      var section  = '';

      /* Find section title on this page */
      for (var li = 0; li < pgLines.length; li++) {
        var tx2 = ltext(pgLines[li]).trim();
        if (/medicare\s+part\s+[""]?b[""]?/i.test(tx2)) { section = 'Medicare Part B'; break; }
        if (/hmo\s+part\s+b/i.test(tx2))                { section = 'HMO Part B';      break; }
      }
      if (!section) continue; /* not a Part B page */

      /* Parse data lines */
      for (var li2 = 0; li2 < pgLines.length; li2++) {
        var line = pgLines[li2];
        var full = ltext(line).trim();

        /* Skip boilerplate */
        if (/focus\s+one\s+rehab/i.test(full)) continue;
        if (/paso\s+robles/i.test(full))        continue;
        if (/los\s+angeles/i.test(full))        continue;
        if (/^phone\s*:/i.test(full))           continue;
        if (/^fax\s*:/i.test(full))             continue;
        if (/^facility\s*:/i.test(full))        continue;
        if (/^month\s+/i.test(full))            continue;
        if (/medicare\s+part\s+[""]?b[""]?/i.test(full)) continue;
        if (/^hmo\s+part\s+b/i.test(full))     continue;

        /* Skip column-header lines */
        if (/patient\s+name/i.test(full))       continue;
        if (/^bill\b/i.test(full) && line.length <= 3) continue;

        /* Skip blank padding rows (only $ and - tokens, no name) */
        if (isBlankPaddingRow(line))            continue;

        /* TOTAL row */
        if (/^total$/i.test(line[0] ? line[0].text.trim() : '')) {
          var tr = parseDataLine(line, facility, month, section, 'Total');
          if (tr) allRows.push(tr);
          continue;
        }

        /* Percentage summary rows (80% of Charges / 75% of Charges) */
        if (/^\d+%\s+of\s+charges/i.test(full)) {
          var pr = parseDataLine(line, facility, month, section, 'Percentage Summary');
          if (pr) allRows.push(pr);
          continue;
        }

        /* Regular patient row — must start with a name token (non-$, non-digit at x < ~200) */
        var m0 = line[0];
        if (!m0) continue;
        var t0 = m0.text.trim();
        if (!t0 || /^\$/.test(t0) || /^\d/.test(t0)) continue;

        var row = parseDataLine(line, facility, month, section, 'Patient');
        if (row && row.patientName) allRows.push(row);
      }
    }

    return { fileName: fileName, rows: allRows };
  }

  /* ── CSV export ──────────────────────────────────────────────────────── */

  function esc(v) {
    if (v == null) return '';
    v = String(v).trim();
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }

  function rowsToCsv(rows) {
    var out = [CSV_HEADERS.map(esc).join(',')];
    rows.forEach(function (r) {
      out.push([
        r.facility, r.month, r.section, r.recordType, r.patientName,
        r.pt, r.ot, r.st, r.amountBill, r.amountPd, r.datePd
      ].map(esc).join(','));
    });
    return out.join('\r\n');
  }

  function combineResults(results) {
    var all = [];
    results.forEach(function (res) {
      (res.rows || []).forEach(function (r) { all.push(r); });
    });
    return all;
  }

  window.PdfPartBExtractor = {
    extractPartBPdf: extractPartBPdf,
    combineResults:  combineResults,
    rowsToCsv:       rowsToCsv,
    CSV_HEADERS:     CSV_HEADERS
  };

})(window);
