/**
 * svgConverter.js — Core conversion engine
 *
 * Three modes:
 *   'trace'  — ImageTracer vectorization (flat-color polygons, good for simple logos/icons)
 *   'embed'  — Wrap raster in <svg><image> — perfect quality, scalable, ~same file size as source
 *
 * Pre-processing helpers:
 *   - upsample2x: doubles canvas size before tracing (more pixels → smoother gradient bands)
 *   - blurCanvas: optional Gaussian-style blur to soften harsh color edges before trace
 */

var SVGConverter = (function() {
  'use strict';

  /* ------------------------------------------------------------------ */
  /*  Preset definitions                                                  */
  /* ------------------------------------------------------------------ */

  var PRESETS = {
    // Embed: wraps raster as <image> inside SVG — perfect quality, fully scalable
    embed: null,

    // Logo: 16 colors, no blur — best for flat logos with solid colours / simple gradients
    logo: {
      numberofcolors: 16,
      pathomit: 4,
      ltres: 0.5,
      qtres: 0.5,
      colorsampling: 2,
      blurradius: 0,
      strokewidth: 0,
      rightangleenhance: true,
      desc: false,
      viewbox: true
    },

    // Detailed: 64 colors, mild blur — best for logos with gradients
    detailed: {
      numberofcolors: 64,
      pathomit: 0,
      ltres: 0.5,
      qtres: 0.5,
      colorsampling: 2,
      blurradius: 1,
      blurdelta: 10,
      strokewidth: 0,
      rightangleenhance: true,
      desc: false,
      viewbox: true
    },

    // High-quality: max colors, pre-upsampled 2x, blur — closest to photo quality
    hq: {
      numberofcolors: 128,
      pathomit: 0,
      ltres: 0.3,
      qtres: 0.3,
      colorsampling: 2,
      blurradius: 2,
      blurdelta: 8,
      strokewidth: 0,
      rightangleenhance: false,
      desc: false,
      viewbox: true
    }
  };

  /* ------------------------------------------------------------------ */
  /*  Canvas helpers                                                      */
  /* ------------------------------------------------------------------ */

  /** Draw imgEl to a canvas at optional scale (default 1x). */
  function drawToCanvas(imgEl, scale) {
    scale = scale || 1;
    var w = Math.round((imgEl.naturalWidth  || imgEl.width)  * scale);
    var h = Math.round((imgEl.naturalHeight || imgEl.height) * scale);
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    // Use high-quality downscaling if browser supports it
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(imgEl, 0, 0, w, h);
    return canvas;
  }

  /* ------------------------------------------------------------------ */
  /*  Embed mode: wrap raster as <svg><image>                             */
  /* ------------------------------------------------------------------ */

  function embedAsSVG(imgEl) {
    return new Promise(function(resolve) {
      var w = imgEl.naturalWidth  || imgEl.width;
      var h = imgEl.naturalHeight || imgEl.height;

      // Convert to PNG data URL via canvas for a consistent base64 src
      var canvas = drawToCanvas(imgEl, 1);
      var dataURL = canvas.toDataURL('image/png');

      var svg =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<svg xmlns="http://www.w3.org/2000/svg" ' +
            'xmlns:xlink="http://www.w3.org/1999/xlink" ' +
            'width="' + w + '" height="' + h + '" ' +
            'viewBox="0 0 ' + w + ' ' + h + '">\n' +
        '  <!-- Embedded raster — perfect quality, fully scalable -->\n' +
        '  <image x="0" y="0" width="' + w + '" height="' + h + '" ' +
               'xlink:href="' + dataURL + '" ' +
               'href="' + dataURL + '" ' +
               'image-rendering="optimizeQuality" ' +
               'preserveAspectRatio="xMidYMid meet"/>\n' +
        '</svg>\n';

      resolve(svg);
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Trace mode: ImageTracer vectorization                               */
  /* ------------------------------------------------------------------ */

  function traceToSVG(imgEl, presetName, customOpts) {
    return new Promise(function(resolve, reject) {
      if (typeof ImageTracer === 'undefined') {
        reject(new Error('ImageTracer library not loaded'));
        return;
      }
      try {
        var preset = PRESETS[presetName] || PRESETS.logo;
        var opts = Object.assign({}, preset, customOpts || {});

        // HQ preset: upsample 2x before trace so gradient bands are finer
        var scale = (presetName === 'hq') ? 2 : 1;
        var canvas = drawToCanvas(imgEl, scale);

        var svgStr = ImageTracer.imagedataToSVG(
          canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height),
          opts
        );
        resolve(svgStr);
      } catch(e) {
        reject(e);
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Public API                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Convert an image to SVG.
   * @param {HTMLImageElement} imgEl
   * @param {string} mode  — 'embed' | 'logo' | 'detailed' | 'hq'
   * @param {object} customOpts — override individual tracer options (trace modes only)
   * @returns {Promise<string>} SVG string
   */
  function imageToSVG(imgEl, mode, customOpts) {
    if (mode === 'embed') {
      return embedAsSVG(imgEl);
    }
    return traceToSVG(imgEl, mode || 'logo', customOpts || {});
  }

  /**
   * Export image to a transparent PNG Blob at a given max dimension.
   * @param {HTMLImageElement} imgEl
   * @param {number} size — target longest-side px (0 = native)
   * @returns {Promise<Blob>}
   */
  function imageToPNG(imgEl, size) {
    return new Promise(function(resolve, reject) {
      try {
        var nw = imgEl.naturalWidth  || imgEl.width;
        var nh = imgEl.naturalHeight || imgEl.height;
        var ratio = nw / nh;
        var w, h;
        if (size && size > 0) {
          if (nw >= nh) { w = size; h = Math.round(size / ratio); }
          else          { h = size; w = Math.round(size * ratio); }
        } else {
          w = nw; h = nh;
        }
        var out = document.createElement('canvas');
        out.width = w; out.height = h;
        var ctx2 = out.getContext('2d');
        ctx2.imageSmoothingEnabled = true;
        ctx2.imageSmoothingQuality = 'high';
        ctx2.drawImage(imgEl, 0, 0, w, h);
        out.toBlob(function(blob) { resolve(blob); }, 'image/png');
      } catch(e) {
        reject(e);
      }
    });
  }

  /**
   * Export a cropped region of the image to a square PNG Blob.
   * Used for favicon generation — crops to selection then exports at given size.
   * @param {HTMLImageElement} imgEl  source image
   * @param {object} crop  { x, y, w, h } in natural image pixels
   * @param {number} size  output square size (e.g. 32, 48, 180, 512)
   * @returns {Promise<Blob>}
   */
  function cropToPNG(imgEl, crop, size) {
    return new Promise(function(resolve, reject) {
      try {
        var out = document.createElement('canvas');
        out.width = size; out.height = size;
        var ctx = out.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(imgEl, crop.x, crop.y, crop.w, crop.h, 0, 0, size, size);
        out.toBlob(function(blob) { resolve(blob); }, 'image/png');
      } catch(e) {
        reject(e);
      }
    });
  }

  /**
   * Create a cropped SVG favicon (embed mode, square viewBox crop).
   * @param {HTMLImageElement} imgEl  source image
   * @param {object} crop  { x, y, w, h } in natural image pixels
   * @returns {string} SVG string
   */
  function cropToFaviconSVG(imgEl, crop) {
    var canvas = document.createElement('canvas');
    canvas.width  = imgEl.naturalWidth  || imgEl.width;
    canvas.height = imgEl.naturalHeight || imgEl.height;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(imgEl, 0, 0);
    var dataURL = canvas.toDataURL('image/png');

    var size = Math.max(crop.w, crop.h);
    return (
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<svg xmlns="http://www.w3.org/2000/svg" ' +
          'xmlns:xlink="http://www.w3.org/1999/xlink" ' +
          'viewBox="' + crop.x + ' ' + crop.y + ' ' + crop.w + ' ' + crop.h + '" ' +
          'width="' + size + '" height="' + size + '">\n' +
      '  <image x="0" y="0" ' +
             'width="' + (imgEl.naturalWidth || imgEl.width) + '" ' +
             'height="' + (imgEl.naturalHeight || imgEl.height) + '" ' +
             'xlink:href="' + dataURL + '" ' +
             'href="' + dataURL + '" ' +
             'preserveAspectRatio="xMidYMid meet"/>\n' +
      '</svg>\n'
    );
  }

  /**
   * Detect the background color of an image by sampling the four corners.
   * Returns { r, g, b } or null if image has transparent corners.
   */
  function detectBackground(imageData, w, h) {
    var d = imageData.data;
    function px(x, y) {
      var i = (y * w + x) * 4;
      return { r: d[i], g: d[i+1], b: d[i+2], a: d[i+3] };
    }
    var sz = Math.max(1, Math.min(4, Math.floor(Math.min(w, h) / 10)));
    var samples = [];
    for (var cy = 0; cy < sz; cy++) {
      for (var cx = 0; cx < sz; cx++) {
        samples.push(px(cx, cy));
        samples.push(px(w-1-cx, cy));
        samples.push(px(cx, h-1-cy));
        samples.push(px(w-1-cx, h-1-cy));
      }
    }
    var tr = 0, tg = 0, tb = 0, count = 0;
    samples.forEach(function(s) {
      if (s.a > 200) { tr += s.r; tg += s.g; tb += s.b; count++; }
    });
    if (count === 0) return null;
    return { r: Math.round(tr/count), g: Math.round(tg/count), b: Math.round(tb/count) };
  }

  /** Euclidean RGB color distance */
  function colorDist(r1, g1, b1, r2, g2, b2) {
    return Math.sqrt((r1-r2)*(r1-r2) + (g1-g2)*(g1-g2) + (b1-b2)*(b1-b2));
  }

  /**
   * Generate a black version of the image.
   * Detects background color from corners, makes it transparent.
   * All non-background pixels → solid black.
   */
  function imageToBlackPNG(imgEl) {
    return new Promise(function(resolve, reject) {
      try {
        var w = imgEl.naturalWidth  || imgEl.width;
        var h = imgEl.naturalHeight || imgEl.height;
        var src = document.createElement('canvas');
        src.width = w; src.height = h;
        var sctx = src.getContext('2d');
        sctx.drawImage(imgEl, 0, 0);

        var out = document.createElement('canvas');
        out.width = w; out.height = h;
        var ctx = out.getContext('2d');
        var outData = ctx.createImageData(w, h);
        var srcData = sctx.getImageData(0, 0, w, h);
        var d = srcData.data;

        var bg = detectBackground(srcData, w, h);
        var THRESH = bg ? 45 : -1;

        for (var i = 0; i < d.length; i += 4) {
          var a = d[i + 3];
          var isBg = (a < 30) ||
            (bg && colorDist(d[i], d[i+1], d[i+2], bg.r, bg.g, bg.b) < THRESH);
          if (!isBg) {
            outData.data[i]     = 0;
            outData.data[i + 1] = 0;
            outData.data[i + 2] = 0;
            outData.data[i + 3] = 255;
          }
        }
        ctx.putImageData(outData, 0, 0);
        out.toBlob(function(blob) { resolve(blob); }, 'image/png');
      } catch(e) {
        reject(e);
      }
    });
  }

  /**
   * Generate a white version of the image.
   * Detects background color from corners, makes it transparent.
   * All non-background pixels → solid white.
   */
  function imageToWhitePNG(imgEl) {
    return new Promise(function(resolve, reject) {
      try {
        var w = imgEl.naturalWidth  || imgEl.width;
        var h = imgEl.naturalHeight || imgEl.height;
        var src = document.createElement('canvas');
        src.width = w; src.height = h;
        var sctx = src.getContext('2d');
        sctx.drawImage(imgEl, 0, 0);

        var out = document.createElement('canvas');
        out.width = w; out.height = h;
        var ctx = out.getContext('2d');
        var outData = ctx.createImageData(w, h);
        var srcData = sctx.getImageData(0, 0, w, h);
        var d = srcData.data;

        var bg = detectBackground(srcData, w, h);
        var THRESH = bg ? 45 : -1;

        for (var i = 0; i < d.length; i += 4) {
          var a = d[i + 3];
          var isBg = (a < 30) ||
            (bg && colorDist(d[i], d[i+1], d[i+2], bg.r, bg.g, bg.b) < THRESH);
          if (!isBg) {
            outData.data[i]     = 255;
            outData.data[i + 1] = 255;
            outData.data[i + 2] = 255;
            outData.data[i + 3] = 255;
          }
        }
        ctx.putImageData(outData, 0, 0);
        out.toBlob(function(blob) { resolve(blob); }, 'image/png');
      } catch(e) {
        reject(e);
      }
    });
  }

  /**
   * Extract the top N dominant colors from an image (background excluded).
   * Returns array of { hex, r, g, b } sorted by frequency.
   */
  function extractColors(imgEl, maxColors) {
    maxColors = maxColors || 8;
    var nw = imgEl.naturalWidth  || imgEl.width;
    var nh = imgEl.naturalHeight || imgEl.height;
    var scale = Math.min(1, 150 / Math.max(nw, nh));
    var canvas = document.createElement('canvas');
    canvas.width  = Math.max(1, Math.round(nw * scale));
    canvas.height = Math.max(1, Math.round(nh * scale));
    var ctx = canvas.getContext('2d');
    ctx.drawImage(imgEl, 0, 0, canvas.width, canvas.height);
    var imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    var d = imgData.data;

    var bg = detectBackground(imgData, canvas.width, canvas.height);
    var BG_THRESH = 35;
    var STEP = 28; /* quantization bucket size */

    var buckets = {};
    for (var i = 0; i < d.length; i += 4) {
      if (d[i+3] < 30) continue;
      var r = d[i], g = d[i+1], b = d[i+2];
      if (bg && colorDist(r, g, b, bg.r, bg.g, bg.b) < BG_THRESH) continue;
      var key = (Math.round(r/STEP)*STEP) + ',' +
                (Math.round(g/STEP)*STEP) + ',' +
                (Math.round(b/STEP)*STEP);
      if (!buckets[key]) buckets[key] = { r: 0, g: 0, b: 0, count: 0 };
      buckets[key].r += r; buckets[key].g += g; buckets[key].b += b; buckets[key].count++;
    }

    var sorted = Object.values(buckets).sort(function(a, b) { return b.count - a.count; });
    var chosen = [];
    sorted.forEach(function(bucket) {
      var ar = Math.round(bucket.r / bucket.count);
      var ag = Math.round(bucket.g / bucket.count);
      var ab = Math.round(bucket.b / bucket.count);
      var tooClose = chosen.some(function(c) {
        return colorDist(ar, ag, ab, c.r, c.g, c.b) < 50;
      });
      if (!tooClose && chosen.length < maxColors) {
        var hex = '#' +
          ('0' + ar.toString(16)).slice(-2).toUpperCase() +
          ('0' + ag.toString(16)).slice(-2).toUpperCase() +
          ('0' + ab.toString(16)).slice(-2).toUpperCase();
        chosen.push({ hex: hex, r: ar, g: ag, b: ab });
      }
    });
    return chosen;
  }

  /**
   * Load a File into an HTMLImageElement.
   * @returns {Promise<HTMLImageElement>}
   */
  function loadFileAsImage(file) {
    return new Promise(function(resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function() { resolve(img); };
      img.onerror = function() { reject(new Error('Could not load image')); };
      img.src = url;
    });
  }

  /**
   * Convert an SVG string to a blob URL for <img> preview.
   */
  function svgStringToURL(svgStr) {
    var blob = new Blob([svgStr], { type: 'image/svg+xml' });
    return URL.createObjectURL(blob);
  }

  return {
    imageToSVG:       imageToSVG,
    imageToPNG:       imageToPNG,
    cropToPNG:        cropToPNG,
    cropToFaviconSVG: cropToFaviconSVG,
    imageToBlackPNG:  imageToBlackPNG,
    imageToWhitePNG:  imageToWhitePNG,
    extractColors:    extractColors,
    loadFileAsImage:  loadFileAsImage,
    svgStringToURL:   svgStringToURL,
    PRESETS:          PRESETS
  };

})();
