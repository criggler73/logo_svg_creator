/**
 * pdfHmoSkilledExtractor.js — Focus One Rehab: HMO Skilled Extractor
 *
 * PDF STRUCTURE (one section per page):
 *
 *   L000-L001  Focus One Rehab Services / address
 *   L002       Facility:  California Post Acute
 *   L003       Bill Type:  HMO Skilled   Month:  2023 June
 *   L004       OT  PT  ST        ← column group labels (OT is first!)
 *   L005       Patient Name (Last, First)   Total Charges
 *   L006       Units  Charges  Units  Charges  Units  Charges
 *   L007       [blank padding row: starts with 0]
 *   L008+      Patient data rows:
 *              [Name](x~64)  [OT_units]  [$]  [OT_chg]  [PT_units]  [$]  [PT_chg]  [ST_units]  [$]  [ST_chg]  [$totalChg]
 *   ...        Blank/padding rows: start with [0] token at ~x240-300, no name
 *   Last line  [Totals:]  [OT_units] [$] [OT_chg] [PT_units] [$] [PT_chg] [ST_units] [$] [ST_chg] [$total]
 *
 * KEY TOKEN QUIRKS:
 *   - OT column comes FIRST (left), then PT, then ST — note ordering
 *   - Total Charges token is already combined: [$1,215.00] — no merging needed for it
 *   - Some individual charges already merged: [$ 1,260.00] (with space) — handle both
 *   - Blank rows begin with a [0] token (units=0) at x~240-290 with no name to the left
 *   - x-positions of columns vary per page — use token ordering after filtering name
 *
 * OUTPUT CSV COLUMNS:
 *   Facility, Month, Section, Record Type, Patient Name,
 *   OT Units, OT Charges, PT Units, PT Charges, ST Units, ST Charges, Total Charges
 *
 *   Record Type: Patient | Total
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

  /* True if token text represents a dollar amount (with $ prefix) */
  function isDollarToken(t) {
    return /^\$[\d,]+(\.\d+)?$/.test(t) || /^\$-$/.test(t) || /^\$\s*[\d,]+(\.\d+)?$/.test(t);
  }

  /* True if token is a plain integer (units) */
  function isUnits(t) {
    return /^\d+$/.test(t);
  }

  /* ── Row factory ───────────────────────────────────────────────────────── */

  var CSV_HEADERS = [
    'Facility', 'Month', 'Section', 'Record Type', 'Patient Name',
    'OT Units', 'OT Charges', 'PT Units', 'PT Charges', 'ST Units', 'ST Charges',
    'Total Charges'
  ];

  function makeRow(fac, mon, rt, name) {
    return {
      facility: fac || '', month: mon || '', section: 'HMO Skilled',
      recordType: rt || '', patientName: name || '',
      otUnits: '', otCharges: '', ptUnits: '', ptCharges: '',
      stUnits: '', stCharges: '', totalCharges: ''
    };
  }

  /* ── Parse one data row ──────────────────────────────────────────────────
   * Columns (left to right): Name | OT_units $ OT_chg | PT_units $ PT_chg | ST_units $ ST_chg | $total
   * Total Charges is the last token and already formatted as "$X,XXX.XX"
   * Individual charges split as [$] [390.00] — need to merge first.
   */
  function parsePatientRow(line, fac, mon, rt) {
    /* Merge split $ + number pairs */
    var merged = [];
    for (var mi = 0; mi < line.length; mi++) {
      var mt = line[mi].text.trim();
      if (mt === '$' && mi + 1 < line.length) {
        var nextT = line[mi + 1].text.trim();
        if (/^[\d,]+(\.\d+)?$/.test(nextT) || nextT === '-') {
          merged.push({ x: line[mi].x, y: line[mi].y, text: '$' + nextT });
          mi++; continue;
        }
      }
      merged.push(line[mi]);
    }

    /* Find the name: first text token that is not a digit and not a dollar sign, at x < 200 */
    var nameIdx = -1;
    for (var i = 0; i < merged.length; i++) {
      var t = merged[i].text.trim();
      if (t && !isUnits(t) && !isDollarToken(t) && t !== '-') {
        if (merged[i].x < 200) { nameIdx = i; break; }
      }
    }

    var name = '';
    var numStart = 0;
    if (nameIdx >= 0) {
      name = merged[nameIdx].text.trim();
      numStart = nameIdx + 1;
    } else {
      return null; /* blank row */
    }

    /* Collect numeric tokens: units (plain int) and dollar amounts */
    var nums = [];
    for (var j = numStart; j < merged.length; j++) {
      var tk = merged[j].text.trim();
      if (isDollarToken(tk)) { nums.push({ kind: '$', val: fmt$(tk) }); }
      else if (isUnits(tk))  { nums.push({ kind: 'n', val: tk });       }
      /* Skip dashes */
    }

    /*
     * Expected sequence: OT_units $ OT_chg  PT_units $ PT_chg  ST_units $ ST_chg  $total
     * That's: n $ n $ n $ $  (7 items, last is the merged total)
     * But ST units can be 0 and ST charge can be - (absent from nums)
     * Robust approach: collect all n/$ pairs in order, last $ is total
     */
    var row = makeRow(fac, mon, rt, name);

    /* Extract total charges — last $ token */
    var lastDollarIdx = -1;
    for (var k = nums.length - 1; k >= 0; k--) {
      if (nums[k].kind === '$') { lastDollarIdx = k; break; }
    }
    if (lastDollarIdx >= 0) {
      row.totalCharges = nums[lastDollarIdx].val;
      nums = nums.slice(0, lastDollarIdx);
    }

    /* Now parse up to 3 modality pairs: units + $ */
    var modalIdx = 0;
    var i2 = 0;
    while (i2 < nums.length && modalIdx < 3) {
      if (nums[i2].kind === 'n') {
        var units = nums[i2].val;
        var chg   = (i2 + 1 < nums.length && nums[i2 + 1].kind === '$') ? nums[i2 + 1].val : '';
        i2 += (chg !== '' ? 2 : 1);
        if (modalIdx === 0) { row.otUnits = units; row.otCharges = chg; }
        else if (modalIdx === 1) { row.ptUnits = units; row.ptCharges = chg; }
        else if (modalIdx === 2) { row.stUnits = units; row.stCharges = chg; }
        modalIdx++;
      } else {
        i2++;
      }
    }

    return row;
  }

  /* ── Main per-PDF parser ─────────────────────────────────────────────── */

  async function extractHmoSkilledPdf(pdfDoc, fileName) {
    var allRows = [];

    for (var p = 1; p <= pdfDoc.numPages; p++) {
      var items   = await getPageItems(pdfDoc, p);
      var pgLines = groupLines(items);

      /* Read facility and month from L002 / L003 */
      var facility = '', month = '';
      pgLines.forEach(function (line) {
        var tx = ltext(line).trim();
        var fm = tx.match(/facility\s*:\s*(.+?)(?:\s{2,}|$)/i);
        if (fm) facility = fm[1].trim();
        /* Month: label is present on most pages */
        var mm = tx.match(/month\s*:\s*(.+)/i);
        if (mm) { month = mm[1].trim(); return; }
        /* Some pages omit the "Month:" label — year/month follows directly after "HMO Skilled" */
        var nm = tx.match(/hmo\s+skilled\s+(\d{4}\s+\w+)/i);
        if (nm && !month) month = nm[1].trim();
      });

      /* Check this is an HMO Skilled page */
      var isHmo = pgLines.some(function (l) {
        return /hmo\s+skilled/i.test(ltext(l));
      });
      if (!isHmo) continue;

      /* Process data lines */
      for (var li = 0; li < pgLines.length; li++) {
        var line = pgLines[li];
        var full = ltext(line).trim();

        /* Skip boilerplate */
        if (/focus\s+one\s+rehab/i.test(full))         continue;
        if (/paso\s+robles/i.test(full))                continue;
        if (/^facility\s*:/i.test(full))                continue;
        if (/bill\s+type.*hmo\s+skilled/i.test(full))  continue;
        if (/^ot\s+pt\s+st$/i.test(full))              continue;
        if (/patient\s+name/i.test(full))               continue;
        if (/^units\s+charges/i.test(full))             continue;

        /* Totals row */
        if (/^totals\s*:/i.test(full)) {
          var tr = parsePatientRow(line, facility, month, 'Total');
          /* Override name — "Totals:" label */
          if (tr) { tr.patientName = 'Totals'; allRows.push(tr); }
          continue;
        }

        /* Blank padding rows start with [0] at first position with no name */
        var firstTok = line[0] ? line[0].text.trim() : '';
        if (isUnits(firstTok) || isDollarToken(firstTok)) continue;
        if (firstTok === '-') continue;

        /* Patient row */
        var row = parsePatientRow(line, facility, month, 'Patient');
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
        r.otUnits, r.otCharges, r.ptUnits, r.ptCharges,
        r.stUnits, r.stCharges, r.totalCharges
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

  window.PdfHmoSkilledExtractor = {
    extractHmoSkilledPdf: extractHmoSkilledPdf,
    combineResults:       combineResults,
    rowsToCsv:            rowsToCsv,
    CSV_HEADERS:          CSV_HEADERS
  };

})(window);
