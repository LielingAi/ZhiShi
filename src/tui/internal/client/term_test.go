package client

import (
	"strings"
	"testing"
)

func TestTermEndpoint(t *testing.T) {
	cases := []struct {
		base, token, env string
		wantURL          string
		wantAuth         bool
	}{
		{
			base: "http://127.0.0.1:7411", token: "", env: "local",
			wantURL: "ws://127.0.0.1:7411/api/admin/environment/term?env=local",
		},
		{
			base: "http://127.0.0.1:7411/", token: "s3cr3t", env: "kali-lab",
			wantURL:  "ws://127.0.0.1:7411/api/admin/environment/term?env=kali-lab&token=s3cr3t",
			wantAuth: true,
		},
		{
			base: "https://team.example:443", token: "t", env: "a b",
			wantURL:  "wss://team.example:443/api/admin/environment/term?env=a+b&token=t",
			wantAuth: true,
		},
	}
	for _, c := range cases {
		gotURL, header := termEndpoint(c.base, c.token, c.env)
		if gotURL != c.wantURL {
			t.Fatalf("URL 不对：\n实际 %s\n期望 %s", gotURL, c.wantURL)
		}
		_, hasAuth := header["Authorization"]
		if hasAuth != c.wantAuth {
			t.Fatalf("token=%q 时 Authorization 头存在性不对：%v", c.token, header)
		}
	}
}

func TestTermFrameJSON(t *testing.T) {
	// 未用字段不进 JSON：服务端按 type 分发，多余的空字段会让帧变脏。
	got := string(TermFrame{Type: "input", Data: "ls\r"}.JSON())
	if got != `{"type":"input","data":"ls\r"}` {
		t.Fatalf("input 帧形状不对：%s", got)
	}
	got = string(TermFrame{Type: "resize", Cols: 120, Rows: 40}.JSON())
	if got != `{"type":"resize","cols":120,"rows":40}` {
		t.Fatalf("resize 帧形状不对：%s", got)
	}
	got = string(TermFrame{Type: "ping"}.JSON())
	if got != `{"type":"ping"}` {
		t.Fatalf("ping 帧形状不对：%s", got)
	}
	if !strings.Contains(string(TermFrame{Type: "exit", Code: 7}.JSON()), `"code":7`) {
		t.Fatal("exit 帧要带 code")
	}
}
