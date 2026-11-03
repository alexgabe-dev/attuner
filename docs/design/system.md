# Attuner design system

Calm, precise and private. Original angular monogram, charcoal opaque surfaces and sparse violet emphasis. No fantasy landscape, decorative analytics, imitation game branding or translucent application cards.

## Foundations

Tokens are defined once in `packages/ui/src/styles.css` through CSS variables and Tailwind 4 `@theme`. Canvas #0D0F12; surface #15181D; raised #1B1F25; interactive #242A32; primary #F2F3F5; secondary #9BA3AF; muted #8A939F; accent #A78BFA; success #55C69A; warning #E5B567; error #E47B83. Decorative border #2B3038. Filled violet buttons use dark text. Required text contrast is 4.5:1; automated checks cover rendered overview and conflict dialogs.

Inter Variable is the sole UI face. JetBrains Mono Variable is for code, hashes, paths and revisions. Font assets ship locally through Fontsource; there are no Google Fonts requests. The initial visual pass was inspected and supporting text increased for readability. Body/control text is approximately 13–14px, supporting copy 11–12px, page headings 25–27px, status headings 17–19px. Micro labels are 9–11px with adequate contrast.

Spacing follows 4/8/12/16/24/32/40/48px. Controls have 6px radii, content panels 7–8px, overlays 10px. Borders define hierarchy; shadows are confined to overlays. Lucide is the sole general-purpose icon set, supplemented by the original brand and a small OS glyph.

## Composition

Persistent sidebar, quiet breadcrumb bar, clear page heading and one dominant status region. Installation metadata is one integrated panel. Devices and activity use rows, not independent oversized cards. Desktop uses a real OS titlebar. Web uses persistent Next layout state and real routes/back navigation.

Shared primitives are `Button`, `Badge`, `Brand`; the demo workbench composes section headers, timelines, tables, dialogs, empty states and progress. Do not extract a broad component library before live screens require it.

## States and interactions

Every status uses text and an icon rather than color alone. Connectivity, revision acknowledgement and game readiness are distinct concepts. The deterministic demo selector exposes synchronized, pending, offline, conflict and error states. Demo sync has staged progress and safe cancellation. Offline acknowledgement is never fabricated. Restore and pairing are explicitly read-only informational previews.

Radix Dialog provides modal semantics, focus containment and Escape dismissal. Focus restoration is explicit for programmatic dialogs. Mobile navigation makes background content inert and traps focus. A skip link and visible focus rings support keyboard use. Command menu: Command/Ctrl+K.

Hover 120ms, state 180ms, panels 220ms. OS reduced motion and a saved-session preview preference remove nonessential transitions. Errors persist in the primary status; completion messages use a polite live region.

## Responsive behavior

Below 768px use a navigation drawer, stacked regions, labeled device rows, scroll-contained tables and unified diff by default. At 768–1023px use a compact sidebar and stacked overview sections. Larger layouts use two columns, constrained reading widths and optional side-by-side comparison. Tables may scroll internally; the document must not overflow horizontally.

Future monitoring pages should add charts only when they answer a specific operational question. Future Monaco and virtualized lists must be lazy-loaded.
