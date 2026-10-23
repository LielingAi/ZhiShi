package app

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

// Action 是键路由的产物。update.go 只认 Action，不认具体按键——
// 这样"哪个键干什么"是纯数据，可以单测。
type Action int

const (
	// ActionNone 表示吃掉这次按键，谁也不处理（覆盖层打开时的透传拦截）。
	ActionNone Action = iota
	// ActionInput 表示"其余全给输入框"——INSERT 模式的兜底。
	ActionInput
	ActionCursorUp
	ActionCursorDown
	ActionToggleExpand
	ActionCopy
	ActionOpenExternal
	ActionFilterFailed
	ActionCommandPalette
	ActionActionLayer
	ActionQuitOrInterrupt
	ActionSend
	ActionNewline
	ActionTabComplete
	ActionCloseOverlay
	// ActionOverlayKey 表示"交给栈顶覆盖层自己处理"：面板要收字符做过滤、
	// 列表要收 ↑↓，都不能走输入框（否则按键会同时进面板和输入框）。
	ActionOverlayKey
	// 滚动。虚拟滚动必须能滚，否则"只渲染可见窗口"就成了"只渲染最后几块"。
	ActionScrollPageUp
	ActionScrollPageDown
	ActionScrollBottom
	// 四个数据覆盖层（M2a）。
	ActionEnvOverlay
	ActionLineOverlay
	ActionTaskOverlay
	ActionArchiveOverlay
	// attach（全屏接管远端 pty）与历史回看（M2b）。
	ActionAttach
	ActionHistoryOverlay
	// 鼠标捕获开关：关掉后终端可以原生拖选复制（Alt+m）。
	ActionToggleMouse
	// 斜杠菜单（输入 `/` 时的候选）：上下选、Tab 接受。
	ActionMenuUp
	ActionMenuDown
	ActionMenuAccept
	// 单行滚动（鼠标释放时 ↑↓ 兜底翻历史）。
	ActionScrollLineUp
	ActionScrollLineDown
	// 重开待答面板（Pending choices）。
	ActionChoices
	// F1 键位总表。
	ActionHelp
	// 会话操作（重置/回退/分叉/切模型）。
	ActionSession
	// 队列面板（查看/撤销纠偏与排队）。
	ActionQueue
	// 自动循环观察面（Alt+w）。
	ActionAutoRun
	// 搜索面板（Ctrl+F）。
	ActionSearch
	// 追加图片附件（Alt+i）与移除最后一张（Alt+u）。
	ActionImage
	ActionDropImage
	// `@` 文件补全。
	ActionAtUp
	ActionAtDown
	ActionAtAccept
)

// Route 是键路由的唯一入口，三段式且顺序不能变：
//
//  1. overlay 栈顶优先（覆盖层吃掉一切，防止按键穿透到输入框）
//  2. 全局键（Alt+字母 / Ctrl+K / Ctrl+C / Esc / Ctrl+Space / Enter …）
//  3. 其余全给输入框
//
// bubbletea 的 Key 只有 Alt 一个修饰位（没有 Ctrl/Shift 字段），所以导航
// 一律 Alt+字母；Ctrl 组合靠 String() 的 "ctrl+x" 形态识别。
func Route(m Model, msg tea.KeyMsg) Action {
	if ov, ok := m.TopOverlay(); ok {
		return routeOverlay(ov, msg)
	}
	// 斜杠菜单只在输入 `/` 且还没开始打参数时存在：↑↓ 归它、Tab 接受。
	// Enter 仍走 ActionSend——它是"接受还是执行"由 Update 按完全匹配判断。
	if m.MenuRows() > 0 {
		switch msg.String() {
		case "up", "ctrl+p":
			return ActionMenuUp
		case "down", "ctrl+n":
			return ActionMenuDown
		case "tab":
			return ActionMenuAccept
		}
	}
	// @ 补全候选在场时，方向键与 Tab 归它；Enter 也先接受补全（由 Update 决定）。
	if m.AtRows() > 0 {
		switch msg.String() {
		case "up", "ctrl+p":
			return ActionAtUp
		case "down", "ctrl+n":
			return ActionAtDown
		case "tab":
			return ActionAtAccept
		}
	}
	// ↑↓ 归谁：单行输入时给 stream，多行时才归输入框（光标上下移）。
	//
	// 之前只在"输入框空 && 鼠标已释放"时才滚动，导致两个死键场景：
	// 打了字之后 ↑↓ 落到 textarea，而单行输入没有可移动的行 → 什么也不发生；
	// F2 接管鼠标后 ↑↓ 又变回死键。现在按"是否多行"判断，与鼠标状态无关。
	if !strings.Contains(m.Input.Value(), "\n") {
		switch msg.String() {
		case "up":
			return ActionScrollLineUp
		case "down":
			return ActionScrollLineDown
		}
	}
	if a, ok := globalKey(msg); ok {
		return a
	}
	return ActionInput
}

// routeOverlay：覆盖层打开时，按键只属于栈顶那一层。
//
// 除了"关闭"（Esc 逐层退）之外一律交给栈顶自己处理——面板收字符做过滤、
// 列表收 ↑↓、空壳则全部吃掉（覆盖层打开时按键绝不该漏到输入框）。
func routeOverlay(_ Overlay, msg tea.KeyMsg) Action {
	switch msg.String() {
	case "esc", "ctrl+c":
		return ActionCloseOverlay
	}
	return ActionOverlayKey
}

func globalKey(msg tea.KeyMsg) (Action, bool) {
	switch msg.String() {
	// ── 导航 ───────────────────────────────────────────────
	case "alt+k":
		return ActionCursorUp, true
	case "alt+j":
		return ActionCursorDown, true
	case "alt+r":
		return ActionToggleExpand, true
	case "alt+y":
		return ActionCopy, true
	case "alt+o":
		return ActionOpenExternal, true
	case "alt+f":
		return ActionFilterFailed, true
	// ── 数据覆盖层（M2a）──────────────────────────────────
	case "alt+e":
		return ActionEnvOverlay, true
	case "alt+l":
		return ActionLineOverlay, true
	case "alt+t":
		return ActionTaskOverlay, true
	case "alt+a":
		return ActionArchiveOverlay, true
	case "alt+s":
		return ActionAttach, true
	case "alt+h":
		return ActionHistoryOverlay, true
	case "pgup":
		return ActionScrollPageUp, true
	case "pgdown":
		return ActionScrollPageDown, true
	case "alt+g":
		return ActionScrollBottom, true
	// ── 鼠标捕获开关 ───────────────────────────────────────
	// Alt+m 之外再给 F2：中文输入法开着时 Alt+字母偶尔被 IME 吃掉，
	// F 键不经过 IME。
	case "alt+q":
		return ActionQueue, true
	case "alt+u":
		return ActionDropImage, true
	case "alt+i":
		return ActionImage, true
	case "ctrl+f":
		return ActionSearch, true
	case "alt+w":
		return ActionAutoRun, true
	case "alt+x":
		return ActionSession, true
	case "f1":
		return ActionHelp, true
	case "alt+d":
		return ActionChoices, true
	case "alt+m", "f2":
		return ActionToggleMouse, true
	// ── 面板 ───────────────────────────────────────────────
	case "ctrl+k":
		return ActionCommandPalette, true
	case "ctrl+space", "ctrl+@":
		// Ctrl+Space 在终端里就是 NUL，bubbletea 只给 "ctrl+@"——
		// 两个都收，免得换终端就失灵。
		return ActionActionLayer, true
	// ── 生命周期 ───────────────────────────────────────────
	case "ctrl+c":
		return ActionQuitOrInterrupt, true
	case "enter":
		return ActionSend, true
	case "alt+enter", "shift+enter", "ctrl+j":
		// 换行。三个都收，但只有一个是跨平台可靠的：
		//  - Windows 控制台把 Ctrl+J 归一成 VK_RETURN（和 Enter 同码），
		//    bubbletea 拿不到 Ctrl 位——Ctrl+J 在 Windows 上就是"发送"。
		//  - Shift+Enter 需要 CSI-u，bubbletea v1.3 没有。
		//  - Alt+Enter 靠 Alt 位区分，Windows/Unix 都能到。
		return ActionNewline, true
	case "tab":
		return ActionTabComplete, true
	case "esc":
		return ActionCloseOverlay, true
	}
	return ActionNone, false
}
