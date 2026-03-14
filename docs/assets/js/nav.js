/**
 * nav.js — LeapfrogIQ Apps shared navigation and footer
 *
 * Usage: SiteNav.init({ depth: N })
 *   depth 0 = docs/index.html              (root of docs/)
 *   depth 1 = docs/legal/*.html            (one folder deep)
 *   depth 2 = docs/tools/logo-svg-converter/index.html  (two folders deep)
 *
 * All asset and page paths are relative — no absolute URLs, works on
 * localhost, GitHub Pages, Netlify, and any custom domain.
 */
(function(window) {
  'use strict';

  var _root = '';   /* set in init() based on depth */
  var AREA_CALC = 'https://area.leapfrogiq.ai';

  /* Build a root-relative path from depth */
  function root(depth) {
    if (depth === 0) return './';
    var s = '';
    for (var i = 0; i < depth; i++) s += '../';
    return s;
  }

  /* Detect active nav link */
  function isActive(path) {
    var cur = window.location.pathname;
    return cur === path || cur.endsWith(path) || cur.endsWith(path.replace(/\/$/, '/index.html'));
  }

  function navLink(path, label, external) {
    var href = external ? path : _root + path.replace(/^\//, '');
    var cls = (!external && isActive(path)) ? ' class="active"' : '';
    var target = external ? ' target="_blank" rel="noopener"' : '';
    return '<a href="' + href + '"' + cls + target + '>' + label + '</a>';
  }

  function buildNav() {
    var el = document.createElement('nav');
    el.className = 'site-nav';
    el.setAttribute('role', 'navigation');
    el.setAttribute('aria-label', 'Main navigation');
    el.innerHTML =
      '<a class="nav-logo" href="' + _root + '" aria-label="LeapfrogIQ Apps home">' +
        '<img src="' + _root + 'assets/img/logo.svg" alt="LeapfrogIQ Apps" width="96" height="96" />' +
        '<div class="nav-brand">' +
          '<span class="nav-brand-main">LeapfrogIQ Apps</span>' +
          '<span class="nav-brand-sub">Free Browser Tools</span>' +
        '</div>' +
      '</a>' +
      '<div class="nav-links" id="siteNavLinks">' +
        navLink('', 'All Tools') +
        navLink('tools/logo-svg-converter/', 'Logo SVG Converter') +
        navLink(AREA_CALC + '/', 'Blueprint Calc', true) +
        navLink('legal/privacy-policy.html', 'Privacy') +
        navLink('legal/terms-of-service.html', 'Terms') +
      '</div>' +
      '<button class="nav-menu-btn" id="navMenuBtn" aria-label="Toggle menu" aria-expanded="false">&#9776;</button>' +
      '<div class="nav-cta">' +
        '<a class="btn btn-primary" href="' + _root + 'tools/logo-svg-converter/" style="font-size:13px;padding:8px 16px;">Convert Logo &rarr;</a>' +
      '</div>';
    return el;
  }

  function buildFooter() {
    var el = document.createElement('footer');
    el.className = 'site-footer';
    el.setAttribute('role', 'contentinfo');
    el.innerHTML =
      '<div class="footer-inner">' +
        '<div class="footer-brand">' +
          '<img src="' + _root + 'assets/img/logo.svg" alt="LeapfrogIQ Apps" width="100" />' +
          '<div class="footer-brand-name">LeapfrogIQ Apps</div>' +
          '<p>Free browser-based utility tools for contractors, designers, developers, and small businesses. No signup, no downloads, no stored data.</p>' +
        '</div>' +
        '<div class="footer-col">' +
          '<h4>Tools</h4>' +
          '<a href="' + _root + 'tools/logo-svg-converter/">Logo SVG Converter</a>' +
          '<a href="' + AREA_CALC + '/" target="_blank" rel="noopener">Blueprint Calc</a>' +
          '<a href="' + _root + '#tools">Favicon Generator <em style="font-size:11px;opacity:.7;">(Soon)</em></a>' +
          '<a href="' + _root + '#tools">PNG to SVG <em style="font-size:11px;opacity:.7;">(Soon)</em></a>' +
        '</div>' +
        '<div class="footer-col">' +
          '<h4>More</h4>' +
          '<a href="' + _root + '">All Tools</a>' +
          '<a href="' + AREA_CALC + '/about.html" target="_blank" rel="noopener">About</a>' +
          '<a href="' + AREA_CALC + '/contact.html" target="_blank" rel="noopener">Contact</a>' +
        '</div>' +
        '<div class="footer-col">' +
          '<h4>Legal</h4>' +
          '<a href="' + _root + 'legal/privacy-policy.html">Privacy Policy</a>' +
          '<a href="' + _root + 'legal/terms-of-service.html">Terms of Service</a>' +
        '</div>' +
      '</div>' +
      '<div class="footer-bottom">' +
        '<span>&copy; 2026 LeapfrogIQ. All rights reserved.</span>' +
        '<span>Free tools. No signup. No stored data.</span>' +
      '</div>';
    return el;
  }

  function init(options) {
    var opts = options || {};
    var depth = typeof opts.depth === 'number' ? opts.depth : 0;
    _root = root(depth);

    /* Inject shared CSS if not already present */
    if (!document.querySelector('link[href*="shared.css"]')) {
      var link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = _root + 'assets/css/shared.css';
      document.head.insertBefore(link, document.head.firstChild);
    }

    /* Nav */
    if (!opts.noNav) {
      var insertBefore = opts.navBefore || document.body.firstChild;
      document.body.insertBefore(buildNav(), insertBefore);

      var menuBtn = document.getElementById('navMenuBtn');
      var navLinks = document.getElementById('siteNavLinks');
      if (menuBtn && navLinks) {
        menuBtn.addEventListener('click', function() {
          var open = navLinks.classList.toggle('open');
          menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
      }
    }

    /* Footer */
    if (!opts.noFooter) {
      document.body.appendChild(buildFooter());
    }
  }

  window.SiteNav = { init: init };

})(window);
