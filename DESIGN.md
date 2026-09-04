---
name: "AI写作"
description: "An editorial proof desk that keeps authorship, evidence, and revision on one calm working surface."
colors:
  canvas: "#e8ebe5"
  paper: "#f8f9f4"
  paper-strong: "#ffffff"
  paper-muted: "#eef1eb"
  rail: "#0a2926"
  rail-raised: "#123632"
  ink-strong: "#0b2422"
  ink: "#29403d"
  muted: "#596b67"
  coral: "#ff6542"
  coral-dark: "#b93820"
  coral-soft: "#ffe5dc"
  cyan: "#9fd6d1"
  cyan-dark: "#176a67"
  cyan-soft: "#e1f3f0"
  good: "#16765f"
  warn: "#945806"
  bad: "#b8322b"
typography:
  display-en:
    fontFamily: '"Barlow Condensed", sans-serif'
    fontSize: "clamp(52px, 7.2vw, 94px)"
    fontWeight: 800
    lineHeight: 0.92
    letterSpacing: "-0.025em"
  display-zh:
    fontFamily: '"ZCOOL QingKe HuangYou", "Microsoft YaHei", sans-serif'
    fontWeight: 700
  ui:
    fontFamily: '"Segoe UI Variable", "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.6
  reading:
    fontFamily: '"Iowan Old Style", "Songti SC", "STSong", Georgia, serif'
rounded:
  small: "2px"
  floating: "5px"
spacing:
  control-gap: "10px"
  content-gap: "18px"
  section-inset: "24px"
  section-inset-fluid: "clamp(24px, 3vw, 38px)"
components:
  button-primary:
    backgroundColor: "{colors.coral}"
    textColor: "{colors.ink-strong}"
    typography: "{typography.ui}"
    rounded: "{rounded.small}"
    padding: "9px 15px"
    height: "42px"
  button-primary-hover:
    backgroundColor: "{colors.coral-dark}"
    textColor: "{colors.paper-strong}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    typography: "{typography.ui}"
    rounded: "{rounded.small}"
    padding: "9px 15px"
    height: "36px"
  text-input:
    backgroundColor: "{colors.paper-strong}"
    textColor: "{colors.ink-strong}"
    typography: "{typography.ui}"
    rounded: "{rounded.small}"
    padding: "11px 14px"
    height: "48px"
  segmented-length-control:
    backgroundColor: "{colors.paper-strong}"
    textColor: "{colors.muted}"
    typography: "{typography.ui}"
    height: "42px"
  sidebar-navigation-item:
    backgroundColor: "transparent"
    textColor: "{colors.paper}"
    typography: "{typography.ui}"
    rounded: "{rounded.small}"
    padding: "9px 10px"
    height: "48px"
  research-ledger-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.ui}"
    padding: "10px 0"
  document-galley:
    backgroundColor: "{colors.paper-strong}"
    textColor: "{colors.ink}"
    typography: "{typography.reading}"
    padding: "54px clamp(30px, 6vw, 78px) 72px"
    width: "930px"
---

# Design System: AI写作

## Overview

**Creative North Star: "Editorial Proof Desk / 编辑部校样台"**

AI写作 feels like a magazine copy desk laid out for active work: a deep editorial rail frames cool paper, fluorescent proof marks identify decisive actions, and cyan metadata keeps evidence visible without competing with the draft. The interface is calm, literate, information-dense, and deliberately low-depth.

Authorship and evidence share one proof surface. Folio labels, hairline rules, crop marks, compressed headlines, ledger rows, and a white document galley make the application read as a working publication rather than a generic AI dashboard.

**Key Characteristics:**

- Magazine flatplan structure with folio numbers, crop marks, and ruled sections.
- Deep ink-green fields, cool paper neutrals, fluorescent coral proofing, and cyan metadata.
- Compressed display type paired with dependable bilingual controls and a reading-serif galley token.
- Square, low-depth controls whose state changes carry more weight than decoration.

## Colors

The palette separates working material, proofing action, and evidence metadata with a restrained editorial hierarchy.

### Primary

- **Fluorescent Proof Coral** (`{colors.coral}`): Reserved for primary generation, rewrite, and upload actions, active proof marks, and current-step indicators. Its deeper state (`{colors.coral-dark}`) carries hover emphasis; its wash (`{colors.coral-soft}`) marks selected or editable material.

### Secondary

- **Metadata Cyan** (`{colors.cyan}`): Connects the rail to evidence and bilingual brand detail. The accessible dark state (`{colors.cyan-dark}`) is used for metadata text, links, progress, and focus; the soft state (`{colors.cyan-soft}`) supports status fields and hover surfaces.

### Tertiary

- **Proof Status Green** (`{colors.good}`), **Amber** (`{colors.warn}`), and **Red** (`{colors.bad}`): Communicate successful, cautionary, and failed checks without displacing coral as the action color.

### Neutral

- **Cold Canvas** (`{colors.canvas}`): The application ground around all working surfaces.
- **Working Paper** (`{colors.paper}`): Standard section and ledger surface.
- **Galley White** (`{colors.paper-strong}`): Inputs and the final reading sheet.
- **Muted Paper** (`{colors.paper-muted}`): Secondary desks, explanatory fields, and tonal separation.
- **Editorial Rail** (`{colors.rail}`) and **Raised Rail** (`{colors.rail-raised}`): Persistent navigation and its hover layer.
- **Proof Ink** (`{colors.ink-strong}`), **Body Ink** (`{colors.ink}`), and **Pencil Note** (`{colors.muted}`): Headings, body copy, and supporting text in descending emphasis.

**The Proof Mark Rule.** Coral identifies authorship-changing actions and active editorial state; cyan identifies evidence, focus, metadata, and progress.

## Typography

**Display Font:** `{typography.display-en}` with `{typography.display-zh}` for Chinese glyphs.

**Body Font:** `{typography.ui}`.

**Reading Font:** `{typography.reading}`.

**Character:** The display pairing is narrow, direct, and publication-minded. The UI stack stays familiar across English and Chinese, while the reading token preserves a quieter long-form option for document content.

### Hierarchy

- **Display** (`{typography.display-en}`): Oversized opening statements with tight tracking and a near-solid line box.
- **Page Headline** (36–58px, 700, 1): Editor-state titles below the folio rule.
- **Section Title** (17px, 750, 1.35): Compact workflow labels beside numbered proof badges.
- **Body** (`{typography.ui}`): Controls, instructions, and operational copy.
- **Ledger Label** (11.5–13px, 600–700): Uppercase folios, indices, dates, source kinds, and tabular numerals.

**The Copy-Fit Rule.** Use condensed display type for hierarchy and folio rhythm, not for paragraphs or control copy; long-form text retains a readable 72ch maximum.

## Layout

The desktop shell uses a 228px sticky rail and a main work area capped at 1280px. Opening workflows are adjacent flatplan regions: rewrite uses two equal columns, while generation pairs a wider composition desk with a narrower settings desk. Once title directions are generated, the setup surface is replaced inside the same persistent shell by a full-width title desk with a clear return action and an adjacent research ledger. Section padding uses `{spacing.section-inset-fluid}`; internal control groups follow `{spacing.control-gap}` and `{spacing.content-gap}`.

At 1120px, the rail narrows to 196px, domain cells move from three to two columns, and document comparison stacks. At 900px, the rail becomes a sticky top masthead and all task grids become a single column. At 620px, navigation forms a second masthead row, domains become one column, title actions stack, research dates recede, and galley actions enter normal flow.

## Elevation & Depth

The system is flat by default. Large color fields, 1px rules, tonal paper changes, and adjacency establish hierarchy; routine steps, domain cells, research rows, and navigation do not float. Only the document galley receives a broad paper shadow, and the sentence-rewrite popover receives the stronger floating shadow required by its modal layer.

**The Flat Proof Rule.** Do not use card shadows for grouping; reserve elevation for the authored sheet and the focused rewrite layer.

## Shapes

Controls use square geometry with `{rounded.small}` corners; only the floating rewrite layer uses `{rounded.floating}`. Workflow regions, domain grids, segment controls, document previews, tables, and metadata chips are hard-edged. One-pixel hairlines, dashed upload rules, square state marks, and mitered icons reinforce print-registration precision.

## Components

### Buttons

- **Primary:** Fluorescent coral on proof ink, using `{components.button-primary}`; hover shifts to `{components.button-primary-hover}`.
- **Ghost:** Transparent and quiet using `{components.button-ghost}`; hover gains muted paper and stronger ink.
- **Focus:** Every keyboard-focusable control uses a 3px metadata-cyan outline with a 3px offset; controls on the dark rail use coral.

### Inputs and Segmented Controls

- **Text Input:** Galley-white, 1px strong-ink rule, `{rounded.small}`, and `{components.text-input}` dimensions. Focus changes the rule to metadata cyan without adding glow.
- **Length Control:** Three equal cells share one ruled container. The active cell becomes editorial-rail green with white type; inactive cells remain white with pencil-note labels.

### Navigation

- **Sidebar Item:** A numbered, icon-led row using `{components.sidebar-navigation-item}`. Hover reveals raised rail; active state adds a translucent coral field, coral text, and a 7px square proof mark.

### Domain Cells and Research Ledger

- **Domain Cell:** A border-joined editorial index with an absolute two-digit number, title, and short description. Cyan wash communicates hover; coral wash and a square proof mark communicate selection.
- **Research Ledger Row:** A two-line source entry using `{components.research-ledger-row}`. Cyan carries source kind and date, strong ink carries the title, and only the title turns coral on hover.

### Document Galley

- **Galley:** A centered white sheet using `{components.document-galley}` with a 72ch reading measure. A dark proof-action bar sits above the sheet on larger screens and returns to normal flow on mobile.

## Do's and Don'ts

### Do:

- **Do** keep authorship actions coral and evidence or focus states cyan.
- **Do** use broad ruled regions, folio numbers, and tonal paper fields to organize dense workflows.
- **Do** keep the document galley readable at no more than 72ch and let long content grow vertically.
- **Do** preserve visible keyboard focus, reduced-motion behavior, and the single-column task order at narrow widths.

### Don't:

- **Don't** return to pastel gradients, stacked rounded cards, glass panels, or generic AI-dashboard decoration.
- **Don't** distribute shadows across routine controls or workflow regions.
- **Don't** round editorial grids, ruled rows, document previews, or registration marks into pills.
- **Don't** use coral for metadata or cyan for the primary authorship action.
