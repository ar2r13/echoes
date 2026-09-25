# Frontend UI and Style Guide

Read this document when working on:

- Lit components
- pages
- CSS
- design tokens
- reusable UI primitives
- DOM boundaries
- visual refactors
- accessibility of UI
- TypeScript/template formatting

Do not load it for backend-only or unrelated repository work.

## Styling Architecture

The styling model has three ownership levels.

### Application shell

`src/style.css`

Use for:

- document/application layout
- typography defaults
- global layer ordering
- genuinely global application vocabulary

Do not grow this into a collection of feature-specific selectors.

### Shared primitives

`src/styles/*`

Use for reusable:

- tokens
- reset rules
- controls
- effects
- surfaces
- layout primitives
- cross-component visual contracts

Examples include:

```text
src/styles/variables.css
src/styles/reset.css
src/styles/button.css
src/styles/controls.css
src/styles/table.css
src/styles/data.css
src/styles/shell.css
```

Extract a shared primitive only when reuse is real.

Do not move local feature CSS into `src/styles/*` merely because another feature happens to contain a similar declaration.

### Feature styles

Keep page/component-specific CSS next to its owner:

```text
src/pages/<feature>/style.css
src/components/<name>/style.css
```

Local styles should describe that feature's structure and variations without leaking into unrelated screens.

## Native CSS First

Use CSS itself as the composition system.

Prefer native features including:

- custom properties
- `@scope`
- `@layer`
- native nesting
- `@custom-selector`
- `:where(...)`
- inheritance
- `currentColor`
- `calc()`
- `min()`
- `max()`
- `clamp()`
- `color-mix()`
- relative color syntax where useful

Avoid introducing JavaScript styling abstractions for relationships CSS can already express cleanly.

TypeScript modules should consume colocated stylesheets using the repository's native CSS import pattern such as:

```ts
import style from './style.css' with { type: 'css' }
```

Follow the surrounding file when exact usage differs.

CSS-to-CSS composition may use `@import` in shared stylesheet entrypoints.

## Design System Source

The product's visual language is the LOBSTR design system, in its blockchain
explorer form: a light, compact, cool-desaturated system for dense tables, long
hashes and numbers that must align.

Its tokens are vendored verbatim under:

```text
src/styles/lobstr/
```

Those files hold the values. Do not edit them by hand and do not retype their
hexes elsewhere; re-sync them from the Claude Design project
`1c8cc924-1863-43f9-86e3-9f7cd1404cba` instead. `colors.css`, `typography.css`
and `space.css` come from that project's `tokens/`; `fonts.css` is the same
`@font-face` set repointed at `/fonts/` and trimmed to the latin subsets.

The system's own aliases are already role-named, so application CSS consumes
them directly:

```text
--fg  --fg-strong  --fg-muted  --fg-subtle  --fg-faint  --fg-link
--bg-page  --bg-surface  --bg-sunken  --bg-hover  --bg-accent
--line  --line-strong  --focus-ring
--ok-*  --err-*  --warn-*  --info-*  --neutral-*  --value-in  --value-out
--t-*  --w-*  --lh-*  --ls-*  --font-ui  --font-mono
--s-*  --r-*  --e-*  --ctl-*  --row-h  --gutter  --page-max
--dur  --dur-fast  --ease
```

`src/styles/variables.css` is the only bridge, and stays thin: it names what
LOBSTR leaves to the consumer — the `--border` hairline shorthand, the composite
`--type-*` roles behind the system's `.lb-h1`/`.lb-body`/`.lb-meta` helpers, and
readable `--gap-*` names for steps of the 2px grid.

The system's class layer (`css/controls`, `css/table`, `css/data`, `css/shell`
in the source project) is BEM and is *not* vendored. Its values are re-expressed
in this repository's trait vocabulary under `src/styles/`:

```text
src/styles/button.css     .button, .icon-button
src/styles/controls.css   .badge .chip .tabs .segmented .field .alert .spinner .pager
src/styles/table.css      .table .table-wrap .empty
src/styles/data.css       .amount .details .metrics
src/styles/shell.css      .panel .toolbar .crumbs .pagehead .page .stack .row
```

When a primitive changes upstream, change it in these files against the source
values rather than copying the `lb-` classes in.

Constraints the system states explicitly, which application CSS must not
reintroduce:

- backgrounds are flat colour, never a gradient
- borders, not shadows: panels, tables and toolbars carry one hairline and 6px
  corners; the two elevation tokens are only for things that actually float
- radii are 2/3/4/6/10px and `--r-full`; no 8/12/16px radius exists
- compact by default: controls are 24/28/34px, table rows 36px, gutter 24px
- teal is the only saturated colour in the interface, and carries links, the
  primary button, the active tab underline and the focus ring
- status hues are dialled back so fifty rows of badges stay calm
- every hash truncates head/tail, carries the full value in `title`, and has a
  copy affordance
- machine values — hashes, amounts, block heights, nonces — are mono with
  tabular figures, right-aligned when numeric, never bold

Ubuntu is the only typeface, self-hosted from `src/fonts/` in weights
300/400/500/700, with a system mono for machine values.

## Design Tokens

CSS custom properties are the main visual contract.

Name global tokens by semantic role.

The vendored system already provides the global set; prefer its namespaces:

```text
--fg-*  --bg-*  --line*      colour roles
--t-*  --w-*  --lh-*  --ls-*  type
--s-*  --gap-*                space
--r-*  --e-*                  radius and elevation
--ctl-*  --row-h              control metrics
```

Add a global token only when the system leaves the role unnamed, and add it to
`src/styles/variables.css` rather than to a feature stylesheet.

Component-local variables should describe what they control:

```text
--background
--padding
--text-color
--picker-size
--picker-icon
```

Avoid global variables named after a route, incidental DOM structure, or one-off screen.

Feature-specific local custom properties are fine when their meaning is genuinely local.

## Spacing

Spacing comes from the vendored 2px grid, `--s-1` through `--s-13`. Use those
steps directly, or the readable aliases the bridge names for them:

```text
--gap-xxs
--gap-xs
--gap-sm
--gap
--gap-md
--gap-lg
--gap-xl
```

Do not introduce numeric-prefix naming such as `--gap-2xs`, and do not invent
values between the grid's steps.

Before adding a one-off margin, padding, gap, or layout offset, check whether the existing spacing scale expresses it.

## Units

Use `rem` as the default design-sized unit.

Use contextual units when they better express the contract:

- `em`
- `ch`
- `lh`
- `%`
- `vw`
- `vh`
- `dvh`
- `svh`
- `lvh`

Use `px` only when a fixed device-like threshold is intentional, for example:

- hairlines
- precise borders
- raster alignment
- platform-specific fixed thresholds

Do not use `px` merely because a mockup happened to specify pixels.

## Computed Values

Prefer expressing relationships rather than copying literals.

For sizing:

```css
calc()
min()
max()
clamp()
```

For colors:

```css
color-mix()
relative color syntax
hsl(from ...)
```

Use `currentColor` where an icon, border, or decoration should follow text/context color.

For intentionally unbounded pill-like radii, prefer an explicit unbounded expression where supported by the target CSS model rather than arbitrary giant sentinel values.

Stable tokens should contain inputs. Derived values should normally be computed from those inputs.

## Class Vocabulary

Classes are composable traits, not block namespaces.

Preferred vocabulary resembles:

```text
button
row
stack
inline
wide
center

solid
outlined
round
lifted
accent
minor
muted

link
regular
bolder
small
large
```

Composition should read like a styling phrase:

```html
<button class='button solid'>
<button class='button outlined'>
<button class='button solid inline stack'>
```

Each modifier should have a narrow responsibility.

For example:

- `solid` -> filled surface
- `outlined` -> border treatment
- `inline` -> inline presentation
- `stack` -> stacked internal flow
- `muted` -> reduced emphasis

Prefer combining small traits over inventing a feature-specific class for every visual combination.

## No BEM

BEM naming is forbidden in new and refactored code.

Do not introduce:

```text
block__element
block--modifier
block__element--modifier
```

Class names should remain kebab-case trait names without `__` or `--` BEM separators.

If styling only makes sense inside one page or component, scope the selector locally instead of encoding the entire ownership hierarchy into the class name.

## Specificity

Keep selectors low-specificity and composable.

Prefer:

- `@scope`
- semantic selectors within an owned subtree
- `:where(...)` for reset/utility behavior
- custom selectors for reusable semantic groups
- nested local modifiers

Avoid:

- deep descendant chains
- high-specificity global selectors
- selectors coupled to unrelated page structure
- `!important` except for deliberate reset/contract cases where override behavior requires it

## Scope

Open-DOM page/component CSS should be ownership-bound.

Use `@scope` or the repository's open-DOM style infrastructure rather than global feature selectors.

Within a scoped component, semantic selectors are acceptable when the component owns that DOM structure.

Example conceptual shape:

```css
@scope (example-page) {
	header {
		...
	}

	section {
		...
	}
}
```

Do not use a scoped component stylesheet as an excuse to override unrelated application elements outside its ownership boundary.

## DOM Boundaries

### Light/open DOM

Prefer for:

- pages
- application-specific feature UI
- components intended to blend into surrounding layout
- components that should inherit normal app typography/style context

Use the repository's existing open-DOM helpers.

### Shadow DOM

Prefer when:

- slots are part of the component API
- internal structure must be protected from surrounding CSS
- the component should survive outside the current app
- controlled external styling through tokens, `::part`, or `::slotted` is part of the contract

A custom element does not need shadow DOM merely because it is reusable.

Correctness that depends on outside CSS not interfering is, however, a strong reason to use shadow DOM.

## Shadow DOM Styling

Shadow roots must not rely on `src/style.css` selectors leaking inward.

Consume shared design through explicit contracts.

Prefer:

- inherited typography where appropriate
- inherited color
- `currentColor`
- shared custom properties
- portable shared primitive stylesheets
- component-specific styles

Examples of useful contracts:

```text
--color-*
--font-*
--weight-*
--background
--padding
--radius-*
```

Keep app-shell layout selectors and page-only utilities outside shadow roots.

## Inheritance

Let typography and colors inherit unless the component explicitly owns a different value.

Avoid redeclaring:

- font family
- text color
- font weight
- line-height

without a component-specific reason.

Build base objects from variables and let modifiers change variables rather than duplicate entire declaration blocks.

Prefer:

```css
.button {
	background: var(--background);
	color: var(--text-color)
}

.button.solid {
	--background: var(--color-accent);
	--text-color: var(--color-on-accent)
}
```

over repeating the complete button style for every variation.

## CSS Layers

Use the application's intended global order:

```text
reset
element
component.base
component.modifier
layout
modifier
```

Meaning:

- `reset` -> normalization/defaults
- `element` -> tag/semantic element behavior
- `component.base` -> shared component primitives
- `component.modifier` -> component-level variants
- `layout` -> structural composition helpers
- `modifier` -> final visual/state traits

Use layers to express precedence instead of relying on accidental stylesheet import order.

Declare component primitives in `component.base`, never in a bare `@layer
component`: a layer's own rules outrank its sub-layers, so a primitive left
unlayered inside `component` silently wins over every `component.modifier` rule
that sets the same property.

## Declaration Grouping

Group declarations by function and separate groups with a blank line.

Preferred conceptual order:

1. layout and positioning
2. sizing
3. spacing
4. overflow/scroll behavior
5. border/radius/outline
6. typography
7. colors/surfaces
8. interaction/motion

Example:

```css
.panel {
	display: grid;
	position: relative;

	inline-size: 100%;
	min-block-size: 10rem;

	gap: var(--gap);
	padding: var(--gap);

	border: 1px solid currentColor;
	border-radius: var(--radius-md);

	font-weight: var(--weight-regular);
	line-height: 1.4;

	color: var(--color-text);
	background: var(--color-surface);

	transition: opacity .2s
}
```

The exact grouping may vary when another ordering makes the relationship clearer.

Do not machine-sort declarations alphabetically.

## Media Queries

When responsive behavior belongs to an existing selector, nest the media query inside that selector.

Prefer:

```css
.panel {
	display: grid;

	@media (width < 40rem) {
		display: block
	}
}
```

Use a top-level media query when there is no meaningful owning selector.

## TypeScript Formatting

Preserve the formatting dialect of the file being edited.

The repository's dominant style is:

- tabs
- same-line braces
- no semicolons by default
- single quotes
- blank lines between logical groups

Definitions have a space before parentheses:

```ts
render ()
constructor ()
connectedCallback ()
```

Calls remain tight:

```ts
render()
navigation.navigate()
document.startViewTransition()
```

Type annotations use spaces around the colon:

```ts
event : NavigateEvent
root : HTMLElement | null
```

Use ordinary compact JS punctuation:

```ts
{ id }
{ event, route }
```

Short trivial guard clauses may stay compact:

```ts
if (!value) return
```

Do not introduce extra braces where the local code consistently omits them for a simple single action.

Do not reformat unrelated code.

## Naming

Prefer the shortest name that remains precise.

One-word names are preferred when they clearly preserve domain meaning.

Good:

```text
ledger
profile
route
asset
currency
transaction
```

Do not force one-word names when doing so makes the name vague.

Avoid abbreviations whose only benefit is fewer characters.

Clarity wins over artificial brevity.

## Lit Templates

Templates should remain compact and HTML-like.

Prefer unquoted simple attributes when valid in the local style:

```html
<div class=row role=list>
```

Quote multi-word values with single quotes:

```html
<button class='solid outlined' aria-label='Close dialog'>
```

Do not introduce double-quoted HTML attributes in Lit templates.

Keep event/property bindings near the element they configure.

Use multiline templates when nesting or branches become easier to read that way.

Keep expressions small.

Instead of embedding multi-step computation in the template, stage it in TypeScript:

```ts
const label = ...
const disabled = ...

return html`
	<button ?disabled=${disabled}>${label}</button>
`
```

If a conditional branch becomes structurally large, extract a helper or local template variable.

## Comments

Use comments sparingly.

Good comments explain:

- intent
- browser/platform quirks
- compatibility constraints
- non-obvious interaction behavior
- reasons for an unusual implementation

Do not narrate obvious code line by line.

Preserve useful existing comments about browser quirks and platform behavior.

Avoid unrelated comment cleanup while making a focused change.

## Accessibility

UI implementation must preserve semantics and native behavior.

Prefer real:

```html
button
input
select
dialog
a
```

over generic elements emulating them.

Custom interactions must account for:

- keyboard input
- focus
- accessible names
- labels/descriptions
- changed state announcements where relevant
- touch/mouse/keyboard modality
- reduced motion
- zoom
- contrast

Native behavior is preferable to rebuilding equivalent behavior manually.

## Motion

Use motion only when it helps communicate state or navigation.

Prefer platform primitives such as View Transitions when appropriate.

Respect `prefers-reduced-motion`.

Avoid expensive animation patterns that trigger unnecessary repeated layout work.

## Reuse Rule

Share primitives, not copied feature CSS.

Before extracting something globally, ask whether the shared thing has a stable reusable contract.

If yes, extract the primitive.

If two pages only happen to use similar declarations today, keep them local until a real shared contract emerges.

## UI Refactor Checklist

Before finishing a CSS/component refactor, verify:

- no new BEM names
- ownership is local or genuinely shared
- spacing uses the existing scale where possible
- hardcoded values are not duplicated transformations of existing tokens
- selectors remain low-specificity
- DOM boundary still matches component contract
- shadow DOM does not depend on shell CSS
- keyboard/focus behavior still works
- reduced-motion behavior remains valid
- unrelated files were not reformatted

When uncertain about style, inspect nearby code before creating a new convention.