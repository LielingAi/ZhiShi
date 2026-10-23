// Package render 把 Block 画成字符串。纯函数 + 一个按键全等的缓存。
//
// 为什么要缓存：流式 turn 每秒几十次事件，View 每次都要重画整个 stream；
// 只有"正在长的那一块"真的变了，其余块的输出逐字节相同。缓存用
// (ID, version, width, expanded, live) 做键，命中率接近 100%。
package render

import (
	"fmt"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/charmbracelet/lipgloss"

	"github.com/lielingai/zhishi/tui/internal/store"
	"github.com/lielingai/zhishi/tui/internal/style"
)

// collapsedLines 折叠态显示的行数上限。工具输出动辄几百行，全铺开会把
// 对话顶出屏幕，而"看结论"才是默认需求。
const collapsedLines = 6

// CollapsedLineLimit 是折叠阈值（供 app 层给用户反馈：短于它的块按 Alt+r
// 视觉上不会有变化，必须说清楚，不能让人以为按键坏了）。
const CollapsedLineLimit = collapsedLines

// toolPeekLines 是工具输出"值得直接看"的行数上限。超过就整段折叠成零行，
// 首行摘要进块头；不超过就原样显示（短输出没必要再点一次）。
const toolPeekLines = 3

// FoldedBodyLines 是折叠态实际显示的正文字行数。draw 与 estimateHeight
// 都只能走这一个函数——两处口径一旦不同，滚动就会跳。
func FoldedBodyLines(kind store.Kind, total int) int {
	if !FoldsByDefault(kind) {
		return total
	}
	switch kind {
	case store.KindTool:
		if total > toolPeekLines {
			return 0
		}
		return total
	default:
		if limit := CollapsedLimit(kind); total > limit {
			return limit
		}
		return total
	}
}

// CollapsedLimit 返回某类块折叠态保留的行数。
//
// 工具输出压得最狠（3 行：够看到 exit 与首行输出）。6 行时一次 turn 里四个
// env_exec 就能把屏幕占满，助手的结论被挤到看不见——这正是"都是工具输出"的
// 直接来源。思考过程稍宽松（4 行），它通常按段出现、读的是走向。
func CollapsedLimit(kind store.Kind) int {
	switch kind {
	case store.KindTool:
		// 超长工具输出折叠成**零行正文**：首行摘要（env_exec 的 exit=N）
		// 并进块头，其余全靠 Alt+r。一次 turn 里十几个 env_exec 时，
		// 每个多占一行就是十几行——那就是结论被顶出屏幕的量。
		return 0
	case store.KindThinking:
		return 3
	default:
		return collapsedLines
	}
}

// FoldsByDefault 决定这类块是否受折叠约束。
//
// 只有"日志型"内容折叠：工具输出、思考过程。助手正文与用户消息是**要读的
// 文字**——把总结截成 6 行 + "Alt+r 展开"，等于让人每次都多按一次键才能看到
// 结论（这是实际反馈里最刺眼的一条）。
func FoldsByDefault(kind store.Kind) bool {
	return kind == store.KindTool || kind == store.KindThinking
}

// 风格全部取自 internal/style（唯一配色来源，主题由 ZHISHI_THEME 选）。
var (
	accentStyle = lipgloss.NewStyle().Foreground(lipgloss.Color(style.Current.Accent)).Bold(true)
	userStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color(style.Current.User)).Bold(true)
	toolStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color(style.Current.Tool)).Bold(true)
	okStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color(style.Current.OK))
	failStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color(style.Current.Fail))
	errStyle    = failStyle
	dimStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color(style.Current.Dim))
	noticeStyle = lipgloss.NewStyle().Foreground(lipgloss.Color(style.Current.Notice))
	codeStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color(style.Current.OK))
	quoteStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color(style.Current.Dim)).Italic(true)
	boldStyle   = lipgloss.NewStyle().Bold(true)

	bodyIndent   = "  "
	liveCursor   = "▌"
	blockMarker  = "▍" // 块头左侧的 gutter；当前块由 app 层换成 ▸
	foldEllipsis = "…"
)

// entry 是一条缓存记录：除了输出，还要存失效条件。
type entry struct {
	version  int
	width    int
	expanded bool
	live     bool
	out      string
}

// measure 是块高度缓存。键同 entry，但**不含 live**：live 只在块头上加一个
// 光标字符，不改行数，没必要为它重算高度。
type measure struct {
	version  int
	width    int
	expanded bool
	height   int
}

// Cache 是渲染缓存。零值不可用，用 NewCache。
type Cache struct {
	mu      sync.Mutex
	width   int // 最近一次渲染的宽度；宽度变了整体失效
	entries map[string]entry
	heights map[string]measure
	// renders 是真实渲染次数（缓存未命中）。**只给测试断言**：命中时它不该动。
	renders int
	// calls 是 Block() 的调用次数（命中也算）。虚拟滚动的断言用它对账：
	// 只有进入窗口的块才该出现在这里。
	calls int
	// estimates 是"估算高度"的实算次数。Height 命中缓存时它不该动。
	estimates int
}

// NewCache 构造缓存。
func NewCache() *Cache {
	return &Cache{entries: make(map[string]entry), heights: make(map[string]measure), width: -1}
}

// 只有 *Cache 方法，没有包级默认缓存。
//
// 早先有一份包级 defaultCache 供"一进程一个 Model"的便捷调用（探针/自检）；
// 但缓存键含 block ID，多实例共用会互相读到别人的旧输出——全局可变缓存是
// 状态泄漏的经典来源，而 M1 之后要支持多线/多窗口。所以调用方必须显式持有
// 一个 *Cache（app.Model 一个，探针自己 NewCache 一个）。

// Stream 把整串块拼成一段文本。
//
// 只给探针/小规模场景用。真实 TUI 走虚拟滚动（app 侧按窗口取块）：把 1200
// 个块全拼一遍正是 M1 要消灭的那笔开销。
func (c *Cache) Stream(blocks []store.Block, width int) string {
	if len(blocks) == 0 {
		return dimStyle.Render("  还没有内容。输入一句话开始。")
	}
	parts := make([]string, 0, len(blocks))
	for _, b := range blocks {
		parts = append(parts, c.Block(b, width, b.Live))
	}
	return strings.Join(parts, "\n")
}

// Block 渲染单个块。命中条件 = version && width && expanded && live 全等。
func (c *Cache) Block(b store.Block, width int, live bool) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls++
	return c.blockLocked(b, c.prepare(width), live)
}

// Height 返回块在给定宽度下占的行数（含块头）。
//
// 已渲染过的块返回精确值；没渲染过的**只估算，不渲染**——虚拟滚动要省的正是
// "把没上屏的块也画一遍"，为了量高度先把 1200 个块全画一遍等于白省。估算值
// 也进缓存（否则滚动时每帧都要重算一遍），块一旦进窗口就被 blockLocked
// 回填成精确值。
func (c *Cache) Height(b store.Block, width int) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	width = c.prepare(width)
	if m, ok := c.heights[b.ID]; ok &&
		m.version == b.Version && m.width == width && m.expanded == b.Expanded {
		return m.height
	}
	c.estimates++
	h := estimateHeight(b, width)
	c.heights[b.ID] = measure{version: b.Version, width: width, expanded: b.Expanded, height: h}
	return h
}

// Renders 返回真实渲染次数（供测试断言缓存命中）。
func (c *Cache) Renders() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.renders
}

// Calls 返回 Block() 的调用次数（含命中）。虚拟滚动的测试用它证明
// "没进窗口的块根本没被问过"。
func (c *Cache) Calls() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.calls
}

// Estimates 返回高度估算的实算次数（供测试断言高度缓存命中）。
func (c *Cache) Estimates() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.estimates
}

// prepare 做宽度夹取与"宽度变化整体失效"。必须在持锁状态下调用。
func (c *Cache) prepare(width int) int {
	// 太窄时折行会把内容切碎；给个下界，避免极端 resize 时崩画。
	if width < 8 {
		width = 8
	}
	if c.width != width {
		// 宽度变化 → 换行结果全部作废，整体失效（高度同理）。
		c.entries = make(map[string]entry)
		c.heights = make(map[string]measure)
		c.width = width
	}
	return width
}

func (c *Cache) blockLocked(b store.Block, width int, live bool) string {
	if e, ok := c.entries[b.ID]; ok &&
		e.version == b.Version && e.width == width && e.expanded == b.Expanded && e.live == live {
		return e.out
	}
	out := c.draw(b, width, live)
	c.renders++
	c.entries[b.ID] = entry{version: b.Version, width: width, expanded: b.Expanded, live: live, out: out}
	// 顺手回填精确高度：这一帧已经把块画出来了，再量一次是白量。
	c.heights[b.ID] = measure{
		version:  b.Version,
		width:    width,
		expanded: b.Expanded,
		height:   1 + strings.Count(out, "\n"),
	}
	return out
}

// estimateHeight 按正文长度估行数，不排版、不加样式。
//
// 折行宽度与 draw 里一致（扣掉正文缩进），所以平时误差只有"制表符/宽字符
// 边界"那一两行。
func estimateHeight(b store.Block, width int) int {
	wrapWidth := width - len(bodyIndent)
	if wrapWidth < 1 {
		wrapWidth = 1
	}
	h := 2 // 块前留白 + 块头
	if b.Kind == store.KindTool {
		h = 1 // 工具块之间不留空行：一屏十几个调用，空行是纯浪费
	}
	if b.Body == "" {
		return h
	}
	lines := 0
	for _, para := range strings.Split(b.Body, "\n") {
		if para == "" {
			lines++
			continue
		}
		n := (lipgloss.Width(para) + wrapWidth - 1) / wrapWidth
		if n < 1 {
			n = 1
		}
		lines += n
	}
	if !b.Expanded {
		// 折叠提示挂在块头，不额外占行——估算与 draw 必须同口径。
		lines = FoldedBodyLines(b.Kind, lines)
	}
	return h + lines
}

// draw 是真渲染路径：无缓存、无副作用。
func (c *Cache) draw(b store.Block, width int, live bool) string {
	var sb strings.Builder
	// 块前留一行白：没有间距时整屏是一堵墙，分不清哪里开始是新消息。
	// 高度估算里同样按 2 行起算（gap + 块头），两边必须同步。
	lines := wrapText(b.Body, width-len(bodyIndent))
	hidden := 0
	if !b.Expanded {
		if show := FoldedBodyLines(b.Kind, len(lines)); show < len(lines) {
			hidden = len(lines) - show
			lines = lines[:show]
		}
	}

	if b.Kind != store.KindTool {
		// 工具块之间不留空行；其余块前留一白，区分消息。
		sb.WriteString("\n")
	}
	// 折叠提示挂在块头上，不单独占一行：一次 turn 里五六个工具块各多一行，
	// 加起来就是结论被挤出屏幕的那几行。
	sb.WriteString(head(b, live, hidden, width))
	if b.Body == "" {
		return sb.String()
	}
	sb.WriteString("\n")
	inCode := false
	for _, ln := range lines {
		sb.WriteString(bodyIndent)
		if b.Kind == store.KindAssistant {
			sb.WriteString(styleMarkdownLine(ln, &inCode))
		} else {
			sb.WriteString(styleBody(b, ln))
		}
		sb.WriteString("\n")
	}
	return strings.TrimRight(sb.String(), "\n")
}

// head 是块头。设计上刻意简单：
//
//	▍ ● <tool>  ✓/✗  <dur>  还有 N 行（Alt+r）
//
// 工具只有 ok/fail 二态（真实退出码不到前端，见 store.Block 注释），
// 所以不印 exit。折叠提示也挂在这一行，不额外占行。
func head(b store.Block, live bool, hidden, width int) string {
	cursor := ""
	if live {
		cursor = liveCursor
	}
	gutter := dimStyle.Render(blockMarker)
	fold := ""
	if hidden > 0 {
		// 折叠后正文不占行，块头得自己交代"这条干了什么"：首行摘要 +
		// 还剩多少行。摘要按剩余宽度截断，绝不能让块头撑破当前宽度。
		suffix := fmt.Sprintf("%s 还有 %d 行（Alt+r）", foldEllipsis, hidden)
		preview := firstLinePreview(b.Body)
		if preview != "" {
			avail := width - 24 - len([]rune(suffix))
			if avail > 8 {
				preview = truncateRunes(preview, avail)
				fold = "  " + dimStyle.Render(preview)
			}
		}
		fold += "  " + dimStyle.Render(suffix)
	}
	switch b.Kind {
	case store.KindTool:
		label := b.Title
		if label == "" {
			label = "tool"
		}
		dot := okStyle.Render("●")
		mark := okStyle.Render("✓")
		if b.Failed {
			dot = failStyle.Render("●")
			mark = failStyle.Render("✗")
		}
		line := fmt.Sprintf("%s %s %s  %s  %s",
			gutter, dot, toolStyle.Render(label), mark, dimStyle.Render(duration(b.Duration)))
		return line + fold + cursor
	case store.KindUser:
		return fmt.Sprintf("%s %s", gutter, userStyle.Render("› you")) + cursor
	case store.KindAssistant:
		label := "zhishi"
		if b.Title != "" {
			label = b.Title
		}
		return fmt.Sprintf("%s %s", gutter, accentStyle.Render("✻ "+label)) + cursor
	case store.KindThinking:
		return fmt.Sprintf("%s %s", gutter, dimStyle.Render("∴ thinking")) + fold + cursor
	case store.KindError:
		return fmt.Sprintf("%s %s", gutter, failStyle.Render("✗ error")) + cursor
	default:
		return fmt.Sprintf("%s %s", gutter, noticeStyle.Render("• note")) + cursor
	}
}

// firstLinePreview 取正文首行做块头摘要（env_exec 就是 exit=N）。
func firstLinePreview(body string) string {
	line, _, _ := strings.Cut(body, "\n")
	return strings.TrimSpace(line)
}

// truncateRunes 按"显示宽度≈1 的字符"截断；全角字符会略宽，调用方留了余量。
func truncateRunes(s string, limit int) string {
	if limit <= 0 {
		return ""
	}
	r := []rune(s)
	if len(r) <= limit {
		return s
	}
	return string(r[:limit-1]) + foldEllipsis
}

// 轻量 markdown：只做到"扫一眼能看出结构"，不做完整解析。
//
// 三条硬约束（否则会和虚拟滚动/折行打架）：
//  1. 不改行数——需要多行结构的语法（表格、多行代码围栏）一律按单行处理；
//  2. 不变宽——只允许**去掉**标记（`#`、`**`、反引号），不允许插入占宽字符；
//  3. 不加状态——围栏代码块的开合是逐行扫出来的，折叠截断后可能从中途开始，
//     这时按"非代码"渲染，宁可少上色也不要把整段染色。

var (
	reInlineCode = regexp.MustCompile("`([^`]+)`")
	reInlineBold = regexp.MustCompile(`\*\*([^*]+)\*\*`)
)

func styleMarkdownLine(line string, inCode *bool) string {
	trimmed := strings.TrimLeft(line, " \t")
	indent := line[:len(line)-len(trimmed)]

	if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
		*inCode = !*inCode
		return dimStyle.Render(line)
	}
	if *inCode {
		return indent + codeStyle.Render(trimmed)
	}
	if level := headingLevel(trimmed); level > 0 {
		return indent + accentStyle.Render(strings.TrimSpace(trimmed[level:]))
	}
	if strings.HasPrefix(trimmed, "- ") || strings.HasPrefix(trimmed, "* ") {
		return indent + "• " + inlineMarkdown(trimmed[2:])
	}
	if strings.HasPrefix(trimmed, "> ") {
		return indent + quoteStyle.Render("│ "+trimmed[2:])
	}
	return indent + inlineMarkdown(trimmed)
}

// headingLevel 返回 `#` 的个数（后面必须跟空格）；不是标题返回 0。
func headingLevel(s string) int {
	n := 0
	for n < len(s) && s[n] == '#' {
		n++
	}
	if n == 0 || n > 6 || n >= len(s) || s[n] != ' ' {
		return 0
	}
	return n + 1 // 连空格一起吃掉
}

func inlineMarkdown(s string) string {
	if strings.ContainsRune(s, '`') {
		s = reInlineCode.ReplaceAllString(s, codeStyle.Render("$1"))
	}
	if strings.Contains(s, "**") {
		s = reInlineBold.ReplaceAllString(s, boldStyle.Render("$1"))
	}
	return s
}

func styleBody(b store.Block, line string) string {
	switch {
	case b.Kind == store.KindError:
		return errStyle.Render(line)
	case b.Kind == store.KindThinking:
		return dimStyle.Render(line)
	default:
		return line
	}
}

func duration(d time.Duration) string {
	switch {
	case d <= 0:
		return "-"
	case d < time.Second:
		return fmt.Sprintf("%dms", d.Milliseconds())
	default:
		return fmt.Sprintf("%.1fs", d.Seconds())
	}
}

// wrapText 按显示宽度折行。
//
// 不用 lipgloss 的 Width：它只补齐不折行；也不引 x/text——宽度用
// lipgloss.Width 逐 rune 累加（它内部走 x/ansi），中文/emoji 不会算错。
func wrapText(s string, width int) []string {
	if width < 1 {
		width = 1
	}
	var out []string
	for _, para := range strings.Split(s, "\n") {
		if para == "" {
			out = append(out, "")
			continue
		}
		var line strings.Builder
		w := 0
		for _, r := range para {
			rw := lipgloss.Width(string(r))
			if w+rw > width {
				out = append(out, line.String())
				line.Reset()
				w = 0
			}
			line.WriteRune(r)
			w += rw
		}
		out = append(out, line.String())
	}
	return out
}
