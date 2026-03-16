/**
 * pdfPrivateExtractor.js — Focus One Rehab: Private / Private/Medical/Hospice Extractor
 *
 * PDF STRUCTURE (one page per month, 3 sub-tables per page — PT, OT, ST):
 *
 *   L000-L001  Focus One Rehab Services / address
 *   L002       Facility:  California Post Acute
 *   L003       Bill Type:  Private   Month:  2022 August
 *               (or "Private/Medical/Hospice")
 *
 *   Then 3 repeating blocks per page (one per therapy type):
 *     Rate line:   Rate: $1.10 per Minute   Therapy Type: PT   ← (or OT / ST)
 *     Header line: Evaluation   Treatments   Eval + Treatments
 *     Col header:  #  Patient Name  Eval Date  Minutes  Amount  Visits  Minutes  Amount  Total Visits  Minutes  Charges
 *     Data rows:   [#]  [Name]  [EvalDate]  [evalMins]  [$]  [evalAmt]  [treatVisits]  [treatMins]  [$]  [treatAmt]  [totalVisits]  [totalMins]  [$]  [totalCharges]
 *     Blank rows:  [#]  [0]  [$]  [-]  ...  (no name, zeros)
 *     Invoice Total: [Invoice Total]  [evalMins]  [$]  [evalAmt]  [treatVisits]  [treatMins]  [$]  [treatAmt]  [totalVisits]  [totalMins]  [$]  [totalCharges]
 *     Dangling $:  [$]  [totalCharges]  (repeated total on next line — skip)
 *
 * KEY TOKEN QUIRKS:
 *   - Row number [1], [2], [3] is a leading digit token at x < 45
 *   - Name follows immediately after row number (also at small x)
 *   - Blank rows have row number but 0/- where name would be
 *   - "Invoice Total" label is a multi-word token at x < 50
 *   - Trailing dangling-$ line: only [$] and [amount] with no other content — skip
 *   - Bill Type variants: "Private", "Private/Medical/Hospice", "Medical", "Hospice"
 *     → captured verbatim as Section
 *
 * OUTPUT CSV COLUMNS (one row per patient per therapy type per month):
 *   Facility, Month, Section, Therapy Type, Record Type, Patient Name,
 *   Eval Date, Eval Minutes, Eval Amount, Treatment Visits, Treatment Minutes,
 *   Treatment Amount, Total Visits, Total Minutes, Total Charges
 *
 *   Record Type: Patient | Invoice Total
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

  /* ── Dollar / number helpers ───────────────────────────────────────────── */

  function fmt$(s) {
    if (!s) return '';
    var v = s.replace(/[$,\s]/g, '');
    if (v === '-' || v === '') return '';
    if (!/^\d+(\.\d+)?$/.test(v)) return '';
    if (v.indexOf('.') < 0) { v = v + '.00'; }
    else { var p = v.split('.'); v = p[0] + '.' + (p[1] + '00').slice(0, 2); }
    return v;
  }

  /* ── Row factory ───────────────────────────────────────────────────────── */

  var CSV_HEADERS = [
    'Facility', 'Month', 'Section', 'Therapy Type', 'Record Type', 'Patient Name',
    'Eval Date', 'Eval Minutes', 'Eval Amount',
    'Treatment Visits', 'Treatment Minutes', 'Treatment Amount',
    'Total Visits', 'Total Minutes', 'Total Charges'
  ];

  function makeRow(fac, mon, sec, therapy, rt, name) {
    return {
      facility: fac || '', month: mon || '', section: sec || '',
      therapyType: therapy || '', recordType: rt || '', patientName: name || '',
      evalDate: '', evalMins: '', evalAmt: '',
      treatVisits: '', treatMins: '', treatAmt: '',
      totalVisits: '', totalMins: '', totalCharges: ''
    };
  }

  /* ── Parse a data or Invoice Total line ─────────────────────────────────
   *
   * Expected token order (after optional [#] and [name]):
   *   [evalDate?]  [evalMins]  [$]  [evalAmt]  [treatVisits]  [treatMins]  [$]  [treatAmt]  [totalVisits]  [totalMins]  [$]  [totalCharges]
   *
   * evalDate may be present (date string) or absent.
   * Some fields may be 0/- (blank).
   *
   * We extract:
   *   - date strings matching \d{1,2}[/-]\d{1,2}[/-]\d{2,4}  or  \d{1,2}-[A-Za-z]{3}
   *   - number sequences interleaved with dollar amounts
   */
  function parseDataLine(line, fac, mon, sec, therapy, rt, name) {
    var row  = makeRow(fac, mon, sec, therapy, rt, name);
    var vals = [];
    var date = '';

    /* Merge split $ + number pairs first */
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

    merged.forEach(function (tk) {
      var t = tk.text.trim();
      if (!t || t === '-') return;
      /* Skip row-number tokens (single or double digit at far left) */
      if (/^\d{1,2}$/.test(t) && tk.x < 45) return;
      /* Skip name token (already captured) */
      if (t === name) return;
      /* Skip label tokens */
      if (/^invoice\s+total$/i.test(t)) return;
      if (/^\$[\d,.]+$/.test(t) || /^\$-$/.test(t)) {
        var v = fmt$(t);
        vals.push({ kind: '$', val: v });
        return;
      }
      /* Date */
      if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(t) || /^\d{1,2}-[A-Za-z]{3}$/.test(t)) {
        date = t; return;
      }
      /* Plain number (minutes / visits) */
      if (/^\d[\d,]*$/.test(t)) {
        vals.push({ kind: 'n', val: t }); return;
      }
    });

    row.evalDate = date;

    /*
     * vals sequence:
     *   [evalMins] [$evalAmt]  [treatVisits] [treatMins] [$treatAmt]  [totalVisits] [totalMins] [$totalChg]
     *
     * That is 2 numbers + 1 $ + 2 numbers + 1 $ + 2 numbers + 1 $  = 6n + 3$
     * But some (evalMins, evalAmt) may be absent (0 / no eval).
     * Robust: collect all n/$, then assign by known positions.
     *
     * If we have 9 items (6n+3$):
     *   [0]=evalMins [1]=$evalAmt [2]=treatVisits [3]=treatMins [4]=$treatAmt [5]=totalVisits [6]=totalMins [7]=$totalChg
     * If we have 7 items (5n+2$):  treat first two as treatVisits/treatMins, then $, then totalVisits/totalMins, $
     *   (eval was empty)
     * Most reliable: use the $ positions as anchors — there are always exactly 3 $'s (even if value is empty).
     */
    var dollarPositions = [];
    vals.forEach(function (v, idx) { if (v.kind === '$') dollarPositions.push(idx); });

    if (dollarPositions.length >= 3) {
      var d0 = dollarPositions[0], d1 = dollarPositions[1], d2 = dollarPositions[2];
      /* Eval section: tokens before d0 */
      var evalNums = vals.slice(0, d0).filter(function (v) { return v.kind === 'n'; });
      row.evalMins = evalNums.length >= 1 ? evalNums[evalNums.length - 1].val : '';
      row.evalAmt  = vals[d0].val;
      /* Treatment section: tokens between d0+1 and d1 */
      var treatNums = vals.slice(d0 + 1, d1).filter(function (v) { return v.kind === 'n'; });
      row.treatVisits = treatNums.length >= 2 ? treatNums[0].val : (treatNums.length === 1 ? treatNums[0].val : '');
      row.treatMins   = treatNums.length >= 2 ? treatNums[1].val : '';
      row.treatAmt    = vals[d1].val;
      /* Total section: tokens between d1+1 and d2 */
      var totalNums = vals.slice(d1 + 1, d2).filter(function (v) { return v.kind === 'n'; });
      row.totalVisits = totalNums.length >= 2 ? totalNums[0].val : (totalNums.length === 1 ? totalNums[0].val : '');
      row.totalMins   = totalNums.length >= 2 ? totalNums[1].val : '';
      row.totalCharges = vals[d2].val;
    } else if (dollarPositions.length === 1) {
      /* Only total charges present */
      row.totalCharges = vals[dollarPositions[0]].val;
    } else if (dollarPositions.length === 2) {
      /* eval and total, no treatments */
      row.evalAmt      = vals[dollarPositions[0]].val;
      row.totalCharges = vals[dollarPositions[1]].val;
    }

    return row;
  }

  /* ── Main per-PDF parser ─────────────────────────────────────────────── */

  async function extractPrivatePdf(pdfDoc, fileName) {
    var allRows = [];

    for (var p = 1; p <= pdfDoc.numPages; p++) {
      var items   = await getPageItems(pdfDoc, p);
      var pgLines = groupLines(items);

      /* Check this is a Private page */
      var isPrivate = pgLines.some(function (l) {
        return /bill\s+type\s*:.*private/i.test(ltext(l)) ||
               /bill\s+type\s*:.*medical/i.test(ltext(l)) ||
               /bill\s+type\s*:.*hospice/i.test(ltext(l));
      });
      if (!isPrivate) continue;

      /* Read facility, month, section */
      var facility = '', month = '', section = '';
      pgLines.forEach(function (line) {
        var tx = ltext(line).trim();
        var fm = tx.match(/facility\s*:\s*(.+?)(?:\s{2,}|$)/i);
        if (fm) facility = fm[1].trim();
        var mm = tx.match(/month\s*:\s*(.+)/i);
        if (mm) month = mm[1].trim();
        var bm = tx.match(/bill\s+type\s*:\s*([\w\/]+(?:\/[\w]+)*)/i);
        if (bm && !section) section = bm[1].trim();
      });

      /* State machine: track current therapy type */
      var currentTherapy = '';

      for (var li = 0; li < pgLines.length; li++) {
        var line = pgLines[li];
        var full = ltext(line).trim();

        /* Skip boilerplate */
        if (/focus\s+one\s+rehab/i.test(full))         continue;
        if (/paso\s+robles/i.test(full))                continue;
        if (/^facility\s*:/i.test(full))                continue;
        if (/bill\s+type\s*:/i.test(full))              continue;
        if (/^evaluation\s+treatments/i.test(full))     continue;
        if (/^#\s+patient\s+name/i.test(full))          continue;

        /* Therapy type header: Rate: $X.XX per Minute   Therapy Type: PT */
        var tMatch = full.match(/therapy\s+type\s*[:\s]+([A-Z]{2,3})/i);
        if (tMatch) {
          currentTherapy = tMatch[1].toUpperCase();
          continue;
        }

        /* Skip dangling $ lines (only 2 tokens: $ and amount, no name) */
        if (line.length <= 2) {
          var hasName = line.some(function (tk) {
            return tk.text.trim() && !/^\$/.test(tk.text) && !/^\d/.test(tk.text) && tk.text.trim() !== '-';
          });
          if (!hasName) continue;
        }

        /* Blank row: starts with row-number token then 0/$ tokens, no name */
        var isBlank = (function () {
          /* If first non-empty text after optional leading digit is a digit, it's blank */
          var nonLeading = line.filter(function (tk) {
            return tk.text.trim() && !((/^\d{1,2}$/.test(tk.text.trim())) && tk.x < 45);
          });
          if (!nonLeading.length) return true;
          var ft = nonLeading[0].text.trim();
          return ft === '0' || ft === '-' || /^\$/.test(ft);
        })();
        if (isBlank) continue;

        /* Invoice Total row */
        if (/^invoice\s+total$/i.test(full.split(/\s+/).slice(0, 2).join(' ')) ||
            /^invoice\s+total\b/i.test(full)) {
          var row = parseDataLine(line, facility, month, section, currentTherapy, 'Invoice Total', 'Invoice Total');
          if (row) allRows.push(row);
          continue;
        }

        /* Patient row: first token is row number, second is name */
        var rowNum = line[0] ? line[0].text.trim() : '';
        if (/^\d{1,2}$/.test(rowNum) && line[0].x < 45 && line.length > 2) {
          /* Name is next non-numeric token */
          var nameToken = null;
          for (var j = 1; j < line.length; j++) {
            var t = line[j].text.trim();
            if (t && !/^\d/.test(t) && !t.startsWith('$') && t !== '-') {
              nameToken = t; break;
            }
          }
          if (!nameToken) continue;
          var prow = parseDataLine(line, facility, month, section, currentTherapy, 'Patient', nameToken);
          if (prow && prow.patientName) allRows.push(prow);
          continue;
        }

        /* No row number — could still be a patient row on some pages */
        var hasName2 = (function () {
          return line.some(function (tk, idx) {
            var t = tk.text.trim();
            return t && !/^\d/.test(t) && !t.startsWith('$') && t !== '-' && tk.x < 120;
          });
        })();
        if (hasName2) {
          var name2 = '';
          for (var j2 = 0; j2 < line.length; j2++) {
            var t2 = line[j2].text.trim();
            if (t2 && !/^\d/.test(t2) && !t2.startsWith('$') && t2 !== '-' && line[j2].x < 120) {
              name2 = t2; break;
            }
          }
          if (name2 && !/^invoice/i.test(name2)) {
            var prow2 = parseDataLine(line, facility, month, section, currentTherapy, 'Patient', name2);
            if (prow2 && prow2.patientName) allRows.push(prow2);
          }
        }
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
        r.facility, r.month, r.section, r.therapyType, r.recordType, r.patientName,
        r.evalDate, r.evalMins, r.evalAmt,
        r.treatVisits, r.treatMins, r.treatAmt,
        r.totalVisits, r.totalMins, r.totalCharges
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

  window.PdfPrivateExtractor = {
    extractPrivatePdf: extractPrivatePdf,
    combineResults:    combineResults,
    rowsToCsv:         rowsToCsv,
    CSV_HEADERS:       CSV_HEADERS
  };

})(window);
