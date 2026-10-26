package app

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lielingai/zhishi/tui/internal/client"
	"github.com/lielingai/zhishi/tui/internal/protocol"
	"github.com/lielingai/zhishi/tui/internal/render"
	"github.com/lielingai/zhishi/tui/internal/store"
)

// mouseScroll / pageScroll 是滚动的步长。
const (
	mouseScroll = 3
	pageScroll  = 2 // 页滚时留两行重叠，方便接着读
)

// errNoAdmin 是"没有管理面客户端"的统一报错（离线启动/测试构造时会出现）。
var errNoAdmin = fmt.Errorf("没有可用的管理面客户端")

// ── 消息 ────────────────────────────────────────────────────────────────
// 消息只携带数据，不带可执行逻辑：Cmd 回来以后 Update 仍然是一次纯归约。

type (
	// EventMsg 是取回的一帧 SSE 事件。
	//
	// 导出是因为非 TTY 探针（cmd/zhishi-tui --probe）要复用同一个归约器：
	// 探针不跑 bubbletea 循环，只把事件喂进 Update，保证"验证过的路径"就是
	// 真实前端跑的那条。
	EventMsg protocol.Event
	// streamEndMsg 是 SSE 通道结束（正常关闭或异常）。gen 用来丢弃过期订阅
	// 的收尾消息——重连后旧通道关闭会晚一步到达。
	streamEndMsg struct {
		err error
		gen int
	}
	// subscribedMsg 是订阅建立结果。
	subscribedMsg struct {
		sub *client.Subscription
		err error
		gen int
	}
	// healthMsg 是探活结果。
	healthMsg struct{ err error }
	// sendMsg 是 /chat/send 的结果。
	sendMsg struct {
		result client.SendResult
		err    error
	}
	// stopMsg 是 /chat/stop 的结果。
	stopMsg struct{ err error }
	// noticeMsg 是本地提示（桩功能/剪贴板等），只更新状态行。
	noticeMsg string
	// tickMsg 每秒推进一次"当前时刻"，只服务状态行的时长显示。
	tickMsg time.Time
	// openRequestMsg 是正文已落盘、等待外部打开。
	openRequestMsg struct {
		path string
		err  error
	}
	// openDoneMsg 是外部程序退出后的回执。
	openDoneMsg struct{ err error }

	// envListMsg 是 environment/list 的结果（已折成行）。
	envListMsg struct {
		rows []row
		err  error
	}
	// envSelectMsg 是 environment/select 的结果。
	envSelectMsg struct {
		envID     string
		sessionID string
		err       error
	}
	// sessionsMsg 是 GET /sessions 的结果。
	sessionsMsg struct {
		rows []row
		err  error
	}
	// lineSwitchMsg 是 POST /sessions/switch 的结果。
	lineSwitchMsg struct {
		sessionID string
		err       error
	}
	// taskListMsg 是 task/list 的结果。
	taskListMsg struct {
		rows []row
		err  error
	}
	// archiveMsg 是 archive/list 的结果（已按 kind 分组）。
	archiveMsg struct {
		groups []archiveGroup
		ents   []client.ArchiveEntity
		brief  *client.ArchiveBrief
		err    error
	}
	// modelRefreshDoneMsg 是 model/refresh 的结果。
	modelRefreshDoneMsg struct {
		info client.ModelRefreshInfo
		err  error
	}
	// wireMsg 是只读回看的 wire 消息加载结果。
	wireMsg struct {
		lineID string
		title  string
		page   wirePage
		err    error
	}
)

// Init 只"声明"IO 不执行它：先探活，再订阅。
//
// Init 放在 update.go 而不是 model.go，是为了让"发起 IO 的地方只有
// update.go"这条边界在 grep 层面也成立。
func (m Model) Init() tea.Cmd {
	if m.Client == nil {
		return nil
	}
	return tea.Batch(healthCmd(m.Ctx, m.Client), subscribeCmd(m.Ctx, m.Client, m.SubGen))
}

// Update 是唯一发起 IO 的地方。
func (m Model) Update(msg tea.Msg) (Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.Width, m.Height = msg.Width, msg.Height
		m.layout()
		return m, nil

	case tea.KeyMsg:
		return m.handleKey(msg)

	case tea.MouseMsg:
		return m.handleMouse(msg)

	case subscribedMsg:
		if msg.err != nil {
			m.StreamErr = msg.err.Error()
			m.Connected = false
			return m, nil
		}
		m.Sub = msg.sub
		m.SubGen = msg.gen
		m.Connected = true
		m.StreamErr = ""
		return m, waitForEvent(msg.sub, msg.gen)

	case EventMsg:
		ev := protocol.Event(msg)
		m.EventCounts[ev.Kind]++
		wasRunning := m.Running()
		m.applyEvent(ev)
		if m.Running() && !wasRunning {
			// turn 起点只在 idle→running 那一次记：之后每个 chunk 都不该重置秒表。
			m.TaskStarted = time.Now()
			m.TurnDuration = 0
		}
		// 「让人选择」的请求到了就弹面板（已有面板时不抢焦点，排队等前一个答完）。
		m.autoOpenChoice()
		archiveCmd := m.refreshOpenArchive(ev.Kind)
		var cmds []tea.Cmd
		if archiveCmd != nil {
			cmds = append(cmds, archiveCmd)
		}
		if m.Running() {
			if c := m.ensureTick(); c != nil {
				cmds = append(cmds, c)
			}
		}
		if m.Sub != nil {
			cmds = append(cmds, waitForEvent(m.Sub, m.SubGen))
		}
		return m, tea.Batch(cmds...)

	case streamEndMsg:
		if msg.gen != m.SubGen {
			return m, nil // 旧订阅的收尾，忽略
		}
		m.Connected = false
		if msg.err != nil {
			m.StreamErr = msg.err.Error()
		}
		return m, nil

	case healthMsg:
		if msg.err != nil {
			m.LastErr = "sidecar 不可达：" + msg.err.Error()
			return m, nil
		}
		return m, nil

	case sendMsg:
		switch {
		case msg.err != nil:
			m.LastErr = "发送失败：" + msg.err.Error()
		case !msg.result.Success:
			m.LastErr = "发送被拒：" + msg.result.Error
		case msg.result.Queued:
			m.LastNotice = "已入队"
		default:
			m.LastErr = ""
		}
		return m, nil

	case imageLoadedMsg:
		if msg.err != nil {
			m.LastErr = "附加图片失败：" + msg.err.Error()
			return m, nil
		}
		m.addPendingImage(msg.img)
		return m, nil

	case searchResultMsg:
		if ov, ok := m.TopOverlay(); ok {
			if s, isSearch := ov.(*searchOverlay); isSearch {
				s.loading = false
				if msg.err != nil {
					s.note = "检索失败：" + msg.err.Error()
				} else {
					s.hits = msg.hits
					s.sel = 0
					s.note = fmt.Sprintf("%d 条命中（Enter 展开）", len(msg.hits))
				}
			}
		}
		return m, nil

	case sessionWriteDoneMsg:
		if msg.err != nil {
			m.LastErr = "会话操作失败：" + msg.err.Error()
			return m, nil
		}
		m.LastNotice = map[string]string{
			"archive": "已更新归档状态",
			"rename":  "已重命名会话",
			"delete":  "已删除会话",
		}[msg.op]
		if ov, ok := m.TopOverlay(); ok {
			if l, isLine := ov.(*lineOverlay); isLine {
				return m, l.reload(&m)
			}
		}
		return m, nil

	case archiveOpDoneMsg:
		if msg.err != nil {
			m.LastErr = "档案操作失败：" + msg.err.Error()
			return m, nil
		}
		m.LastNotice = map[string]string{
			"resolve": "已证实/解决：" + msg.id,
			"correct": "已记录纠正：" + msg.id,
			"abandon": "已搁置：" + msg.id,
		}[msg.op]
		if ov, ok := m.TopOverlay(); ok {
			if a, isArchive := ov.(*archiveOverlay); isArchive {
				a.note = m.LastNotice
				return m, a.reload(&m)
			}
		}
		return m, nil

	case envOpDoneMsg:
		if msg.err != nil {
			m.LastErr = "环境操作失败：" + msg.err.Error()
			return m, nil
		}
		m.LastNotice = map[string]string{
			"down":   "已停止环境",
			"rm":     "已删除环境",
			"rename": "已重命名环境",
		}[msg.op]
		if ov, ok := m.TopOverlay(); ok {
			if e, isEnv := ov.(*envOverlay); isEnv {
				return m, e.reload(&m)
			}
		}
		return m, nil

	case recipesLoadedMsg:
		if ov, ok := m.TopOverlay(); ok {
			if r, isRecipes := ov.(*recipesOverlay); isRecipes {
				if msg.err != nil {
					r.state = loadFailed
					r.err = msg.err.Error()
				} else {
					r.rows = msg.rows
					r.state = loadReady
				}
			}
		}
		return m, nil

	case modelRefreshDoneMsg:
		if msg.err != nil {
			m.LastErr = "刷新模型目录失败：" + msg.err.Error()
			return m, nil
		}
		ok, models := 0, 0
		failed := make([]string, 0, len(msg.info.Results))
		for _, r := range msg.info.Results {
			if r.Error != "" {
				failed = append(failed, r.ID)
				continue
			}
			ok++
			models += r.ModelsFetched
		}
		m.LastNotice = fmt.Sprintf("模型目录已刷新：%d 个供应商 / %d 个模型", ok, models)
		if len(failed) > 0 {
			m.LastNotice += "（失败：" + strings.Join(failed, "、") + "）"
		}
		return m, nil

	case reportExportDoneMsg:
		if msg.err != nil {
			m.LastErr = "导出失败：" + msg.err.Error()
			return m, nil
		}
		m.LastNotice = fmt.Sprintf(
			"报告已生成：结论 %d 条 · 证据 %d 项 → %s",
			msg.info.FindingCount, msg.info.EvidenceCount, msg.info.ReportDir,
		)
		body := "目录: " + msg.info.ReportDir +
			"\n入口: index.md（摘要 + 漏洞清单）" +
			"\n结论文件: " + fmt.Sprintf("%d 份（findings/）", msg.info.FindingCount) +
			"\n证据回收: " + fmt.Sprintf("%d 项（evidence/）", msg.info.EvidenceCount)
		if msg.info.ArchivePath != "" {
			body += "\n打包: " + msg.info.ArchivePath
		}
		if msg.info.DownloadID != "" {
			body += "\n下载: " + strings.TrimSuffix(m.Server, "/") + "/report/download/" + msg.info.DownloadID +
				"\n  （开鉴权时浏览器需带 token；curl 用 Authorization: Bearer）"
		}
		if len(msg.info.Degraded) > 0 {
			body += "\n降级 " + fmt.Sprintf("%d 项:", len(msg.info.Degraded)) +
				"\n  " + strings.Join(msg.info.Degraded, "\n  ")
		}
		m.addNotice(store.KindNotice, "report", body)
		return m, nil

	case autoRunRefreshedMsg:
		if msg.err != nil {
			if ov, ok := m.TopOverlay(); ok {
				if a, isAuto := ov.(*autoRunOverlay); isAuto {
					a.err = msg.err.Error()
				}
			}
			return m, nil
		}
		if msg.record != nil {
			m.AutoRun = msg.record
		} else if msg.records != nil {
			if ov, ok := m.TopOverlay(); ok {
				if a, isAuto := ov.(*autoRunOverlay); isAuto {
					a.records = msg.records
				}
			}
		}
		return m, nil

	case autoRunStartDoneMsg:
		if msg.err != nil {
			m.LastErr = "启动失败：" + msg.err.Error()
			return m, nil
		}
		m.LastNotice = "自动循环已启动：" + msg.id
		return m, loadAutoRunCmd(m.Ctx, m.Admin, m.AutoRun)

	case autoRunStopDoneMsg:
		if msg.err != nil {
			m.LastErr = "终止失败：" + msg.err.Error()
			return m, nil
		}
		m.LastNotice = "已终止自动循环"
		if m.AutoRun != nil && m.AutoRun.ID == msg.id {
			m.AutoRun.Status = "stopped"
		}
		if ov, ok := m.TopOverlay(); ok {
			if a, isAuto := ov.(*autoRunOverlay); isAuto {
				a.note = "已终止"
			}
		}
		return m, nil

	case queueCancelDoneMsg:
		if msg.err != nil {
			m.LastErr = "撤销失败：" + msg.err.Error()
			return m, nil
		}
		m.queueRemove(msg.id)
		m.LastNotice = "已撤销排队消息"
		if ov, ok := m.TopOverlay(); ok {
			if q, isQueue := ov.(*queueOverlay); isQueue {
				q.note = "已撤销"
				if q.sel >= len(m.Queued) {
					q.sel = len(m.Queued) - 1
				}
				if q.sel < 0 {
					q.sel = 0
				}
			}
		}
		return m, nil

	case sessionOpDoneMsg:
		if msg.err != nil {
			m.LastErr = "会话操作失败：" + msg.err.Error()
			return m, nil
		}
		m.LastNotice = map[string]string{
			"reset":  "会话已重置",
			"rewind": "已回退，正在重新载入历史",
			"fork":   "已分叉，正在重新载入历史",
		}[msg.op]
		// 三个动作都会改变服务端历史：重连一次拿回权威回放。
		return m, m.reconnect()

	case modelSwitchDoneMsg:
		if msg.err != nil {
			m.LastErr = "切模型失败：" + msg.err.Error()
			return m, nil
		}
		m.ModelID = msg.model
		m.LastNotice = "已切换到 " + msg.model
		return m, nil

	case atLoadedMsg:
		m.AtLoaded = true
		m.AtLoading = false
		if msg.err == nil {
			m.AtFiles = msg.files
		}
		m.At = buildAtMenu(m.Input.Value(), m.AtFiles)
		return m, nil

	case modelsLoadedMsg:
		ov, ok := m.TopOverlay()
		if !ok {
			return m, nil
		}
		mo, isModel := ov.(*modelOverlay)
		if !isModel {
			return m, nil
		}
		if msg.err != nil {
			mo.fail(msg.err)
			return m, nil
		}
		rows := make([]row, 0, len(msg.options))
		for _, o := range msg.options {
			r := row{Key: o.ProviderID + "|" + o.Model, Title: o.Model, Desc: o.Provider}
			if o.Status != "" && o.Status != "valid" {
				r.Desc += "  key:" + o.Status
				r.Dim = true
			}
			if o.Current {
				r.Flag = "当前"
			}
			rows = append(rows, r)
		}
		mo.setRows(rows)
		return m, nil

	case taskDetailMsg:
		if msg.err != nil {
			m.LastErr = "任务详情加载失败：" + msg.err.Error()
			return m, nil
		}
		m.PushOverlay(newDetailOverlay("任务 · "+msg.detail.ID, taskDetailBody(msg.detail)))
		return m, nil

	case taskOpDoneMsg:
		if msg.err != nil {
			m.LastErr = "任务操作失败：" + msg.err.Error()
			return m, nil
		}
		if msg.op == "rerun" {
			m.LastNotice = "已重新武装任务"
		} else {
			m.LastNotice = "已终止任务"
		}
		if ov, ok := m.TopOverlay(); ok {
			if t, isTask := ov.(*taskOverlay); isTask {
				return m, t.reload(&m)
			}
		}
		return m, nil

	case choiceRespondedMsg:
		if msg.err != nil {
			m.LastErr = "应答失败：" + msg.err.Error()
			return m, nil
		}
		m.removeChoice(msg.id)
		if top, ok := m.TopOverlay(); ok {
			if o, isChoice := top.(*choiceOverlay); isChoice && o.id == msg.id {
				m.PopOverlay()
			}
		}
		m.LastNotice = "已应答"
		// 还有排队的选择就把下一个弹出来。
		if len(m.Choices) > 0 {
			m.PushOverlay(newChoiceOverlay(m.Choices[0].id))
		}
		return m, nil

	case cliResultMsg:
		body := msg.out
		if strings.TrimSpace(body) == "" {
			body = "(无输出)"
		}
		if _, ok := m.Store.Get(msg.id); ok {
			m.Store.Mutate(msg.id, func(b *store.Block) bool {
				b.Body = body
				b.Failed = !msg.ok
				b.Live = false
				b.Duration = msg.dur
				return true
			})
		} else {
			// 极端情况（重连后块表被换掉）：别把结果丢掉。
			m.addNotice(store.KindTool, "zhishi", body)
		}
		m.ScrollLines = 0
		return m, nil

	case stopMsg:
		if msg.err != nil {
			m.LastErr = "中断失败：" + msg.err.Error()
		} else {
			m.LastNotice = "已请求中断"
		}
		return m, nil

	case noticeMsg:
		m.LastNotice = string(msg)
		return m, nil

	case tickMsg:
		m.Now = time.Time(msg)
		if m.Running() {
			return m, tickCmd()
		}
		// turn 结束：停表，避免空转的定时器把 CPU 一直叫醒。
		m.Ticking = false
		return m, nil

	case openRequestMsg:
		if msg.err != nil {
			m.LastErr = "外部打开失败：" + msg.err.Error()
			return m, nil
		}
		m.LastNotice = "已写到临时文件：" + msg.path
		return m, openCmd(m.Open, msg.path)

	case openDoneMsg:
		if msg.err != nil {
			m.LastErr = "外部程序退出异常：" + msg.err.Error()
			return m, nil
		}
		m.LastNotice = "已从外部程序返回"
		return m, nil

	case envListMsg:
		// 回包写回**它自己那一层**：用户在加载途中可能又开了别的面板。
		if ov, ok := lastOverlayOf[*envOverlay](&m); ok {
			ov.apply(msg.rows, msg.err)
			ov.syncSelection(&m) // 光标落在第一条上，Alt+s 立刻有目标
		}
		return m, nil

	case envSelectMsg:
		ov, opened := lastOverlayOf[*envOverlay](&m)
		if msg.err != nil {
			if opened {
				ov.note = "切换失败：" + msg.err.Error()
			}
			m.LastErr = "环境切换失败：" + msg.err.Error()
			return m, nil
		}
		if opened {
			m.PopOverlay()
		}
		m.EnvironmentID = msg.envID
		m.SelectedEnvID = msg.envID
		return m, m.afterLineSwitch("已切到环境 " + msg.envID)

	case sessionsMsg:
		// 线面板与历史回看用同一份数据源（GET /sessions），两层各自持有状态，
		// 谁在场就喂谁——不能只认其中一种，否则另一层永远停在"加载中"。
		if ov, ok := lastOverlayOf[*lineOverlay](&m); ok {
			ov.apply(msg.rows, msg.err)
		}
		if ov, ok := lastOverlayOf[*historyOverlay](&m); ok {
			ov.apply(msg.rows, msg.err)
		}
		return m, nil

	case lineSwitchMsg:
		ov, opened := lastOverlayOf[*lineOverlay](&m)
		if msg.err != nil {
			if opened {
				ov.note = "切线失败：" + msg.err.Error()
			}
			m.LastErr = "切线失败：" + msg.err.Error()
			return m, nil
		}
		if opened {
			m.PopOverlay()
		}
		return m, m.afterLineSwitch("已切换会话线")

	case taskListMsg:
		if ov, ok := lastOverlayOf[*taskOverlay](&m); ok {
			ov.apply(msg.rows, msg.err)
		}
		return m, nil

	case archiveMsg:
		if ov, ok := lastOverlayOf[*archiveOverlay](&m); ok {
			ov.apply(msg.groups, msg.err, msg.ents, msg.brief)
		}
		return m, nil

	case wireMsg:
		return m.handleWire(msg)
	}
	return m, nil
}

// handleWire 把 wire 结果落成一个只读回看覆盖层（压在历史列表之上）。
func (m Model) handleWire(msg wireMsg) (Model, tea.Cmd) {
	hist, opened := lastOverlayOf[*historyOverlay](&m)
	if msg.err != nil {
		if opened {
			hist.note = "加载失败：" + msg.err.Error()
		}
		m.LastErr = "回看加载失败：" + msg.err.Error()
		return m, nil
	}
	msgs := msg.page.messages
	total := msg.page.total
	if total < len(msgs) {
		total = len(msgs)
	}
	kept := msgs
	if len(kept) > wireWindow {
		kept = kept[len(kept)-wireWindow:]
	}
	if opened {
		hist.note = ""
	}
	m.PushOverlay(newReplayOverlay(msg.title, msg.lineID, replayWire(kept), replayNote(total, len(kept))))
	return m, nil
}

// handleKey 按 Route 的三段式结果分派。除 ActionInput 外都不碰输入框。
func (m Model) handleKey(msg tea.KeyMsg) (Model, tea.Cmd) {
	action := Route(m, msg)
	switch action {
	case ActionInput:
		var cmd tea.Cmd
		// Windows 剪贴板是 CRLF：bubbles 的清洗器会把 \r 和 \n 各自替换成
		// 换行，粘贴出来每行之间多一个空行。先归一成 LF 再交给 textarea。
		if len(msg.Runes) > 1 {
			msg.Runes = normalizePastedNewlines(msg.Runes)
		}
		m.Input, cmd = m.Input.Update(msg)
		// 候选完全由输入内容派生：每敲一个字符重算一次（模板只有 20 来条，
		// 比"维护一份可见性状态机"便宜得多，也不会出现状态不同步）。
		m.Menu = buildSlashMenu(m.Input.Value())
		atCmd := m.refreshAt()
		m.layout()
		if atCmd != nil {
			return m, tea.Batch(cmd, atCmd)
		}
		return m, cmd

	case ActionMenuUp:
		m.Menu.move(-1)
		return m, nil

	case ActionMenuDown:
		m.Menu.move(1)
		return m, nil

	case ActionMenuAccept:
		m.acceptSlashMenu()
		return m, nil

	case ActionAtUp:
		m.At.move(-1)
		return m, nil

	case ActionAtDown:
		m.At.move(1)
		return m, nil

	case ActionAtAccept:
		m.applyAt()
		return m, nil

	case ActionChoices:
		if len(m.Choices) == 0 {
			return m, noticeCmd("当前没有待答的选择")
		}
		if top, ok := m.TopOverlay(); ok {
			if _, isChoice := top.(*choiceOverlay); isChoice {
				return m, nil
			}
		}
		m.PushOverlay(newChoiceOverlay(m.Choices[0].id))
		return m, nil

	case ActionToggleMouse:
		// 鼠标上报被程序接管时，终端的原生拖选是失效的（拖拽事件被我们吃掉）。
		// 关掉捕获，终端就能选字复制；再按一次恢复滚轮/点块头。
		m.MouseOn = !m.MouseOn
		if m.MouseOn {
			m.LastNotice = "鼠标已接管：滚轮/点块头可用（此时拖选不可用）；Alt+m/F2 交还"
			return m, tea.EnableMouseCellMotion
		}
		m.LastNotice = "鼠标已交还终端：直接拖选复制；Alt+m/F2 恢复滚轮/点块头"
		return m, tea.DisableMouse

	case ActionOverlayKey:
		// 栈顶那一层独占按键；它返回的 Cmd 仍然由 update 执行。
		ov, ok := m.TopOverlay()
		if !ok {
			return m, nil
		}
		return m, ov.Handle(&m, msg)

	case ActionCursorUp, ActionCursorDown:
		n := len(m.VisibleBlocks())
		if n == 0 {
			return m, nil
		}
		if action == ActionCursorUp {
			m.Cursor--
		} else {
			m.Cursor++
		}
		if m.Cursor < 0 {
			m.Cursor = 0
		}
		if m.Cursor >= n {
			m.Cursor = n - 1
		}
		m.CursorTouched = true
		// 光标移出视口时必须跟着滚：屏幕不动的话，往上翻十几下就完全看不到
		// 自己在选哪一块了（"移过去了但屏幕没动"就是这么来的）。
		m.ensureCursorVisible()
		return m, nil

	case ActionToggleExpand:
		return m, m.toggleTargetBlock()

	case ActionCopy:
		return m, m.copyTargetBlock()

	case ActionOpenExternal:
		b, ok := m.targetBlock()
		if !ok {
			return m, noticeCmd("没有选中的块")
		}
		if strings.TrimSpace(b.Body) == "" {
			return m, noticeCmd("这个块没有正文")
		}
		return m, writeTempCmd(blockFileName(b), b.Body)

	case ActionFilterFailed:
		m.toggleFailedFilter()
		return m, nil

	case ActionCommandPalette:
		m.PushOverlay(newPaletteOverlay())
		return m, nil

	case ActionActionLayer:
		m.PushOverlay(newNoticeOverlay("动作层", "M2a 空壳：动作层尚未接入。Esc 关闭。"))
		return m, nil

	case ActionHelp:
		m.PushOverlay(&helpOverlay{})
		return m, nil

	case ActionSession:
		m.PushOverlay(newSessionOverlay(&m))
		return m, nil

	case ActionQueue:
		m.PushOverlay(newQueueOverlay())
		return m, nil

	case ActionSearch:
		m.PushOverlay(newSearchOverlay())
		return m, nil

	case ActionDropImage:
		if len(m.PendingImages) == 0 {
			return m, noticeCmd("没有待发送的附图")
		}
		last := m.PendingImages[len(m.PendingImages)-1]
		m.PendingImages = m.PendingImages[:len(m.PendingImages)-1]
		m.LastNotice = fmt.Sprintf("已移除附图 %s（剩 %d 张）", last.Name, len(m.PendingImages))
		return m, nil

	case ActionImage:
		m.PushOverlay(newPromptOverlay("附加图片", "图片路径（可把文件拖进终端，或粘贴路径）",
			func(m *Model, path string) tea.Cmd {
				return loadImageCmd(path)
			}))
		return m, nil

	case ActionAutoRun:
		ov := newAutoRunOverlay()
		m.PushOverlay(ov)
		return m, loadAutoRunCmd(m.Ctx, m.Admin, m.AutoRun)

	case ActionEnvOverlay:
		return m, m.openEnvOverlay()

	case ActionLineOverlay:
		return m, m.openLineOverlay()

	case ActionTaskOverlay:
		return m, m.openTaskOverlay()

	case ActionArchiveOverlay:
		return m, m.openArchiveOverlay()

	case ActionHistoryOverlay:
		return m, m.openHistoryOverlay()

	case ActionTabComplete:
		// 斜杠候选在场时 Tab = 接受（路由已先行拦截）；否则仍是桩：
		// 普通补全要接 sidecar 的补全源。
		if m.MenuRows() > 0 {
			m.acceptSlashMenu()
			return m, nil
		}
		return m, noticeCmd("补全（Tab）在 M1 未实现")

	case ActionCloseOverlay:
		// Esc 的优先级：先收候选，再退覆盖层。两层一起关会让人少一次撤销。
		if _, overlayOpen := m.TopOverlay(); m.Menu != nil && !overlayOpen {
			m.Menu = nil
			m.layout()
			return m, nil
		}
		m.PopOverlay()
		return m, nil

	case ActionSend:
		// @ 候选在场时 Enter = 接受补全，不发送（和斜杠菜单同一套手感）。
		if m.AtRows() > 0 {
			m.applyAt()
			return m, nil
		}
		text := strings.TrimSpace(m.Input.Value())
		// 只有图片没有文字也是合法消息（服务端允许）。
		if text == "" && len(m.PendingImages) == 0 {
			return m, nil
		}
		// 候选在场且没完全敲成选中项 → Enter 先补全（/mod → /model ），
		// 再按一次才执行。完全一致时直接执行，免得单命令（/status）要多按一下。
		if it, ok := m.Menu.selected(); ok && m.MenuRows() > 0 {
			if strings.TrimSpace(it.Insert) != text {
				m.acceptSlashMenu()
				return m, nil
			}
		}
		m.Input.Reset()
		m.Menu = nil
		m.layout()
		m.ScrollLines = 0 // 自己发的消息一定要看得到
		// 以 / 开头 = CLI 子命令（见 slash.go）；否则是会话消息。
		if args, isSlash := parseSlash(text); isSlash {
			return m, m.startCLI(args)
		}
		// 本地先回显一条用户消息：流里只有助手输出，不回显的话自己发了什么
		// 在画面上完全消失（对照 Warp / Claude Code 的对话结构）。
		images := m.PendingImages
		echo := text
		if len(images) > 0 {
			names := make([]string, 0, len(images))
			for _, img := range images {
				names = append(names, "["+img.Name+"]")
			}
			echo = strings.TrimSpace(echo + "  " + strings.Join(names, " "))
		}
		m.addLocalUserEcho(echo)
		m.clearPendingImages()
		return m, sendCmd(m.Ctx, m.Client, text, client.SendOptions{
			PermissionMode: m.PermissionMode,
			Refs:           m.extractRefs(text),
			Images:         images,
		})

	case ActionNewline:
		m.Input.InsertString("\n")
		m.layout()
		return m, nil

	case ActionScrollLineUp:
		// 键盘方向键一次一行；滚轮（走鼠标事件）才用 mouseScroll 步长。
		m.scrollBy(1)
		return m, nil

	case ActionScrollLineDown:
		m.scrollBy(-1)
		return m, nil

	case ActionScrollPageUp:
		m.scrollBy(m.StreamHeight() - pageScroll)
		return m, nil

	case ActionScrollPageDown:
		m.scrollBy(-(m.StreamHeight() - pageScroll))
		return m, nil

	case ActionScrollBottom:
		m.ScrollLines = 0
		return m, nil

	case ActionQuitOrInterrupt:
		// 跑着就中断；空转时两次 Ctrl+C 退出（第一次只是示警）——
		// 单次 Ctrl+C 立刻退出会让人把"想中断 turn"和"想退出"混在一起。
		if m.Running() {
			// 中断本身就是一次完整动作，不顺手武装退出：否则"中断后想继续
			// 观察"会被下一次误按直接杀掉。
			return m, stopCmd(m.Ctx, m.Client)
		}
		if m.QuitArmed {
			m.Quit = true
			return m, tea.Quit
		}
		m.QuitArmed = true
		m.LastNotice = "再按一次 Ctrl+C 退出"
		return m, nil
	}
	return m, nil
}

// handleMouse 处理滚轮与点击。
//
// 点击只认"块头那一行"：块体大部分是正文，误点就折叠会让选择文本变得不可
// 能；而块头是稳定的窄目标（strix 的 eventSpan 也是按块边界命中的）。
func (m Model) handleMouse(msg tea.MouseMsg) (Model, tea.Cmd) {
	logMouseEvent("raw", msg, m)
	if _, open := m.TopOverlay(); open {
		return m, nil // 面板打开时鼠标不作用于底稿
	}
	// 松开事件的 Button 是 MouseButtonNone（bubbletea 的解析：X10 把 release 报成
	// button 3）——所以必须先按 Action 判，不能按 Button 分派，否则拖选永远收不了尾。
	if msg.Action == tea.MouseActionRelease && (m.Sel.down || m.Sel.active) {
		return m.handleLeftMouse(msg)
	}
	switch msg.Button {
	case tea.MouseButtonWheelUp:
		if msg.Action == tea.MouseActionPress {
			m.scrollBy(mouseScroll)
		}
		return m, nil
	case tea.MouseButtonWheelDown:
		if msg.Action == tea.MouseActionPress {
			m.scrollBy(-mouseScroll)
		}
		return m, nil
	case tea.MouseButtonLeft:
		return m.handleLeftMouse(msg)
	default:
		return m, nil
	}
}

// handleLeftMouse 区分两种手势：
//   - 按下不拖 → 点块头折叠（原行为）
//   - 按住拖动 → 应用层选字，松开即复制
//
// 为什么要在应用层做选字：终端一旦向上报鼠标（滚轮要用），原生拖选就被吃掉。
// 想要"既能滚又能选"只有自己算选中范围这一条路——`F2` 释放鼠标仍是原生选择的
// 备用通道。
func (m Model) handleLeftMouse(msg tea.MouseMsg) (Model, tea.Cmd) {
	if m.Frame == nil || m.Frame.width != m.Width || m.Frame.height != m.Height {
		logMouseEvent("no-frame", msg, m)
		return m, nil // 投影与当前尺寸不符（还没渲染过 / 刚 resize）
	}
	switch msg.Action {
	case tea.MouseActionPress:
		m.Sel = selState{down: true, sx: msg.X, sy: msg.Y, ex: msg.X, ey: msg.Y}
		// 点块头：立即折叠，并且这次手势不再当拖选。
		if row := msg.Y - m.Frame.streamTop; row >= 0 && row < len(m.Frame.rows) {
			hit := m.Frame.rows[row]
			if hit.ID != "" && hit.Head {
				m.Sel.down = false
				if m.toggleExpand(hit.ID) {
					if i := m.indexOfVisible(hit.ID); i >= 0 {
						m.Cursor = i
						m.CursorTouched = true
					}
				}
			}
		}
		return m, nil
	case tea.MouseActionMotion:
		if !m.Sel.down {
			return m, nil
		}
		m.Sel.ex, m.Sel.ey = msg.X, msg.Y
		if absInt(msg.X-m.Sel.sx)+absInt(msg.Y-m.Sel.sy) >= 2 {
			m.Sel.active = true
		}
		return m, nil
	case tea.MouseActionRelease:
		if !m.Sel.down {
			return m, nil
		}
		// 有些终端/驱动不投递 motion（或中途丢了），松手的坐标才是准的——
		// 用它补终点，并按"确实移动过"判定是不是拖选。
		m.Sel.ex, m.Sel.ey = msg.X, msg.Y
		if absInt(m.Sel.ex-m.Sel.sx)+absInt(m.Sel.ey-m.Sel.sy) >= 2 {
			m.Sel.active = true
		}
		active := m.Sel.active
		m.Sel.down, m.Sel.active = false, false
		if !active {
			return m, nil
		}
		text := m.selectedText()
		if strings.TrimSpace(text) == "" {
			m.LastNotice = "没有选中文本（拖到正文上再松开）"
			return m, nil
		}
		m.LastNotice = fmt.Sprintf("已复制 %d 行（拖选）", strings.Count(text, "\n")+1)
		return m, copyCmd(text)
	}
	return m, nil
}

func absInt(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// ansiRe 匹配 SGR 颜色/样式序列——抽选中的文本时要去掉，否则复制出去是乱码。
var ansiRe = regexp.MustCompile("\x1b\\[[0-9;]*[a-zA-Z]")

func stripANSI(s string) string { return ansiRe.ReplaceAllString(s, "") }

// selectedText 按拖选的起止坐标从当前帧抽文本（行优先、跨行拼接）。
//
// 列坐标按**字符**近似（宽字符占两列时会有 1 格偏差）——比按显示宽度做
// 全量换算便宜得多，选中文/表格时最多少选半个字。
func (m Model) selectedText() string {
	if m.Frame == nil || len(m.Frame.lines) == 0 {
		return ""
	}
	y1, x1 := m.Sel.sy-m.Frame.streamTop, m.Sel.sx
	y2, x2 := m.Sel.ey-m.Frame.streamTop, m.Sel.ex
	if y1 > y2 || (y1 == y2 && x1 > x2) {
		y1, y2, x1, x2 = y2, y1, x2, x1
	}
	if y1 < 0 {
		y1, x1 = 0, 0
	}
	if y2 >= len(m.Frame.lines) {
		y2 = len(m.Frame.lines) - 1
	}
	// 从输入框/状态行往上拖：起点不在 stream 里，夹到最后一行，别把整段丢空。
	if y1 >= len(m.Frame.lines) {
		y1 = len(m.Frame.lines) - 1
	}
	if y2 < 0 {
		y2 = 0
	}
	var out []string
	for y := y1; y <= y2 && y < len(m.Frame.lines); y++ {
		runes := []rune(stripANSI(m.Frame.lines[y]))
		start, end := 0, len(runes)
		if y == y1 {
			start = x1
		}
		if y == y2 {
			end = x2
		}
		if start < 0 {
			start = 0
		}
		if end > len(runes) {
			end = len(runes)
		}
		if start >= end {
			continue
		}
		out = append(out, strings.TrimRight(string(runes[start:end]), " "))
	}
	return strings.TrimSpace(strings.Join(out, "\n"))
}

// ── 覆盖层入口 ──────────────────────────────────────────────────────────
// 四个入口被 Alt+字母与命令面板条目共用：两处各写一份一定会漂。

func (m *Model) openEnvOverlay() tea.Cmd {
	ov := newEnvOverlay()
	m.PushOverlay(ov)
	return ov.reload(m)
}

func (m *Model) openLineOverlay() tea.Cmd {
	ov := newLineOverlay()
	m.PushOverlay(ov)
	return ov.reload(m)
}

func (m *Model) openTaskOverlay() tea.Cmd {
	ov := newTaskOverlay()
	m.PushOverlay(ov)
	return ov.reload(m)
}

func (m *Model) openArchiveOverlay() tea.Cmd {
	ov := newArchiveOverlay()
	m.PushOverlay(ov)
	return ov.reload(m)
}

func (m *Model) openHistoryOverlay() tea.Cmd {
	ov := newHistoryOverlay()
	m.PushOverlay(ov)
	return ov.reload(m)
}

// reconnect 丢掉旧订阅并重新订阅。
//
// SubGen++ 让旧通道的收尾消息（streamEndMsg）作废——否则旧通道关闭会在
// 新订阅刚建立之后把 Connected 改回 false。
//
// 不改提示文案：调用方刚做了什么它自己最清楚（切线/切环境的提示不能被
// "正在重连…"顶掉）。
func (m *Model) reconnect() tea.Cmd {
	if m.Sub != nil {
		m.Sub.Close()
		m.Sub = nil
	}
	m.Connected = false
	m.StreamErr = ""
	m.SubGen++
	return subscribeCmd(m.Ctx, m.Client, m.SubGen)
}

// ── 事件归约 ────────────────────────────────────────────────────────────
// applyEvent 是纯函数式的：只改 Model，不发 IO。

func (m *Model) applyEvent(ev protocol.Event) {
	switch ev.Kind {
	case protocol.KindInit:
		if ev.SessionState != "" {
			m.SessionSt = ev.SessionState
		}
		if ev.SessionID != "" {
			m.SessionID = ev.SessionID
		}
		// agentDir 是本会话的工作目录，管理面 environment/select 的 workspace
		// 只能从这里来——TUI 没有第二个来源。
		if ev.AgentDir != "" {
			m.Workspace = ev.AgentDir
		}
		if ev.EnvID != "" {
			m.EnvironmentID = ev.EnvID
		}

	case protocol.KindStatus:
		if ev.SessionState != "" {
			m.SessionSt = ev.SessionState
		}
		if ev.SessionID != "" {
			m.SessionID = ev.SessionID
		}

	case protocol.KindMessageReplay:
		m.applySnapshot(ev.Snapshot)

	case protocol.KindMessageChunk:
		m.appendAssistant(ev.Text)

	case protocol.KindMessageComplete:
		m.finalizeAssistant()
		if ev.Model != "" {
			m.ModelID = ev.Model
		}
		m.TurnDuration = time.Duration(ev.DurationMS) * time.Millisecond
		// usage 是**每次调用**的量（不是累计），所以累加得到整条会话的消耗。
		m.UsageTokens += ev.InputTokens + ev.OutputTokens
		m.SessionSt = "idle"

	case protocol.KindMessageError:
		m.finalizeAssistant()
		m.addNotice(store.KindError, "error", ev.Text)
		m.SessionSt = "idle"

	case protocol.KindMessageStopped:
		m.finalizeAssistant()
		m.addNotice(store.KindNotice, "stop", "已中断（Esc / Ctrl+C）")
		m.SessionSt = "idle"

	case protocol.KindThinkingStart:
		m.ensureLive(store.Block{ID: m.thinkingID(), Kind: store.KindThinking})

	case protocol.KindThinkingChunk:
		id := m.thinkingID()
		m.ensureLive(store.Block{ID: id, Kind: store.KindThinking})
		m.Store.Mutate(id, func(b *store.Block) bool {
			b.Body += ev.Delta
			b.Live = true
			return true
		})

	case protocol.KindThinkingDone:
		id := m.thinkingID()
		m.Store.Mutate(id, func(b *store.Block) bool {
			b.Live = false
			return true
		})

	case protocol.KindToolUseStart:
		// 关键：调用工具前必须把当前助手气泡"封段"。
		// 一个 turn 里 sidecar 只在最后发 message-complete，中间调工具时没有
		// 分界；不主动换段的话，工具之后的总结会被追加进**工具之前**那条块里，
		// 屏幕上就是"工具输出在最下面，总结跑到上面去了"。
		m.rotAssistantSegment()
		id := "tool:" + ev.ToolID
		m.ToolStarted[ev.ToolID] = time.Now()
		title := ev.ToolName
		if title == "" {
			title = "tool"
		}
		m.ensureLive(store.Block{ID: id, Kind: store.KindTool, Title: title})
		m.SessionSt = "running"

	case protocol.KindToolResult:
		m.finishTool(ev)

	case protocol.KindContextUsage:
		m.ContextUsed = ev.ContextUsed
		m.ContextWindow = ev.ContextWindow

	case protocol.KindSystemInit:
		if ev.SessionID != "" {
			m.SessionID = ev.SessionID
		}

	case protocol.KindQueueAdded:
		// 按 queueId 去重：重连时 sidecar 会把在途队列逐条重放一遍，
		// 盲自增会让"队列 N"越连越大。
		m.queueAdd(ev.QueueID, queuePreview(ev.Text), ev.Status)
		m.addNotice(store.KindNotice, "queue", "消息已排队")

	case protocol.KindQueueCancelled:
		m.queueRemove(ev.QueueID)

	case protocol.KindSubagentStart:
		if ev.TaskID != "" {
			m.Subagents[ev.TaskID] = struct{}{}
		}

	case protocol.KindSubagentDone:
		delete(m.Subagents, ev.TaskID)

	case protocol.KindSteeringAdded:
		// busy 时发消息 = 纠偏（注入运行中的 loop），不是 FIFO 排队。
		m.queueAdd(ev.QueueID, queuePreview(ev.Text), "steering")
		m.LastNotice = "已注入纠偏队列，模型会在本轮之后接住"
		m.SessionSt = "running"

	case protocol.KindSteeringCancelled:
		m.queueRemove(ev.QueueID)

	case protocol.KindBgStarted:
		if m.Bg == nil {
			m.Bg = make(map[string]int)
		}
		m.Bg[ev.Tag] = ev.PID
		m.LastNotice = "后台任务已启动：" + bgLabel(ev)
		m.addNotice(store.KindNotice, "bg", m.LastNotice)

	case protocol.KindBgFinished:
		delete(m.Bg, ev.Tag)
		m.LastNotice = "后台任务结束：" + bgLabel(ev) + " → " + ev.Status
		m.addNotice(store.KindNotice, "bg", m.LastNotice)

	case protocol.KindAutoRunStarted, protocol.KindAutoRunPhase,
		protocol.KindAutoRunTurn, protocol.KindAutoRunCompleted:
		m.applyAutoRunEvent(ev)

	case protocol.KindSessionTitle:
		if ev.Title != "" {
			m.SessionTitle = ev.Title
		}

	case protocol.KindMission:
		m.Mission = ev.Text

	case protocol.KindDecision, protocol.KindDecisionDone,
		protocol.KindBoundaryAsk, protocol.KindBoundaryExpired:
		// 「让人选择」：登记 pending，面板由 EventMsg 那次统一弹（见 autoOpenChoice）。
		m.applyChoiceEvent(ev)
	}
}

// applySnapshot 把重放/live 的 wire 消息落成块。
func (m *Model) applySnapshot(s *protocol.Snapshot) {
	// 权威回放到了用户的同一条消息：删掉发送时的本地回显，避免出现两次。
	if s != nil && s.Role == "user" {
		for id, body := range m.PendingUserEcho {
			if body == s.Content {
				m.Store.Delete(id)
				delete(m.PendingUserEcho, id)
				break
			}
		}
	}
	applyWireMessage(&m.Store, s)
}

// applyWireMessage 把一条 wire 消息折成 Block 写进 dst。
//
// live 重放与只读回看共用这一份实现（`/chat/stream` 的冷历史与
// `/api/loop-session/messages?format=wire` 的形状逐字段对齐），所以抽成
// 接受 *store.Store 的自由函数——回看要灌进自己的 Store，不能碰 m.Store。
func applyWireMessage(dst *store.Store, s *protocol.Snapshot) {
	if s == nil {
		return
	}
	// 只调工具、没说话的助手消息 content 为空：回放时会长出一个空块头
	// （"✻ zhishi" 下面什么都没有）。这类消息不画。
	// 工具消息例外：它靠 Name / OK 表达信息，正文本来就可能是空的。
	if strings.TrimSpace(s.Content) == "" && s.Role != "tool" {
		return
	}
	b := store.Block{
		ID:      "msg:" + s.ID,
		Version: 1,
		Body:    s.Content,
	}
	switch s.Role {
	case "user":
		b.Kind = store.KindUser
	case "tool":
		b.Kind = store.KindTool
		b.Title = s.Name
		if b.Title == "" {
			b.Title = "tool"
		}
		// wire 只给 ok(bool)，没有退出码——只有成功/失败二态。
		if s.OK != nil && !*s.OK {
			b.Failed = true
		}
	case "assistant":
		b.Kind = store.KindAssistant
	default:
		b.Kind = store.KindAssistant
		b.Title = s.Role
	}
	if s.Kind == "decision" {
		b.Title = "decision"
		if s.Choice != "" {
			b.Body = strings.TrimSpace(b.Body + "\n→ " + s.Choice)
		}
	}
	dst.Upsert(b)
}

func (m *Model) appendAssistant(delta string) {
	if delta == "" {
		return
	}
	id := m.assistantID()
	if _, ok := m.Store.Get(id); !ok && strings.TrimSpace(delta) == "" {
		// 只有空白的分段不要长出一个空块头（"✻ zhishi" 下面什么都没有）。
		// 块已经存在时照常追加——段间空行在 markdown 里是有意义的。
		return
	}
	m.ensureLive(store.Block{ID: id, Kind: store.KindAssistant})
	m.Store.Mutate(id, func(b *store.Block) bool {
		b.Body += delta
		b.Live = true
		return true
	})
	m.SessionSt = "running"
}

func (m *Model) finalizeAssistant() {
	id := m.assistantID()
	b, ok := m.Store.Get(id)
	if !ok {
		return
	}
	if b.Live {
		m.Store.Mutate(id, func(b *store.Block) bool {
			b.Live = false
			return true
		})
	}
	// 换段：下一段增量是新的气泡。
	m.StreamSeq++
}

func (m *Model) finishTool(ev protocol.Event) {
	id := "tool:" + ev.ToolUseID
	if _, ok := m.Store.Get(id); !ok {
		// 没有对应的 tool-use-start（重连后只补了结果）：补一个块，
		// 不要把结果丢掉。
		m.Store.Upsert(store.Block{ID: id, Kind: store.KindTool, Version: 1, Title: "tool"})
	}
	start := m.ToolStarted[ev.ToolUseID]
	delete(m.ToolStarted, ev.ToolUseID)
	m.Store.Mutate(id, func(b *store.Block) bool {
		b.Body = ev.ToolOutput
		b.Live = false
		// SSE 只给 isError 布尔值（sse-adapter 的 1.2.8 H2 注释），没有结构化
		// 退出码。但 env_exec 的正文首行固定是 `exit=N`——非 0 就是失败，
		// 不标出来的话 `exit=1`/`exit=123` 的块挂着绿勾，很容易看漏。
		b.Failed = ev.IsError || toolExitFailed(ev.ToolOutput)
		if !start.IsZero() {
			b.Duration = time.Since(start)
		}
		return true
	})
}

// toolExitFailed 从工具正文首行解析 `exit=N`，非 0 视为失败。
//
// 只认首行：env_exec 的格式是 formatEnvExecResult 钉死的（tools.ts），
// 后面 stdout 里出现的 "exit=" 不算。
func toolExitFailed(output string) bool {
	line, _, _ := strings.Cut(output, "\n")
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, "exit=") {
		return false
	}
	n, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "exit=")))
	return err == nil && n != 0
}

// ensureLive 幂等地保证块存在并处于 live 态。
func (m *Model) ensureLive(b store.Block) {
	if _, ok := m.Store.Get(b.ID); ok {
		m.Store.Mutate(b.ID, func(cur *store.Block) bool {
			if cur.Live {
				return false
			}
			cur.Live = true
			return true
		})
		return
	}
	b.Version = 1
	b.Live = true
	m.Store.Upsert(b)
}

func (m *Model) addNotice(kind store.Kind, title, body string) {
	if strings.TrimSpace(body) == "" {
		return
	}
	m.NoteSeq++
	m.Store.Upsert(store.Block{
		ID:   fmt.Sprintf("note:%d", m.NoteSeq),
		Kind: kind,
		// 提示块不参与流式，版本恒 1。
		Version: 1,
		Title:   title,
		Body:    body,
	})
}

func (m Model) assistantID() string { return fmt.Sprintf("live:assistant:%d", m.StreamSeq) }
func (m Model) thinkingID() string  { return fmt.Sprintf("live:thinking:%d", m.StreamSeq) }

// ── 折叠 / 过滤 / 滚动（状态变更的单一入口）────────────────────────────

// toggleExpand 切换一个块的折叠态。返回 false 表示块不存在。
// ensureCursorVisible 把视口滚到光标块可见的位置。
//
// 坐标口径：ScrollLines = 从底部往上跳过的行数；块占据的距离区间是
// [below, below+h)（below = 该块之后所有块的高度和）。窗口是
// [ScrollLines, ScrollLines+view)。
func (m *Model) ensureCursorVisible() {
	vb := m.VisibleBlocks()
	if len(vb) == 0 {
		return
	}
	cur := m.effectiveCursor()
	if cur < 0 || cur >= len(vb) {
		return
	}
	width := m.VisibleWidth()
	view := m.StreamHeight()
	below := 0
	for i := cur + 1; i < len(vb); i++ {
		below += m.Cache.Height(vb[i], width)
	}
	h := m.Cache.Height(vb[cur], width)

	const context = 2 // 块上下各留一点上下文，别贴着窗口边缘
	switch {
	case below+h > m.ScrollLines+view:
		// 块在窗口上方（更靠历史）→ 滚上去，让块顶落在窗口内。
		m.ScrollLines = below + h - view + context
	case below < m.ScrollLines:
		// 块在窗口下方（更新）→ 滚回底部方向。
		m.ScrollLines = below - context
	}
	if m.ScrollLines < 0 {
		m.ScrollLines = 0
	}
}

// rotAssistantSegment 封掉当前助手气泡，让下一段增量长成新块。
//
// 与 finalizeAssistant 的区别：那个由 message-complete 触发（turn 结束），
// 这个在工具调用前触发（turn 中间）。段号没变时 appendAssistant 会把新正文
// 追加进旧块——工具前后的文字就会粘在同一块里，顺序错乱。
func (m *Model) rotAssistantSegment() {
	id := m.assistantID()
	b, ok := m.Store.Get(id)
	if !ok {
		return
	}
	if b.Live {
		m.Store.Mutate(id, func(cur *store.Block) bool {
			cur.Live = false
			return true
		})
	}
	m.StreamSeq++
}

// addLocalUserEcho 在发送时立刻画出一条 "› you"。
//
// 权威数据里也有这条消息（wire 的 role=user），但那是重放/重连时才到；不发
// 本地回显的话，用户发完话屏幕上什么都不留，只有一个输入框清空。
func (m *Model) addLocalUserEcho(text string) {
	m.NoteSeq++
	id := fmt.Sprintf("local:user:%d", m.NoteSeq)
	m.Store.Upsert(store.Block{ID: id, Kind: store.KindUser, Version: 1, Body: text})
	if m.PendingUserEcho == nil {
		m.PendingUserEcho = make(map[string]string)
	}
	m.PendingUserEcho[id] = text
	m.ScrollLines = 0
}

// targetBlock 决定块级操作（Alt+r/y/o）作用在哪一块。
//
// 光标没被显式移动过时，作用于**最新一块**——用户刚看完输出，按 Alt+r 想展开的
// 就是它。此前默认 Cursor=0（第一块），按下去改的是屏幕顶上那条消息，看起来
// 就是"展开不了"（而且光标在画面上没有标记，无从判断）。
// toggleTargetBlock 展开/折叠当前块——Alt+r 与动作中心共用这一份逻辑。
func (m *Model) toggleTargetBlock() tea.Cmd {
	b, ok := m.targetBlock()
	if !ok {
		return noticeCmd("还没有可折叠的块")
	}
	if !render.FoldsByDefault(b.Kind) {
		// 助手正文/用户消息完整显示，不参与折叠（见 render.FoldsByDefault）。
		return noticeCmd(fmt.Sprintf("「%s」是正文，完整显示，不需要折叠", blockLabel(b)))
	}
	lines := bodyLineCount(b.Body)
	if render.FoldedBodyLines(b.Kind, lines) >= lines {
		// 折叠前后一模一样——必须给一句话，否则用户只会以为按键坏了。
		return noticeCmd(fmt.Sprintf("「%s」只有 %d 行，无需折叠", blockLabel(b), lines))
	}
	m.toggleExpand(b.ID)
	state := "已展开"
	if cur, ok := m.Store.Get(b.ID); ok && !cur.Expanded {
		state = "已折叠"
	}
	m.LastNotice = fmt.Sprintf("%s「%s」（%d 行）", state, blockLabel(b), lines)
	return nil
}

// copyTargetBlock 复制当前块正文——Alt+y 与动作中心共用。
func (m *Model) copyTargetBlock() tea.Cmd {
	b, ok := m.targetBlock()
	if !ok {
		return noticeCmd("没有选中的块")
	}
	return copyCmd(b.Body)
}

func (m Model) targetBlock() (store.Block, bool) {
	vb := m.VisibleBlocks()
	if len(vb) == 0 {
		return store.Block{}, false
	}
	return vb[m.effectiveCursor()], true
}

// normalizePastedNewlines 把 CRLF / 孤立 CR 归一成 LF。
// bubbles 的清洗器会把 \r 和 \n 各自替换成一次换行——Windows 剪贴板的
// CRLF 于是变成两个换行（粘贴多行时每行之间多一个空行）。
func normalizePastedNewlines(runes []rune) []rune {
	out := make([]rune, 0, len(runes))
	for i := 0; i < len(runes); i++ {
		if runes[i] == '\r' {
			if i+1 < len(runes) && runes[i+1] == '\n' {
				continue // CRLF 的 CR 丢掉，保留后面的 LF
			}
			out = append(out, '\n')
			continue
		}
		out = append(out, runes[i])
	}
	return out
}

// bodyLineCount 数正文行数（与渲染口径一致：去掉尾部空行后按 \n 切）。
func bodyLineCount(body string) int {
	trimmed := strings.TrimRight(body, "\n")
	if trimmed == "" {
		return 0
	}
	return strings.Count(trimmed, "\n") + 1
}

func (m *Model) toggleExpand(id string) bool {
	if _, ok := m.Store.Get(id); !ok {
		return false
	}
	// Expanded 变了要 bump Version：渲染缓存以 version 为唯一脏标记，
	// 不递增就会命中折叠态的旧输出（"展开按了没反应"）。
	m.Store.Mutate(id, func(b *store.Block) bool {
		b.Expanded = !b.Expanded
		return true
	})
	return true
}

func (m *Model) toggleFailedFilter() {
	m.OnlyFailed = !m.OnlyFailed
	m.Cursor = 0
	m.ScrollLines = 0
	if m.OnlyFailed {
		m.LastNotice = "只看失败块（Alt+f 再按一次还原）"
	} else {
		m.LastNotice = "已还原全部块"
	}
}

// scrollBy 改变滚动位置并钳进真实范围。
func (m *Model) scrollBy(lines int) {
	m.ScrollLines += lines
	m.clampScroll()
}

// clampScroll 把 ScrollLines 钳进 [0, maxScroll]。
//
// 之前的实现只在"上一帧滚到过顶"时才知道 maxScroll（Frame.maxScroll），
// 内容不足一屏时永远算不出上界 —— 按一下 ↑ 就把底部几行切掉、再按 ↓ 又回来，
// 看起来像"显示异常"。现在直接按块高度求和算真实总高（高度有缓存，O(块数)
// 的 map 查询），任何内容长度都能立刻夹住。
func (m *Model) clampScroll() {
	if m.ScrollLines < 0 {
		m.ScrollLines = 0
	}
	max := m.maxScrollLines()
	if m.ScrollLines > max {
		m.ScrollLines = max
	}
}

// maxScrollLines 是"还能往上滚多少行"，按当前可见块的总高度算。
func (m Model) maxScrollLines() int {
	blocks := m.VisibleBlocks()
	if len(blocks) == 0 {
		return 0
	}
	width := m.VisibleWidth()
	total := 0
	for _, b := range blocks {
		total += m.Cache.Height(b, width)
	}
	max := total - m.StreamHeight()
	if max < 0 {
		return 0
	}
	return max
}

// indexOfVisible 返回块在"当前可见列表"里的下标（找不到 -1）。
func (m Model) indexOfVisible(id string) int {
	for i, b := range m.VisibleBlocks() {
		if b.ID == id {
			return i
		}
	}
	return -1
}

// ensureTick 在 turn 开跑时挂上秒表（幂等：已有在途 tick 就不重复挂）。
func (m *Model) ensureTick() tea.Cmd {
	if m.Now.IsZero() {
		m.Now = time.Now()
	}
	if m.Ticking {
		return nil
	}
	m.Ticking = true
	return tickCmd()
}

// afterLineSwitch 是"线换了"之后的统一善后。
//
// 旧块表必须整份作废：新线的冷历史重放复用同一批 msg:<seq> id，而 Store
// 的 Upsert 按 (id, version) 拒旧——不清理就会留下旧线的正文，看起来像
// "切了环境但内容没变"。
func (m *Model) afterLineSwitch(notice string) tea.Cmd {
	m.Store.Reset()
	m.PendingUserEcho = make(map[string]string)
	m.Cursor = 0
	m.ScrollLines = 0
	m.StreamSeq = 0
	m.NoteSeq = 0
	m.TurnDuration = 0
	m.ContextUsed = 0
	m.ContextWindow = 0
	m.ToolStarted = make(map[string]time.Time)
	m.LastErr = ""
	m.LastNotice = notice
	return m.reconnect()
}

// ── 布局 ────────────────────────────────────────────────────────────────

// layout 按当前终端尺寸重算输入框行数。
//
// stream 的高度是纯派生的（Model.StreamHeight），不需要在这里缓存——虚拟滚动
// 每帧只按它切窗口，没有"viewport 内容"要提前拼好。
func (m *Model) layout() {
	if m.Width <= 0 || m.Height <= 0 {
		return
	}
	// 输入框装在圆角板里：内容宽度 = 总宽 - 左边距 1 - 边框 2 - 内边距 2。
	inner := m.contentWidth() - 4
	if inner < 8 {
		inner = 8
	}
	m.Input.SetWidth(inner)
	m.Input.SetHeight(m.InputLines())
	if n := len(m.VisibleBlocks()); m.Cursor >= n {
		m.Cursor = n - 1
	}
	if m.Cursor < 0 {
		m.Cursor = 0
	}
}

// ── 命令（IO 全部在这里落地）────────────────────────────────────────────

func healthCmd(ctx context.Context, c *client.Client) tea.Cmd {
	return func() tea.Msg {
		if c == nil {
			return healthMsg{err: fmt.Errorf("no client")}
		}
		reqCtx, cancel := context.WithTimeout(ctx, client.ShortTimeout)
		defer cancel()
		return healthMsg{err: c.Health(reqCtx)}
	}
}

func subscribeCmd(ctx context.Context, c *client.Client, gen int) tea.Cmd {
	return func() tea.Msg {
		if c == nil {
			return subscribedMsg{err: fmt.Errorf("no client"), gen: gen}
		}
		sub, err := c.Subscribe(ctx)
		return subscribedMsg{sub: sub, err: err, gen: gen}
	}
}

// waitForEvent 取一帧。通道读取必须包在 Cmd 里——直接读会卡死消息循环。
func waitForEvent(sub *client.Subscription, gen int) tea.Cmd {
	return func() tea.Msg {
		ev, ok := <-sub.Events
		if ok {
			return EventMsg(ev)
		}
		err, _ := <-sub.Errs
		return streamEndMsg{err: err, gen: gen}
	}
}

func sendCmd(ctx context.Context, c *client.Client, text string, opts client.SendOptions) tea.Cmd {
	return func() tea.Msg {
		if c == nil {
			return sendMsg{err: fmt.Errorf("no client")}
		}
		reqCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		res, err := c.Send(reqCtx, text, opts)
		return sendMsg{result: res, err: err}
	}
}

func stopCmd(ctx context.Context, c *client.Client) tea.Cmd {
	return func() tea.Msg {
		if c == nil {
			return stopMsg{err: fmt.Errorf("no client")}
		}
		reqCtx, cancel := context.WithTimeout(ctx, client.ShortTimeout)
		defer cancel()
		return stopMsg{err: c.Stop(reqCtx)}
	}
}

func noticeCmd(text string) tea.Cmd {
	return func() tea.Msg { return noticeMsg(text) }
}

// tickCmd 每秒推进一次 m.Now，只为让状态行的时长自己走。
//
// 用 tea.Tick 而不是自己起 goroutine：定时器也归消息循环管，退出时不会
// 留下一个还在跑的 goroutine。
func tickCmd() tea.Cmd {
	return tea.Tick(time.Second, func(t time.Time) tea.Msg { return tickMsg(t) })
}

// writeTempCmd 把正文落到临时文件；落盘是 IO，只能在 Cmd 里做。
func writeTempCmd(name, body string) tea.Cmd {
	return func() tea.Msg {
		path, err := writeTempFile(name, body)
		return openRequestMsg{path: path, err: err}
	}
}

// openCmd 用 tea.ExecProcess 交给外部程序。
//
// ExecProcess 会先释放终端、程序退出后恢复并重绘——这是唯一"能回到 TUI 且
// 不花屏"的官方姿势（自己 fork + Suspend 要手动管终端状态，容易漏）。
// open(path) 只构造 exec.Cmd，不启动进程。
func openCmd(open opener, path string) tea.Cmd {
	if open == nil {
		return noticeCmd("外部打开不可用：没有配置 opener")
	}
	cmd := open(path)
	if cmd == nil {
		return noticeCmd("外部打开不可用：opener 返回 nil")
	}
	return tea.ExecProcess(cmd, func(err error) tea.Msg { return openDoneMsg{err: err} })
}

// writeTempFile 把正文写到 <tmp>/zhishi-tui/<name>.txt 并返回路径。
//
// 用固定文件名（不带时间戳）：重复打开同一个块应该覆盖，而不是在 /tmp 里
// 堆一坨没人清的副本。
func writeTempFile(name, body string) (string, error) {
	dir := filepath.Join(os.TempDir(), "zhishi-tui")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(dir, sanitizeFileName(name)+".txt")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		return "", err
	}
	return path, nil
}

// blockFileName 给块的正文起个能看懂的文件名。
func blockFileName(b store.Block) string {
	switch b.Kind {
	case store.KindTool:
		return "tool-" + b.Title
	case store.KindUser:
		return "you"
	case store.KindAssistant:
		return "assistant"
	case store.KindThinking:
		return "thinking"
	case store.KindError:
		return "error"
	default:
		return "note"
	}
}

func sanitizeFileName(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	out := strings.Trim(b.String(), "_")
	if out == "" {
		return "block"
	}
	return out
}

// copyCmd 优先用 OSC52 把文本交给终端写系统剪贴板（无外部进程、ssh 里也能用）；
// 拿不到终端时退化成临时文件——静默丢弃是最坏的"复制成功"。
func copyCmd(text string) tea.Cmd {
	return func() tea.Msg {
		if text == "" {
			return noticeMsg("没有可复制的内容")
		}
		if !stdoutIsTerminal() {
			// stdout 不是终端（管道/CI/重定向）：OSC52 序列没有接收方。
			path, err := writeTempFile("copy", text)
			if err != nil {
				return noticeMsg("复制失败：" + err.Error())
			}
			return noticeMsg("终端不支持 OSC52，已写到临时文件：" + path)
		}
		// 这是全仓唯一绕过 bubbletea 渲染器直接写 stdout 的地方——OSC52 是
		// 终端控制序列而不是画面内容，走渲染器会被当成文本换行。
		if _, err := io.WriteString(os.Stdout, osc52(text)); err != nil {
			path, werr := writeTempFile("copy", text)
			if werr != nil {
				return noticeMsg("复制失败：" + err.Error())
			}
			return noticeMsg("OSC52 写入失败，已写到临时文件：" + path)
		}
		return noticeMsg(fmt.Sprintf("已复制 %d 字节（OSC52）", len(text)))
	}
}

// osc52 生成 OSC52 序列（终端负责把它翻译成系统剪贴板写入）。
func osc52(text string) string {
	return "\x1b]52;c;" + base64.StdEncoding.EncodeToString([]byte(text)) + "\x07"
}

// stdoutIsTerminal 判断 stdout 是不是字符设备（终端/控制台）。
func stdoutIsTerminal() bool {
	fi, err := os.Stdout.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
}

func trimLastRune(s string) string {
	r := []rune(s)
	if len(r) == 0 {
		return s
	}
	return string(r[:len(r)-1])
}

// ── 管理面数据命令 ──────────────────────────────────────────────────────
// 只在这里落地 IO：覆盖层与 view 都拿不到网络；DTO → row 的折算也在命令里
// 完成，覆盖层因此不认识传输层类型。

func loadEnvironmentsCmd(ctx context.Context, a adminAPI) tea.Cmd {
	return func() tea.Msg {
		if a == nil {
			return envListMsg{err: errNoAdmin}
		}
		envs, err := a.Environments(ctx)
		if err != nil {
			return envListMsg{err: err}
		}
		rows := make([]row, 0, len(envs))
		for _, e := range envs {
			rows = append(rows, envRow(e))
		}
		return envListMsg{rows: rows}
	}
}

// envRow 把环境条目折成一行：名字取 name（缺省回 id），描述里给"怎么连"。
func envRow(e client.EnvironmentInfo) row {
	name := e.Name
	if name == "" {
		name = e.ID
	}
	desc := e.Kind
	switch {
	case e.Host != "":
		desc += " " + e.Host
	case e.Container != "":
		desc += " " + e.Container
	case e.Address != "":
		desc += " " + e.Address
	}
	if len(e.CapabilityDomains) > 0 {
		desc += " [" + strings.Join(e.CapabilityDomains, ",") + "]"
	}
	return row{Key: e.ID, Title: name, Desc: desc, Flag: e.User}
}

func selectEnvironmentCmd(ctx context.Context, a adminAPI, workspace, id string) tea.Cmd {
	return func() tea.Msg {
		if a == nil {
			return envSelectMsg{envID: id, err: errNoAdmin}
		}
		sessionID, err := a.SelectEnvironment(ctx, workspace, id)
		return envSelectMsg{envID: id, sessionID: sessionID, err: err}
	}
}

func loadSessionsCmd(ctx context.Context, a adminAPI) tea.Cmd {
	return func() tea.Msg {
		if a == nil {
			return sessionsMsg{err: errNoAdmin}
		}
		infos, err := a.Sessions(ctx)
		if err != nil {
			return sessionsMsg{err: err}
		}
		rows := make([]row, 0, len(infos))
		for _, s := range infos {
			rows = append(rows, sessionRow(s))
		}
		return sessionsMsg{rows: rows}
	}
}

// sessionRow 把会话元数据折成一行：标题 + 最后活跃时间 + 消息数。
//
// 不做"当前线"高亮：行的主键是会话 meta id，而当前线只知道 loopSessionId，
// 两者不是一回事（见 README 偏差）；header 里已经显示当前线 id。
func sessionRow(s client.SessionInfo) row {
	title := s.Title
	if title == "" {
		title = s.ID
	}
	desc := trimTimestamp(s.LastActiveAt)
	if n := s.MessageCount(); n > 0 {
		desc += fmt.Sprintf(" · %d 条", n)
	}
	flag := ""
	if s.Archived {
		flag = "已归档"
	}
	return row{Key: s.ID, Ref: s.LoopSessionID, Title: title, Desc: desc, Flag: flag, Dim: s.Archived}
}

// trimTimestamp 把 ISO 时间戳压成 "2026-01-01 00:00"（列表只需要辨识度）。
func trimTimestamp(iso string) string {
	if len(iso) >= 16 {
		return strings.Replace(iso[:16], "T", " ", 1)
	}
	return iso
}

func switchSessionCmd(ctx context.Context, a adminAPI, id string) tea.Cmd {
	return func() tea.Msg {
		if a == nil {
			return lineSwitchMsg{sessionID: id, err: errNoAdmin}
		}
		return lineSwitchMsg{sessionID: id, err: a.SwitchSession(ctx, id)}
	}
}

func loadTasksCmd(ctx context.Context, a adminAPI) tea.Cmd {
	return func() tea.Msg {
		if a == nil {
			return taskListMsg{err: errNoAdmin}
		}
		tasks, err := a.Tasks(ctx)
		if err != nil {
			return taskListMsg{err: err}
		}
		rows := make([]row, 0, len(tasks))
		for _, t := range tasks {
			rows = append(rows, taskRow(t))
		}
		return taskListMsg{rows: rows}
	}
}

func taskRow(t client.TaskInfo) row {
	name := t.Name
	if name == "" {
		name = t.ID
	}
	desc := t.Executor
	if t.DispatchOrigin == "system" {
		desc = "sys · " + desc
	}
	if len(t.Tags) > 0 {
		desc += " #" + strings.Join(t.Tags, " #")
	}
	return row{Key: t.ID, Title: name, Desc: desc, Flag: t.Status,
		Dim: t.Status == "done" || t.Status == "archived"}
}

// loadWireCmd 拉一条线的 wire 消息（只读回看）。
func loadWireCmd(ctx context.Context, a adminAPI, lineID, title string) tea.Cmd {
	return func() tea.Msg {
		if a == nil {
			return wireMsg{lineID: lineID, title: title, err: errNoAdmin}
		}
		page, err := a.WireMessages(ctx, lineID)
		if err != nil {
			return wireMsg{lineID: lineID, title: title, err: err}
		}
		return wireMsg{lineID: lineID, title: title, page: wirePage{
			messages: page.Messages,
			total:    page.Total,
		}}
	}
}

// modelRefreshCmd 刷新模型目录（用已保存的 key，不重写 key）。
func modelRefreshCmd(ctx context.Context, a adminAPI) tea.Cmd {
	return func() tea.Msg {
		if a == nil {
			return modelRefreshDoneMsg{err: errNoAdmin}
		}
		reqCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
		defer cancel()
		info, err := a.ModelRefresh(reqCtx)
		return modelRefreshDoneMsg{info: info, err: err}
	}
}

func loadArchiveCmd(ctx context.Context, a adminAPI, sessionID string) tea.Cmd {
	return func() tea.Msg {
		if a == nil {
			return archiveMsg{err: errNoAdmin}
		}
		data, err := a.Archive(ctx, sessionID)
		if err != nil {
			return archiveMsg{err: err}
		}
		var brief *client.ArchiveBrief
		if len(data.Brief.Solid)+len(data.Brief.Gaps)+len(data.Brief.Closed) > 0 {
			brief = &data.Brief
		}
		return archiveMsg{groups: groupArchive(data.Entities), ents: data.Entities, brief: brief}
	}
}

// groupArchive 按固定 kind 顺序分组；未知 kind 追加在最后，不丢数据
// （服务端将来加实体类型时，TUI 至少还能把它们显示出来）。
func groupArchive(ents []client.ArchiveEntity) []archiveGroup {
	byKind := make(map[string][]row, len(archiveOrder))
	var unknown []string
	for _, e := range ents {
		r := row{Key: e.ID, Desc: e.Text, Flag: e.Status}
		if e.NeedsReview {
			r.Flag += " 待复核"
			r.Dim = true
		}
		if e.Status == "abandoned" || e.Status == "refuted" {
			r.Dim = true
		}
		if _, seen := byKind[e.Kind]; !seen && !isKnownArchiveKind(e.Kind) {
			unknown = append(unknown, e.Kind)
		}
		byKind[e.Kind] = append(byKind[e.Kind], r)
	}
	out := make([]archiveGroup, 0, len(byKind))
	for _, k := range archiveOrder {
		if rows, ok := byKind[k]; ok {
			out = append(out, archiveGroup{kind: k, rows: rows})
		}
	}
	sort.Strings(unknown)
	for _, k := range unknown {
		out = append(out, archiveGroup{kind: k, rows: byKind[k]})
	}
	return out
}

func isKnownArchiveKind(kind string) bool {
	for _, k := range archiveOrder {
		if k == kind {
			return true
		}
	}
	return false
}

// teaModel 把 app.Model 适配成 bubbletea 的 tea.Model。
//
// 单独一层包装换来的是：测试里可以直接断言 (Model, tea.Cmd)，不用每帧
// 把 tea.Model 断言回 app.Model。
type teaModel struct{ Model }

// New 是 bubbletea 程序的入口。
func New(m Model) tea.Model { return teaModel{m} }

func (t teaModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	m, cmd := t.Model.Update(msg)
	return teaModel{m}, cmd
}

func (t teaModel) View() string { return t.Model.View() }

// bgLabel 拼后台任务的展示文案：tag + (pid) + 命令预览。
func bgLabel(ev protocol.Event) string {
	label := ev.Tag
	if label == "" {
		label = "bg"
	}
	if ev.PID > 0 {
		label += fmt.Sprintf(" (pid %d)", ev.PID)
	}
	if ev.Text != "" {
		label += "  " + truncateWidth(ev.Text, 60)
	}
	return label
}

// refreshOpenArchive：archive:changed 到来时，若档案面板正开着就自动重载。
//
// 不这么做的话，agent 在别处改了档案，面板会一直显示旧树——用户只能按 Esc 重开
// （而面板连 r 都没有，直到这一版补上）。
func (m *Model) refreshOpenArchive(kind protocol.Kind) tea.Cmd {
	if kind != protocol.KindArchiveChanged {
		return nil
	}
	ov, ok := m.TopOverlay()
	if !ok {
		return nil
	}
	if a, isArchive := ov.(*archiveOverlay); isArchive {
		return a.reload(m)
	}
	return nil
}
