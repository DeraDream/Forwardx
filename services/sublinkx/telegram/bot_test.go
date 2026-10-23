package telegram

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sublink/models"
	"testing"
)

func TestParseAdminIDs(t *testing.T) {
	ids := parseAdminIDs("123, 456；789\ninvalid")
	if len(ids) != 3 || ids[0] != 123 || ids[1] != 456 || ids[2] != 789 {
		t.Fatalf("unexpected admin ids: %#v", ids)
	}
}

func TestNormalizeReplyKeyboardCommands(t *testing.T) {
	cases := map[string]string{
		"📋 节点列表":          "📋 节点列表",
		"节点列表":            "📋 节点列表",
		"  🧾 订阅列表  ":      "🧾 订阅列表",
		"➕ 添加节点":          "➕ 添加节点",
		"🗑 删除节点":          "🗑 删除节点",
		"/nodes@demo_bot": "/nodes",
	}
	for input, expected := range cases {
		if got := normalizeCommand(input); got != expected {
			t.Fatalf("normalizeCommand(%q) = %q, want %q", input, got, expected)
		}
	}
}

func TestSubscriptionPath(t *testing.T) {
	got := subscriptionPath("myclash", "clash")
	want := "/c/?token=bd201e7e5dd57d7c21a2412ee1523905&client=clash"
	if got != want {
		t.Fatalf("subscriptionPath() = %q, want %q", got, want)
	}
}

func TestManagerTestMessage(t *testing.T) {
	var calledPaths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calledPaths = append(calledPaths, r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "result": map[string]any{}})
	}))
	defer server.Close()

	manager := &Manager{}
	err := manager.TestMessage(models.TelegramConfig{
		Token:        "test-token",
		AdminChatIDs: "123,456",
		APIBaseURL:   server.URL,
	})
	if err != nil {
		t.Fatal(err)
	}

	expected := []string{
		"/bottest-token/getMe",
		"/bottest-token/sendMessage",
		"/bottest-token/sendMessage",
	}
	if strings.Join(calledPaths, ",") != strings.Join(expected, ",") {
		t.Fatalf("unexpected calls: %#v", calledPaths)
	}
}
