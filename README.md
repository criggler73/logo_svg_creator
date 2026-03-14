# LeapfrogIQ Apps — Logo SVG Converter

Free browser-based tool to convert PNG, JPG, and WEBP logo images to clean SVG vector files. Part of the LeapfrogIQ Apps utility hub.

**Live:** https://leapfrogiq.apps/tools/logo-svg-converter/  
**Hub:** https://leapfrogiq.apps/  
**Repo:** criggler73/logo_svg_creator

---

## What it does

Upload a raster logo (PNG, JPG, WEBP, GIF, BMP) → convert to SVG vector in the browser → download SVG, transparent PNG, or a complete brand asset pack (ZIP).

No signup. No file uploads to a server. All processing in-browser.

---

## Project structure

```
docs/
├── index.html                         # LeapfrogIQ Apps hub homepage
├── assets/
│   ├── css/shared.css                 # Design system (tokens, layout, components)
│   ├── js/
│   │   ├── nav.js                     # Shared nav + footer injection
│   │   ├── svgConverter.js            # Vectorization + PNG export engine
│   │   └── zipBuilder.js              # ZIP pack builder
│   └── img/
│       ├── logo.svg                   # LeapfrogIQ logo
│       └── favicon.svg                # Favicon
├── tools/
│   └── logo-svg-converter/
│       └── index.html                 # Main converter tool page
└── legal/
    ├── privacy-policy.html
    └── terms-of-service.html
```

---

## Tech stack

- **HTML / CSS / Vanilla JS** — no framework required
- **Imagetracer.js** — raster-to-SVG vectorization (browser-only)
- **JSZip** — in-browser ZIP creation
- **FileSaver.js** — download trigger
- **Static site** — deploy from `/docs` to GitHub Pages, Netlify, or Cloudflare Pages

---

## Deployment

### GitHub Pages
1. Go to Settings → Pages
2. Set source to `main` branch, `/docs` folder
3. Set custom domain to `leapfrogiq.apps` (or leave as GitHub Pages URL for testing)

### Netlify / Cloudflare
- Publish directory: `docs`
- No build command needed (static HTML)

---

## Roadmap

| Phase | Feature |
|-------|---------|
| MVP ✅ | Upload → vectorize → SVG + PNG + ZIP download |
| Phase 2 | Black/white SVG variants, favicon set (16/32/48 PNG + ICO) |
| Phase 2 | `/tools/png-to-svg/`, `/tools/jpg-to-svg/` keyword pages |
| Phase 3 | Favicon Generator as separate tool page |
| Later | Brand Kit Generator (color variants, multiple sizes) |

---

## Related tools

- [Blueprint Area Calculator](https://area.leapfrogiq.ai/) — measure square footage from construction blueprints

---

## Author

Mat Robie — LeapfrogIQ  
support@leapfrogiq.ai
