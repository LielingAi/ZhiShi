package app

// 鼠标事件诊断（只在 ZHISHI_TUI_DEBUG_MOUSE=1 时写文件）。
//
// 为什么需要它：拖选依赖"按下 / 移动 / 松开"三类事件与坐标，任何一环在终端
// 侧丢失，表现都是"什么都没发生"，靠猜没法定位。日志落在系统临时目录，
// 看一眼就知道事件来没来、Button/Action/坐标是什么。

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// 默认开启：拖选问题的现场在用户终端里，靠"设个环境变量再跑一次"经常错过；
// 日志只有一个文件、只在鼠标事件时追加，开销可以忽略。
func mouseDebugEnabled() bool { return true }

// MouseDebugPath 返回诊断日志路径：<tmp>/zhishi-mouse.log。
func MouseDebugPath() string {
	return filepath.Join(os.TempDir(), "zhishi-mouse.log")
}

func logMouseEvent(stage string, msg tea.MouseMsg, m Model) {
	if !mouseDebugEnabled() {
		return
	}
	streamTop, rowCount := -1, 0
	if m.Frame != nil {
		streamTop, rowCount = m.Frame.streamTop, len(m.Frame.rows)
	}
	line := fmt.Sprintf("%s stage=%-7s action=%-7v button=%-7v x=%3d y=%3d top=%d rows=%d sel=%v/%v (%d,%d)→(%d,%d)\n",
		time.Now().Format("15:04:05.000"), stage, msg.Action, msg.Button, msg.X, msg.Y,
		streamTop, rowCount, m.Sel.down, m.Sel.active, m.Sel.sx, m.Sel.sy, m.Sel.ex, m.Sel.ey)
	f, err := os.OpenFile(MouseDebugPath(), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.WriteString(line)
}
