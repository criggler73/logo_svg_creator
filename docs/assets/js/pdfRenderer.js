/**
 * pdfRenderer.js — LeapfrogIQ PDF Page Extractor
 *
 * Loads PDF files and renders page thumbnails to canvas elements using PDF.js.
 * Handles the visual page-picker UI.
 */
(function (window) {
  'use strict';

  var WORKER_SRC = null; // Set by init()

  /* ── Initialise PDF.js worker path ── */
  function init(workerSrc) {
    WORKER_SRC = workerSrc;
    if (window.pdfjsLib) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;
    }
  }

  /* ── Load a single PDF from an ArrayBuffer, return pdfjsLib document ── */
  async function loadPdf(arrayBuffer) {
    if (!window.pdfjsLib) throw new Error('PDF.js not loaded');
    var loadingTask = window.pdfjsLib.getDocument({ data: arrayBuffer });
    return await loadingTask.promise;
  }

  /* ── Render a single page to a new <canvas> element ──
   * Returns the canvas element.
   * thumbWidth: desired width in px (height is proportional)
   */
  async function renderPageToCanvas(pdfDoc, pageNum, thumbWidth) {
    thumbWidth = thumbWidth || 160;
    var page = await pdfDoc.getPage(pageNum);
    var viewport = page.getViewport({ scale: 1 });
    var scale = thumbWidth / viewport.width;
    var scaledViewport = page.getViewport({ scale: scale });

    var canvas = document.createElement('canvas');
    canvas.width = scaledViewport.width;
    canvas.height = scaledViewport.height;

    var ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;

    return canvas;
  }

  /* ── Render all pages of a PDF as thumbnail cards ──
   *
   * container: DOM element to append cards into
   * pdfDoc: pdfjsLib document
   * fileName: string, shown as label
   * selectedPages: Set of 1-based page numbers that are "kept"
   * onToggle: function(pageNum, isKept) called when user clicks a thumb
   * thumbWidth: optional px width
   */
  async function renderAllThumbs(container, pdfDoc, fileName, selectedPages, onToggle, thumbWidth) {
    thumbWidth = thumbWidth || 140;
    var numPages = pdfDoc.numPages;

    for (var i = 1; i <= numPages; i++) {
      var card = document.createElement('div');
      card.className = 'thumb-card' + (selectedPages.has(i) ? ' thumb-kept' : ' thumb-discarded');
      card.dataset.page = i;

      var canvas = await renderPageToCanvas(pdfDoc, i, thumbWidth);
      card.appendChild(canvas);

      var label = document.createElement('div');
      label.className = 'thumb-label';
      label.textContent = 'Page ' + i;
      card.appendChild(label);

      var badge = document.createElement('div');
      badge.className = 'thumb-badge';
      badge.textContent = selectedPages.has(i) ? 'Keep' : 'Skip';
      card.appendChild(badge);

      (function (cardEl, pageNum) {
        cardEl.addEventListener('click', function () {
          var kept = selectedPages.has(pageNum);
          if (kept) {
            selectedPages.delete(pageNum);
            cardEl.classList.remove('thumb-kept');
            cardEl.classList.add('thumb-discarded');
            cardEl.querySelector('.thumb-badge').textContent = 'Skip';
          } else {
            selectedPages.add(pageNum);
            cardEl.classList.add('thumb-kept');
            cardEl.classList.remove('thumb-discarded');
            cardEl.querySelector('.thumb-badge').textContent = 'Keep';
          }
          if (onToggle) onToggle(pageNum, !kept);
        });
      })(card, i);

      container.appendChild(card);
    }
  }

  /* ── Render a compact file summary row (no thumbnails) ──
   * Used in the batch preview panel.
   * Returns a <tr> element.
   */
  function buildPreviewRow(fileName, totalPages, keptPages, missingPages) {
    var tr = document.createElement('tr');
    var statusClass = missingPages.length > 0 ? 'status-warn' : 'status-ok';
    var statusText = missingPages.length > 0
      ? 'Partial (' + missingPages.length + ' pg missing)'
      : 'Ready';
    tr.innerHTML =
      '<td class="preview-filename" title="' + fileName + '">' + truncate(fileName, 30) + '</td>' +
      '<td class="preview-total">' + totalPages + '</td>' +
      '<td class="preview-kept">' + keptPages.length + '</td>' +
      '<td class="preview-missing">' + (missingPages.length > 0 ? missingPages.join(', ') : '—') + '</td>' +
      '<td class="preview-status ' + statusClass + '">' + statusText + '</td>';
    return tr;
  }

  /* ── Parse a page range string like "1,3,5-7,10" into a sorted array of 1-based ints ── */
  function parsePageRange(str, maxPages) {
    var pages = new Set();
    var parts = str.split(',');
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i].trim();
      if (!part) continue;
      if (part.indexOf('-') !== -1) {
        var bounds = part.split('-');
        var from = parseInt(bounds[0], 10);
        var to = parseInt(bounds[1], 10);
        if (!isNaN(from) && !isNaN(to)) {
          for (var p = from; p <= to; p++) {
            if (!maxPages || p <= maxPages) pages.add(p);
          }
        }
      } else {
        var n = parseInt(part, 10);
        if (!isNaN(n) && (!maxPages || n <= maxPages)) pages.add(n);
      }
    }
    return Array.from(pages).sort(function (a, b) { return a - b; });
  }

  /* ── Serialise a Set/Array of page numbers to a range string ── */
  function pagesToRangeString(pages) {
    var arr = Array.from(pages).sort(function (a, b) { return a - b; });
    if (arr.length === 0) return '';
    var parts = [];
    var start = arr[0], end = arr[0];
    for (var i = 1; i < arr.length; i++) {
      if (arr[i] === end + 1) {
        end = arr[i];
      } else {
        parts.push(start === end ? '' + start : start + '-' + end);
        start = end = arr[i];
      }
    }
    parts.push(start === end ? '' + start : start + '-' + end);
    return parts.join(', ');
  }

  /* ── Private helper ── */
  function truncate(str, len) {
    return str.length > len ? str.slice(0, len - 1) + '…' : str;
  }

  /* ── Public API ── */
  window.PdfRenderer = {
    init: init,
    loadPdf: loadPdf,
    renderPageToCanvas: renderPageToCanvas,
    renderAllThumbs: renderAllThumbs,
    buildPreviewRow: buildPreviewRow,
    parsePageRange: parsePageRange,
    pagesToRangeString: pagesToRangeString
  };

})(window);
