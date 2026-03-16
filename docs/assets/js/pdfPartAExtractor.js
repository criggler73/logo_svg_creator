/**
 * pdfPartAExtractor.js — Medicare Part A (and HMO A) Detail Extractor
 *
 * FILE STRUCTURE per PDF:
 *
 *   Page header (first page only):
 *     Focus One Rehab Services / address / phone / fax
 *     FACILITY:   California Post Acute
 *     MONTH       2023 June
 *     MEDICARE PART "A" and HMO A's
 *
 *   Resident detail blocks (repeat across pages):
 *     [yellow] Resident Name (Last, First)          Service Dates
 *     AGUILAR, RAMON                                06/01/2023 - 06/30/2023
 *     [yellow] Date Range | ARD | Reason | Component | CMG | Days | Full Rate | Contracted Rate | Charges
 *     06/01/2023 - 06/06/2023 | 5/18/2023 | 5-Day | OT | TJ | 6 | $104.33 | $36.52 | $219.12
 *     ...
 *     [yellow]                                            Total: | $3,048.41
 *
 *   End of Med A section:
 *     Invoiced Amount:   $52,105.67
 *     Per minute
 *     34,818 min x 1.01 = $35,166.18
 *
 *   Patient Summary table (one page, no yellow rows):
 *     2023 June
 *     PATIENT NAME | PT min | PT charge | OT min | OT charge | ST min | ST charge | TOTAL min | Total Charge
 *     AGUILAR, RAMON | 966 | $975.66 | ...
 *     Totals | ...
 *
 *   HMO A section (optional):
 *     HMO A   2023 June
 *     PATIENT NAME | PT min | ...  (summary table first)
 *     Totals
 *     [resident detail blocks — same structure as Med A]
 *     Invoiced Amount / Per minute
 *
 * OUTPUT CSV:
 *   Two logical blocks in one CSV, separated by a blank row:
 *
 *   BLOCK 1 — DETAIL (one row per date-range line):
 *     Facility, Month, Section, Record Type, Resident Name, Service Dates,
 *     Date Range, ARD, Reason, Component, CMG, Days, Full Rate, Contracted Rate, Charges
 *
 *     Record Type values: Detail | Resident Total | Invoiced Amount | Per Minute
 *
 *   BLOCK 2 — PATIENT SUMMARY (one row per patient):
 *     Facility, Month, Section, Record Type, Patient Name,
 *     PT min, PT charge, OT min, OT charge, ST min, ST charge, TOTAL min, Total Charge
 *
 *     Record Type values: Patient Summary | Section Total
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
  function ltok(line, i) { return (i < line.length) ? line[i].text.trim() : ''; }

  function isDate(s) { return /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s); }
  function isDateRange(s) { return /^\d{1,2}\/\d{1,2}\/\d{4}\s*-\s*\d{1,2}\/\d{1,2}\/\d{4}$/.test(s); }

  /* ── Dollar helpers ────────────────────────────────────────────────────── */

  function fmt$(s) {
    if (!s) return '';
    var v = s.replace(/[$,\s]/g, '');
    if (v === '-' || v === '') return '';
    if (!/^\d+(\.\d+)?$/.test(v)) return '';
    if (v.indexOf('.') >= 0) {
      var p = v.split('.');
      v = p[0] + '.' + (p[1] + '00').slice(0, 2);
    }
    return v;
  }

  function lastDollar(line) {
    for (var i = line.length - 1; i >= 0; i--) {
      var t = line[i].text.trim();
      if (/^\$?[\d,]+(\.\d+)?$/.test(t)) return fmt$(t);
      if (t === '-') return '';
    }
    return '';
  }

  function isBlankRow(line) {
    return line.every(function (tk) {
      var t = tk.text.trim();
      return !t || t === '-' || t === '$' || t === '$-' || /^\$?0+(\.0+)?$/.test(t.replace(/,/g,''));
    });
  }

  /* ── Row factories ─────────────────────────────────────────────────────── */

  var DETAIL_HEADERS = [
    'Facility','Month','Section','Record Type','Resident Name','Service Dates',
    'Date Range','ARD','Reason','Component','CMG','Days','Full Rate','Contracted Rate','Charges'
  ];

  var SUMMARY_HEADERS = [
    'Facility','Month','Section','Record Type','Patient Name',
    'PT min','PT charge','OT min','OT charge','ST min','ST charge','TOTAL min','Total Charge'
  ];

  /* Combined header = DETAIL_HEADERS + summary-only columns (drop duplicate context cols) */
  var CSV_HEADERS = DETAIL_HEADERS.concat([
    'PT min','PT charge','OT min','OT charge','ST min','ST charge','TOTAL min','Total Charge','Notes'
  ]);

  function detailRow(fac, mon, sec, rt, name, dates, dr, ard, rsn, comp, cmg, days, fr, cr, ch) {
    return {
      facility:fac, month:mon, section:sec, recordType:rt,
      residentName:name, serviceDates:dates,
      dateRange:dr||'', ard:ard||'', reason:rsn||'', component:comp||'',
      cmg:cmg||'', days:days||'', fullRate:fr||'', contractedRate:cr||'', charges:ch||'',
      ptMin:'',ptCharge:'',otMin:'',otCharge:'',stMin:'',stCharge:'',totalMin:'',totalCharge:'',notes:''
    };
  }

  function summaryRow(fac, mon, sec, rt, name, ptm, ptc, otm, otc, stm, stc, tom, toc) {
    return {
      facility:fac, month:mon, section:sec, recordType:rt,
      residentName:name, serviceDates:'',
      dateRange:'',ard:'',reason:'',component:'',cmg:'',days:'',fullRate:'',contractedRate:'',charges:'',
      ptMin:ptm||'',ptCharge:ptc||'',otMin:otm||'',otCharge:otc||'',
      stMin:stm||'',stCharge:stc||'',totalMin:tom||'',totalCharge:toc||'',notes:''
    };
  }

  function noteRow(fac, mon, sec, rt, notes) {
    return {
      facility:fac,month:mon,section:sec,recordType:rt,
      residentName:'',serviceDates:'',
      dateRange:'',ard:'',reason:'',component:'',cmg:'',days:'',fullRate:'',contractedRate:'',charges:'',
      ptMin:'',ptCharge:'',otMin:'',otCharge:'',stMin:'',stCharge:'',totalMin:'',totalCharge:'',
      notes:notes||''
    };
  }

  /* ── Parse patient-summary table lines ─────────────────────────────────── */
  function parseSummaryLines(lines, fac, mon, sec) {
    var rows = [];
    var inData = false;
    lines.forEach(function (line) {
      var full = ltext(line).trim();
      if (!full) return;
      /* Header row triggers data mode */
      if (/pt\s+min/i.test(full)) { inData = true; return; }
      if (!inData) return;
      if (isBlankRow(line)) return;

      var isTotals = /^totals?$/i.test(ltok(line, 0));
      if (!isTotals && isBlankRow(line)) return;

      var tokens = line.map(function (t) { return t.text.trim(); });
      /* Name = tokens before first integer or $ */
      var nameEnd = tokens.length;
      for (var i = 0; i < tokens.length; i++) {
        if (/^\d+$/.test(tokens[i]) || /^\$/.test(tokens[i])) { nameEnd = i; break; }
      }
      var name = tokens.slice(0, nameEnd).join(' ').trim();
      var nums = tokens.slice(nameEnd);
      var ints = [], dolls = [];
      nums.forEach(function (n) {
        if (/^\d+$/.test(n))                     ints.push(n);
        else if (/^\$[\d,]+(\.\d+)?$/.test(n))   dolls.push(fmt$(n));
        else if (n === '-')                        dolls.push('');
      });
      rows.push(summaryRow(fac, mon, sec,
        isTotals ? 'Section Total' : 'Patient Summary',
        name, ints[0],dolls[0],ints[1],dolls[1],ints[2],dolls[2],ints[3],dolls[3]));
    });
    return rows;
  }

  /* ── Parse a single detail data line ────────────────────────────────────
   * Returns a partial row object {dateRange,ard,reason,component,cmg,days,fullRate,contractedRate,charges}
   * or null if the line is not a valid detail row.
   */
  function parseDetailLine(line) {
    var t0 = ltok(line, 0);
    var startsWithDate = isDate(t0) || isDateRange(t0);
    if (!startsWithDate) return null;

    /* Build date range + find where rest of columns start */
    var dateRange = '', colStart = 1;
    if (isDateRange(t0)) {
      dateRange = t0;
      colStart  = 1;
    } else {
      /* t0 is first date, look for dash + second date */
      dateRange = t0;
      if (ltok(line,1) === '-' && isDate(ltok(line,2))) {
        dateRange += ' - ' + ltok(line,2); colStart = 3;
      } else if (isDate(ltok(line,1))) {
        dateRange += ' - ' + ltok(line,1); colStart = 2;
      }
    }

    var rest = line.slice(colStart);
    var ri = 0;

    var ard = '';
    if (isDate(ltok(rest,ri))) { ard = ltok(rest,ri); ri++; }

    var reason = '';
    if (/^\d+-day$/i.test(ltok(rest,ri))) { reason = ltok(rest,ri); ri++; }

    var comp = '';
    if (/^(ot|pt|slp)$/i.test(ltok(rest,ri))) { comp = ltok(rest,ri); ri++; }

    var cmg = '';
    if (/^[A-Z]{1,2}$/.test(ltok(rest,ri))) { cmg = ltok(rest,ri); ri++; }

    var days = '';
    if (/^\d+$/.test(ltok(rest,ri))) { days = ltok(rest,ri); ri++; }

    var fr = '', cr = '', ch = '';
    if (/^\$[\d,]+\.\d+$/.test(ltok(rest,ri))) { fr = fmt$(ltok(rest,ri)); ri++; }
    if (/^\$[\d,]+\.\d+$/.test(ltok(rest,ri))) { cr = fmt$(ltok(rest,ri)); ri++; }
    if (/^\$[\d,]+\.\d+$/.test(ltok(rest,ri))) { ch = fmt$(ltok(rest,ri)); ri++; }
    if (!ch) ch = lastDollar(line);

    return { dateRange:dateRange, ard:ard, reason:reason, component:comp,
             cmg:cmg, days:days, fullRate:fr, contractedRate:cr, charges:ch };
  }

  /* ── Main per-PDF parser ─────────────────────────────────────────────── */
  async function extractPartAPdf(pdfDoc, fileName) {
    /* 1. Collect all page lines */
    var pageLines = [];
    for (var p = 1; p <= pdfDoc.numPages; p++) {
      pageLines.push(groupLines(await getPageItems(pdfDoc, p)));
    }

    /* 2. Flatten to a single stream */
    var stream = [];
    pageLines.forEach(function (pg) { pg.forEach(function (l) { stream.push(l); }); });

    /* 3. Extract facility + month from early lines */
    var facility = '', month = '';
    for (var si = 0; si < Math.min(stream.length, 60); si++) {
      var tx = ltext(stream[si]);
      var fm = tx.match(/facility\s*[:\s]+(.+)/i);
      if (fm && !facility) facility = fm[1].trim();
      var mm = tx.match(/^month\s+(.+)/i);
      if (mm && !month) month = mm[1].trim();
      if (facility && month) break;
    }

    /* 4. State machine */
    var allRows      = [];
    var section      = '';   /* 'Medicare Part A' | 'HMO A' */
    var mode         = '';   /* 'detail' | 'summary' */

    /* Current resident context */
    var resName      = '';
    var resDates     = '';
    var waitingName  = false; /* true = next content line is the name+dates line */

    /* Summary accumulator */
    var summaryLines = [];

    var perMinNext   = false;

    function pushSummary() {
      if (!summaryLines.length) return;
      allRows.push(null); /* blank separator */
      parseSummaryLines(summaryLines, facility, month, section)
        .forEach(function (r) { allRows.push(r); });
      summaryLines = [];
    }

    for (var i = 0; i < stream.length; i++) {
      var line = stream[i];
      var full = ltext(line).trim();
      if (!full) continue;

      /* ── Skip boilerplate page headers ── */
      if (/focus\s+one\s+rehab/i.test(full))      continue;
      if (/\d{4}\s+\w+.*street/i.test(full))       continue;
      if (/phone\s*:/i.test(full))                 continue;
      if (/fax\s*:/i.test(full))                   continue;
      if (/^facility\s*:/i.test(full))             continue;
      if (/^month\s+\d{4}/i.test(full))            continue; /* "MONTH  2023 June" */

      /* ── Section title: MEDICARE PART "A" and HMO A's ── */
      if (/medicare\s+part\s+[""]?a[""]?\s+and\s+hmo/i.test(full)) {
        pushSummary();
        section      = 'Medicare Part A';
        mode         = 'detail';
        resName = ''; resDates = ''; waitingName = false;
        continue;
      }

      /* ── HMO A header: "HMO A  2023 June" ── */
      if (/^hmo\s*a\b/i.test(ltok(line,0)) && !/medicare/i.test(full)) {
        pushSummary();
        var hmom = full.replace(/^hmo\s*a\s*/i,'').trim();
        if (hmom) month = hmom;
        section      = 'HMO A';
        /* HMO A starts with summary table then detail — start in summary mode */
        mode         = 'summary';
        resName = ''; resDates = ''; waitingName = false;
        continue;
      }

      /* ── Invoiced Amount ── */
      if (/invoiced\s+amount/i.test(full)) {
        var invRow = noteRow(facility, month, section, 'Invoiced Amount', full);
        invRow.charges = lastDollar(line);
        allRows.push(invRow);
        perMinNext = false;
        continue;
      }

      /* ── Per minute label / formula ── */
      if (/^per\s+minute$/i.test(full)) { perMinNext = true; continue; }
      if (perMinNext) {
        allRows.push(noteRow(facility, month, section, 'Per Minute', full));
        perMinNext = false;
        continue;
      }

      if (!section) continue;

      /* ── Summary mode ── */
      if (mode === 'summary') {
        /* Resident Name header → switch to detail */
        if (/resident\s+name/i.test(full)) {
          pushSummary();
          mode        = 'detail';
          waitingName = true;
          continue;
        }
        summaryLines.push(line);
        continue;
      }

      /* ── Detail mode ── */

      /* Summary table trigger: "PT min" column header */
      if (/pt\s+min/i.test(full) && mode === 'detail') {
        mode = 'summary';
        summaryLines.push(line);
        resName = ''; resDates = '';
        continue;
      }

      /* "Resident Name (Last, First)" yellow header — next line is name+dates */
      if (/resident\s+name/i.test(full)) {
        waitingName = true;
        continue;
      }

      /* "Date Range  ARD  Reason ..." column header row — skip */
      if (/date\s+range/i.test(full) && /ard/i.test(full)) continue;

      /* Waiting for the name + service dates line */
      if (waitingName) {
        /* Split by x position: name is left, dates are right.
           Find x midpoint of the line. */
        var xs = line.map(function (t) { return t.x; });
        var xmin = Math.min.apply(null, xs);
        var xmax = Math.max.apply(null, xs);
        var xmid = (xmin + xmax) / 2;

        var nameToks = [], dateToks = [];
        if (xmax - xmin > 150) {
          /* Wide line — split at midpoint */
          line.forEach(function (t) {
            if (t.x < xmid) nameToks.push(t.text.trim());
            else             dateToks.push(t.text.trim());
          });
        } else {
          /* Narrow — split at first date token */
          var hitDate = false;
          line.forEach(function (t) {
            var tx = t.text.trim();
            if (!hitDate && isDate(tx)) hitDate = true;
            if (hitDate) dateToks.push(tx);
            else         nameToks.push(tx);
          });
        }
        resName  = nameToks.join(' ').trim();
        resDates = dateToks.join(' ').replace(/\s*-\s*/g,' - ').trim();
        waitingName = false;
        continue;
      }

      /* Total row for this resident */
      if (/^total\s*[:\s]/i.test(full) || /^total$/i.test(ltok(line,0))) {
        var tr2 = detailRow(facility,month,section,'Resident Total',resName,resDates,'','','','','','','','',lastDollar(line));
        allRows.push(tr2);
        continue;
      }

      /* ── Actual detail data line ── */
      var dl = parseDetailLine(line);
      if (dl) {
        var dr = detailRow(facility,month,section,'Detail',resName,resDates,
          dl.dateRange,dl.ard,dl.reason,dl.component,dl.cmg,dl.days,
          dl.fullRate,dl.contractedRate,dl.charges);
        allRows.push(dr);
      }
    }

    /* Flush any remaining summary */
    pushSummary();

    return { fileName:fileName, rows:allRows };
  }

  /* ── CSV export ──────────────────────────────────────────────────────── */

  var CSV_HEADERS = [
    'Facility','Month','Section','Record Type','Resident Name','Service Dates',
    'Date Range','ARD','Reason','Component','CMG','Days','Full Rate','Contracted Rate','Charges',
    'PT min','PT charge','OT min','OT charge','ST min','ST charge','TOTAL min','Total Charge','Notes'
  ];

  function esc(v) {
    if (v == null) return '';
    v = String(v).trim();
    return /[",\n\r]/.test(v) ? '"'+v.replace(/"/g,'""')+'"' : v;
  }

  function rowsToCsv(rows) {
    var out = [CSV_HEADERS.map(esc).join(',')];
    rows.forEach(function (r) {
      if (r === null) { out.push(new Array(CSV_HEADERS.length).fill('').join(',')); return; }
      out.push([
        r.facility,r.month,r.section,r.recordType,r.residentName,r.serviceDates,
        r.dateRange,r.ard,r.reason,r.component,r.cmg,r.days,
        r.fullRate,r.contractedRate,r.charges,
        r.ptMin,r.ptCharge,r.otMin,r.otCharge,r.stMin,r.stCharge,r.totalMin,r.totalCharge,
        r.notes
      ].map(esc).join(','));
    });
    return out.join('\r\n');
  }

  function combineResults(results) {
    var all = [];
    results.forEach(function (res) {
      (res.rows||[]).forEach(function (r) { all.push(r); });
    });
    return all;
  }

  window.PdfPartAExtractor = {
    extractPartAPdf : extractPartAPdf,
    combineResults  : combineResults,
    rowsToCsv       : rowsToCsv,
    CSV_HEADERS     : CSV_HEADERS
  };

})(window);
