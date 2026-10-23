// Package app 是 Elm 三件套的容器：Model 只存状态，Update 只做归约与发起
// IO，View 只做纯渲染。
//
// 边界铁律（评审会看）：
//   - model.go 不产生任何 IO —— 这里只声明状态与构造函数；
//   - view.go 只读 Model，不写任何东西，也不发 Cmd；
//   - 只有 update.go 会返回 tea.Cmd。
package app

import (
	"context"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/textarea"

	"github.com/lielingai/zhishi/tui/internal/client"
	"github.com/lielingai/zhishi/tui/internal/protocol"
	"github.com/lielingai/zhishi/tui/internal/render"
	"github.com/lielingai/zhishi/tui/internal/store"
)

// 输入框高度上下界（行）。1 行是常态，长消息自动长到 6 行就不再涨，
// 多出来的靠 textarea 内部滚动——否则一条长 prompt 会把 stream 挤没。
const (
	minInputLines = 1
	maxInputLines = 6
)

// 没有 WindowSizeMsg 时的兜底尺寸。真终端一定会发尺寸，但非 TTY（管道、
// 屏幕录制、CI）下拿不到——那时按 80x24 画，至少还能看出布局。
const (
	defaultWidth  = 80
	defaultHeight = 24
)

// streamBufferBlocks 是可见窗口上下各多渲染的块数。
//
// 留缓冲的理由：滚动定位用的是（可能估算的）块高，边界上会差几行；多渲染
// 几块就能把差的那几行补齐，而不用在帧内反复试算。
const streamBufferBlocks = 5

// opener 按路径构造一个"外部打开"命令。
//
// 做成 Model 上的字段而不是包级变量：包级可变状态在测试里是泄漏源，
// 而这里必须能被打桩（测试不能真起 pager）。
type opener func(path string) *exec.Cmd

// adminAPI 是 app 用到的 sidecar 管理面。
//
// 定成接口是为了测试能打桩（不真连网络）；*client.Client 实现它。
// 各方法的返回类型是 client 的 DTO——它们是线上形状的镜像，不是业务模型。
type adminAPI interface {
	Environments(ctx context.Context) ([]client.EnvironmentInfo, error)
	SelectEnvironment(ctx context.Context, workspace, id string) (string, error)
	Sessions(ctx context.Context) ([]client.SessionInfo, error)
	SwitchSession(ctx context.Context, id string) error
	Tasks(ctx context.Context) ([]client.TaskInfo, error)
	TaskGet(ctx context.Context, id string) (client.TaskDetail, error)
	Archive(ctx context.Context, sessionID string) ([]client.ArchiveEntity, error)
	WireMessages(ctx context.Context, loopSessionID string) (client.WirePage, error)
	TaskUpdateStatus(ctx context.Context, id, status, message string) error
	TaskRerun(ctx context.Context, id string) error
	Models(ctx context.Context) ([]client.ModelOption, error)
	AutoRunShow(ctx context.Context, id string) (client.AutoRunInfo, error)
	AutoRunList(ctx context.Context, workspace string) ([]client.AutoRunInfo, error)
	AutoRunStop(ctx context.Context, id string) error
	AutoRunStart(ctx context.Context, name, goal, envKey, budgetKind string, budgetLimit float64, criteria []string) (string, error)
	ReportExport(ctx context.Context, workspace string) (client.ReportExportInfo, error)
	EnvDown(ctx context.Context, id string) error
	EnvRm(ctx context.Context, id string) error
	EnvRename(ctx context.Context, id, name string) error
	EnvRecipes(ctx context.Context) ([]client.EnvRecipe, error)
	ArchiveCorrect(ctx context.Context, sessionID, id, reason string) error
	ArchiveResolve(ctx context.Context, sessionID, id, note string) error
	ArchiveAbandon(ctx context.Context, sessionID, id, reason string) error
	SearchMemory(ctx context.Context, q string) ([]client.MemoryHit, error)
	SearchExpert(ctx context.Context, q string) ([]client.ExpertHit, error)
	SearchIntel(ctx context.Context, q string) (string, int, error)
	SessionPatch(ctx context.Context, id string, patch map[string]any) error
	SessionDelete(ctx context.Context, id string) error
	ChatModel(ctx context.Context, providerID, model string) error
	ResetChat(ctx context.Context) error
	Rewind(ctx context.Context, userMessageID string) error
	Fork(ctx context.Context, messageID string) error
}

// clickRow 是 stream 区某一行映射到的块，供鼠标命中用（strix 的 eventSpan
// 思路：投影里记行 → 事件的归属）。
type clickRow struct {
	ID   string
	Head bool // 是否块头行——只有点块头才切换折叠
}

// frameState 是上一帧的投影。
//
// 它由 View 写、Update 读，是**派生数据**而不是权威状态：权威状态是
// blocks + ScrollLines，投影每帧重建一次，丢了也能重算。之所以放在 Model
// 上，是因为鼠标事件只给了终端坐标，必须靠上一帧才知道那行是哪个块。
type frameState struct {
	width     int
	height    int
	streamTop int // stream 区在整幅画面里的起始行（header 之后）
	rows      []clickRow
	// maxScroll 是"还能往上滚多少行"。只有这一帧走到了顶（第一块都渲染了）
	// 才知道；负数表示未知。Update 用它把 ScrollLines 钳在真实范围内，
	// 免得用户滚到顶后再滚回来要按同样多次。
	maxScroll int
	// lines 是这一帧 stream 区的原始渲染行（带样式），给鼠标拖选做文本抽取：
	// 终端原生拖选被鼠标上报挡住，只能在应用层自己算选中了哪几个字符。
	lines []string
}

// selState 是鼠标拖选状态（画面内，行号相对 stream 区）。
type selState struct {
	down   bool // 左键按下中
	active bool // 已经拖动过（>0 格），松开时按"选字"而不是"点击"处理
	sx, sy int
	ex, ey int
}

// Model 是全部状态。它不持有 net/http 之外的可变外部资源：Client 只是配置
// 载体（BaseURL/Token），真正发请求的永远是 update.go 里的 Cmd。
type Model struct {
	// 连接
	Server    string
	Client    *client.Client
	Sub       *client.Subscription
	Connected bool
	StreamErr string
	SessionID string
	// SessionTitle 是 sidecar 自动生成的标题（chat:session-title-changed）。
	SessionTitle string
	// Mission 是当前线的任务形态标签（chat:mission-changed 的 label）。
	Mission string
	// Bg 记录在跑的后台进程（tag → pid），chat:bg-started/finished 维护。
	Bg         map[string]int
	SessionSt  string
	LastErr    string
	LastNotice string
	// SubGen 是订阅代次。重连时旧通道的收尾消息会晚一步到，靠代次把它丢掉，
	// 免得把新订阅刚建立的 Connected 又改回 false。
	SubGen int

	// 布局
	Width  int
	Height int

	// 数据
	Store  store.Store
	Cursor int
	// PendingUserEcho 记录"已本地回显、还没被权威回放确认"的用户消息
	// （本地块 ID → 正文）。回放送来同一条时删掉本地块，避免出现两次。
	PendingUserEcho map[string]string
	// CursorTouched 表示用户显式移动过块光标（Alt+j/k 或鼠标点块）。
	// 没动过时，块级操作（Alt+r/y/o）落在**最新一块**上——见 expandTarget。
	CursorTouched bool
	OnlyFailed    bool
	// Overlays 是覆盖层栈（栈顶独占按键，Esc 逐层退）。
	Overlays []Overlay
	// Cache 是这块 Model 独占的渲染缓存。用实例而不是 render 的包级缓存：
	// 缓存键是 (ID, version)，多实例（例如测试）共用一份会互相拿到别人的
	// 旧输出。
	Cache *render.Cache

	// 组件
	Input textarea.Model
	// Menu 是输入 `/` 时的命令候选（nil = 不显示）。只由输入内容派生，
	// 不持久：Tab/Enter 接受后立刻清空。
	Menu *slashMenu
	// Choices 是待答的决策/越界请求（服务端 pending 的本地镜像，按 id 去重）。
	Choices []*choiceRequest
	// PendingImages 是下一次发送附带在 images 里的图片（Alt+i 添加，发送后清空）。
	PendingImages []client.ChatImage
	// AutoRun 是当前/最近的自动循环状态（由 auto-run:* 事件维护，不轮询）。
	AutoRun *client.AutoRunInfo
	// PermissionMode 是发送时带的权限模式：auto（默认，越界要审批）|
	// fullAgency（后台全自主）。在会话操作面板里切换。
	PermissionMode string
	// At 是输入 `@` 时的文件补全候选；AtFiles 是一整个会话共用的文件表。
	At        *atMenu
	AtFiles   []client.WorkspaceFile
	AtLoaded  bool
	AtLoading bool
	// Sel 是鼠标拖选状态。
	Sel selState
	// MouseOn 表示终端的鼠标上报是否被程序接管（滚轮 / 点块头）。关掉后终端
	// 拿回鼠标，可以直接拖选复制——全屏 TUI 里这是唯一能"选字"的方式。
	MouseOn bool

	// 滚动：从底部往上滚过的行数（0 = 贴底，跟随新内容）。
	ScrollLines int
	// Frame 是上一帧的派生投影（行 → 块），见 frameState。
	Frame *frameState

	// 管理面
	Admin adminAPI
	// Workspace 是本会话的 agentDir（chat:init 的 agentDir）：管理面里
	// environment/select 的 workspace 要它，TUI 没有第二个来源。
	Workspace string
	// EnvironmentID 是当前锚定的环境（chat:init 的 environment.id）。
	EnvironmentID string
	// SelectedEnvID 是环境面板里光标指着的环境。attach 优先用它，
	// 没有就回落到 EnvironmentID——"我在面板里看着 kali，就 attach 到 kali"。
	SelectedEnvID string

	// 会话附加信息（状态行用）
	ModelID       string
	ContextUsed   int
	ContextWindow int
	TurnDuration  time.Duration
	EventCounts   map[protocol.Kind]int

	// 状态行数据源
	UsageTokens int                 // message-complete 的 usage 累计（in+out）
	TaskStarted time.Time           // 当前 turn 的起点
	Now         time.Time           // 由 tea.Tick 每秒推进；View 用它算时长
	Ticking     bool                // 是否已有在途的 tick 定时器（避免叠加）
	Queued      []QueueItem         // 队列项 id 集合（按 id 去重，重放不重复计数）
	Subagents   map[string]struct{} // 在跑的子任务 id 集合
	Open        opener              // 外部打开命令构造器（测试注入）

	// 流式块的合成 ID 序号。sidecar 的增量事件（message-chunk /
	// thinking-chunk）不带消息 id，只能由前端给"这一段"编号；换段靠
	// message-complete 收尾。
	StreamSeq int
	// NoteSeq 给提示块编号（错误/中断/桩提示）。
	NoteSeq int

	// Ctx 是所有请求的生命周期锚：退出时 Cancel 掉，SSE 长连接与在途
	// 请求一起收尾。
	Ctx    context.Context
	Cancel context.CancelFunc

	// 工具开始时刻：tool-result-complete 只给终态，duration 只能前端自己量。
	ToolStarted map[string]time.Time

	// 退出
	QuitArmed bool
	Quit      bool
}

// NewModel 构造初态。c 为 nil 表示纯离线（测试/渲染自查）。
func NewModel(server string, c *client.Client) Model {
	ta := textarea.New()
	ta.Prompt = "› "
	ta.Placeholder = "说点什么…   / 命令  ·  Ctrl+J 换行"
	ta.ShowLineNumbers = false
	ta.CharLimit = 0
	ta.SetHeight(minInputLines)
	ta.Focus() // INSERT 模式：输入框永远聚焦，没有 NORMAL 模式

	ctx, cancel := context.WithCancel(context.Background())

	m := Model{
		Server:          server,
		Client:          c,
		Width:           defaultWidth,
		Height:          defaultHeight,
		Input:           ta,
		Frame:           &frameState{maxScroll: -1},
		EventCounts:     make(map[protocol.Kind]int),
		ToolStarted:     make(map[string]time.Time),
		Queued:          nil,
		Bg:              make(map[string]int),
		PendingUserEcho: make(map[string]string),
		Subagents:       make(map[string]struct{}),
		SessionSt:       "unknown",
		Cache:           render.NewCache(),
		Open:            defaultOpener,
		PermissionMode:  "auto",
		MouseOn:         false, // 默认把鼠标留给终端：拖选复制开箱即用；滚轮靠 ↑↓ 兜底（WT 会翻译）
		Ctx:             ctx,
		Cancel:          cancel,
	}
	if c != nil {
		m.Admin = c
	}
	m.layout()
	return m
}

// TopOverlay 返回栈顶覆盖层。
func (m Model) TopOverlay() (Overlay, bool) {
	if len(m.Overlays) == 0 {
		return nil, false
	}
	return m.Overlays[len(m.Overlays)-1], true
}

// PushOverlay 压栈。
func (m *Model) PushOverlay(o Overlay) { m.Overlays = append(m.Overlays, o) }

// PopOverlay 出栈，返回是否有东西可弹。
func (m *Model) PopOverlay() bool {
	if len(m.Overlays) == 0 {
		return false
	}
	m.Overlays = m.Overlays[:len(m.Overlays)-1]
	return true
}

// Running 表示 sidecar 报告当前 turn 在跑（chat:status / chat:init）。
func (m Model) Running() bool { return m.SessionSt == "running" }

// CursorBlock 返回光标所在的块。
func (m Model) CursorBlock() (store.Block, bool) { return m.Store.At(m.Cursor) }

// effectiveCursor 是"块级操作真正会落在"的下标（VisibleBlocks 的下标）。
//
// 光标没被显式移动过时，取**最后一块可折叠的块**（正文超过折叠阈值）：用户
// 看到的「…（还有 N 行，Alt+r 展开）」就在那一块上，按 Alt+r 想展开的也是它。
// 早先取"最新一块"——最新那块常常只有两三行（一条工具结果），于是展开的是个
// 短块，屏幕上毫无变化，看起来还是"按了没反应"。全都短 → 回落最后一块。
func (m Model) effectiveCursor() int {
	vb := m.VisibleBlocks()
	n := len(vb)
	if n == 0 {
		return 0
	}
	if !m.CursorTouched {
		for i := n - 1; i >= 0; i-- {
			lines := bodyLineCount(vb[i].Body)
			// 只有"折叠确实会隐藏内容"的块才算可折叠目标；短输出按了也不会有变化。
			if render.FoldedBodyLines(vb[i].Kind, lines) < lines {
				return i
			}
		}
		return n - 1
	}
	if m.Cursor < 0 {
		return 0
	}
	if m.Cursor >= n {
		return n - 1
	}
	return m.Cursor
}

// VisibleBlocks 返回当前视图要画的块（Alt+f 只看失败）。
func (m Model) VisibleBlocks() []store.Block {
	if m.OnlyFailed {
		return m.Store.FilterFailed()
	}
	return m.Store.List()
}

// InputLines 返回输入框当前占的行数（1..6）。
func (m Model) InputLines() int {
	n := m.Input.LineCount()
	if n < minInputLines {
		n = minInputLines
	}
	if n > maxInputLines {
		n = maxInputLines
	}
	return n
}

// StreamHeight 返回 stream 区可用行数。
//
// 布局契约：header(1) + 分隔线(1) + stream + [菜单(0..8)] + input(内容 1..6 + 边框 2) + status(2)。
func (m Model) StreamHeight() int {
	h := m.Height - 1 - 1 - m.InputLines() - 2 - 2 - m.MenuRows() - m.AtRows()
	if h < 1 {
		h = 1
	}
	return h
}

// QueuedCount / SubagentCount 是状态行的计数。
func (m Model) QueuedCount() int   { return len(m.Queued) }
func (m Model) SubagentCount() int { return len(m.Subagents) }

// Elapsed 返回当前 turn 的墙钟时长。
//
// 用 m.Now（由 tick 推进）而不是 time.Since：View 必须是纯函数，读时钟会让
// 同样的 Model 渲染出不同结果，也没法测。
func (m Model) Elapsed() time.Duration {
	if !m.Running() {
		// 空闲时展示上一个 turn 的耗时（chat:message-complete 里带来的）。
		return m.TurnDuration
	}
	if m.TaskStarted.IsZero() || !m.Now.After(m.TaskStarted) {
		return 0
	}
	return m.Now.Sub(m.TaskStarted)
}

// defaultOpener 按 $PAGER 或系统默认程序打开一个文本文件。
//
// 只在命令真正执行时才读环境变量：NewModel 里把它当函数值存下，不做任何 IO。
func defaultOpener(path string) *exec.Cmd {
	if pager := os.Getenv("PAGER"); pager != "" {
		fields := strings.Fields(pager)
		if len(fields) > 0 {
			return exec.Command(fields[0], append(fields[1:], path)...)
		}
	}
	if runtime.GOOS == "windows" {
		// start 会让 .txt 走系统关联程序；空 "" 是 start 的窗口标题占位。
		return exec.Command("cmd", "/c", "start", "", path)
	}
	return exec.Command("less", "-R", path)
}
