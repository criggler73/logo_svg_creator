/**
 * zipBuilder.js — Build and trigger download of a ZIP asset pack
 * Requires JSZip and FileSaver.js to be loaded first.
 */

var ZipBuilder = (function() {
  'use strict';

  /**
   * Build and download a brand asset ZIP.
   * @param {object} assets
   *   assets.svg        {string}  SVG string (vectorized or embed)
   *   assets.png512     {Blob}    transparent PNG at 512px
   *   assets.pngOrig    {Blob}    original-size PNG (optional)
   *   assets.pngBlack   {Blob}    black version PNG (optional)
   *   assets.pngWhite   {Blob}    white version PNG (optional)
   *   assets.faviconSVG {string}  cropped SVG favicon (optional)
   *   assets.fav16      {Blob}    favicon 16px PNG (optional)
   *   assets.fav32      {Blob}    favicon 32px PNG (optional)
   *   assets.fav48      {Blob}    favicon 48px PNG (optional)
   *   assets.fav180     {Blob}    favicon 180px PNG (optional)
   * @param {string} filename  – base name without extension
   */
  function buildAndDownload(assets, filename) {
    if (typeof JSZip === 'undefined') { alert('JSZip not loaded'); return; }
    if (typeof saveAs === 'undefined') { alert('FileSaver not loaded'); return; }

    var zip = new JSZip();
    var name = (filename || 'brand-assets').replace(/[^a-z0-9_\-]/gi, '_');

    /* SVG */
    if (assets.svg)      zip.file('svg/' + name + '.svg', assets.svg);

    /* PNG variants */
    if (assets.png512)   zip.file('png/' + name + '-512.png',  assets.png512);
    if (assets.pngOrig)  zip.file('png/' + name + '-original.png', assets.pngOrig);
    if (assets.pngBlack) zip.file('png/' + name + '-black.png', assets.pngBlack);
    if (assets.pngWhite) zip.file('png/' + name + '-white.png', assets.pngWhite);

    /* Favicon set */
    if (assets.faviconSVG) zip.file('favicon/favicon.svg',       assets.faviconSVG);
    if (assets.fav16)      zip.file('favicon/favicon-16.png',    assets.fav16);
    if (assets.fav32)      zip.file('favicon/favicon-32.png',    assets.fav32);
    if (assets.fav48)      zip.file('favicon/favicon-48.png',    assets.fav48);
    if (assets.fav180)     zip.file('favicon/favicon-180.png',   assets.fav180);

    /* README */
    var lines = [
      'LeapfrogIQ Apps \u2014 Brand Asset Pack',
      'Tool: Logo SVG Converter (https://leapfrogiq.apps/tools/logo-svg-converter/)',
      '',
      'Contents:',
      '  svg/' + name + '.svg                  \u2014 scalable vector logo',
      '  png/' + name + '-512.png              \u2014 transparent PNG at 512px',
      '  png/' + name + '-original.png         \u2014 original-size PNG',
      '  png/' + name + '-black.png            \u2014 black version (transparent background)',
      '  png/' + name + '-white.png            \u2014 white version (transparent background)',
      '  favicon/favicon.svg                   \u2014 SVG favicon (cropped)',
      '  favicon/favicon-16.png                \u2014 16\xd716 px favicon',
      '  favicon/favicon-32.png                \u2014 32\xd732 px favicon',
      '  favicon/favicon-48.png                \u2014 48\xd748 px favicon',
      '  favicon/favicon-180.png               \u2014 180\xd7180 px Apple touch icon',
      '',
      'All files processed in your browser.',
      'No data was uploaded to any server.',
    ];
    zip.file('README.txt', lines.join('\n'));

    zip.generateAsync({ type: 'blob' })
      .then(function(content) {
        saveAs(content, name + '-brand-assets.zip');
      })
      .catch(function(err) {
        console.error('ZIP generation failed', err);
        alert('Could not generate ZIP: ' + err.message);
      });
  }

  return { buildAndDownload: buildAndDownload };

})();
