package api

import (
	"fmt"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"sublink/models"

	"github.com/gin-gonic/gin"
)

func TestTemplateFingerprintTracksLocalContent(t *testing.T) {
	templatePath := filepath.Join(t.TempDir(), "clash.yaml")
	if err := os.WriteFile(templatePath, []byte("mode: rule\n"), 0600); err != nil {
		t.Fatal(err)
	}
	config := fmt.Sprintf(`{"clash":%q}`, templatePath)

	first, cacheable := templateFingerprint(config, "clash")
	if !cacheable {
		t.Fatal("local template should be cacheable")
	}
	if err := os.WriteFile(templatePath, []byte("mode: test\n"), 0600); err != nil {
		t.Fatal(err)
	}
	second, cacheable := templateFingerprint(config, "clash")
	if !cacheable {
		t.Fatal("local template should remain cacheable")
	}
	if first == second {
		t.Fatal("template fingerprint did not change with file content")
	}
}

func TestRemoteTemplateDisablesSubscriptionCache(t *testing.T) {
	config := `{"clash":"https://example.com/clash.yaml"}`
	if _, cacheable := templateFingerprint(config, "clash"); cacheable {
		t.Fatal("remote templates must not use the generated subscription cache")
	}
}

func TestEgernTemplateFingerprintTracksLocalContent(t *testing.T) {
	templatePath := filepath.Join(t.TempDir(), "egern.yaml")
	if err := os.WriteFile(templatePath, []byte("proxies: []\n"), 0600); err != nil {
		t.Fatal(err)
	}
	config := fmt.Sprintf(`{"egern":%q}`, templatePath)

	first, cacheable := templateFingerprint(config, "egern")
	if !cacheable {
		t.Fatal("local Egern template should be cacheable")
	}
	if err := os.WriteFile(templatePath, []byte("proxies: []\nipv6: false\n"), 0600); err != nil {
		t.Fatal(err)
	}
	second, cacheable := templateFingerprint(config, "egern")
	if !cacheable || first == second {
		t.Fatal("Egern template fingerprint did not change with local content")
	}
}

func TestNodeFingerprintTracksNodeChanges(t *testing.T) {
	nodes := []models.Node{{ID: 1, Name: "node", Link: "ss://first"}}
	first := subscriptionNodesFingerprint(nodes)
	nodes[0].Link = "ss://second"
	second := subscriptionNodesFingerprint(nodes)
	if first == second {
		t.Fatal("node fingerprint did not change with node content")
	}
}

func TestEgernCacheKeyTracksPublicSubscriptionURL(t *testing.T) {
	templatePath := filepath.Join(t.TempDir(), "egern.yaml")
	if err := os.WriteFile(templatePath, []byte("proxies: []\n"), 0600); err != nil {
		t.Fatal(err)
	}
	sub := models.Subcription{
		ID:     1,
		Config: fmt.Sprintf(`{"egern":%q}`, templatePath),
	}

	contextA, _ := gin.CreateTestContext(httptest.NewRecorder())
	contextA.Request = httptest.NewRequest("GET", "http://internal/c/?token=abc", nil)
	contextA.Request.Header.Set("X-Forwarded-Proto", "https")
	contextA.Request.Header.Set("X-Forwarded-Host", "a.example.com")

	contextB, _ := gin.CreateTestContext(httptest.NewRecorder())
	contextB.Request = httptest.NewRequest("GET", "http://internal/c/?token=abc", nil)
	contextB.Request.Header.Set("X-Forwarded-Proto", "https")
	contextB.Request.Header.Set("X-Forwarded-Host", "b.example.com")

	keyA, cacheableA := subscriptionCacheKey(contextA, sub, "egern")
	keyB, cacheableB := subscriptionCacheKey(contextB, sub, "egern")
	if !cacheableA || !cacheableB {
		t.Fatal("local Egern subscriptions should be cacheable")
	}
	if keyA == keyB {
		t.Fatal("Egern cache key did not change with the public subscription URL")
	}
}
