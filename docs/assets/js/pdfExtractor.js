/**
 * pdfExtractor.js — LeapfrogIQ PDF Page Extractor
 *
 * Core extraction logic:
 *   - Apply a page pattern to a batch of PDFs
 *   - Merge selected pages into one output PDF using pdf-lib
 *   - Save/load session (pattern + file list) as JSON
 *   - Generate CSV report of results
 */
(function (window) {
  'use strict';

  /* ──────────────────────────────────────────────
   * applyPatternToFile
   *
   * Given a 1-based array of desired page numbers and a PDF's total page count,
   * returns { keptPages, missingPages }.
   *
   * Pages that exist in the PDF are "kept"; pages that exceed the page count
   * are "missing" (skipped gracefully).
   * ────────────────────────────────────────────── */
  function applyPatternToFile(patternPages, totalPages) {
    var kept = [];
    var missing = [];
    for (var i = 0; i < patternPages.length; i++) {
      var p = patternPages[i];
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
   * Processes an array of { file, arrayBuffer, name, totalPages } objects.
   * patternPages: sorted array of 1-based page numbers to extract.
   * onProgress: function(current, total, fileName) — called after each file.
   *
   * Returns { pdfBytes (Uint8Array), report (array of result rows) }
   * ────────────────────────────────────────────── */
  async function extractAndMerge(fileItems, patternPages, onProgress) {
    if (!window.PDFLib) throw new Error('pdf-lib not loaded');
    var PDFDocument = window.PDFLib.PDFDocument;

    var mergedDoc = await PDFDocument.create();
    var report = [];
    var CHUNK = 10; // process in chunks to keep memory manageable

    for (var i = 0; i < fileItems.length; i++) {
      var item = fileItems[i];
      if (onProgress) onProgress(i + 1, fileItems.length, item.name);

      try {
        var applied = applyPatternToFile(patternPages, item.totalPages);

        if (applied.keptPages.length > 0) {
          // pdf-lib uses 0-based indices
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

      // Yield to browser every chunk to keep UI responsive
      if ((i + 1) % CHUNK === 0) {
        await new Promise(function (resolve) { setTimeout(resolve, 0); });
      }
    }

    var pdfBytes = await mergedDoc.save();
    return { pdfBytes: pdfBytes, report: report };
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
  function saveSession(patternPages, label) {
    var session = {
      version: 1,
      label: label || 'LeapfrogIQ PDF Pattern',
      savedAt: new Date().toISOString(),
      patternPages: patternPages
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
    applyPatternToFile: applyPatternToFile,
    extractAndMerge: extractAndMerge,
    buildCsvReport: buildCsvReport,
    saveSession: saveSession,
    loadSession: loadSession,
    downloadPdf: downloadPdf,
    downloadCsv: downloadCsv
  };

})(window);
