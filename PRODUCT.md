# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary users are Chinese-speaking writers, fiction authors, editors, and independent content creators working on Word drafts, story ideas, or source-backed articles. They use the product at a desktop workstation to turn rough material into editable, publishable writing, with English available as a secondary interface language.

## Product Purpose

AI写作 is a writing workbench for rewriting Word documents, drafting fiction from a story brief, generating articles from a title or domain, editing sentence by sentence, and exporting finished work. Success means the user can move from draft, premise, or article idea to natural-sounding, editable copy without stitching together several tools.

## Positioning

The product combines three independent workflows in one persistent workspace: humanizing existing documents, drafting fiction from a controlled narrative brief, and generating articles grounded in live research. Its distinguishing mechanism is that generation, close editing, scoring, and Word or WeChat-ready output remain connected rather than becoming disconnected chat responses; research and citations remain exclusive to factual articles.

## Operating Context

The current application is a local-first React/Vite web app commonly launched on Windows. Users can upload `.docx` or `.txt` samples, configure an article or fiction draft, wait through visible generation progress, refine individual sentences, and export Word or WeChat-formatted HTML. Article generation can search public web articles, comments, papers, and news sources; fiction generation deliberately does not.

## Capabilities and Constraints

- Preserve Rewrite Word, Generate Article, and Write Novel modes, their independent in-progress state, bilingual UI, editing, scoring, and export behavior. Source preview and citations apply only to Generate Article.
- The interface must remain usable during 30–90 second model operations and when individual research providers fail.
- The frontend stack is React 18, TypeScript, Zustand, and Vite with no component-library dependency.
- The application must remain responsive and must not rely on remote decorative assets to render its core interface.
- The product identity is text-only: show the name without a logo or favicon.

## Brand Commitments

Retain the name “AI写作”. The voice is direct, calm, literate, and credible rather than promotional. Use a text-only wordmark; do not display a logo or favicon.

## Evidence on Hand

Product behavior and real interface copy are present in `frontend/src`, while workflow and capability documentation is present in `README.md` and `README.zh.md`. There are no customer logos, testimonials, performance benchmarks, pricing claims, or other marketing proof to invent.

## Product Principles

1. Make the next writing action unmistakable.
2. Keep evidence visible without competing with the draft.
3. Treat long-running work and partial source failure as normal product states.
4. Let users retain authorship through direct editing and transparent citations.
5. Prefer a focused editorial workstation over a generic AI dashboard.

## Accessibility & Inclusion

Maintain keyboard-visible focus, readable contrast, reduced-motion support, semantic controls, bilingual text resilience, and functional layouts from mobile through desktop widths.
