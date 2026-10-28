---
name: "AI写作"
description: "A sunlit, hand-painted picture-book world around calm cream-paper working surfaces: the shell is illustrated, the writing is not."
colors:
  canvas: "#f3ead2"
  paper: "#fffaf0"
  paper-strong: "#fffdf6"
  paper-muted: "#f6eed9"
  ink-strong: "#243126"
  ink: "#2e3a2f"
  muted: "#5b6553"
  sky: "#a6cbdd"
  sky-deep: "#4a7ea3"
  sky-ink: "#2c6490"
  sky-soft: "#e2eef0"
  cloud: "#fbf5e6"
  sap: "#8fa75a"
  meadow: "#6f8f4e"
  forest: "#2f5a3c"
  forest-deep: "#24412f"
  sage-soft: "#e7eed4"
  sun: "#e8c36a"
  sun-soft: "#fbefc8"
  roof: "#c2502d"
  roof-dark: "#a23c1d"
  roof-soft: "#f8e1d1"
  good: "#2f6f4a"
  warn: "#8a5a14"
  bad: "#a63a2c"
typography:
  display-zh:
    fontFamily: '"ZCOOL KuaiLe", "Fraunces", "Microsoft YaHei", sans-serif'
    fontSize: "clamp(36px, 4.7vw, 66px)"
    fontWeight: 700
    lineHeight: 1.12
  display-en:
    fontFamily: '"Fraunces", "Iowan Old Style", Georgia, serif'
    fontSize: "clamp(36px, 4.7vw, 66px)"
    fontWeight: 700
    lineHeight: 1.12
  ui:
    fontFamily: '"Segoe UI Variable", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.6
  reading:
    fontFamily: '"Fraunces", "Segoe UI Variable", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
rounded:
  card: "26px 20px 24px 18px"
  control: "14px"
  pill: "999px"
spacing:
  control-gap: "10px"
  content-gap: "22px"
  section-inset: "22px"
  section-inset-fluid: "clamp(22px, 2.8vw, 36px)"
components:
  button-primary:
    backgroundColor: "{colors.roof}"
    textColor: "#ffffff"
    typography: "{typography.ui}"
    rounded: "{rounded.pill}"
    padding: "9px 18px"
    height: "42px"
  button-primary-hover:
    backgroundColor: "{colors.roof-dark}"
    textColor: "#ffffff"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.ui}"
    rounded: "{rounded.pill}"
    padding: "9px 18px"
    height: "38px"
  text-input:
    backgroundColor: "{colors.paper-strong}"
    textColor: "{colors.ink-strong}"
    typography: "{typography.ui}"
    rounded: "{rounded.control}"
    padding: "11px 16px"
    height: "48px"
  segmented-length-control:
    backgroundColor: "{colors.paper-strong}"
    textColor: "{colors.muted}"
    typography: "{typography.ui}"
    rounded: "{rounded.pill}"
    height: "48px"
  sidebar-navigation-item:
    backgroundColor: "transparent"
    textColor: "{colors.cloud}"
    typography: "{typography.ui}"
    rounded: "18px"
    padding: "9px 14px 9px 12px"
    height: "50px"
  research-ledger-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.ui}"
    rounded: "12px"
    padding: "10px 6px"
  document-galley:
    backgroundColor: "{colors.paper-strong}"
    textColor: "{colors.ink}"
    typography: "{typography.reading}"
    rounded: "{rounded.card}"
    padding: "54px clamp(30px, 6vw, 78px) 72px"
    width: "930px"
---

# Design System: AI写作

## Overview

**Creative North Star: "Sunlit Picture-Book Workshop / 晴空草地上的写作小屋"**

AI写作 is a bright, relaxed, hand-painted world with a quiet writing desk set inside it. The look is a blend of Japanese hand-drawn animation backgrounds, watercolour and gouache picture-book illustration, naturalistic light and plant layering, and a touch of European fairy tale and fantasy romanticism. Everything sits on warm cream watercolour paper with a barely visible grain.

The world is the shell: the page sky, the sidebar, and the hero scene of each mode. The work is not: forms, pickers, title results, research lists, progress, the document galley, score bar, sentence popover and WeChat export panel sit on calm cream paper cards with generous space and no art behind the text.

**Key Characteristics:**

- Warm, restrained colour. Nothing neon or candy-bright. The scenery carries the colour; the interface chrome stays quiet.
- Watercolour for sky and distance (transparent, softly blurred wash edges); gouache for foreground foliage, roofs and paths (flatter, matte, denser colour with a lit side, a shadow side and warm rim highlights).
- Each hero is a deckle-edged painted vignette on the paper, not a full-bleed background, with a faint fold line and graphite under-drawing.
- Cards and controls are rounded and slightly hand-cut: asymmetric card radii, pill buttons, soft ink outlines, round painted step badges.
- Small signs of everyday life in every scene (a lit window, chimney smoke, a clothesline, a fence, a mailbox, a bench, a lantern) and no characters.

### Original-scene rule (IP)

Every scene is original and generic: sky, clouds, hills, meadow, forest, a cottage, a windmill, a path. Do not draw or name any existing film's characters, creatures, logos, titles, castles or recognisable scenes, and never write the name of a studio or film in the product or code. Birds stay tiny and distant; people, if ever added, stay tiny and distant.

## Colors

The palette separates paper, ink, the action colour and the scenery.

### Primary

- **Terracotta Roof** (`{colors.roof}`): The only action colour: primary generation, rewrite and upload buttons, and the current-selection mark. White text on it meets 4.5:1 (4.69:1). Its deeper state (`{colors.roof-dark}`) carries hover; its wash (`{colors.roof-soft}`) marks a selected card.

### Secondary

- **Meadow and Forest** (`{colors.sap}`, `{colors.meadow}`, `{colors.forest}`, `{colors.forest-deep}`): Foliage and hills in the art; in the interface, forest is the sidebar field, the active segment, the document action bar and the strong text green. `{colors.sage-soft}` is the hover wash.
- **Sky** (`{colors.sky}`, `{colors.sky-deep}`): Washes and the progress bar. The text-safe `{colors.sky-ink}` carries links, source metadata and summaries on paper (6.1:1); `{colors.sky-soft}` fills chips and busy banners.
- **Sun Gold** (`{colors.sun}`, `{colors.sun-soft}`): Warm light: active-nav dot, step badge, sidebar numerals, hover wash on neutral buttons.

### Tertiary

- **Good** (`{colors.good}`), **Warn** (`{colors.warn}`), **Bad** (`{colors.bad}`) with their soft washes communicate score and validation status. Each pair meets 4.5:1.

### Neutral

- **Canvas** (`{colors.canvas}`) is the paper ground; **Paper** (`{colors.paper}`) is the card; **Paper Strong** (`{colors.paper-strong}`) is inputs and the galley; **Paper Muted** (`{colors.paper-muted}`) is secondary desks.
- **Ink Strong** (`{colors.ink-strong}`), **Ink** (`{colors.ink}`) and **Muted** (`{colors.muted}`, 5.8:1 on paper) are headings, body and supporting text.

**The One Action Colour Rule.** Terracotta means "do the next writing action". Green means place and state, blue means evidence and links, gold means warmth. Do not add colours outside the token list; the scenery's own pigments live only inside the scenery components.

## Typography

**Display:** `{typography.display-zh}` for Chinese UI (the `lang="zh-CN"` document) and `{typography.display-en}` for English. ZCOOL KuaiLe is a rounded, hand-lettered Chinese face; Fraunces is a soft, friendly old-style serif. Both are OFL-licensed and bundled locally through `@fontsource`.

**Body:** `{typography.ui}`: the system stack, for readable Chinese and English controls and operational copy.

**Reading:** `{typography.reading}`: inside the document galley, headings use Fraunces over the system face. The hand-lettered display face never appears inside the reading area.

### Scale

One small scale, used everywhere: 11 (media tag), 12, 13 (labels, meta, hints), 15 (body and controls), 17 (card titles), 20 (index numerals), 26 and 30 (score and galley sub-heads), and fluid display sizes for hero (36–66px), page heads (30–46px) and results titles (30–50px). Weights are 400, 600 to 650 for controls and labels, 700 for display. Body line height is 1.6; display is 1.12 to 1.2; the galley is 1.78 with a 680px measure.

## Layout

Desktop uses a 236px painted sidebar and a main pane capped at 1240px. The hero is two columns: words on bare paper, a painted vignette (800 : 520) beside them. Working surfaces are separate cards with a 22px gap: rewrite uses two equal columns, generation a wider composition desk plus a narrower settings desk. Once title directions exist, the setup is replaced in the same shell by a title card with a back action and adjacent research card.

At 1120px the sidebar narrows to 208px, domain cells go to two columns, document comparison stacks, file pickers and the title field stack inside their half-width card. At 900px the sidebar becomes a sticky painted masthead, its scenery is dropped, and the hero and task grids go to one column. At 620px navigation takes a second masthead row, the vignette becomes a short strip below the hero copy, and galley actions enter normal flow. There is never page-level horizontal scroll.

## Elevation & Depth

Cards use a single warm, soft shadow (`0 12px 28px` at about 11% plus a small contact shadow) on a soft ink outline. Buttons lift on hover with a soft shadow. The sentence popover takes the strongest float shadow. Shadows are warm brown, never hard-offset.

## Shapes

Cards have asymmetric, hand-cut radii (`{rounded.card}`); controls are 14px; buttons, segments, chips and score pills are pills. Step badges are organic round blobs. Dashed or dotted ink rules replace hairlines inside cards. Hero vignettes have ragged dry-brush edges baked into the alpha of the painted image.

## Components

### Buttons

- **Primary:** terracotta pill, white text, soft ground shadow and a faint top highlight. Hover darkens to `{colors.roof-dark}` and lifts. Press settles. Disabled is flat paper-grey.
- **Neutral:** paper-strong pill with a soft ink outline; hover washes gold and turns the outline forest.
- **Ghost / link:** quiet; hover adds a sage wash, or a roof-coloured underline for links.
- **Focus:** every focusable control shows a 3px `{colors.sky-ink}` outline with a 3px offset; on forest fields (sidebar, galley action bar) the outline is sun gold.

### Inputs and Segmented Controls

- **Text input / select / textarea:** paper-strong, 1px soft ink rule, 14px radius; focus changes the rule to `{colors.sky-ink}` and adds a soft ring.
- **Length control:** one pill container of three pill cells; the active cell is forest with paper text.

### Navigation

- **Sidebar item:** a pill row (numeral, icon, label) in cream on forest. Hover slides it 3px and washes it. The active item becomes a paper tab with a gold dot. The wordmark "AI写作" is text only, set in the display face with a hand-drawn gold wave beneath it.

### Domain Cells and Research Ledger

- **Domain cell:** a rounded paper card with a forest numeral; hover washes sage; selected becomes `{colors.roof-soft}` with a terracotta dot.
- **Research row:** dashed-rule rows with blue source metadata; hover washes sage and the title turns terracotta-dark.

### Document Galley

- **Galley:** a centered paper sheet at a 680px reading measure with a forest action bar on top (length status, polish, export). Nothing in or around the galley moves.

## Where Art Goes (and Does Not)

**Illustrated shell:** a page sky wash, a painted meadow strip at the page foot, the sidebar forest edge, and the hero vignette of each mode.

- **Rewrite Word:** meadow and hillside with a distant cottage (terracotta roof, lit window, chimney smoke), clothesline, fence, mailbox, bench under a tree, a bicycle, a winding path, wildflowers.
- **Generate Article:** a wide summer sky with towering cumulus over far hills, a hill village, a windmill, a coral kite, a path, tiny birds.
- **Write Novel:** a forest path under a canopy with light falling from a sky opening, a lantern on a trunk, a bench, a tiny far cottage window, ferns and wildflowers.
- **Sidebar:** forest edge with a painted tree line, swaying grass, a few warm glints and leaves hanging from the corner. It drops away at 900px.

**Calm surfaces:** forms, domain picker, title results, research list, progress banner, document galley, score bar, popover, WeChat export panel. These sit on cream paper cards. Only a very faint colour wash bleeds from a card corner, never behind text. Do not put illustration under copy.

**Construction:** the art is painted offline, not drawn live. `frontend/scripts/paint-scenery/` (a build-time tool, run with the Playwright that ships in the ui-acceptance skill; Playwright is not a frontend dependency) simulates the media in headless Chrome and exports local WebP files to `frontend/src/assets/scenery/`:

- Watercolour washes (sky, distance): wobbling edges that mix soft bleeds with a few crisp dry-brush stretches, pigment pooled at the edge, blotchy colour and light granulation.
- Gouache (foreground, roofs, paths): denser, flatter colour with brush-direction streaks and rough edges.
- Foliage: dabbed leaf strokes with lit tops, cool shadowed undersides and warm rim highlights, never circles.
- Cumulus left mostly as bare paper with lilac-grey shading; faint graphite lines under the washes; paper grain; a deckled vignette whose alpha doubles as the CSS mask.

Moving elements (cloud masses, grass fringe, smoke, kite, windmill sails, light shafts, sidebar glints) are separate transparent images positioned over the background. `scenery-art.css` is generated and maps each image to its layer and rectangle; the React components are empty `aria-hidden` spans. Re-run the generator to change the art; total weight stays under about 700 KB. No remote fonts or images.

## Motion

Motion is slow, gentle and alive; only `transform` and `opacity` animate. Nothing moves inside the text-editing or reading areas.

**Full tier** (no reduced-motion preference): cloud drift (±5% over 80–140s), grass and leaf sway (±2.4°, 6–9s), light-shaft shimmer, chimney smoke and kite bob, a slowly turning windmill, sidebar glints, panels easing in with a 16px rise over 700ms, buttons lifting 2px with a soft spring and settling on press.

**Reduced tier** (`prefers-reduced-motion: reduce`, which is always on for some users): ambient life stays, slower and smaller: cloud drift ±2.4% at 1.7× duration, sway ≤1.3°, shimmer and smoke as opacity only, kite ±1.2°, 6px fade-in rises, 1px hover lift, no spring and no press scale. The windmill stops. Nothing loops faster than six seconds, and no bounces, scale pops, parallax or long slides remain.

## Do's and Don'ts

### Do:

- **Do** keep terracotta for the next writing action and use only tokenised colours in the interface.
- **Do** keep text on paper: every body, label and placeholder meets AA contrast.
- **Do** keep the galley at a 680px measure and let content grow vertically.
- **Do** keep keyboard focus clearly visible and the single-column task order at narrow widths.
- **Do** keep the wordmark text-only.

### Don't:

- **Don't** put busy art behind working surfaces or move anything inside the reading and editing areas.
- **Don't** animate SVG filters, layout properties or anything that causes layout shift.
- **Don't** draw or name any existing film's characters, creatures, logos, titles or scenes.
- **Don't** use hard offset shadows, sterile square boxes, neon colour, or remote fonts and images.
