/**
 * pdfPartAExtractor.js — Medicare Part A (and HMO A) Detail Extractor
 *
 * KEY PDF QUIRKS discovered from real file analysis:
 *
 * 1. Dollar values are split tokens: [$] [882.74] — NOT [$882.74]
 *    Must merge adjacent $ + number tokens when parsing summary tables.
 *
 * 2. "Contracted Rate" column header is split across two lines:
 *    [Contracted](x=436) on one line, [Rate](x=460) on the next.
 *    Must skip "Rate" stub lines and treat "Contracted" as part of column header.
 *
 * 3. Long names wrap: "RODRIGUEZ ACEVEDO," on one line, "MIGUEL" on the next.
 *    The number tokens appear on the SECOND line (MIGUEL line).
 *    Must merge the two lines for summary parsing.
 *
 * 4. Component is blank on continuation rows — must carry forward last non-blank.
 *
 * 5. "Totals" row uses same split-dollar format as summary rows.
 *
 * 6. HMO A detail pages have x-coordinates ~half those of Med A pages (different scale/margin).
 *    The column structure is identical but x positions differ — use relative/positional parsing.
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

  /* Return a clean numeric string, always with 2 decimal places. */
  function fmt$(s) {
    if (!s) return '';
    var v = s.replace(/[$,\s]/g, '');
    if (v === '-' || v === '') return '';
    if (!/^\d+(\.\d+)?$/.test(v)) return '';
    /* Ensure exactly 2 decimal places */
    if (v.indexOf('.') < 0) {
      v = v + '.00';
    } else {
      var p = v.split('.');
      v = p[0] + '.' + (p[1] + '00').slice(0, 2);
    }
    return v;
  }

  /*
   * Merge split dollar tokens: PDF emits [$] [882.74] as separate tokens.
   * This function returns an array of tokens where adjacent [$] + [number] pairs
   * are merged into a single token like [$882.74].
   */
  function mergeTokens(line) {
    var merged = [];
    for (var i = 0; i < line.length; i++) {
      var t = line[i].text.trim();
      if (t === '$' && i + 1 < line.length) {
        var next = line[i + 1].text.trim();
        if (/^[\d,]+(\.\d+)?$/.test(next) || next === '-') {
          merged.push({ x: line[i].x, y: line[i].y, text: '$' + next });
          i++; /* skip the number token */
          continue;
        }
      }
      merged.push(line[i]);
    }
    return merged;
  }

  function lastDollar(line) {
    var m = mergeTokens(line);
    for (var i = m.length - 1; i >= 0; i--) {
      var t = m[i].text.trim();
      if (/^\$?[\d,]+(\.\d+)?$/.test(t)) return fmt$(t);
      if (t === '-' || t === '$-') return '';
    }
    return '';
  }

  function isBlankRow(line) {
    return mergeTokens(line).every(function (tk) {
      var t = tk.text.trim();
      return !t || t === '-' || t === '$-' || t === '$0.00' ||
             /^\$?0+(\.0+)?$/.test(t.replace(/,/g, ''));
    });
  }

  /* ── CSV row factories ─────────────────────────────────────────────────── */

  var CSV_HEADERS = [
    'Facility', 'Month', 'Section', 'Record Type', 'Resident Name', 'Service Dates',
    'Date Range', 'ARD', 'Reason', 'Component', 'CMG', 'Days', 'Full Rate', 'Contracted Rate', 'Charges',
    'PT min', 'PT charge', 'OT min', 'OT charge', 'ST min', 'ST charge', 'TOTAL min', 'Total Charge', 'Notes'
  ];

  function makeRow(fac, mon, sec, rt, name, dates) {
    return {
      facility: fac||'', month: mon||'', section: sec||'', recordType: rt||'',
      residentName: name||'', serviceDates: dates||'',
      dateRange:'', ard:'', reason:'', component:'', cmg:'', days:'',
      fullRate:'', contractedRate:'', charges:'',
      ptMin:'', ptCharge:'', otMin:'', otCharge:'',
      stMin:'', stCharge:'', totalMin:'', totalCharge:'', notes:''
    };
  }

  /* ── Parse patient-summary table lines ─────────────────────────────────── */
  /*
   * Token format after merging: PATIENT NAME ... int $xxx.xx int $xxx.xx int $xxx.xx int $xxx.xx
   * Dollar sign and number are separate in PDF — mergeTokens() fixes this first.
   * Long names that wrap to a second line (e.g. "RODRIGUEZ ACEVEDO," / "MIGUEL") are
   * handled by pre-merging consecutive lines where the second has no name-start tokens.
   */
  function parseSummaryLines(lines, fac, mon, sec) {
    var rows = [];
    var inData = false;

    /* Pre-merge wrapped name lines: if a line starts with a text token but has no numbers,
       and the NEXT line starts with a text token followed immediately by numbers,
       then the first line is the start of the name and we should merge them. */
    var merged = [];
    for (var i = 0; i < lines.length; i++) {
      var line = mergeTokens(lines[i]);
      var full = ltext(line).trim();
      if (!full) continue;

      /* Detect a "name overflow" line: only text tokens, no numbers, no $ */
      var isNameOnly = line.every(function (t) {
        return !/^\$/.test(t.text) && !/^\d+$/.test(t.text.trim());
      });

      /* If this is name-only AND next line has the numbers, merge them */
      if (isNameOnly && i + 1 < lines.length) {
        var nextLine = mergeTokens(lines[i + 1]);
        var nextHasNumbers = nextLine.some(function (t) { return /^\d+$/.test(t.text.trim()); });
        if (nextHasNumbers) {
          /* Merge: prepend this line's tokens to next line */
          merged.push(line.concat(nextLine));
          i++; /* skip next line */
          continue;
        }
      }
      merged.push(line);
    }

    merged.forEach(function (line) {
      var full = ltext(line).trim();
      if (!full) return;
      /* Column header row */
      if (/pt\s+min/i.test(full)) { inData = true; return; }
      if (!inData) return;
      if (isBlankRow(line)) return;

      var isTotals = /^totals?$/i.test(ltok(line, 0));

      /* Extract: name tokens (non-numeric, non-$) then numeric/dollar tokens */
      var nameEnd = line.length;
      for (var i = 0; i < line.length; i++) {
        var t = line[i].text.trim();
        if (/^\d+$/.test(t) || /^\$/.test(t)) { nameEnd = i; break; }
      }
      var name = line.slice(0, nameEnd).map(function (t) { return t.text.trim(); }).join(' ').trim();
      var rest = line.slice(nameEnd);

      /* Collect: int $amt int $amt int $amt int $amt (PT OT ST TOTAL) */
      var ints = [], dolls = [];
      rest.forEach(function (tk) {
        var t = tk.text.trim();
        if (/^\d[\d,]*$/.test(t))               ints.push(t.replace(/,/g, ''));
        else if (/^\$[\d,]+(\.\d+)?$/.test(t))  dolls.push(fmt$(t));
        else if (t === '$-' || t === '-')        dolls.push('');
      });

      var r = makeRow(fac, mon, sec, isTotals ? 'Section Total' : 'Patient Summary', name, '');
      r.ptMin      = ints[0]  || '';
      r.ptCharge   = dolls[0] || '';
      r.otMin      = ints[1]  || '';
      r.otCharge   = dolls[1] || '';
      r.stMin      = ints[2]  || '';
      r.stCharge   = dolls[2] || '';
      r.totalMin   = ints[3]  || '';
      r.totalCharge= dolls[3] || '';
      rows.push(r);
    });
    return rows;
  }

  /* ── Parse a single detail data line ────────────────────────────────────
   * Returns partial object or null.
   * Handles the "Contracted Rate" column header split across two lines —
   * the "Rate" stub line is filtered upstream, but the column header that says
   * "Contracted" alone is also filtered before reaching here.
   */
  function parseDetailLine(line) {
    var t0 = ltok(line, 0);
    var startsDate = isDate(t0) || isDateRange(t0);
    if (!startsDate) return null;

    /* Build date range */
    var dateRange = '', colStart = 1;
    if (isDateRange(t0)) {
      dateRange = t0;
    } else {
      dateRange = t0;
      if (ltok(line, 1) === '-' && isDate(ltok(line, 2))) {
        dateRange += ' - ' + ltok(line, 2); colStart = 3;
      } else if (isDate(ltok(line, 1))) {
        dateRange += ' - ' + ltok(line, 1); colStart = 2;
      }
    }

    var rest = line.slice(colStart);
    var ri = 0;

    var ard = '';
    if (isDate(ltok(rest, ri))) { ard = ltok(rest, ri); ri++; }

    var reason = '';
    if (/^\d+-day$/i.test(ltok(rest, ri))) { reason = ltok(rest, ri); ri++; }

    var comp = '';
    if (/^(ot|pt|slp)$/i.test(ltok(rest, ri))) { comp = ltok(rest, ri); ri++; }

    var cmg = '';
    if (/^[A-Z]{1,2}$/.test(ltok(rest, ri))) { cmg = ltok(rest, ri); ri++; }

    var days = '';
    if (/^\d+$/.test(ltok(rest, ri))) { days = ltok(rest, ri); ri++; }

    /* Full Rate, Contracted Rate, Charges — each is $xxx.xx */
    var fr = '', cr = '', ch = '';
    if (/^\$[\d,]+\.\d+$/.test(ltok(rest, ri))) { fr = fmt$(ltok(rest, ri)); ri++; }
    if (/^\$[\d,]+\.\d+$/.test(ltok(rest, ri))) { cr = fmt$(ltok(rest, ri)); ri++; }
    if (/^\$[\d,]+\.\d+$/.test(ltok(rest, ri))) { ch = fmt$(ltok(rest, ri)); ri++; }
    if (!ch) ch = lastDollar(line);

    return { dateRange: dateRange, ard: ard, reason: reason, component: comp,
             cmg: cmg, days: days, fullRate: fr, contractedRate: cr, charges: ch };
  }

  /* ── Main per-PDF parser ─────────────────────────────────────────────── */

  async function extractPartAPdf(pdfDoc, fileName) {
    /* Collect all page lines, tagging each line with its page index */
    var pageLines = [];
    for (var p = 1; p <= pdfDoc.numPages; p++) {
      pageLines.push(groupLines(await getPageItems(pdfDoc, p)));
    }

    /*
     * Build a per-page month index so we can update the current month
     * whenever a new MEDICARE PART "A" section header is encountered.
     * The MONTH line always appears on the same page as the section header.
     */
    var pageMonth = [];    /* pageMonth[p] = month string for page p (0-indexed) */
    var pageFacility = []; /* pageFacility[p] = facility string for page p */
    var lastFac = '', lastMon = '';
    for (var pi = 0; pi < pageLines.length; pi++) {
      var pg = pageLines[pi];
      var fac = '', mon = '';
      for (var li = 0; li < pg.length; li++) {
        var tx0 = ltext(pg[li]).trim();
        var fm0 = tx0.match(/facility\s*[:\s]+(.+)/i);
        if (fm0) fac = fm0[1].trim();
        var mm0 = tx0.match(/^month\s+(.+)/i);
        if (mm0) mon = mm0[1].trim();
      }
      if (fac) lastFac = fac;
      if (mon) lastMon = mon;
      pageFacility[pi] = lastFac;
      pageMonth[pi]    = lastMon;
    }

    /* Flatten stream — tag every line with its page index */
    var stream = [];
    pageLines.forEach(function (pg, pidx) {
      pg.forEach(function (l) {
        stream.push({ line: l, pageIdx: pidx });
      });
    });

    /* Seed facility and month from page 0 */
    var facility = pageFacility[0] || '';
    var month    = pageMonth[0]    || '';

    var allRows     = [];
    var section     = '';
    var mode        = '';
    var resName     = '';
    var resDates    = '';
    var waitingName = false;
    var lastComp    = ''; /* for component carry-forward */
    var summaryLines = [];
    var perMinNext  = false;

    function pushSummary() {
      if (!summaryLines.length) return;
      allRows.push(null); /* blank separator */
      parseSummaryLines(summaryLines, facility, month, section)
        .forEach(function (r) { allRows.push(r); });
      summaryLines = [];
    }

    for (var i = 0; i < stream.length; i++) {
      var line = stream[i].line;
      var pageIdx = stream[i].pageIdx;
      var full = ltext(line).trim();
      if (!full) continue;

      /* ── Skip boilerplate ── */
      if (/focus\s+one\s+rehab/i.test(full))    continue;
      if (/\d{4}\s+\w+.*street/i.test(full))    continue;
      if (/^phone\s*:/i.test(full))              continue;
      if (/^fax\s*:/i.test(full))               continue;
      if (/^facility\s*:/i.test(full))           continue;
      if (/^month\s+\d{4}/i.test(full))          continue;

      /* Skip "Contracted" and "Rate" stub lines from split column header */
      if (/^contracted$/i.test(full))            continue;
      if (/^rate$/i.test(full) && line.length <= 2) continue;

      /* Skip stray "#" overflow marker lines */
      if (/^#+$/.test(full) && line.length <= 2) continue;

      /* Skip page number stubs (single digit at far left) */
      if (/^\d+$/.test(full) && line.length === 1 && line[0].x < 60) continue;

      /* ── Section title: MEDICARE PART "A" and HMO A's ── */
      if (/medicare\s+part\s+[""]?a[""]?\s+and\s+hmo/i.test(full)) {
        pushSummary();
        /* Update month and facility from THIS page's header */
        facility = pageFacility[pageIdx] || facility;
        month    = pageMonth[pageIdx]    || month;
        section = 'Medicare Part A'; mode = 'detail';
        resName = ''; resDates = ''; waitingName = false; lastComp = '';
        continue;
      }

      /* ── HMO A header ── */
      if (/^hmo\s*a\b/i.test(ltok(line, 0)) && !/medicare/i.test(full)) {
        pushSummary();
        /* The HMO A line itself often carries the month: "HMO A   2023 June" */
        var hmom = full.replace(/^hmo\s*a\s*/i, '').trim();
        if (hmom) month = hmom;
        section = 'HMO A'; mode = 'summary';
        resName = ''; resDates = ''; waitingName = false; lastComp = '';
        continue;
      }

      /* ── Invoiced Amount ── */
      if (/invoiced\s+amount/i.test(full)) {
        var inv = makeRow(facility, month, section, 'Invoiced Amount', '', '');
        var invAmt = lastDollar(line);
        /* Sometimes the dollar value is on the very next line (PDF line-wrap) */
        if (!invAmt && i + 1 < stream.length) {
          var nextFull = ltext(stream[i + 1].line).trim();
          if (/^\$[\d,]+\.\d+$/.test(nextFull)) {
            invAmt = fmt$(nextFull);
            i++; /* consume the next line */
          }
        }
        inv.charges = invAmt; inv.notes = full;
        allRows.push(inv); perMinNext = false; continue;
      }

      /* ── Per minute ── */
      if (/^per\s+minute$/i.test(full)) { perMinNext = true; continue; }
      if (perMinNext) {
        var pm = makeRow(facility, month, section, 'Per Minute', '', '');
        pm.notes = full; allRows.push(pm); perMinNext = false; continue;
      }

      if (!section) continue;

      /* ── Summary mode ── */
      if (mode === 'summary') {
        if (/resident\s+name/i.test(full)) {
          pushSummary(); mode = 'detail'; waitingName = true; continue;
        }
        summaryLines.push(line); continue;
      }

      /* ── Detail mode ── */

      /* PT min column header → switch to summary */
      if (/pt\s+min/i.test(full) && mode === 'detail') {
        mode = 'summary'; summaryLines.push(line);
        resName = ''; resDates = ''; lastComp = ''; continue;
      }

      /* Resident Name header label */
      if (/resident\s+name/i.test(full)) { waitingName = true; continue; }

      /* Column header row */
      if (/date\s+range/i.test(full) && /ard/i.test(full)) continue;

      /* Name + service dates line */
      if (waitingName) {
        var xs = line.map(function (t) { return t.x; });
        var xmin = Math.min.apply(null, xs);
        var xmax = Math.max.apply(null, xs);
        var xmid = (xmin + xmax) / 2;
        var nameToks = [], dateToks = [];
        if (xmax - xmin > 150) {
          line.forEach(function (t) {
            if (t.x < xmid) nameToks.push(t.text.trim());
            else             dateToks.push(t.text.trim());
          });
        } else {
          var hitDate = false;
          line.forEach(function (t) {
            var tx = t.text.trim();
            if (!hitDate && isDate(tx)) hitDate = true;
            if (hitDate) dateToks.push(tx); else nameToks.push(tx);
          });
        }
        resName  = nameToks.join(' ').trim();
        resDates = dateToks.join(' ').replace(/\s*-\s*/g, ' - ').trim();
        waitingName = false; lastComp = '';
        continue;
      }

      /* Total row */
      if (/^total\s*[:\s]/i.test(full) || /^total$/i.test(ltok(line, 0))) {
        var tr = makeRow(facility, month, section, 'Resident Total', resName, resDates);
        tr.charges = lastDollar(line); allRows.push(tr); continue;
      }

      /* Detail data line */
      var dl = parseDetailLine(line);
      if (dl) {
        /* Component carry-forward: if blank, use last non-blank component */
        if (dl.component) {
          lastComp = dl.component;
        } else {
          dl.component = lastComp;
        }
        /* Reset carry-forward when a new component type starts */
        var dr = makeRow(facility, month, section, 'Detail', resName, resDates);
        dr.dateRange      = dl.dateRange;
        dr.ard            = dl.ard;
        dr.reason         = dl.reason;
        dr.component      = dl.component;
        dr.cmg            = dl.cmg;
        dr.days           = dl.days;
        dr.fullRate       = dl.fullRate;
        dr.contractedRate = dl.contractedRate;
        dr.charges        = dl.charges;
        allRows.push(dr);
      }
    }

    pushSummary();
    return { fileName: fileName, rows: allRows };
  }

  /* ── CSV export ──────────────────────────────────────────────────────── */

  var CSV_HEADERS = [
    'Facility', 'Month', 'Section', 'Record Type', 'Resident Name', 'Service Dates',
    'Date Range', 'ARD', 'Reason', 'Component', 'CMG', 'Days', 'Full Rate', 'Contracted Rate', 'Charges',
    'PT min', 'PT charge', 'OT min', 'OT charge', 'ST min', 'ST charge', 'TOTAL min', 'Total Charge', 'Notes'
  ];

  function esc(v) {
    if (v == null) return '';
    v = String(v).trim();
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }

  function rowsToCsv(rows) {
    var out = [CSV_HEADERS.map(esc).join(',')];
    rows.forEach(function (r) {
      if (r === null) { out.push(new Array(CSV_HEADERS.length).fill('').join(',')); return; }
      out.push([
        r.facility, r.month, r.section, r.recordType, r.residentName, r.serviceDates,
        r.dateRange, r.ard, r.reason, r.component, r.cmg, r.days,
        r.fullRate, r.contractedRate, r.charges,
        r.ptMin, r.ptCharge, r.otMin, r.otCharge,
        r.stMin, r.stCharge, r.totalMin, r.totalCharge, r.notes
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

  window.PdfPartAExtractor = {
    extractPartAPdf: extractPartAPdf,
    combineResults:  combineResults,
    rowsToCsv:       rowsToCsv,
    CSV_HEADERS:     CSV_HEADERS
  };

})(window);
