package node

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func testSSLink(name string) string {
	return EncodeSSURL(Ss{
		Name:   name,
		Server: "example.com",
		Port:   8388,
		Param: Param{
			Cipher:   "aes-128-gcm",
			Password: "password",
		},
	})
}

func TestEncodeClashInitializesMissingGroupProxies(t *testing.T) {
	templatePath := filepath.Join(t.TempDir(), "clash.yaml")
	template := `proxies: []
proxy-groups:
  - name: Proxy
    type: select
rules: []
`
	if err := os.WriteFile(templatePath, []byte(template), 0600); err != nil {
		t.Fatal(err)
	}

	output, err := EncodeClash([]string{testSSLink("Node A")}, SqlConfig{Clash: templatePath})
	if err != nil {
		t.Fatal(err)
	}

	var profile map[string]interface{}
	if err := yaml.Unmarshal(output, &profile); err != nil {
		t.Fatal(err)
	}
	groups := profile["proxy-groups"].([]interface{})
	group := groups[0].(map[string]interface{})
	proxies := group["proxies"].([]interface{})
	if len(proxies) != 1 || proxies[0] != "Node A" {
		t.Fatalf("group proxies = %#v, want [Node A]", proxies)
	}
}

func TestEncodeClashPreservesTemplateTopLevelOrder(t *testing.T) {
	templatePath := filepath.Join(t.TempDir(), "clash.yaml")
	template := `unified-delay: true
mixed-port: 7890
proxies: []
proxy-groups:
  - name: Proxy
    type: select
    proxies: [DIRECT]
rules: []
`
	if err := os.WriteFile(templatePath, []byte(template), 0600); err != nil {
		t.Fatal(err)
	}

	output, err := EncodeClash([]string{testSSLink("Node A")}, SqlConfig{Clash: templatePath})
	if err != nil {
		t.Fatal(err)
	}
	text := string(output)
	for _, key := range []string{"unified-delay:", "mixed-port:", "proxies:", "proxy-groups:", "rules:"} {
		if !strings.Contains(text, key) {
			t.Fatalf("output missing %q:\n%s", key, text)
		}
	}
	if strings.Index(text, "unified-delay:") > strings.Index(text, "mixed-port:") ||
		strings.Index(text, "mixed-port:") > strings.Index(text, "proxies:") ||
		strings.Index(text, "proxies:") > strings.Index(text, "proxy-groups:") ||
		strings.Index(text, "proxy-groups:") > strings.Index(text, "rules:") {
		t.Fatalf("top-level key order changed:\n%s", text)
	}
}

func TestEncodeSurgeInjectsBeforeParametersAndSkipsSubnet(t *testing.T) {
	templatePath := filepath.Join(t.TempDir(), "surge.conf")
	template := `[General]
test-timeout = 5

[Proxy]
DIRECT = direct

[Proxy Group]
Proxy = select, DIRECT, interval=600
Auto = url-test, DIRECT, tolerance=100, interval=300
Balance = load-balance, DIRECT, persistent=true
Subnet = subnet, default = DIRECT, TYPE:WIFI = Proxy

[Rule]
FINAL,Proxy
`
	if err := os.WriteFile(templatePath, []byte(template), 0600); err != nil {
		t.Fatal(err)
	}

	output, err := EncodeSurge([]string{testSSLink("Node A"), testSSLink("Node B")}, SqlConfig{Surge: templatePath})
	if err != nil {
		t.Fatal(err)
	}

	expectations := []string{
		"Proxy = select, DIRECT, Node A, Node B, interval=600",
		"Auto = url-test, DIRECT, Node A, Node B, tolerance=100, interval=300",
		"Balance = load-balance, DIRECT, Node A, Node B, persistent=true",
		"Subnet = subnet, default = DIRECT, TYPE:WIFI = Proxy",
	}
	for _, expected := range expectations {
		if !strings.Contains(output, expected) {
			t.Fatalf("Surge output missing %q:\n%s", expected, output)
		}
	}
}
