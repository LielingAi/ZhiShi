package app

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/lielingai/zhishi/tui/internal/client"
)

func writeTempPNG(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "shot.png")
	if err := os.WriteFile(p, []byte{0x89, 'P', 'N', 'G'}, 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

// Alt+i → 输入路径 → 读盘 base64 入队；状态行显示张数。
func TestAttachImageByPath(t *testing.T) {
	p := writeTempPNG(t)
	m := testModel()
	m, _ = m.Update(alt('i'))
	if _, ok := m.TopOverlay(); !ok {
		t.Fatal("Alt+i 应弹出路径输入框")
	}
	for _, r := range p {
		m, _ = m.Update(runes(string(r)))
	}
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("Enter 应加载图片")
	}
	m, _ = m.Update(cmd())
	if len(m.PendingImages) != 1 {
		t.Fatalf("应入队 1 张，实际 %d", len(m.PendingImages))
	}
	img := m.PendingImages[0]
	if img.MimeType != "image/png" || img.Name != "shot.png" {
		t.Fatalf("图片元信息不对：%+v", img)
	}
	raw, _ := base64.StdEncoding.DecodeString(img.Data)
	if len(raw) != 4 {
		t.Fatalf("base64 内容不对：%v", raw)
	}
	if !strings.Contains(m.statusLine(), "图 1") {
		t.Fatalf("状态行应显示附图数：%s", m.statusLine())
	}
}

// 不支持的格式给明确错误，不静默失败。
func TestAttachImageRejectsUnknownFormat(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a.bmp")
	_ = os.WriteFile(p, []byte("x"), 0o600)
	m := testModel()
	m, _ = m.Update(alt('i'))
	for _, r := range p {
		m, _ = m.Update(runes(string(r)))
	}
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m, _ = m.Update(cmd())
	if len(m.PendingImages) != 0 {
		t.Fatal("bmp 不该被接受")
	}
	if !strings.Contains(m.LastErr, "不支持") {
		t.Fatalf("应提示格式不支持，实际 %q", m.LastErr)
	}
}

// 只有图片没有文字也能发送；发送后清空。
func TestSendWithOnlyImage(t *testing.T) {
	m := testModel()
	m.PendingImages = []client.ChatImage{{Name: "a.png", MimeType: "image/png", Data: "aGk="}}
	m, cmd := m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("只有图片时 Enter 应发送")
	}
	if len(m.PendingImages) != 0 {
		t.Fatal("发送后应清空附图")
	}
	for _, b := range m.Store.List() {
		if !strings.Contains(b.Body, "[a.png]") {
			t.Fatalf("本地回显应带图片名：%q", b.Body)
		}
	}
}

// Alt+u 移除最后一张附图（以前只能靠发出去才能清空）。
func TestDropPendingImage(t *testing.T) {
	m := testModel()
	m.PendingImages = []client.ChatImage{{Name: "a.png"}, {Name: "b.png"}}
	m, _ = m.Update(alt('u'))
	if len(m.PendingImages) != 1 || m.PendingImages[0].Name != "a.png" {
		t.Fatalf("应移除最后一张，实际 %+v", m.PendingImages)
	}
	m, cmd := m.Update(alt('u'))
	if len(m.PendingImages) != 0 || cmd != nil {
		t.Fatalf("第二张应被移除，实际 %+v cmd=%v", m.PendingImages, cmd)
	}
	// 空的时候给提示
	m, cmd = m.Update(alt('u'))
	if cmd == nil {
		t.Fatal("没有附图时应提示")
	}
}
