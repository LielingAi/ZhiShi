package app

// 图片附件（Alt+i）：终端里没有原生文件选择框，交互就只能是**路径**。
//
// 两种常见来源都覆盖：
//   - 拖文件进终端 → 终端会粘贴它的路径（Windows Terminal 拖放即粘贴路径）
//   - 手动输入 / 复制路径，或直接粘贴（Ctrl+V 由终端处理成字符流）
//
// 选完立刻读盘并 base64 编码进内存；发送时随 /chat/send 的 images 走。
// 不做上传中转：聊天图片走的是 payload.images（base64），不是
// /api/files/upload（那条是"往环境里传文件"，语义不同）。

import (
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lielingai/zhishi/tui/internal/client"
)

// maxImageBytes 是单张图片上限：base64 后体积 ×1.37，8MB 原图已经 11MB 请求体，
// 再大既拖慢首 token，也可能撞上服务端/模型的请求体限制。
const maxImageBytes = 8 << 20

// imageMime 按扩展名判 MIME。识别不了返回空——让用户换个格式，而不是瞎猜。
func imageMime(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	default:
		return ""
	}
}

type imageLoadedMsg struct {
	img client.ChatImage
	err error
}

func loadImageCmd(path string) tea.Cmd {
	return func() tea.Msg {
		p := strings.TrimSpace(strings.Trim(path, `"'`))
		if p == "" {
			return imageLoadedMsg{err: fmt.Errorf("路径为空")}
		}
		mime := imageMime(p)
		if mime == "" {
			return imageLoadedMsg{err: fmt.Errorf("不支持的图片格式（png/jpg/gif/webp）：%s", p)}
		}
		fi, err := os.Stat(p)
		if err != nil {
			return imageLoadedMsg{err: fmt.Errorf("读不到文件：%w", err)}
		}
		if fi.Size() > maxImageBytes {
			return imageLoadedMsg{err: fmt.Errorf("图片太大（%.1fMB > 8MB）", float64(fi.Size())/(1<<20))}
		}
		raw, err := os.ReadFile(p)
		if err != nil {
			return imageLoadedMsg{err: fmt.Errorf("读盘失败：%w", err)}
		}
		return imageLoadedMsg{img: client.ChatImage{
			Name:     filepath.Base(p),
			MimeType: mime,
			Data:     base64.StdEncoding.EncodeToString(raw),
		}}
	}
}

// addPendingImage 入队并提示（重复路径/名字允许——同图两次引用是合法需求）。
func (m *Model) addPendingImage(img client.ChatImage) {
	m.PendingImages = append(m.PendingImages, img)
	m.LastNotice = fmt.Sprintf("已附加图片 %s（共 %d 张，Enter 发送）", img.Name, len(m.PendingImages))
}

// clearPendingImages 发送后清空。
func (m *Model) clearPendingImages() {
	m.PendingImages = nil
}
