package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/gin-gonic/gin"
)

func withVisualTemplateTestDir(t *testing.T) {
	t.Helper()
	oldDir, oldErr := visualTemplateDir, visualTemplateDirErr
	visualTemplateDir = t.TempDir()
	visualTemplateDirErr = nil
	visualTemplateDirOnce = sync.Once{}
	t.Cleanup(func() {
		visualTemplateDir, visualTemplateDirErr = oldDir, oldErr
		visualTemplateDirOnce = sync.Once{}
	})
}

func callVisualTemplateJSON(t *testing.T, handler gin.HandlerFunc, payload any) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	writer := httptest.NewRecorder()
	router := gin.New()
	router.POST("/", handler)
	router.ServeHTTP(writer, req)
	return writer
}

func TestVisualTemplateHandlersSupportIndependentFormats(t *testing.T) {
	gin.SetMode(gin.TestMode)
	withVisualTemplateTestDir(t)
	cases := []struct {
		file, kind, content string
	}{
		{"egern.yaml", "egern", "policy_groups: []\nrules:\n  - default:\n      policy: DIRECT\n"},
		{"egern-modules.yaml", "egern", "modules:\n  - url: https://example.com/module.yaml\n"},
		{"loon.conf", "loon", "[Proxy Group]\nPROXY = select,DIRECT\n\n[Rule]\nFINAL,DIRECT\n"},
		{"clash.yaml", "clash", "proxy-groups: []\nrules:\n  - MATCH,DIRECT\n"},
	}
	for _, tc := range cases {
		writer := callVisualTemplateJSON(t, CreateVisualTemplate, map[string]string{"filename": tc.file, "content": tc.content, "type": tc.kind})
		if writer.Code != http.StatusOK {
			t.Fatalf("create %s: status %d, body %s", tc.kind, writer.Code, writer.Body.String())
		}
	}

	listWriter := httptest.NewRecorder()
	listRouter := gin.New()
	listRouter.GET("/", ListVisualTemplates)
	listRouter.ServeHTTP(listWriter, httptest.NewRequest(http.MethodGet, "/", nil))
	if listWriter.Code != http.StatusOK {
		t.Fatalf("list: status %d, body %s", listWriter.Code, listWriter.Body.String())
	}
	var listResponse struct {
		Data []VisualTemplate `json:"data"`
	}
	if err := json.Unmarshal(listWriter.Body.Bytes(), &listResponse); err != nil {
		t.Fatal(err)
	}
	types := map[string]string{}
	for _, item := range listResponse.Data {
		types[item.File] = item.Type
	}
	for _, tc := range cases {
		if types[tc.file] != tc.kind {
			t.Errorf("list type for %s = %q, want %q", tc.file, types[tc.file], tc.kind)
		}
	}

	wrong := callVisualTemplateJSON(t, CreateVisualTemplate, map[string]string{"filename": "wrong.yaml", "content": "proxy-groups: []\n", "type": "egern"})
	if wrong.Code != http.StatusBadRequest {
		t.Fatalf("mismatched type status = %d, want 400; body %s", wrong.Code, wrong.Body.String())
	}
}
