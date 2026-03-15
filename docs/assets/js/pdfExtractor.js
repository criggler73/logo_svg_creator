/**
 * pdfExtractor.js — LeapfrogIQ PDF Page Extractor
 *
 * Core extraction logic:
 *   - Rule-based extraction (skip N, keep range, from-end offsets)
 *   - Apply a page pattern to a batch of PDFs
 *   - Merge selected pages into one output PDF using pdf-lib
 *   - Extract each file into its own PDF and ZIP them (folder/batch mode)
 *   - Save/load session (pattern + rules) as JSON
 *   - Generate CSV report of results
 */
(function (window) {
  'use strict';

  /* ──────────────────────────────────────────────
   * RULE-BASED EXTRACTION
   *
   * Rules are applied in order and resolved against the actual page count
   * of each PDF at runtime, so "last page" or "skip first 2" work correctly
   * regardless of how many pages a file has.
   *
   * Rule types:
   *   { type: 'skip',       pages: [1, 3] }         — skip specific pages
   *   { type: 'keep',       pages: [2, 4, 5] }       — keep specific pages
   *   { type: 'keep-range', from: 2, to: 5 }         — keep pages 2 through 5
   *   { type: 'skip-first', count: 1 }               — skip first N pages
   *   { type: 'skip-last',  count: 1 }               — skip last N pages
   *   { type: 'keep-first', count: 3 }               — keep only first N pages
   *   { type: 'keep-last',  count: 2 }               — keep only last N pages
   *   { type: 'keep-from-end', offset: 1 }           — keep page that is Nth from end
   *
   * If rules array is empty or null, falls back to patternPages (explicit list).
   * ────────────────────────────────────────────── */

  /* Resolve rules against a specific totalPages count.
   * Returns a sorted array of 1-based page numbers to keep. */
  function resolveRules(rules, totalPages) {
    if (!rules || rules.length === 0) return null;

    // Start with all pages, then apply keeps/skips
    var allPages = [];
    for (var i = 1; i <= totalPages; i++) allPages.push(i);

    // Split into keep-rules and skip-rules
    var hasKeepRule = rules.some(function (r) {
      return r.type === 'keep' || r.type === 'keep-range' ||
             r.type === 'keep-first' || r.type === 'keep-last' || r.type === 'keep-from-end';
    });

    var kept = new Set(hasKeepRule ? [] : allPages);

    rules.forEach(function (rule) {
      var p, from, to;
      switch (rule.type) {
        case 'keep':
          (rule.pages || []).forEach(function (n) { if (n >= 1 && n <= totalPages) kept.add(n); });
          break;
        case 'keep-range':
          from = Math.max(1, rule.from || 1);
          to   = Math.min(totalPages, rule.to || totalPages);
          for (p = from; p <= to; p++) kept.add(p);
          break;
        case 'keep-first':
          for (p = 1; p <= Math.min(rule.count || 1, totalPages); p++) kept.add(p);
          break;
        case 'keep-last':
          from = Math.max(1, totalPages - (rule.count || 1) + 1);
          for (p = from; p <= totalPages; p++) kept.add(p);
          break;
        case 'keep-from-end':
          p = totalPages - (rule.offset || 0);
          if (p >= 1) kept.add(p);
          break;
        case 'skip':
          (rule.pages || []).forEach(function (n) { kept.delete(n); });
          break;
        case 'skip-first':
          for (p = 1; p <= Math.min(rule.count || 1, totalPages); p++) kept.delete(p);
          break;
        case 'skip-last':
          from = Math.max(1, totalPages - (rule.count || 1) + 1);
          for (p = from; p <= totalPages; p++) kept.delete(p);
          break;
      }
    });

    return Array.from(kept).sort(function (a, b) { return a - b; });
  }

  /* Parse a plain-English rule string into a rules array.
   * Supports:
   *   "skip first 2"         → skip-first 2
   *   "skip last 1"          → skip-last 1
   *   "keep 2-5"             → keep-range 2..5
   *   "keep pages 1,3,5"     → keep [1,3,5]
   *   "skip pages 1,3"       → skip [1,3]
   *   "keep first 3"         → keep-first 3
   *   "keep last 2"          → keep-last 2
   */
  function parseRuleString(str) {
    var rules = [];
    var lines = str.split(/[\n;]+/);
    lines.forEach(function (line) {
      line = line.trim().toLowerCase();
      if (!line) return;
      var m;

      if ((m = line.match(/^skip\s+first\s+(\d+)/))) {
        rules.push({ type: 'skip-first', count: parseInt(m[1], 10) });
      } else if ((m = line.match(/^skip\s+last\s+(\d+)/))) {
        rules.push({ type: 'skip-last', count: parseInt(m[1], 10) });
      } else if ((m = line.match(/^keep\s+first\s+(\d+)/))) {
        rules.push({ type: 'keep-first', count: parseInt(m[1], 10) });
      } else if ((m = line.match(/^keep\s+last\s+(\d+)/))) {
        rules.push({ type: 'keep-last', count: parseInt(m[1], 10) });
      } else if ((m = line.match(/^keep\s+(\d+)\s*[-–]\s*(\d+)/))) {
        rules.push({ type: 'keep-range', from: parseInt(m[1], 10), to: parseInt(m[2], 10) });
      } else if ((m = line.match(/^keep\s+(?:pages?\s+)?([0-9,\s]+)/))) {
        var pages = m[1].split(',').map(function (s) { return parseInt(s.trim(), 10); }).filter(function (n) { return !isNaN(n); });
        if (pages.length) rules.push({ type: 'keep', pages: pages });
      } else if ((m = line.match(/^skip\s+(?:pages?\s+)?([0-9,\s]+)/))) {
        var skipPages = m[1].split(',').map(function (s) { return parseInt(s.trim(), 10); }).filter(function (n) { return !isNaN(n); });
        if (skipPages.length) rules.push({ type: 'skip', pages: skipPages });
      }
    });
    return rules;
  }

  /* Serialise rules back to human-readable string */
  function rulesToString(rules) {
    if (!rules || rules.length === 0) return '';
    return rules.map(function (r) {
      switch (r.type) {
        case 'skip-first':   return 'Skip first ' + r.count;
        case 'skip-last':    return 'Skip last ' + r.count;
        case 'keep-first':   return 'Keep first ' + r.count;
        case 'keep-last':    return 'Keep last ' + r.count;
        case 'keep-range':   return 'Keep ' + r.from + '-' + r.to;
        case 'keep':         return 'Keep pages ' + r.pages.join(', ');
        case 'skip':         return 'Skip pages ' + r.pages.join(', ');
        case 'keep-from-end': return 'Keep page ' + r.offset + ' from end';
        default: return '';
      }
    }).filter(Boolean).join('\n');
  }

  /* ──────────────────────────────────────────────
   * applyPatternToFile
   *
   * Given rules (or fallback patternPages) and a PDF's total page count,
   * returns { keptPages, missingPages }.
   * ────────────────────────────────────────────── */
  function applyPatternToFile(patternPages, totalPages, rules) {
    var resolved = rules && rules.length > 0
      ? resolveRules(rules, totalPages)
      : null;

    var targetPages = resolved || patternPages;
    var kept = [];
    var missing = [];

    for (var i = 0; i < targetPages.length; i++) {
      var p = targetPages[i];
      if (p >= 1 && p <= totalPages) {
        kept.push(p);
      } else {
        missing.push(p);
      }
    }
    return { keptPages: kept, missingPages: missing };
  }

  /* ──────────────────────────────────────────────
   * extractAndMerge
   *
   * Processes an array of { arrayBuffer, name, totalPages } objects.
   * patternPages: sorted 1-based fallback array.
   * rules: optional rules array (takes priority over patternPages).
   * onProgress: function(current, total, fileName).
   *
   * Returns { pdfBytes (Uint8Array), report (array of result rows) }
   * ────────────────────────────────────────────── */
  async function extractAndMerge(fileItems, patternPages, onProgress, rules) {
    if (!window.PDFLib) throw new Error('pdf-lib not loaded');
    var PDFDocument = window.PDFLib.PDFDocument;

    var mergedDoc = await PDFDocument.create();
    var report = [];
    var CHUNK = 10;

    for (var i = 0; i < fileItems.length; i++) {
      var item = fileItems[i];
      if (onProgress) onProgress(i + 1, fileItems.length, item.name);

      try {
        var applied = applyPatternToFile(patternPages, item.totalPages, rules);

        if (applied.keptPages.length > 0) {
          var indices = applied.keptPages.map(function (p) { return p - 1; });
          var srcDoc = await PDFDocument.load(item.arrayBuffer, { ignoreEncryption: true });
          var copiedPages = await mergedDoc.copyPages(srcDoc, indices);
          copiedPages.forEach(function (page) { mergedDoc.addPage(page); });
        }

        report.push({
          fileName: item.name,
          totalPages: item.totalPages,
          keptPages: applied.keptPages,
          missingPages: applied.missingPages,
          status: applied.missingPages.length > 0 ? 'partial' : 'ok',
          error: null
        });
      } catch (err) {
        report.push({
          fileName: item.name,
          totalPages: item.totalPages || '?',
          keptPages: [],
          missingPages: patternPages,
          status: 'error',
          error: err.message
        });
      }

      if ((i + 1) % CHUNK === 0) {
        await new Promise(function (resolve) { setTimeout(resolve, 0); });
      }
    }

    var pdfBytes = await mergedDoc.save();
    return { pdfBytes: pdfBytes, report: report };
  }

  /* ──────────────────────────────────────────────
   * extractToZip
   *
   * Like extractAndMerge but produces individual PDFs per source file,
   * packaged into a ZIP archive. Used in folder/batch mode.
   *
   * Returns { zipBlob, report }
   * ────────────────────────────────────────────── */
  async function extractToZip(fileItems, patternPages, onProgress, rules) {
    if (!window.PDFLib) throw new Error('pdf-lib not loaded');
    if (!window.JSZip)  throw new Error('JSZip not loaded');
    var PDFDocument = window.PDFLib.PDFDocument;

    var zip = new window.JSZip();
    var report = [];
    var CHUNK = 10;

    for (var i = 0; i < fileItems.length; i++) {
      var item = fileItems[i];
      if (onProgress) onProgress(i + 1, fileItems.length, item.name);

      try {
        var applied = applyPatternToFile(patternPages, item.totalPages, rules);

        if (applied.keptPages.length > 0) {
          var indices = applied.keptPages.map(function (p) { return p - 1; });
          var srcDoc = await PDFDocument.load(item.arrayBuffer, { ignoreEncryption: true });
          var outDoc = await PDFDocument.create();
          var copiedPages = await outDoc.copyPages(srcDoc, indices);
          copiedPages.forEach(function (page) { outDoc.addPage(page); });
          var pdfBytes = await outDoc.save();

          // Strip .pdf extension, add -extracted suffix
          var baseName = item.name.replace(/\.pdf$/i, '') + '-extracted.pdf';
          zip.file(baseName, pdfBytes);
        }

        report.push({
          fileName: item.name,
          totalPages: item.totalPages,
          keptPages: applied.keptPages,
          missingPages: applied.missingPages,
          status: applied.keptPages.length === 0 ? 'skipped' : applied.missingPages.length > 0 ? 'partial' : 'ok',
          error: null
        });
      } catch (err) {
        report.push({
          fileName: item.name,
          totalPages: item.totalPages || '?',
          keptPages: [],
          missingPages: patternPages,
          status: 'error',
          error: err.message
        });
      }

      if ((i + 1) % CHUNK === 0) {
        await new Promise(function (resolve) { setTimeout(resolve, 0); });
      }
    }

    // Add CSV report to ZIP
    var csvStr = buildCsvReport(report);
    zip.file('extraction-report.csv', csvStr);

    var zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 3 } });
    return { zipBlob: zipBlob, report: report };
  }

  /* ──────────────────────────────────────────────
   * buildCsvReport
   *
   * Converts the report array into a CSV string ready for download.
   * ────────────────────────────────────────────── */
  function buildCsvReport(report) {
    var lines = [
      ['File Name', 'Total Pages', 'Pages Kept', 'Pages Kept Count', 'Missing Pages', 'Status', 'Error'].join(',')
    ];
    for (var i = 0; i < report.length; i++) {
      var r = report[i];
      lines.push([
        csvEscape(r.fileName),
        r.totalPages,
        csvEscape(r.keptPages.join(', ')),
        r.keptPages.length,
        csvEscape(r.missingPages.join(', ')),
        r.status,
        csvEscape(r.error || '')
      ].join(','));
    }
    return lines.join('\n');
  }

  /* ──────────────────────────────────────────────
   * saveSession / loadSession
   *
   * Persists the user's page pattern as a downloadable JSON file.
   * On load, returns the session object or null if invalid.
   * ────────────────────────────────────────────── */
  function saveSession(patternPages, label, rules) {
    var session = {
      version: 2,
      label: label || 'LeapfrogIQ PDF Pattern',
      savedAt: new Date().toISOString(),
      patternPages: patternPages,
      rules: rules || []
    };
    var json = JSON.stringify(session, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'pdf-pattern.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function loadSession(file, callback) {
    var reader = new FileReader();
    reader.onload = function (e) {
      try {
        var session = JSON.parse(e.target.result);
        if (!session.patternPages || !Array.isArray(session.patternPages)) {
          callback(null, 'Invalid session file: missing patternPages');
          return;
        }
        callback(session, null);
      } catch (err) {
        callback(null, 'Could not parse session file: ' + err.message);
      }
    };
    reader.readAsText(file);
  }

  /* ──────────────────────────────────────────────
   * downloadPdf
   *
   * Triggers a browser download of a Uint8Array as a .pdf file.
   * ────────────────────────────────────────────── */
  function downloadPdf(pdfBytes, fileName) {
    var blob = new Blob([pdfBytes], { type: 'application/pdf' });
    if (window.saveAs) {
      window.saveAs(blob, fileName);
    } else {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = fileName || 'extracted-pages.pdf';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }
  }

  /* ──────────────────────────────────────────────
   * downloadCsv
   * ────────────────────────────────────────────── */
  function downloadCsv(csvString, fileName) {
    var blob = new Blob([csvString], { type: 'text/csv' });
    if (window.saveAs) {
      window.saveAs(blob, fileName);
    } else {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = fileName || 'pdf-extraction-report.csv';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }
  }

  /* ── Private helper ── */
  function csvEscape(str) {
    if (!str) return '';
    str = String(str);
    if (str.indexOf(',') !== -1 || str.indexOf('"') !== -1 || str.indexOf('\n') !== -1) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  /* ── Public API ── */
  window.PdfExtractor = {
    resolveRules: resolveRules,
    parseRuleString: parseRuleString,
    rulesToString: rulesToString,
    applyPatternToFile: applyPatternToFile,
    extractAndMerge: extractAndMerge,
    extractToZip: extractToZip,
    buildCsvReport: buildCsvReport,
    saveSession: saveSession,
    loadSession: loadSession,
    downloadPdf: downloadPdf,
    downloadCsv: downloadCsv
  };

})(window);
