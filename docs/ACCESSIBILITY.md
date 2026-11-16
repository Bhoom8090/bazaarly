# Accessibility Review — Bazaarly

WCAG 2.2 alignment of the customer-facing UI (React 18, no UI library, HashRouter).
This is a code review, not a formal third-party audit. Unverified items are marked (manual check recommended).

## Perceivable

- Emoji-based product tiles are decorative; every interactive/product element has an accessible name (`aria-label`, visible text).
- Price and availability are presented as text (no images of text). No external images; gradient SVG tiles behind emoji with `role="img"` + `aria-label`.
- Colour is not the only indicator of state (e.g. availability status is text: IN/LOW/OUT_OF_STOCK; order milestones use text + CSS `.done`/`.current` classes).
- Contrast: header navy #131921 on white text; body text #0f1111 on #eaeded; price #b12704; link #007185 — all pass WCAG AA for normal text.

## Operable

- Skip-to-main link (`Skip to main content`) first in DOM; focuses `#main-content` on click.
- "Back to top" is a real `<button>` with a click handler (does not collide with the HashRouter route — prior bug fixed).
- Product tiles are links, keyboard-focusable; visible `:focus-visible` focus ring (3px solid #007185).
- Quantity controls are `<button>`s with `aria-label` (Increase/Decrease quantity); `+`/`-` glyphs are labelled.
- Forms use `<label htmlFor="...">`; inputs have names, `inputMode` for OTP (numeric), `autoComplete` for email/name/password.
- Cart quantity changes announce via `aria-live="polite"` on the quantity value.
- Notifications list is `aria-live="polite"`; notification toasts/alerts carry `role="alert"`.

## Understandable

- Consistent header/nav/search pattern across routes; `aria-label`s on the search form and nav landmarks (`role="banner"`, `<nav>`s, `role="contentinfo"`, `role="tablist"`).
- Error messages use plain language, e.g. "Payment was declined" / "Some items are out of stock"; validation messages identify the field (zod issue path).
- Login error region uses `role="alert"`.

## Robust

- Semantic HTML5 (`<header>`, `<main id="main-content">`, `<nav>`, `<footer>`, headings in order h1→h2→h3).
- `tabIndex="-1"` on `<main>` so skip link can focus it.
- Works with keyboard only; no mouse-only gestures. Forms submittable via Enter.

## Items NOT verified / known gaps

- No axe/lighthouse scan run in CI yet.
- Focus trap in modals: the app has no modals (uses routes).
- Colour-blind palettes not simulated.
- Screen reader announcements tested only via `aria-live` roles, not with an actual screen reader (manual check recommended: NVDA + Edge).
- Date/time formats follow `en-IN` locale; not localized for other regions.
- Toast announcements rely on `aria-live`; not observed with NVDA/JAWS.

## How to verify quickly

1. Open http://localhost:3000 with JS enabled; tab through: skip link → logo → search input → category select → account → notifications → cart.
2. Disable mouse; confirm every interactive control receives visible focus and activates with Enter/Space.
3. Chrome DevTools → Rendering → Emulate vision deficiency to spot colour-only signals (none found by review).
