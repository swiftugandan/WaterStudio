# Accessibility: WCAG 2.2 AA audit

WaterStudio targets WCAG 2.2 level AA (plan, section 10). This is the audit that closes the Phase 2 gate. It is
kept current: a change that affects a criterion below updates this file in the same commit.

- Date: 2026-10-11
- Scope: the web app at `apps/web` in Chromium, light and dark themes, comfortable density, with Net1.
- Method: automated checks in CI plus the manual review below. The automated checks run axe-core with the
  `wcag2a`, `wcag2aa`, `wcag21aa` and `wcag22aa` rules (`apps/web/e2e/app.spec.ts`) on the whole app with a graph,
  the reports and the assistant open, in both themes, and on every editor in turn: the inspector, each options
  tab, patterns, curves, controls, query and group edit, add element, the legend editor, the calibration report,
  the studies, the multi-species and the network tools panels, and the proposals review panel (whose Accept is
  also exercised from the keyboard).
  Token contrast is unit-tested (`packages/ui/src/tokens/tokens.test.ts`).

## Result

Passes, with the exception noted under 2.5.7 (dock splitters) and the known third-party issue under 4.1.2.

## Criteria

| Criterion | How WaterStudio meets it |
| --- | --- |
| 1.1.1 Non-text content | Icons are `aria-hidden` next to text labels; icon-only buttons have names. The map is an `application` with a description of how to use it. Charts are `role="img"` with a summary and a table view with the same numbers; the contour plot's label lists node counts per band. The overview map is labelled. |
| 1.3.1 Info and relationships | Every field has a `<label>`; tables use `th` with `scope`; panels, ribbon groups and inspector groups are labelled regions; tab sets use `tablist`/`tab`/`tabpanel`; lists of elements are `listbox`/`option`. |
| 1.3.2, 1.3.3 Sequence, sensory characteristics | Reading order follows the DOM. Instructions never rely on shape or position alone. |
| 1.4.1 Use of colour | Results colours always come with a legend and numbers (labels, inspector, table). Invalid fields have a message as well as a red border. Flow direction uses arrows. |
| 1.4.3 Contrast (minimum) | Text tokens meet 4.5:1 on every surface in both themes (unit-tested); axe checks rendered contrast. |
| 1.4.4, 1.4.10 Resize text, reflow | Layout is in CSS pixels of tokens and survives 200 % zoom; a ribbon wider than the window scrolls. The workbench is a desktop application: reflow to 320 px is not a goal (the exception for content requiring two-dimensional layout, such as maps and data tables, applies). |
| 1.4.11 Non-text contrast | Control borders and focus rings meet 3:1; chart series colours meet 3:1 against the chart background (unit-tested). |
| 1.4.12 Text spacing | No fixed-height text containers clip when spacing grows, except virtualised list rows (24 px), which are single-line IDs and numbers. |
| 1.4.13 Content on hover or focus | Only native `title` tooltips and the chart crosshair, which does not hide content and goes on pointer leave. |
| 2.1.1 Keyboard | Every command is in the ribbon (Tab, Enter) and the command palette (Ctrl+K), most with shortcuts. Elements are chosen in the model browser or results table (arrow keys, Enter; Ctrl/Shift to toggle/add), found by ID (Ctrl+F) or by query. Nodes and links are added by typing in the Add element panel; nodes move by editing X and Y; vertices are typed in the inspector. The focused map pans with arrow keys and zooms with = and -. In the MSX editor Ctrl+Enter applies and runs. Projects save with Ctrl+Shift+S, and File › Recover is a ribbon button and palette command. |
| 2.1.2 No keyboard trap | Focus leaves every panel with Tab; the map's Escape cancels a gesture without trapping focus. |
| 2.1.4 Character key shortcuts | Single-key tool shortcuts (V, H, J, R, T, P, U, L, B, F) can be turned off (View › Single-key shortcuts), never act while typing in a field, and every one is also a ribbon button. |
| 2.4.2 Page titled | The title is the file name and "WaterStudio", with a mark when unsaved. |
| 2.4.3 Focus order | DOM order: title, ribbon, panels left to right, status bar. Panels opened by a command are brought to the front; Ctrl+F puts focus in the Find box. |
| 2.4.6, 2.4.7 Headings and labels; focus visible | Panels and groups have headings; the focus ring token is visible on every control, list rows show the active row when the list has focus. |
| 2.4.11 Focus not obscured (minimum) | No sticky content overlaps focused controls; the map's floating legends sit in its corners, away from the map's own focus outline. |
| 2.5.1, 2.5.2 Pointer gestures, cancellation | No path-based or multipoint gestures are required. Actions happen on pointer up; Escape cancels a drag. |
| 2.5.3 Label in name | Visible ribbon labels are contained in the accessible names (names come from command titles). |
| 2.5.7 Dragging movements | Window selection: the query panel. Moving nodes: X and Y in the inspector. Moving vertices: typed in the inspector; double-click adds or removes one. Panning: arrow keys or the overview map. Aligning the backdrop: click a point of the image, then where it belongs. **Exception:** resizing dock panels uses dockview's splitters, which need dragging; panels can instead be closed, reopened, floated and tabbed from the View tab. Tracked upstream. |
| 2.5.8 Target size (minimum) | Controls are at least 24 by 24 CSS pixels or spaced to meet the criterion (checked by axe). |
| 3.1.1 Language of page | `lang="en"`. |
| 3.2.1, 3.2.2 On focus, on input | Focusing never changes context; selects apply their value immediately but only to the edited option, and every change can be undone. |
| 3.3.1, 3.3.3 Error identification and suggestion | Invalid input keeps the typed text, marks the field `aria-invalid` and says what is wrong and how to fix it (`role="alert"`). Controls and rules are checked by the engine before they apply, with EPANET's message. MSX input errors list each bad line as a button that selects the line in the editor. |
| 3.3.2 Labels or instructions | Every input has a visible label; formats are given in placeholders and help (h:mm, x y). |
| 3.3.7 Redundant entry | Defaults (Options › Defaults) avoid retyping common values; Copy and Paste properties carry an element's values to others. |
| 3.3.8 Accessible authentication | No authentication; the assistant's API key is a pasteable field. |
| 4.1.2 Name, role, value | Toggles use `aria-pressed`, tabs `aria-selected`, listboxes `aria-activedescendant` and `aria-selected`. **Known issue:** dockview renders each tab's close button inside the tab element (nested interactive), excluded from axe and tracked upstream; the same panels can be closed from the View tab. |
| 4.1.3 Status messages | Run status, query and import results, copy and apply confirmations and the outcome of accepting a proposal use `role="status"`; the assistant's log and the proposal count are `aria-live`. |

## Not covered yet

- Screen-reader walkthroughs (NVDA, VoiceOver) of the main tasks; planned before 1.0.
- Forced-colours (Windows high contrast) styling of the map canvas.
