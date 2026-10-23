package app

import (
	"strconv"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lielingai/zhishi/tui/internal/protocol"
	"github.com/lielingai/zhishi/tui/internal/render"
	"github.com/lielingai/zhishi/tui/internal/store"
)

// wireWindow 是只读回看的窗口上限。
//
// 服务端还有一层 2000 条的护栏（truncated 标记），这里再按 200 条折一次：
// 一个覆盖层盒子最多显示几十行，200 条已经够翻一阵，再多只是拖慢首屏。
const wireWindow = 200

// replayWire 用与 live 完全相同的归约器，把 wire 消息灌进一个**独立** Store。
//
// 独立实例是关键：回看不许污染当前会话的流（Store/Cursor/ScrollLines/StreamSeq
// 一个都不动）。归约走的是 applyWireMessage——live 重放与只读回看只有一份
// 实现，不会出现"回看里 tool 块和 live 长得不一样"。
func replayWire(messages []protocol.Snapshot) *store.Store {
	dst := &store.Store{}
	for i := range messages {
		applyWireMessage(dst, &messages[i])
	}
	return dst
}

// ── 历史列表（Alt+h 的第一层）─────────────────────────────────────────

// historyOverlay 列会话线供回看。数据源与线面板相同（GET /sessions），
// 但 Enter 的语义不同：这里不切线，只读它的历史。
type historyOverlay struct{ list }

func newHistoryOverlay() *historyOverlay { return &historyOverlay{} }

func (o *historyOverlay) Title() string { return "历史回看" }

func (o *historyOverlay) reload(m *Model) tea.Cmd {
	o.state = loadRunning
	o.err = ""
	if m.Admin == nil {
		o.state = loadFailed
		o.err = "没有可用的管理面客户端"
		return nil
	}
	return loadSessionsCmd(m.Ctx, m.Admin)
}

func (o *historyOverlay) Handle(m *Model, msg tea.KeyMsg) tea.Cmd {
	switch msg.String() {
	case "up", "ctrl+p":
		o.move(-1)
	case "down", "ctrl+n":
		o.move(1)
	case "r":
		return o.reload(m)
	case "enter":
		r, ok := o.selected()
		if !ok || o.state != loadReady {
			return nil
		}
		// 必须用 loopSessionId 拉 wire（/api/loop-session/messages 只认它）；
		// 列表行的主键是会话 meta id，两者不是一回事。
		line := r.Ref
		if line == "" {
			o.note = "这条线没有 loopSessionId，无法回看"
			return nil
		}
		o.note = "正在加载 wire 消息…"
		return loadWireCmd(m.Ctx, m.Admin, line, r.Title)
	}
	return nil
}

func (o *historyOverlay) Render(m Model, width, height int) string {
	return listBody("历史回看", o.list, width, listOverlayRows(height),
		"↑↓ 选择  Enter 回看  r 刷新  Esc 关闭")
}

func (o *historyOverlay) Summary() Summary {
	return Summary{Kind: "history", Title: "历史回看", State: o.state.String(), Err: o.err,
		Count: len(o.rows), First: o.first()}
}

func (o *historyOverlay) apply(rows []row, err error) {
	if err != nil {
		o.fail(err)
		return
	}
	o.setRows(rows)
}

// ── 回看视图（只读）──────────────────────────────────────────────────

// replayOverlay 是只读回看视图。
//
// 它自己持有一份 Store + Cache：块 ID 是 msg:<n>，与 live 会话会撞，共用
// 缓存会读到另一条线的正文。只读的含义：没有输入框、不发消息，唯一动作是
// 复制当前块（y / Alt+y）。
type replayOverlay struct {
	title  string
	lineID string
	blocks *store.Store
	cache  *render.Cache

	cursor  int // 当前块
	topLine int // 窗口顶部在整段文本里的行号
	note    string
}

func newReplayOverlay(title, lineID string, blocks *store.Store, note string) *replayOverlay {
	return &replayOverlay{
		title:  title,
		lineID: lineID,
		blocks: blocks,
		cache:  render.NewCache(),
		note:   note,
	}
}

func (o *replayOverlay) Title() string { return "只读回看 · " + o.title }

func (o *replayOverlay) Handle(m *Model, msg tea.KeyMsg) tea.Cmd {
	n := o.blockCount()
	switch msg.String() {
	case "up", "ctrl+p":
		if o.cursor > 0 {
			o.cursor--
		}
	case "down", "ctrl+n":
		if o.cursor < n-1 {
			o.cursor++
		}
	case "pgup":
		o.topLine -= replayPageLines
	case "pgdown":
		o.topLine += replayPageLines
	case "g":
		o.topLine = 0
	case "y", "alt+y":
		if b, ok := o.cursorBlock(); ok {
			return copyCmd(b.Body)
		}
		return noticeCmd("没有选中的块")
	case "enter":
		// 只读：Enter 不发消息（防误按把历史内容当成 prompt 发出去）。
		return noticeCmd("只读回看：不能发送")
	}
	if o.topLine < 0 {
		o.topLine = 0
	}
	return nil
}

// replayPageLines 是一页滚动的行数（盒子里能显示的行数，粗略即可）。
const replayPageLines = 10

func (o *replayOverlay) Render(m Model, width, height int) string {
	head := headerStyle.Render("只读回看 · " + o.title)
	lines, starts := o.lines(width)

	bodyRows := listOverlayRows(height)
	if bodyRows < 3 {
		bodyRows = 3
	}
	if len(lines) == 0 {
		return strings.Join([]string{head, dimStyle.Render("  （这条线没有可回看的消息）"),
			footerHint("Esc 返回列表")}, "\n")
	}

	// 让光标块保持可见：修正只在本地做（Render 不写回状态）。
	top := o.topLine
	if s, ok := o.blockStart(starts, o.cursor); ok {
		if s < top {
			top = s
		}
		if s >= top+bodyRows {
			top = s - bodyRows + 1
		}
	}
	if top > len(lines)-bodyRows {
		top = len(lines) - bodyRows
	}
	if top < 0 {
		top = 0
	}
	end := top + bodyRows
	if end > len(lines) {
		end = len(lines)
	}

	out := []string{head}
	if o.note != "" {
		out = append(out, noticeStyle.Render("· "+o.note))
	}
	out = append(out, lines[top:end]...)
	sel := "—"
	if b, ok := o.cursorBlock(); ok {
		sel = blockLabel(b)
	}
	out = append(out, footerHint(
		"↑↓ 块  PgUp/PgDn 滚动  y 复制  Esc 返回列表",
		countLabel(o.cursor+1, len(o.blocks.List()))+"  "+sel))
	return strings.Join(out, "\n")
}

func (o *replayOverlay) Summary() Summary {
	s := Summary{Kind: "replay", Title: "只读回看 · " + o.title, State: "ready", Count: o.blockCount()}
	if b, ok := o.cursorBlock(); ok {
		s.First = b.Kind.String() + " " + firstLine(b.Body)
	}
	return s
}

func (o *replayOverlay) blockCount() int { return o.blocks.Len() }

func (o *replayOverlay) cursorBlock() (store.Block, bool) { return o.blocks.At(o.cursor) }

// lines 渲染整段回看文本，并返回每个块的首行行号。
//
// 只读视图不参与主视图的虚拟滚动（有 200 条上限，画一遍就够），但走的仍是
// 同一个 render.Cache，所以滚动时是缓存命中而不是重画。
func (o *replayOverlay) lines(width int) ([]string, []int) {
	blocks := o.blocks.List()
	var lines []string
	starts := make([]int, 0, len(blocks))
	for _, b := range blocks {
		starts = append(starts, len(lines))
		out := o.cache.Block(b, width-2, b.Live)
		lines = append(lines, strings.Split(out, "\n")...)
	}
	return lines, starts
}

func (o *replayOverlay) blockStart(starts []int, idx int) (int, bool) {
	if idx < 0 || idx >= len(starts) {
		return 0, false
	}
	return starts[idx], true
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

// ── wire 加载结果的本地镜像 ────────────────────────────────────────────

// wirePage 是 client.WirePage 的本地镜像（覆盖层不认识 client 的 DTO）。
type wirePage struct {
	messages []protocol.Snapshot
	total    int
}

// replayNote 生成"仅显示最近 N 条"的提示（空字符串表示没截）。
func replayNote(total, kept int) string {
	if total <= kept {
		return ""
	}
	return "仅显示最近 " + strconv.Itoa(kept) + " 条（该线共 " + strconv.Itoa(total) + " 条）"
}
