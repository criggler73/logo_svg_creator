/**
 * pdfTableExtractor.js — LeapfrogIQ PDF Table / Data Extractor
 *
 * Extracts structured tables from facility/invoice-style PDFs that have consistent layouts:
 *   1) Invoice (Total Charges summary)
 *   2) Invoice Detail for Medicare Part A (resident/patient line items)
 *   3) Patient details by modality (PT min, OT min, ST min, etc.)
 *   4) Medicare Part B table (patient + AMOUNT BILL, 75% of Charges)
 *   5) Private and Medical details by patient and modality
 *
 * Uses PDF.js getTextContent() for text + positions, then section detection and
 * line/column parsing. Handles multi-page continuation (sections span pages).
 * Combines all months/PDFs into one table per type with a "Month" or "Source" column.
 */
(function (window) {
  'use strict';

  var SECTION_NAMES = {
    1: 'Invoice (Total Charges)',
    2: 'Medicare Part A Detail',
    3: 'Patient Details by Modality',
    4: 'Medicare Part B',
    5: 'Private and Medical'
  };

  var COLUMN_GAP_POINTS = 18;  /* min x-gap between columns */
  var LINE_Y_TOLERANCE = 5;    /* same line if y within this */
  var MONTH_REGEX = /(?:Month|MONTH)\s*[:\s]*(\d{4}\s+[A-Za-z]+|[A-Za-z]+\s+\d{4})/i;

  /**
   * Get text content for one page with (x, y) in top-down coordinates.
   * Returns Promise<{ pageNum, height, items: [{ x, y, text }] }>.
   */
  async function getPageTextItems(pdfDoc, pageNum) {
    var page = await pdfDoc.getPage(pageNum);
    var viewport = page.getViewport({ scale: 1 });
    var textContent = await page.getTextContent();
    var height = viewport.height;
    var items = [];

    for (var i = 0; i < textContent.items.length; i++) {
      var it = textContent.items[i];
      var t = it.transform;
      var x = t[4];
      var y = height - t[5]; /* PDF y is from bottom */
      var str = (it.str || '').trim();
      if (str) items.push({ x: x, y: y, text: str });
    }

    return { pageNum: pageNum, height: height, items: items };
  }

  /**
   * Group items into lines (same y within tolerance), sort lines top-to-bottom, items left-to-right.
   */
  function itemsToLines(items) {
    if (!items.length) return [];
    items = items.slice().sort(function (a, b) {
      if (Math.abs(a.y - b.y) <= LINE_Y_TOLERANCE) return a.x - b.x;
      return a.y - b.y;
    });
    var lines = [];
    var currentY = items[0].y;
    var currentLine = [];

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (Math.abs(it.y - currentY) <= LINE_Y_TOLERANCE) {
        currentLine.push(it);
      } else {
        if (currentLine.length) {
          currentLine.sort(function (a, b) { return a.x - b.x; });
          lines.push(currentLine);
        }
        currentY = it.y;
        currentLine = [it];
      }
    }
    if (currentLine.length) {
      currentLine.sort(function (a, b) { return a.x - b.x; });
      lines.push(currentLine);
    }
    return lines;
  }

  /**
   * Get full text of a line (for section detection).
   */
  function lineText(line) {
    return line.map(function (it) { return it.text; }).join(' ');
  }

  /**
   * Detect which section type a line or block belongs to (1–5 or 0 for unknown).
   * Order matters: Part B before Part A so "Medicare Part B" is not caught as A.
   */
  function detectSectionType(line) {
    var text = (typeof line === 'string') ? line : lineText(line);
    var lower = text.toLowerCase();

    if (/total\s+charges|subtotal|total\s+of\s+all\s+therapy|group\s+treatment/i.test(text)) return 1;
    if (/medicare\s+part\s+["']?b["']?|amount\s+bill|75%\s*of\s*charges|date\s+pd/i.test(lower)) return 4;
    if (/medicare\s+part\s+["']?a["']?|resident\s+name\s*\(last|date\s+range.*ard|contracted\s+rate.*charges/i.test(text)) return 2;
    if (/patient\s+name|pt\s+min|ot\s+min|st\s+min|total\s+min|total\s+charge/i.test(lower) && /pt\s+min|ot\s+min|st\s+min/.test(lower)) return 3;
    if (/private\s+and\s+medical|therapy\s+type\s*:\s*pt|therapy\s+type\s*:\s*ot|eval\s+date|evaluation.*treatments/i.test(lower)) return 5;

    return 0;
  }

  /**
   * Extract month string from lines (e.g. "2024 May").
   */
  function extractMonthFromLines(lines) {
    for (var i = 0; i < Math.min(lines.length, 30); i++) {
      var m = (typeof lines[i] === 'string' ? lines[i] : lineText(lines[i])).match(MONTH_REGEX);
      if (m) return m[1].trim();
    }
    return '';
  }

  /**
   * Split a line (array of { x, text }) into cells by column gaps.
   */
  function lineToCells(line) {
    if (!line.length) return [];
    var cells = [];
    var cellStart = line[0].x;
    var cellTexts = [line[0].text];

    for (var i = 1; i < line.length; i++) {
      var prev = line[i - 1];
      var curr = line[i];
      var gap = curr.x - (prev.x + (prev.text || '').length * 5); /* rough */
      if (gap >= COLUMN_GAP_POINTS) {
        cells.push(cellTexts.join(' ').trim());
        cellTexts = [curr.text];
        cellStart = curr.x;
      } else {
        cellTexts.push(curr.text);
      }
    }
    cells.push(cellTexts.join(' ').trim());
    return cells;
  }

  /**
   * Parse a list of lines (each line = array of { x, text }) into a table: { headers, rows }.
   */
  function parseTableLines(sectionLines) {
    if (!sectionLines.length) return { headers: [], rows: [] };
    var rows = sectionLines.map(function (line) { return lineToCells(line); });
    var headers = rows[0] || [];
    var dataRows = rows.slice(1).filter(function (row) {
      return row.some(function (c) { return (c || '').trim().length > 0; });
    });
    return { headers: headers, rows: dataRows };
  }

  /**
   * Full extraction for one PDF.
   * Returns Promise<{ fileName, month, sections: { type, name, table }, errors }>.
   */
  async function extractOnePdf(pdfDoc, fileName) {
    var numPages = pdfDoc.numPages;
    var allPageLines = [];
    var month = '';

    for (var p = 1; p <= numPages; p++) {
      var pageData = await getPageTextItems(pdfDoc, p);
      var lines = itemsToLines(pageData.items);
      allPageLines.push({ pageNum: p, lines: lines });
      if (p <= 3 && !month) month = extractMonthFromLines(lines);
    }

    if (!month) month = fileName.replace(/\.pdf$/i, '');

    var currentSection = 0;
    var sectionLines = { 1: [], 2: [], 3: [], 4: [], 5: [] };

    for (var i = 0; i < allPageLines.length; i++) {
      var pl = allPageLines[i];
      var pageLines = pl.lines;

      for (var L = 0; L < pageLines.length; L++) {
        var line = pageLines[L];
        var detected = detectSectionType(line);
        if (detected) currentSection = detected;
        if (currentSection && sectionLines[currentSection]) {
          sectionLines[currentSection].push(line);
        }
      }
    }

    var tables = {};
    [1, 2, 3, 4, 5].forEach(function (type) {
      var parsed = parseTableLines(sectionLines[type] || []);
      tables[type] = {
        name: SECTION_NAMES[type],
        headers: parsed.headers,
        rows: parsed.rows
      };
    });

    return {
      fileName: fileName,
      month: month,
      tables: tables,
      sectionLineCounts: {
        1: (sectionLines[1] || []).length,
        2: (sectionLines[2] || []).length,
        3: (sectionLines[3] || []).length,
        4: (sectionLines[4] || []).length,
        5: (sectionLines[5] || []).length
      }
    };
  }

  /**
   * Escape a cell for CSV (quotes and double-quotes).
   */
  function escapeCsvCell(s) {
    if (s == null) return '';
    s = String(s).trim();
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  /**
   * Convert headers + rows to CSV string. Optionally prepend an extra column (e.g. Month).
   */
  function toCsv(headers, rows, extraColumnName, extraColumnValue) {
    var out = [];
    var h = (headers || []).slice();
    if (extraColumnName) h.unshift(extraColumnName);
    out.push(h.map(escapeCsvCell).join(','));
    for (var i = 0; i < (rows || []).length; i++) {
      var row = (rows[i] || []).slice();
      if (extraColumnValue !== undefined) row.unshift(extraColumnValue);
      out.push(row.map(escapeCsvCell).join(','));
    }
    return out.join('\r\n');
  }

  /**
   * Combine results from multiple PDFs into one table per section type.
   * Each row gets a "Month" column from the source PDF.
   */
  function combineResults(results) {
    var combined = { 1: { headers: [], rows: [] }, 2: { headers: [], rows: [] }, 3: { headers: [], rows: [] }, 4: { headers: [], rows: [] }, 5: { headers: [], rows: [] } };
    var headerSet = { 1: null, 2: null, 3: null, 4: null, 5: null };

    for (var r = 0; r < results.length; r++) {
      var res = results[r];
      var month = res.month || res.fileName || '';

      for (var t = 1; t <= 5; t++) {
        var tbl = res.tables[t];
        if (!tbl || !tbl.rows.length) continue;
        if (!headerSet[t] && tbl.headers.length) headerSet[t] = tbl.headers;
        var h = headerSet[t] || tbl.headers || [];
        if (combined[t].headers.length === 0 && h.length) combined[t].headers = h;
        for (var i = 0; i < tbl.rows.length; i++) {
          var row = tbl.rows[i].slice();
          while (row.length < combined[t].headers.length) row.push('');
          combined[t].rows.push({ month: month, row: row });
        }
      }
    }

    /* Build final CSV-friendly structure with Month column */
    var out = {};
    for (var type = 1; type <= 5; type++) {
      var headers = ['Month'].concat(combined[type].headers);
      var rows = combined[type].rows.map(function (o) {
        return [o.month].concat(o.row);
      });
      out[type] = { name: SECTION_NAMES[type], headers: headers, rows: rows };
    }
    return out;
  }

  /**
   * Build CSV string for a combined table (with Month column).
   */
  function combinedTableToCsv(combinedTable) {
    return toCsv(combinedTable.headers, combinedTable.rows);
  }

  window.PdfTableExtractor = {
    SECTION_NAMES: SECTION_NAMES,
    extractOnePdf: extractOnePdf,
    combineResults: combineResults,
    combinedTableToCsv: combinedTableToCsv,
    toCsv: toCsv,
    getPageTextItems: getPageTextItems,
    itemsToLines: itemsToLines,
    detectSectionType: detectSectionType,
    extractMonthFromLines: extractMonthFromLines
  };
})(window);
