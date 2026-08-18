// Generative UI design guideline content — AI generates interactive HTML
// widgets inline in chat by emitting <generative-ui-widget> tags in its text
// response. The frontend parses tags from the chat:message-chunk stream and
// renders the inner HTML in a sandboxed iframe.
//
// Loader contract:
//   Both runtimes (builtin Claude Agent SDK and external CLIs) reach this
//   content through `zhishi widget readme <module>` invoked via their shell
//   tool. The CLI command POSTs to `readme/widget` (admin-api.ts), which calls
//   `buildReadMeContent()` below to assemble the modules.
//
// Why text tags instead of MCP tool_use:
//   Agent SDK buffers MCP tool input_json_delta until tool execution completes,
//   preventing real-time streaming. Text output (chat:message-chunk) streams
//   token-by-token, so widget HTML can render progressively as the AI writes.

// This file is content-only — pure string ops, no SDK / zod imports. It's
// statically imported by admin-api.ts (handleReadme) which is on the hot path.

// ===================================================================
// Design Guideline Sections (loaded on-demand by `zhishi widget readme`)
// ===================================================================

const SECTION_CORE = `# Widget Design System — Core

## Philosophy
Widgets render inline in the chat message flow. They must feel like a natural part of the conversation — not a foreign embed.
- **Seamless**: background transparent, typography matches surrounding text
- **Flat**: no gradients, mesh backgrounds, noise textures, drop shadows, blur, glow
- **Compact**: show essential content inline, explain the rest in your text response
- **Text goes in response, visuals go in \`<generative-ui-widget>\` tags**: all explanatory text must be OUTSIDE the widget tags

## Streaming rules
HTML streams token by token. Structure for progressive rendering:
- <style> first (short, ≤15 lines) — so elements are styled as they appear
- Content HTML next — visual elements render progressively
- <script> last — runs only after streaming completes
- Prefer inline style="..." over <style> blocks when possible
- SVG: <defs> (markers) first, then visual elements immediately

## Hard constraints
- widget_code = self-contained HTML fragment. NO <!DOCTYPE>, <html>, <head>, <body>
- 2 font weights only: 400 regular, 600 semibold. Never 700.
- No gradients, drop shadows, blur, glow (they flash during streaming DOM diffs)
- No HTML comments, CSS comments (waste tokens, break streaming)
- No font-size below 11px
- No emoji — use CSS shapes or SVG paths
- No position:fixed (iframe viewport auto-sizes to content height)
- No tabs, carousels, display:none during streaming
- No fetch() / XMLHttpRequest / WebSocket — all data must be inline in widget_code (network is blocked by CSP)
- Responsive: percentage widths, viewBox for SVG. Min width 300px.
- Match the conversation language for all text content.

## Pre-styled elements & utility classes
The widget sandbox provides pre-styled form elements and layout utilities:
- Form elements (input, select, button, range slider, textarea) are automatically styled — write bare HTML tags
- Button with class "primary" gets accent color: \`<button class="primary">Submit</button>\`
- Layout classes available: .flex, .flex-col, .grid, .grid-2, .grid-3, .grid-4, .gap-2/3/4/6, .p-2/3/4, .w-full, .text-center, .rounded, .rounded-lg, .border, .bg-elevated, .bg-inset, .text-muted, .text-secondary, .text-accent, .stat-card, .stat-value, .stat-label
- Use these classes freely — they are scoped to the widget iframe

## CSS variables (auto light/dark — always use these, never hardcode colors)
EXCEPTION: Chart.js <canvas> cannot use CSS variables — use hex from color palette instead.
### Layout
- --widget-text: primary text
- --widget-text-secondary: secondary/muted text
- --widget-text-muted: subtle/hint text
- --widget-bg: main background (transparent in widget context)
- --widget-bg-elevated: card/surface background
- --widget-bg-inset: inset/input background
- --widget-border: default border (10% opacity)
- --widget-border-strong: hover/emphasis border (18% opacity)
- --widget-accent: warm accent (buttons, links, highlights)
- --widget-accent-subtle: 8% accent background
- --widget-radius: default border radius (10px)

### Semantic
- --widget-success / --widget-success-bg
- --widget-error / --widget-error-bg
- --widget-warning / --widget-warning-bg
- --widget-info / --widget-info-bg

## CDN libraries (CSP-enforced allowlist)
- Chart.js: https://cdn.jsdelivr.net/npm/chart.js
- D3.js: https://cdn.jsdelivr.net/npm/d3@7
- Mermaid: https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js
- Lucide: https://unpkg.com/lucide@latest
- Any package from: cdn.jsdelivr.net, cdnjs.cloudflare.com, unpkg.com, esm.sh
- Web fonts: Google Fonts only — <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=..."> (e.g. 'Noto Serif SC', 'ZCOOL XiaoWei', 'Ma Shan Zheng'). Request ONLY weights 400 & 600 (per the font-weight rule). Always include a system fallback in font-family so it degrades gracefully offline.`;

const SECTION_PALETTE = `# Color Palette — 7 ramps, 7 stops each

Colors encode meaning, not sequence. Don't cycle like a rainbow.
- 2-3 ramps max per widget
- Text on colored backgrounds: use 800/900 stop from same ramp, never pure black
- Light mode fills: 50 stop. Strokes/borders: 400-600 stop. Titles: 800 stop.
- Subtle backgrounds: use the 50 stop at 60% opacity for gentler tones.

| Ramp    | 50      | 100     | 300     | 500     | 700     | 800     | 900     |
|---------|---------|---------|---------|---------|---------|---------|---------|
| Warm    | #faf0e6 | #f0d9bf | #d4a574 | #c26d3a | #8b4513 | #6b3410 | #4a2409 |
| Teal    | #e6f5f0 | #b3e0cf | #5dbf9e | #2e8b6e | #1a6b50 | #0f5040 | #04342c |
| Coral   | #faeae5 | #f0bfad | #e08060 | #c25030 | #8b3018 | #6b2010 | #4a150a |
| Sage    | #f0f2ec | #d4dbc8 | #a3b08a | #6f8660 | #4a6040 | #3a4a30 | #2a3520 |
| Stone   | #f2f0eb | #d6d2c9 | #ada599 | #857d74 | #5f5a54 | #454240 | #2e2c2a |
| Sky     | #e8f1fa | #b8d4f0 | #70a8d8 | #3a7ab8 | #1a5a90 | #0e4070 | #052a4a |
| Amber   | #faf0dc | #f0d68a | #daa830 | #b88018 | #8a5a0a | #6a4005 | #4a2a02 |

### Assignment rules
- Primary data: Warm or Teal (the app's signature colors)
- Positive/growth: Teal or Sage
- Negative/decline: Coral
- Neutral/reference: Stone
- Informational: Sky
- Warning/attention: Amber
- Never use more than 3 ramps in a single widget`;

const SECTION_CHART = `# Charts — Chart.js patterns

## CRITICAL: Canvas cannot use CSS variables — use hex from color palette
Chart.js renders on <canvas>, which does NOT support CSS variables. Always use hex colors directly.

## Complete working template
Scripts run in order and a CDN \`<script src>\` finishes loading before the next
script runs, so just load the library, then use it — no onload/init dance.
\`\`\`html
<div style="position:relative;width:100%;height:300px"><canvas id="c"></canvas></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
<script>
var chart = new Chart(document.getElementById('c'),{
  type:'line',
  data:{labels:['Jan','Feb','Mar','Apr','May'],datasets:[{
    data:[30,45,28,50,42],
    borderColor:'#c26d3a',backgroundColor:'rgba(194,109,58,0.1)',fill:true,tension:0.3
  }]},
  options:{responsive:true,maintainAspectRatio:false,
    plugins:{legend:{display:false}},
    scales:{y:{grid:{color:'rgba(0,0,0,0.06)'}},x:{grid:{display:false}}}}
});
</script>
\`\`\`

## Color hex values for Chart.js (from palette)
- Warm: borderColor '#c26d3a', bg 'rgba(194,109,58,0.1)'
- Teal: borderColor '#2e8b6e', bg 'rgba(46,139,110,0.1)'
- Coral: borderColor '#c25030', bg 'rgba(194,80,48,0.1)'
- Sky: borderColor '#3a7ab8', bg 'rgba(58,122,184,0.1)'
- Amber: borderColor '#b88018', bg 'rgba(184,128,24,0.1)'
- Stone (neutral): borderColor '#857d74', bg 'rgba(133,125,116,0.1)'

## Chart rules
- Height on wrapper div, responsive:true, maintainAspectRatio:false
- borderRadius:6 for bars, tension:0.3 for smooth lines
- Load the CDN script, then \`new Chart(...)\` in the next \`<script>\` — the library is guaranteed loaded by then
- Multiple charts: unique canvas IDs (c1, c2...)
- Round every displayed number

## Interactive controls MUST update chart
Controls that modify data MUST call chart.update() after changes:
\`\`\`js
function update(){
  var v=+document.getElementById('slider').value;
  chart.data.datasets[0].data = baseData.map(d => Math.round(d * v / 50));
  document.getElementById('display').textContent = v;
  chart.update();
}
\`\`\`

## Metric dashboard pattern
Stat cards above chart. Use .stat-card, .stat-value, .stat-label classes (pre-styled).
\`\`\`html
<div class="grid grid-3 gap-3 mb-4">
  <div class="stat-card"><div class="stat-label">Total</div><div class="stat-value" id="total">¥0</div></div>
  ...
</div>
\`\`\`

## Number formatting
- Use Intl.NumberFormat for locale-aware formatting
- Abbreviate large numbers: 1,234,567 → 1.2M`;

const SECTION_DIAGRAM = `# Diagrams — SVG patterns

## SVG setup
\`<svg width="100%" viewBox="0 0 680 H">\` — 680px fixed width. Adjust H to fit content + 40px buffer.
Font: system-ui. Use <defs> for markers. One SVG per widget.

## Required arrow marker
\`<defs><marker id="a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>\`

## Node styling
- Fill: palette 50 stop. Stroke: palette 500 stop, 1.5px. rx=12 for rounded corners
- Title: 13px, 600 weight, palette 800 stop. Subtitle: 11px, palette 700 stop
- Node width >= (chars × 8 + 40) px. Max 5 words per subtitle

## Connectors
- Stroke: 1.5px, palette 300 stop. Curved paths (cubic bezier) preferred
- marker-end="url(#a)" for arrows. Labels: 10px, palette 600 stop

## Diagram type catalog — pick the best fit

| Type | When to use | Key pattern |
|------|-------------|-------------|
| Flowchart | "process", "steps", "flow" | Nodes left→right or top→bottom, straight arrows |
| Timeline | "history", "evolution", "phases" | Horizontal axis line with event markers, stagger labels above/below |
| Hierarchy | "architecture", "tree", "org chart" | Root at top, children below with vertical arrows |
| Layered stack | "layers", "stack", "architecture" | Full-width horizontal bands, items inside each band |
| Cycle | "loop", "feedback", "lifecycle" | 3-5 nodes in circular arrangement with curved arrows |
| Comparison | "vs", "compare", "side by side" | Two parallel groups with matching rows |
| Quadrant | "matrix", "2x2", "classify" | Two axes, four colored quadrant rects |

## Complexity budget
- Max 4 nodes per row, max 5 tiers
- 2-3 color ramps per diagram
- Verify no arrow crosses unrelated nodes

## Multi-widget narratives
For complex topics, output MULTIPLE widgets of DIFFERENT types interleaved with text:
1. Overview diagram (hierarchy/flowchart)
2. Text explaining one aspect
3. Detail widget (cycle/chart for that aspect)
4. Text with quantitative insight
5. Interactive Chart.js with controls`;

const SECTION_INTERACTIVE = `# Interactive — UI component patterns

## Component tokens
- Card: var(--widget-bg-elevated), 1px solid var(--widget-border), var(--widget-radius) border-radius, 16px padding
- Button primary: var(--widget-accent) bg, white text, 8px radius, 8px 16px padding, 13px 600 weight
- Button secondary: var(--widget-bg-inset) bg, var(--widget-text) text
- Input: var(--widget-bg) bg, 1px solid var(--widget-border), 8px radius, 8px 12px padding, 13px
- Input focus: border-color var(--widget-accent)
- Slider: accent-color var(--widget-accent) (native range input)
- Toggle: 40x22px, var(--widget-border) off, var(--widget-accent) on, white knob
- Badge/tag: var(--widget-bg-inset) bg, var(--widget-text-secondary) text, 4px 10px padding, 9999px radius, 11px

## Interactive explainer pattern
Use when: "explain how X works", "teach me about Y", "show me how Z works"
- Controls (sliders, inputs, toggles) at top or left
- Visualization (chart, SVG, canvas) reacts to controls in real-time
- Key metric display: large number with label, updates live
- State management: use a plain object and a render() function. No framework needed.

## Comparison layout
Use when: "compare X vs Y", "help me choose", "pricing comparison"
- Side-by-side card grid: grid-template-columns: repeat(auto-fit, minmax(200px, 1fr))
- Each card: var(--widget-bg-elevated), matching height, 16px padding
- Highlight recommended: 2px solid var(--widget-accent) border
- Feature rows: alternating var(--widget-bg) / transparent

## Data record layout
Use when: "show me the contact card", "create a receipt", "display the record"
- Single card, centered, max-width 400px
- Header: colored stripe using palette 500 stop, white text, 12px 16px padding
- Field rows: label (11px, var(--widget-text-muted)) + value (13px, var(--widget-text)), 8px row gap`;

const SECTION_ART = `# Art and illustration

## When to use
- "Draw", "illustrate", "create a visual of"
- Abstract concepts that benefit from visual metaphor
- Decorative header images for documents

## Rules
- Pure SVG only, no external images
- Use palette colors, not arbitrary hex
- Minimum viable detail — suggest rather than depict
- Ensure all shapes have accessible contrast against background
- No text-heavy illustrations (text goes in the response, not the SVG)`;

// Module → sections mapping (deduplicated when multiple modules requested)
const MODULE_SECTIONS: Record<string, string[]> = {
  chart:       ['CORE', 'PALETTE', 'CHART'],
  diagram:     ['CORE', 'PALETTE', 'DIAGRAM'],
  interactive: ['CORE', 'PALETTE', 'INTERACTIVE'],
  dashboard:   ['CORE', 'PALETTE', 'CHART', 'INTERACTIVE'],
  art:         ['CORE', 'PALETTE', 'ART'],
};

const ALL_SECTIONS: Record<string, string> = {
  CORE: SECTION_CORE,
  PALETTE: SECTION_PALETTE,
  CHART: SECTION_CHART,
  DIAGRAM: SECTION_DIAGRAM,
  INTERACTIVE: SECTION_INTERACTIVE,
  ART: SECTION_ART,
};

export function buildReadMeContent(modules: string[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const mod of modules) {
    const sectionKeys = MODULE_SECTIONS[mod];
    if (!sectionKeys) continue;
    for (const key of sectionKeys) {
      if (!seen.has(key)) {
        seen.add(key);
        parts.push(ALL_SECTIONS[key]);
      }
    }
  }
  if (parts.length === 0) {
    return 'Unknown module(s). Available: chart, diagram, interactive, dashboard, art.';
  }
  // Always prepend output format instructions
  return SECTION_OUTPUT_FORMAT + '\n\n---\n\n' + parts.join('\n\n---\n\n');
}

// ===================================================================
// Output Format Section (prepended to all `zhishi widget readme` responses)
// Teaches the AI how to output <generative-ui-widget> tags. Trigger judgment
// (when to widget at all) lives in the system prompt — see SECTION_WIDGET in
// system-prompt-cli-tools.ts — not here.
// ===================================================================

const SECTION_OUTPUT_FORMAT = `# How to Output Widgets

## Output format
To create a widget, output a \`<generative-ui-widget>\` tag directly in your text response.
The frontend will detect the tag, extract the HTML, and render it in a sandboxed iframe inline in the conversation.

\`\`\`
Your explanatory text here...

<generative-ui-widget>
<style>
  .widget { font-family: system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; color: var(--widget-text); padding: 16px; }
</style>
<div class="widget">
  <!-- SVG, canvas, or HTML content -->
</div>
<script>
  // Interactive logic. Runs after all HTML is rendered.
</script>
</generative-ui-widget>

More explanatory text here...
\`\`\`

## Rules
- A widget is a BLOCK on its own. Put the opening \`<generative-ui-widget>\` tag on its own line with a blank line before and after. NEVER drop it inside a markdown table, list, or an emphasis/code span (\`**…**\`, \`\`\` \`…\` \`\`\`) — splitting a markdown structure across the widget leaves both halves malformed and they render as raw \`**\`/\`|\` symbols.
- The parser also accepts a fully-closed widget mid-line, but a bare mid-line mention with no closing tag is treated as literal prose.
- Content inside is a self-contained HTML fragment — NO <!DOCTYPE>, <html>, <head>, <body>
- Structure for streaming: <style> first (short) → content HTML → <script> last
- All explanatory text goes OUTSIDE the <generative-ui-widget> tags (in normal markdown)
- You can output multiple widgets in a single response — interleave with text (each pair of tags is one self-contained widget, rendered in its own sandbox)
- Each widget should be focused and ≤ 4000 chars. Split complex topics into multiple widgets.
- CDN script loading: load the \`<script src>\`, then use the library in the next \`<script>\` — scripts run in order, so the library is loaded by then. No onload/init dance needed.
- Pre-styled form elements: bare <input>, <button>, <select>, <textarea> are automatically styled. Use class="primary" for accent buttons.
- Layout utility classes available: .flex, .grid, .grid-2, .grid-3, .gap-3, .gap-4, .p-3, .p-4, .rounded, .rounded-lg, .border, .bg-elevated, .stat-card, .stat-value, .stat-label

## Format-only fallbacks
- ER / database schema → Mermaid in a fenced code block (the chat renderer handles it)
- Static data dumps → markdown table
- Code → fenced code block`;
