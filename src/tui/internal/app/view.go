package app

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"

	"github.com/lielingai/zhishi/tui/internal/render"
	"github.com/lielingai/zhishi/tui/internal/store"
	"github.com/lielingai/zhishi/tui/internal/style"
)

// blockSpan 是"块 → 渲染后的行区间"，虚拟滚动的定位与鼠标命中都靠它。
type blockSpan struct {
	id         string
	start, end int
}

// growBlocks 是自校正时往上多要的块数（约 24 块的量级，够补几十行偏差）。
const growBlocks = 24

// View 是纯函数：只读 Model，不写权威状态、不发 Cmd。
//
// 布局契约（用 JoinVertical 拼，纵向四段）：
//
//	header   1 行   地址 / 会话态 / 模型 / context 用量
//	stream   虚拟滚动窗口（只渲染可见块 + 前后各 5 块缓冲）
//	menu     0–8 行  输入 `/` 时的命令候选（不进覆盖层栈，不抢焦点）
//	input    1–6 行 textarea
//	status   2 行   状态行 + 提示/键位
//
// 覆盖层不参与 Join：它是"最后叠绘"的一层，盖在成品画面之上。
func (m Model) View() string {
	height := m.StreamHeight()
	stream, rows, maxScroll, vis := m.renderStream(height)
	m.publishFrame(rows, maxScroll, vis)

	parts := []string{m.viewHeader(), m.viewHeaderRule(), stream}
	if menu := m.viewSlashMenu(); menu != "" {
		parts = append(parts, menu)
	}
	if at := m.viewAtMenu(); at != "" {
		parts = append(parts, at)
	}
	parts = append(parts, m.viewInput(), m.viewStatus())
	out := lipgloss.JoinVertical(lipgloss.Left, parts...)
	if viewMargin > 0 {
		// 整体左缩进：内容贴着终端边框会显得被挤住。逐行加，宽度在各自的
		// 构造函数里已经按 contentWidth() 扣过这一列。
		pad := strings.Repeat(" ", viewMargin)
		lines := strings.Split(out, "\n")
		for i := range lines {
			lines[i] = pad + lines[i]
		}
		out = strings.Join(lines, "\n")
	}
	return m.drawOverlay(out)
}

// publishFrame 把这一帧的投影写到 m.Frame。
//
// 这是 View 里唯一的写入，且写的是**派生数据**（下一帧整份重建）：权威状态
// （块表、ScrollLines）一个字都没动，所以"同输入 → 同输出"仍然成立。之所以
// 允许 View 写它：鼠标事件只给终端坐标，不给块 ID，必须靠上一帧的投影翻译。
func (m Model) publishFrame(rows []clickRow, maxScroll int, vis []string) {
	if m.Frame == nil {
		return
	}
	m.Frame.width = m.Width
	m.Frame.height = m.Height
	m.Frame.streamTop = 1 // header 恒定占一行
	m.Frame.rows = rows
	m.Frame.maxScroll = maxScroll
	// 行数补齐到视口高度，鼠标坐标才能直接当下标用。
	lines := make([]string, len(rows))
	copy(lines, vis)
	m.Frame.lines = lines
}

// viewMargin 是内容整体左缩进（列）。1 列就够把内容与终端边框拉开距离。
const viewMargin = 1

// contentWidth 是留给内容的列数（已扣左侧缩进）。
func (m Model) contentWidth() int {
	w := m.Width - viewMargin
	if w < 8 {
		w = 8
	}
	return w
}

// VisibleWidth 是 stream 区可用的列数（左侧缩进 + 右侧留 1 列空白）。
func (m Model) VisibleWidth() int {
	w := m.contentWidth() - 1
	if w < 8 {
		w = 8
	}
	return w
}

// renderStream 只渲染可见窗口。
//
// 算法（strix 的 eventSpan 思路 + 高度缓存）：
//  1. 从内容底部往上跳过 scroll 行，定位视口**底边**落在哪个块的哪一行；
//  2. 再从那里往上走 height 行，定位**顶边**落在哪个块；
//  3. 上下各多渲染 streamBufferBlocks 块当缓冲，渲染完用精确行数切窗口；
//  4. 估算把窗口估小了（切不到足够的行）就往上多要 growBlocks 块重渲染一次。
//     最多两轮——差几行由切片兜住，下一帧高度已经是精确值，不会无限循环。
func (m Model) renderStream(height int) (string, []clickRow, int, []string) {
	blocks := m.VisibleBlocks()
	width := m.VisibleWidth()
	if len(blocks) == 0 {
		return padLines([]string{
				dimStyle.Render("  还没有内容。输入一句话开始。"),
				"",
				dimStyle.Render("  第一次用？F1 帮助（按「想做什么」分组）· Ctrl+K 动作中心 · Ctrl+F 搜索"),
				dimStyle.Render("  面板：Alt+e 环境 · Alt+l 研究线 · Alt+t 任务 · Alt+a 研究档案 · Alt+w 自动循环"),
			}, height),
			make([]clickRow, height), 0, make([]string, height)
	}

	scroll := m.ScrollLines
	bottom, skip, total := locateBottom(m.Cache, blocks, width, scroll)
	maxScroll := -1
	if total >= 0 {
		// 走到了顶：总高度是精确的，可以算出真实可滚量。
		maxScroll = total - height
		if maxScroll < 0 {
			maxScroll = 0
		}
		if scroll > maxScroll {
			// 翻过头了：本帧按贴顶渲染（ScrollLines 由 Update 钳回，不在这里改）。
			bottom, skip, _ = locateBottom(m.Cache, blocks, width, maxScroll)
		}
	}
	top := locateTopFrom(m.Cache, blocks, width, bottom, skip, height)

	var lines []string
	var spans []blockSpan
	var vis []string
	var rows []clickRow
	for attempt := 0; attempt < 2; attempt++ {
		r0 := top - streamBufferBlocks
		if r0 < 0 {
			r0 = 0
		}
		r1 := bottom + 1 + streamBufferBlocks
		if r1 > len(blocks) {
			r1 = len(blocks)
		}
		lines, spans = m.renderRange(blocks, width, r0, r1)
		vis, rows = selectRendered(lines, spans, bottom-r0, skip, height)
		if len(vis) >= height || r0 == 0 {
			break
		}
		top -= growBlocks
		if top < 0 {
			top = 0
		}
	}
	return padLines(vis, height), padRows(rows, height), maxScroll, vis
}

// locateBottom 从内容底部往上跳过 scroll 行，返回视口底边所在块与被压掉的
// 行数（该块有多少行落在视口下方）。
//
// 第三个返回值是总高度：只有一路走到第一块（滚到顶）才算得出来，否则 -1。
func locateBottom(c *render.Cache, blocks []store.Block, width, scroll int) (bottom, skip, total int) {
	skip = scroll
	acc := 0
	for i := len(blocks) - 1; i >= 0; i-- {
		h := c.Height(blocks[i], width)
		if skip < h {
			return i, skip, -1
		}
		skip -= h
		acc += h
	}
	return 0, 0, acc
}

// locateTopFrom 从底边往上走 height 行，返回视口顶边所在块。
func locateTopFrom(c *render.Cache, blocks []store.Block, width, bottom, skip, height int) int {
	acc := -skip
	top := bottom
	for top >= 0 {
		acc += c.Height(blocks[top], width)
		if acc >= height {
			break
		}
		top--
	}
	if top < 0 {
		top = 0
	}
	return top
}

// renderRange 渲染 blocks[r0:r1) 并记下每块占的行区间。
func (m Model) renderRange(blocks []store.Block, width, r0, r1 int) ([]string, []blockSpan) {
	lines := make([]string, 0, 256)
	spans := make([]blockSpan, 0, r1-r0)
	cursorID := m.cursorBlockID(blocks)
	for i := r0; i < r1; i++ {
		b := blocks[i]
		out := m.Cache.Block(b, width, b.Live)
		if b.ID == cursorID {
			out = markCursorBlock(out)
		}
		start := len(lines)
		lines = append(lines, strings.Split(out, "\n")...)
		spans = append(spans, blockSpan{id: b.ID, start: start, end: len(lines)})
	}
	return lines, spans
}

// cursorBlockID 返回块级操作（Alt+r / Alt+y / Alt+o）的目标块 ID。
// 光标没被显式移动过时取最新一块，与 expandTarget 同口径。
func (m Model) cursorBlockID(blocks []store.Block) string {
	if len(blocks) == 0 {
		return ""
	}
	i := m.effectiveCursor()
	if i < 0 || i >= len(blocks) {
		return ""
	}
	return blocks[i].ID
}

// markCursorBlock 把块头标记 ▍ 换成 ▸，让"当前块"在画面上看得见。
// 只改渲染结果的副本，缓存里仍是未标记版本（按 Version 失效的契约不变）。
func markCursorBlock(out string) string {
	idx := strings.Index(out, "▍")
	if idx < 0 {
		return out
	}
	return out[:idx] + "▸" + out[idx+len("▍"):]
}

// selectRendered 按视口底边位置从已渲染的行里切出 stream 区，并给出每行的归属。
//
// 返回的切片可能短于 height：那说明渲染范围的上方不够（估算偏小），
// 调用方会往上加块重试。
func selectRendered(lines []string, spans []blockSpan, bottomIdx, skip, height int) ([]string, []clickRow) {
	if bottomIdx < 0 || bottomIdx >= len(spans) {
		return nil, nil
	}
	end := spans[bottomIdx].end - skip
	if end > len(lines) {
		end = len(lines)
	}
	if end < 0 {
		end = 0
	}
	start := end - height
	if start < 0 {
		start = 0
	}
	shown := lines[start:end]

	vis := make([]string, len(shown))
	rows := make([]clickRow, len(shown))
	si := 0
	for i, ln := range shown {
		vis[i] = ln
		abs := start + i
		for si < len(spans) && spans[si].end <= abs {
			si++
		}
		if si < len(spans) && abs >= spans[si].start && abs < spans[si].end {
			rows[i] = clickRow{ID: spans[si].id, Head: abs == spans[si].start}
		}
	}
	return vis, rows
}

// padLines 把行数补到 n（内容不足时下方留白，与滚动语义一致）。
func padLines(lines []string, n int) string {
	out := make([]string, n)
	copy(out, lines)
	return strings.Join(out, "\n")
}

// padRows 把行 → 块的映射补到 n 行（鼠标命中永远按 height 行查表）。
func padRows(rows []clickRow, n int) []clickRow {
	if len(rows) == n {
		return rows
	}
	out := make([]clickRow, n)
	copy(out, rows)
	return out
}

func (m Model) viewHeader() string {
	// 2.2.5：运行/空闲状态只在状态行与输入框边框显示（header 不再重复）。
	// 这里只保留连接异常提示——它会改变"能不能操作"的判断，不能省。
	left := headerStyle.Render("zhishi") + dimStyle.Render("  "+shortServer(m.Server))
	if m.SessionTitle != "" {
		left += dimStyle.Render("  ·  ") + valueStyle.Render(truncateWidth(m.SessionTitle, 32))
	}
	right := ""
	if !m.Connected {
		right = warnStyle.Render("未连接")
	}
	if m.SessionID != "" {
		right = dimStyle.Render(m.SessionID) + dimStyle.Render("  ") + right
	}
	if right == "" {
		return left
	}
	// 左标题 / 右状态：右侧贴边，中间留白。宽度不够时优先保右。
	gap := m.contentWidth() - lipgloss.Width(left) - lipgloss.Width(right)
	if gap < 1 {
		left = truncateWidth(left, m.contentWidth()-lipgloss.Width(right)-1)
		gap = 1
	}
	return left + strings.Repeat(" ", gap) + right
}

// shortServer 把 http://127.0.0.1:7411 压成 127.0.0.1:7411。
func shortServer(server string) string {
	s := strings.TrimPrefix(strings.TrimPrefix(server, "http://"), "https://")
	s = strings.TrimSuffix(s, "/")
	return s
}

// viewHeaderRule 是标题与内容之间的一条细线。
//
// 没有它时标题和第一条消息之间只有一行空白，滚动起来之后很容易分不清"这一行
// 是标题还是内容"。
func (m Model) viewHeaderRule() string {
	return faintStyle.Render(strings.Repeat("─", m.contentWidth()))
}

// viewInput 把输入框装进圆角板里。
//
// 为什么值得两层边框：无边框的 textarea 在满屏文本里没有"落点"，眼睛找不到
// 该看哪里；一块安静的板把输入区和输出区分开，也是 Warp / opencode 那类界面
// 最显眼的一处结构。
func (m Model) viewInput() string {
	// lipgloss 的 Width 是"含内边距、不含边框"的宽度：Width(W-2) 画出来正好 W 列。
	inner := m.contentWidth() - 2
	if inner < 10 {
		inner = 10
	}
	// 运行中输入板换警示色边框——这是屏幕上最容易被余光扫到的位置。
	border := style.Current.Faint
	if m.Running() {
		border = style.Current.Warn
	}
	return inputStyle.BorderForeground(lipgloss.Color(border)).Width(inner).Render(m.Input.View())
}

// viewStatus 固定两行：状态行 + 提示/键位行。
func (m Model) viewStatus() string {
	return lipgloss.JoinVertical(lipgloss.Left,
		truncateWidth(m.statusLine(), m.contentWidth()),
		truncateWidth(m.secondLine(), m.contentWidth()),
	)
}

// statusLine 是状态行的正文：
//
//	INSERT  deepseek-flash · ctx 41% · 168k/250k · Σ 12k · 队列 0 · 5m12s · 1 子任务
//
// 口径（M2a 定稿）：`ctx%` 与 `a/b` **同源**自 chat:context-usage 快照
// （contextTokens/contextWindow），`Σ` 才是 chat:message-complete 的 usage
// 累计（与窗口无关）。两段各说一件事，不会互相矛盾。
//
// 窄屏降级顺序：子任务 → Σ → 上下文对数 → 截断。
func (m Model) statusLine() string {
	modelName := m.ModelID
	if modelName == "" {
		modelName = "—"
	}
	// drop 是丢弃优先级：数字越大越先被丢（0 = 永不丢）。
	// 定稿顺序：子任务 → Σ → 上下文对数。
	type seg struct {
		text string
		drop int
	}
	segs := []seg{
		{modeStyle.Render("INSERT"), 0},
	}
	if m.Running() {
		// 2.2.4：忙碌状态必须在输入框旁边也可见（header 在顶部，滚动时容易看丢）。
		state := "● 运行中"
		if el := m.Elapsed(); el > 0 {
			state += " " + fmtDuration(el)
		}
		segs = append(segs, seg{runStyle.Render(state), 0})
	}
	if m.MouseOn {
		// 默认是"鼠标交给终端"，只有接管时才提示——常态不该占状态栏。
		segs = append(segs, seg{selStyle.Render("鼠标"), 3})
	}
	if n := len(m.Choices); n > 0 {
		// 待答请求必须一直显眼：Esc 收起面板后也要能看到还有几个没答。
		segs = append(segs, seg{selStyle.Render(fmt.Sprintf("!%d 待答（Alt+d）", n)), 0})
	}
	segs = append(segs, seg{valueStyle.Render(modelName), 0})
	if m.ContextWindow > 0 {
		segs = append(segs,
			seg{fmt.Sprintf("ctx %d%%", percent(m.ContextUsed, m.ContextWindow)), 0},
			seg{fmtTokens(m.ContextUsed) + "/" + fmtTokens(m.ContextWindow), 1},
		)
	}
	segs = append(segs, seg{"Σ " + sigmaText(m.UsageTokens), 2})
	if m.Mission != "" {
		segs = append(segs, seg{selStyle.Render(m.Mission), 3})
	}
	if n := len(m.PendingImages); n > 0 {
		segs = append(segs, seg{selStyle.Render(fmt.Sprintf("图 %d", n)), 0})
	}
	if m.AutoRunActive() {
		segs = append(segs, seg{selStyle.Render(fmt.Sprintf("⛁ %s · 轮 %d", phaseOrDash(m.AutoRun.Phase), m.AutoRun.Turns)), 2})
	}
	if n := len(m.Bg); n > 0 {
		segs = append(segs, seg{fmt.Sprintf("后台 %d", n), 2})
	}
	segs = append(segs, seg{fmt.Sprintf("队列 %d", m.QueuedCount()), 0})
	if el := m.Elapsed(); el > 0 {
		segs = append(segs, seg{fmtDuration(el), 0})
	}
	if n := m.SubagentCount(); n > 0 {
		segs = append(segs, seg{fmt.Sprintf("%d 子任务", n), 3})
	}

	// maxDrop 是"允许保留的最高丢弃等级"：先按全集画，超宽再逐级降。
	build := func(maxDrop int) string {
		parts := make([]string, 0, len(segs))
		for _, s := range segs {
			if s.drop > maxDrop {
				continue
			}
			parts = append(parts, s.text)
		}
		// 分隔符只留两个空格：圆点满屏时状态行像一串电报码，读不出层级。
		// 层级交给 mode chip 与数值本身的颜色。
		return strings.Join(parts, dimStyle.Render("  "))
	}

	line := build(3)
	for level := 2; level >= 0 && lipgloss.Width(line) > m.contentWidth(); level-- {
		line = build(level)
	}
	return line
}

// sigmaText 是 usage 累计段的取值：没有 usage 时显示 "-"（设计定稿要求）。
func sigmaText(tokens int) string {
	if tokens <= 0 {
		return "-"
	}
	return fmtTokens(tokens)
}

// secondLine 是光标位置 + 一条"此刻最重要"的提示。
func (m Model) secondLine() string {
	total := len(m.VisibleBlocks())
	cur := m.effectiveCursor()
	pos := "0/0"
	if total > 0 {
		pos = fmt.Sprintf("%d/%d", cur+1, total)
	}
	sel := "—"
	if vb := m.VisibleBlocks(); cur >= 0 && cur < len(vb) {
		sel = blockLabel(vb[cur])
	}
	filter := ""
	if m.OnlyFailed {
		filter = warnStyle.Render(" 只看失败")
	}
	left := fmt.Sprintf("%s %s  %s%s",
		dimStyle.Render("▸"), styleCount(pos), sel, filter)

	right := ""
	switch {
	case m.LastErr != "":
		right = errStyle.Render("! ") + m.LastErr
	case m.StreamErr != "":
		right = errStyle.Render("流断开：") + m.StreamErr
	case m.LastNotice != "":
		right = noticeStyle.Render("· ") + m.LastNotice
	case m.QuitArmed:
		right = warnStyle.Render("再按一次 Ctrl+C 退出")
	case m.ScrollLines > 0:
		right = dimStyle.Render(fmt.Sprintf("↑ 上翻 %d 行（Alt+g 回底）", m.ScrollLines))
	default:
		// 2.2：不再常驻键位清单——只提示「此刻最有用的下一步」。
		// 键位总表在 F1；全部动作在 Ctrl+K。
		hint := "Ctrl+K 动作中心  ·  / 命令  ·  F1 键位"
		if m.Running() {
			hint = "Ctrl+C 停  ·  Ctrl+K 动作中心  ·  F1 键位"
		} else if vb := m.VisibleBlocks(); cur >= 0 && cur < len(vb) {
			b := vb[cur]
			lines := bodyLineCount(b.Body)
			if !b.Expanded && render.FoldedBodyLines(b.Kind, lines) < lines {
				hint = "Alt+r 展开这一块  ·  Ctrl+K 动作中心  ·  F1 键位"
			}
		}
		right = dimStyle.Render(hint)
		if len(m.Choices) > 0 {
			right = selStyle.Render(fmt.Sprintf("有 %d 条待答：Alt+d 打开", len(m.Choices)))
		}
	}
	return truncateWidth(left+dimStyle.Render("  ")+right, m.contentWidth())
}

func blockLabel(b store.Block) string {
	switch b.Kind {
	case store.KindTool:
		label := b.Title
		if label == "" {
			label = "tool"
		}
		out := label + "  ✓"
		if b.Failed {
			out = label + "  ✗"
		}
		if !b.Live && b.Duration > 0 {
			out += "  " + fmtDuration(b.Duration)
		}
		return out
	case store.KindUser:
		return "you"
	case store.KindAssistant:
		return "zhishi"
	case store.KindThinking:
		return "thinking"
	case store.KindError:
		return "error ⚠"
	default:
		return "note"
	}
}

func styleCount(s string) string { return countStyle.Render(s) }

// drawOverlay 把栈顶覆盖层叠到成品画面上。
//
// 覆盖层不参与 JoinVertical：它是盖上去的一层，行数不变、底层布局不动
// （流不重排、滚动位置不跳）。
func (m Model) drawOverlay(base string) string {
	ov, ok := m.TopOverlay()
	if !ok {
		return base
	}
	return overlayOn(base, m.overlayBox(ov), m.Height)
}

// overlayBox 是覆盖层统一盒形：圆角边框 + 居中。
//
// 尺寸在这里收口（而不是每层自己算），四个面板才能长得一样。
func (m Model) overlayBox(ov Overlay) string {
	width := m.Width - 8
	if width < 24 {
		width = 24
	}
	if width > 76 {
		width = 76
	}
	height := m.Height - 4
	if height < 8 {
		height = 8
	}
	return boxStyle.Render(ov.Render(m, width, height))
}

// overlayOn 把面板叠到成品画面上。
//
// 用整行替换而不是列级合成：面板带边框，两侧露出的半行底稿对可读性没帮助，
// 却要按显示宽度切 ANSI 字符串（中文 + 样式码双重风险）。
func overlayOn(base, box string, height int) string {
	if box == "" {
		return base
	}
	baseLines := strings.Split(base, "\n")
	boxLines := strings.Split(box, "\n")
	boxW := 0
	for _, l := range boxLines {
		if w := lipgloss.Width(l); w > boxW {
			boxW = w
		}
	}
	left := (lineWidth(baseLines) - boxW) / 2
	if left < 0 {
		left = 0
	}
	top := (height - len(boxLines)) / 2
	if top < 0 {
		top = 0
	}
	for i, l := range boxLines {
		row := top + i
		if row >= len(baseLines) {
			baseLines = append(baseLines, "")
		}
		baseLines[row] = strings.Repeat(" ", left) + l
	}
	return strings.Join(baseLines, "\n")
}

func lineWidth(lines []string) int {
	w := 0
	for _, l := range lines {
		if lw := lipgloss.Width(l); lw > w {
			w = lw
		}
	}
	return w
}

// padRight 按显示宽度补齐（名字里可能有中文，不能用 len）。
//
// styled 是已经着色的成品，raw 是未着色的原文——宽度必须按原文量。
func padRight(styled, raw string, w int) string {
	if pad := w - lipgloss.Width(raw); pad > 0 {
		return styled + strings.Repeat(" ", pad)
	}
	return styled + " "
}

// truncateWidth 按显示宽度截断（超宽会撑破 JoinVertical 的对齐）。
func truncateWidth(s string, limit int) string {
	if limit <= 0 {
		return ""
	}
	if lipgloss.Width(s) <= limit {
		return s
	}
	var b strings.Builder
	w := 0
	for _, r := range s {
		rw := lipgloss.Width(string(r))
		if w+rw > limit-1 {
			b.WriteString("…")
			break
		}
		b.WriteRune(r)
		w += rw
	}
	return b.String()
}

func percent(used, window int) int {
	if window <= 0 {
		return 0
	}
	p := used * 100 / window
	if p > 100 {
		p = 100
	}
	return p
}

// fmtTokens 把 token 数写成 k 单位（状态行示例就是 168k/250k 这种形态）。
func fmtTokens(n int) string {
	if n < 1000 {
		return fmt.Sprintf("%d", n)
	}
	if n < 1000000 {
		return fmt.Sprintf("%.0fk", float64(n)/1000)
	}
	return fmt.Sprintf("%.1fm", float64(n)/1000000)
}

func fmtDuration(d time.Duration) string {
	if d < time.Minute {
		return fmt.Sprintf("%ds", int(d.Seconds()))
	}
	if d < time.Hour {
		return fmt.Sprintf("%dm%02ds", int(d.Minutes()), int(d.Seconds())%60)
	}
	return fmt.Sprintf("%dh%02dm", int(d.Hours()), int(d.Minutes())%60)
}

// 外壳配色取自 internal/style（与块渲染同一套主题）。
var (
	headerStyle = lipgloss.NewStyle().Foreground(lipgloss.Color(style.Current.Accent)).Bold(true)
	dimStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color(style.Current.Dim))
	faintStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color(style.Current.Faint))
	countStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color(style.Current.Text)).Bold(true)
	modeStyle   = lipgloss.NewStyle().
			Foreground(lipgloss.Color(style.Current.Bg)).
			Background(lipgloss.Color(style.Current.Accent)).
			Bold(true)
	valueStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color(style.Current.Text))
	selStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color(style.Current.Warn)).Bold(true)
	runStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color(style.Current.Warn)).Bold(true)
	noticeStyle = lipgloss.NewStyle().Foreground(lipgloss.Color(style.Current.Notice))
	errStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color(style.Current.Fail))
	warnStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color(style.Current.Warn))
	boxStyle    = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color(style.Current.Accent)).
			Padding(0, 1)
	// 输入框边框比内容更低一级：安静地把输入区和输出区分开。
	inputStyle = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color(style.Current.Faint)).
			Padding(0, 1)
)
