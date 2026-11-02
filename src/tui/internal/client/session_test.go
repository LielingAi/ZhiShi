package client

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNewSessionAndLiveAttach(t *testing.T) {
	var attached bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/sessions/new":
			_, _ = w.Write([]byte(`{"success":true,"sessionId":"ls-window"}`))
		case "/chat/stream":
			attached = r.URL.Query().Get("sessionId") == "ls-window" && r.URL.Query().Get("attach") == "1"
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = w.Write([]byte(": ok\n\n"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	c := New(srv.URL, "")
	sessionID, err := c.NewSession(context.Background())
	if err != nil || sessionID != "ls-window" {
		t.Fatalf("NewSession = %q, %v", sessionID, err)
	}
	sub, err := c.Subscribe(context.Background(), sessionID)
	if err != nil {
		t.Fatalf("Subscribe 失败：%v", err)
	}
	sub.Close()
	if !attached {
		t.Fatal("live 订阅必须同时携带 sessionId 与 attach=1")
	}
}
