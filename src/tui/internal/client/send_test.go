package client

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// /chat/send 的 payload 必须带 permissionMode 与 refs：服务端 parseChatRefs 只认
// 这两个字段，不带等于"引用白选、权限模式白切"。
func TestSendIncludesRefsAndPermissionMode(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/send" {
			t.Errorf("路径不对：%s", r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&got)
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer srv.Close()

	c := New(srv.URL, "")
	if _, err := c.Send(context.Background(), "看下这个", SendOptions{
		PermissionMode: "fullAgency",
		Refs:           []ChatRef{{Type: "file", Path: "a/b.go"}, {Type: "env", ID: "vsrx"}},
	}); err != nil {
		t.Fatalf("Send 失败：%v", err)
	}
	if got["text"] != "看下这个" || got["permissionMode"] != "fullAgency" {
		t.Fatalf("payload 缺字段：%+v", got)
	}
	refs, ok := got["refs"].([]any)
	if !ok || len(refs) != 2 {
		t.Fatalf("refs 不对：%+v", got["refs"])
	}
	first := refs[0].(map[string]any)
	if first["type"] != "file" || first["path"] != "a/b.go" {
		t.Fatalf("文件 ref 形状不对：%+v", first)
	}
}

func TestSendOmitsEmptyOptions(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer srv.Close()

	c := New(srv.URL, "")
	if _, err := c.Send(context.Background(), "hi", SendOptions{}); err != nil {
		t.Fatalf("Send 失败：%v", err)
	}
	if _, ok := got["refs"]; ok {
		t.Fatalf("空 refs 不该出现在 payload：%+v", got)
	}
	if _, ok := got["permissionMode"]; ok {
		t.Fatalf("空 permissionMode 不该出现在 payload：%+v", got)
	}
}

// 图片：base64 直传 payload.images（不走 /api/files/upload——那是往环境传文件）。
func TestSendIncludesImages(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&got)
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer srv.Close()

	c := New(srv.URL, "")
	if _, err := c.Send(context.Background(), "", SendOptions{
		Images: []ChatImage{{Name: "a.png", MimeType: "image/png", Data: "aGk="}},
	}); err != nil {
		t.Fatalf("Send 失败：%v", err)
	}
	imgs, ok := got["images"].([]any)
	if !ok || len(imgs) != 1 {
		t.Fatalf("images 缺失：%+v", got)
	}
	first := imgs[0].(map[string]any)
	if first["name"] != "a.png" || first["mimeType"] != "image/png" || first["data"] != "aGk=" {
		t.Fatalf("图片字段不对：%+v", first)
	}
}
