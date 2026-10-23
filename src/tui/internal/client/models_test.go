package client

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// model/list 的真实形状：data 是 provider 数组，models 是对象数组，
// current 在信封层。按 []string 解会报 "cannot unmarshal object"。
func TestModelsParsesRealShape(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{
			"success": true,
			"data": [
				{"id":"deepseek","name":"DeepSeek","status":"valid","hasApiKey":true,
				 "models":[{"model":"deepseek-v4-pro","modelName":"V4 Pro"},{"model":"deepseek-flash"}]},
				{"id":"kimi","name":"Kimi","status":"not-set","hasApiKey":false,
				 "models":[{"model":"k3"}]}
			],
			"current": {"providerId":"deepseek","modelId":"deepseek-v4-pro"}
		}`))
	}))
	defer srv.Close()

	opts, err := New(srv.URL, "").Models(context.Background())
	if err != nil {
		t.Fatalf("Models 失败：%v", err)
	}
	if len(opts) != 3 {
		t.Fatalf("应有 3 个模型，实际 %d：%+v", len(opts), opts)
	}
	if opts[0].ProviderID != "deepseek" || opts[0].Model != "deepseek-v4-pro" || !opts[0].Current {
		t.Fatalf("当前模型标记不对：%+v", opts[0])
	}
	if opts[2].ProviderID != "kimi" || opts[2].Status != "not-set" {
		t.Fatalf("未配 key 的 provider 应标 not-set：%+v", opts[2])
	}
}
