package app

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lielingai/zhishi/tui/internal/client"
)

// 四个数据覆盖层的公共骨架：
//   - 打开时立刻发一次加载（状态先落 loading，避免闪一帧空白）；
//   - 加载失败只把错误行画在盒子里，**不关面板**（用户能重试/换个看）；
//   - Enter 的动作结果由 update 处理（成功关面板 + 提示，失败留在原地报错）。
//
// 面板不认识传输层类型：client 的 DTO 在命令里就折成 row / archiveGroup。

const listOverlayMinRows = 3

func listOverlayRows(height int) int {
	n := height - 10 // 标题 + 底注 + 边框 + 一行余量
	if n < listOverlayMinRows {
		n = listOverlayMinRows
	}
	return n
}

// listBody 拼出"标题 + 反馈 + 列表 + 底注"的通用盒内内容。
func listBody(title string, l list, width, maxRows int, hint string) string {
	lines := []string{headerStyle.Render(title)}
	if l.note != "" {
		lines = append(lines, noticeStyle.Render("· "+l.note))
	}
	lines = append(lines, renderList(l, width, maxRows)...)
	lines = append(lines, footerHint(hint, countLabel(l.sel+1, len(l.rows))))
	return strings.Join(lines, "\n")
}

// ── 环境面板（Alt+e）────────────────────────────────────────────────────

// envOverlay 除列表外还带"删除需二次确认"的短状态（不可逆操作）。
type envOverlay struct {
	list
	pendingRemove   string
	pendingRemoveAt time.Time
}

func newEnvOverlay() *envOverlay { return &envOverlay{} }

func (o *envOverlay) Title() string { return "环境" }

// reload 发起一次加载。调用方（update 的打开动作 / r 键）负责执行返回的 Cmd。
func (o *envOverlay) reload(m *Model) tea.Cmd {
	o.state = loadRunning
	o.err = ""
	if m.Admin == nil {
		o.state = loadFailed
		o.err = "没有可用的管理面客户端"
		return nil
	}
	return loadEnvironmentsCmd(m.Ctx, m.Admin)
}

func (o *envOverlay) Handle(m *Model, msg tea.KeyMsg) tea.Cmd {
	switch msg.String() {
	case "up", "ctrl+p":
		o.move(-1)
		o.syncSelection(m)
	case "down", "ctrl+n":
		o.move(1)
		o.syncSelection(m)
	case "r":
		return o.reload(m)
	case "d", "x", "n", "l":
		return o.handleWriteKeys(m, msg)
	case "enter":
		r, ok := o.selected()
		if !ok || o.state != loadReady {
			return nil
		}
		if m.Workspace == "" {
			// environment/select 的 workspace 必填，而 TUI 只能从 chat:init
			// 拿 agentDir——没收到就老实说，别发一条注定被拒的请求。
			o.note = "workspace 未知（未收到 chat:init 的 agentDir）"
			return nil
		}
		o.note = "切换中…"
		return selectEnvironmentCmd(m.Ctx, m.Admin, m.Workspace, r.Key)
	}
	return nil
}

func (o *envOverlay) Render(m Model, width, height int) string {
	return listBody("环境", o.list, width, listOverlayRows(height),
		"↑↓ 选择  Enter 切换  r 刷新  Esc 关闭")
}

func (o *envOverlay) Summary() Summary {
	return Summary{Kind: "env", Title: "环境", State: o.state.String(), Err: o.err,
		Count: len(o.rows), First: o.first()}
}

func (o *envOverlay) apply(rows []row, err error) {
	if err != nil {
		o.fail(err)
		return
	}
	o.setRows(rows)
}

// syncSelection 把光标位置写进 Model.SelectedEnvID：Alt+s / 面板 s 都靠它
// 知道"用户正看着哪个环境"。
func (o *envOverlay) syncSelection(m *Model) {
	if r, ok := o.selected(); ok {
		m.SelectedEnvID = r.Key
	}
}

// ── 线面板（Alt+l）──────────────────────────────────────────────────────

// lineOverlay 带"删除需二次确认"的短状态。
type lineOverlay struct {
	list
	pendingDelete   string
	pendingDeleteAt time.Time
}

func newLineOverlay() *lineOverlay {
	return &lineOverlay{list: list{emptyHint: "（没有历史会话）发过消息后会自动建档；切/归档/删除都在这个面板"}}
}

func (o *lineOverlay) Title() string { return "线" }

func (o *lineOverlay) reload(m *Model) tea.Cmd {
	o.state = loadRunning
	o.err = ""
	if m.Admin == nil {
		o.state = loadFailed
		o.err = "没有可用的管理面客户端"
		return nil
	}
	return loadSessionsCmd(m.Ctx, m.Admin)
}

func (o *lineOverlay) Handle(m *Model, msg tea.KeyMsg) tea.Cmd {
	switch msg.String() {
	case "r":
		return o.reload(m)
	case "a", "n", "x":
		return o.handleWriteKeys(m, msg)
	case "up", "ctrl+p":
		o.move(-1)
	case "down", "ctrl+n":
		o.move(1)
	case "enter":
		r, ok := o.selected()
		if !ok || o.state != loadReady {
			return nil
		}
		o.note = "切换中…"
		return switchSessionCmd(m.Ctx, m.Admin, r.Key)
	}
	return nil
}

func (o *lineOverlay) Render(m Model, width, height int) string {
	return listBody("线", o.list, width, listOverlayRows(height),
		"↑↓ 选择  Enter 切线  Esc 关闭")
}

func (o *lineOverlay) Summary() Summary {
	return Summary{Kind: "line", Title: "线", State: o.state.String(), Err: o.err,
		Count: len(o.rows), First: o.first()}
}

func (o *lineOverlay) apply(rows []row, err error) {
	if err != nil {
		o.fail(err)
		return
	}
	o.setRows(rows)
}

// ── 任务面板（Alt+t）────────────────────────────────────────────────────

// taskOverlay 除列表外还带"终止需二次确认"的短状态。
type taskOverlay struct {
	list
	// pendingStop 记录"已经按了一次 x"的任务 id 与时间：3 秒内再按一次才真停。
	// 任务面板的 x 是破坏性操作，误触代价比多按一次高。
	pendingStop   string
	pendingStopAt time.Time
}

func newTaskOverlay() *taskOverlay {
	return &taskOverlay{list: list{emptyHint: "（没有任务）agent 用 task 工具建的任务会出现在这里；CLI 侧 zhishi task list"}}
}

func (o *taskOverlay) Title() string { return "任务中心" }

func (o *taskOverlay) reload(m *Model) tea.Cmd {
	o.state = loadRunning
	o.err = ""
	if m.Admin == nil {
		o.state = loadFailed
		o.err = "没有可用的管理面客户端"
		return nil
	}
	return loadTasksCmd(m.Ctx, m.Admin)
}

func (o *taskOverlay) Handle(m *Model, msg tea.KeyMsg) tea.Cmd {
	switch msg.String() {
	case "r":
		return o.reload(m)
	case "up", "ctrl+p":
		o.move(-1)
	case "down", "ctrl+n":
		o.move(1)
	case "c":
		r, ok := o.selected()
		if !ok || o.state != loadReady {
			return nil
		}
		o.note = "续命中…"
		return taskOpCmd(m.Ctx, m.Admin, "rerun", r.Key)

	case "x":
		r, ok := o.selected()
		if !ok || o.state != loadReady {
			return nil
		}
		if o.pendingStop == r.Key && time.Since(o.pendingStopAt) < 3*time.Second {
			o.pendingStop = ""
			o.note = "终止中…"
			return taskOpCmd(m.Ctx, m.Admin, "stop", r.Key)
		}
		o.pendingStop = r.Key
		o.pendingStopAt = time.Now()
		o.note = "再按一次 x 确认终止（3 秒内有效）"

	case "enter", "d":
		r, ok := o.selected()
		if !ok || o.state != loadReady {
			return nil
		}
		return taskDetailCmd(m.Ctx, m.Admin, r.Key)
	}
	return nil
}

func (o *taskOverlay) Render(m Model, width, height int) string {
	return listBody("任务中心 · agent 建的任务", o.list, width, listOverlayRows(height),
		"↑↓ 选择  r 刷新  Esc 关闭（终止/续命留桩）")
}

func (o *taskOverlay) Summary() Summary {
	return Summary{Kind: "task", Title: "任务", State: o.state.String(), Err: o.err,
		Count: len(o.rows), First: o.first()}
}

func (o *taskOverlay) apply(rows []row, err error) {
	if err != nil {
		o.fail(err)
		return
	}
	o.setRows(rows)
}

// ── 档案面板（Alt+a）───────────────────────────────────────────────────

// archiveGroup 是按 kind 分的一组实体（只读树的一节）。
type archiveGroup struct {
	kind string
	rows []row
}

type archiveOverlay struct {
	list   // state/err 三态
	groups []archiveGroup
	// ents 是原始实体（详情面板要全文/链接，而 row 只留了摘要）。
	ents []client.ArchiveEntity
	// sel 是扁平实体列表里的光标（分组顺序拼接），写操作作用在它上面。
	sel  int
	note string
}

func newArchiveOverlay() *archiveOverlay { return &archiveOverlay{} }

func (o *archiveOverlay) Title() string { return "研究档案 · 假设/结论/证据/问题" }

func (o *archiveOverlay) reload(m *Model) tea.Cmd {
	o.state = loadRunning
	o.err = ""
	if m.Admin == nil {
		o.state = loadFailed
		o.err = "没有可用的管理面客户端"
		return nil
	}
	return loadArchiveCmd(m.Ctx, m.Admin, m.SessionID)
}

func (o *archiveOverlay) Handle(m *Model, msg tea.KeyMsg) tea.Cmd {
	switch msg.String() {
	case "r":
		// 档案会被 agent 在别处改，不能只靠重开面板。
		return o.reload(m)
	case "up", "ctrl+p":
		o.sel--
	case "down", "ctrl+n":
		o.sel++
	case "v", "c", "a":
		return o.handleOps(m, msg)
	case "enter", "d":
		return o.detail(m)
	}
	flat := o.flatRows()
	if o.sel < 0 {
		o.sel = 0
	}
	if o.sel >= len(flat) {
		o.sel = len(flat) - 1
	}
	if o.sel < 0 {
		o.sel = 0
	}
	return nil
}

func (o *archiveOverlay) Render(m Model, width, height int) string {
	switch o.state {
	case loadIdle, loadRunning:
		return strings.Join([]string{headerStyle.Render("研究档案 · 假设/结论/证据/问题"), dimStyle.Render("  加载中…")}, "\n")
	case loadFailed:
		lines := append([]string{headerStyle.Render("研究档案")}, wrapLines("! "+o.err, width, errStyle)...)
		lines = append(lines, footerHint("Esc 关闭"))
		return strings.Join(lines, "\n")
	}

	maxRows := listOverlayRows(height)
	lines := []string{headerStyle.Render("研究档案")}
	if o.note != "" {
		lines = append(lines, noticeStyle.Render("· "+o.note))
	}
	total := o.count()
	if total == 0 {
		lines = append(lines, dimStyle.Render("  （档案为空：agent 用 research_archive 写入假设 / 结论 / 证据 / 问题）"))
	}
	shown, idx := 0, 0
	for _, g := range o.groups {
		if len(g.rows) == 0 {
			continue
		}
		if shown >= maxRows {
			break
		}
		lines = append(lines, headerStyle.Render(kindLabel(g.kind)+"  "+strconv.Itoa(len(g.rows))))
		shown++
		for _, r := range g.rows {
			if shown >= maxRows {
				break
			}
			mark := "  "
			style := valueStyle
			if idx == o.sel {
				mark = "▸ "
				style = selStyle
			}
			line := mark + padRight(style.Render(r.Key), r.Key, 6)
			line += truncateWidth(r.Desc, width-10)
			if r.Flag != "" {
				line += "  " + dimStyle.Render(r.Flag)
			}
			lines = append(lines, line)
			shown++
			idx++
		}
	}
	if rest := total - idx; rest > 0 && shown >= maxRows {
		lines = append(lines, dimStyle.Render("  …（窗口已满，Esc 关闭后可再看）"))
	}
	lines = append(lines, footerHint("Esc 关闭"))
	return strings.Join(lines, "\n")
}

func (o *archiveOverlay) Summary() Summary {
	s := Summary{Kind: "archive", Title: "研究档案", State: o.state.String(), Err: o.err, Count: o.count()}
	for _, g := range o.groups {
		if len(g.rows) > 0 {
			s.First = g.rows[0].Key + " " + g.rows[0].Desc
			break
		}
	}
	return s
}

func (o *archiveOverlay) apply(groups []archiveGroup, err error, ents []client.ArchiveEntity) {
	if err != nil {
		o.fail(err)
		return
	}
	o.groups = groups
	o.ents = ents
	o.state = loadReady
	o.err = ""
}

func (o *archiveOverlay) count() int {
	n := 0
	for _, g := range o.groups {
		n += len(g.rows)
	}
	return n
}

func (o *archiveOverlay) nonEmptyGroups() []archiveGroup {
	out := make([]archiveGroup, 0, len(o.groups))
	for _, g := range o.groups {
		if len(g.rows) > 0 {
			out = append(out, g)
		}
	}
	return out
}

// kindLabel 把实体 kind 翻成中文分组名（顺序固定：假设→结论→证据→问题）。
func kindLabel(kind string) string {
	switch kind {
	case "hypothesis":
		return "假设"
	case "finding":
		return "结论"
	case "evidence":
		return "证据"
	case "question":
		return "问题"
	default:
		return kind
	}
}

// archiveOrder 是档案分组的展示顺序（设计稿：假设→结论→证据→问题）。
var archiveOrder = []string{"hypothesis", "finding", "evidence", "question"}

// taskOpCmd 执行任务写操作（rerun / stop），完成后刷新面板。
//
// 「终止」映射到 update-status(stopped)：服务端 TASK_STATUSES 里没有 cancelled，
// stopped 是终态且会走状态机（写 history + 信任账本）。
func taskOpCmd(ctx context.Context, admin adminAPI, op, id string) tea.Cmd {
	return func() tea.Msg {
		if admin == nil {
			return taskOpDoneMsg{op: op, id: id, err: fmt.Errorf("没有可用的管理面客户端")}
		}
		reqCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		var err error
		switch op {
		case "rerun":
			err = admin.TaskRerun(reqCtx, id)
		case "stop":
			err = admin.TaskUpdateStatus(reqCtx, id, "stopped", "TUI 手动终止")
		default:
			err = fmt.Errorf("未知任务操作 %q", op)
		}
		return taskOpDoneMsg{op: op, id: id, err: err}
	}
}

type taskOpDoneMsg struct {
	op  string
	id  string
	err error
}
