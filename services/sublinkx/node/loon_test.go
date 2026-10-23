package node

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEncodeLoonWritesShadowsocksInNativeProxySyntax(t *testing.T) {
	output, err := EncodeLoon([]string{
		"ss://YWVzLTEyOC1nY206cGFzc0BleGFtcGxlLmNvbTo0NDM#SS",
		"tuic://unsupported",
		"vless://uuid@example.com:443?type=ws#VLESS",
	}, SqlConfig{})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output, `SS = Shadowsocks,example.com,443,aes-128-gcm,"pass",udp=false`) {
		t.Fatalf("Loon output did not contain a native Shadowsocks proxy: %q", output)
	}
	if strings.Contains(output, "\nss://") || !strings.Contains(output, "vless://uuid") {
		t.Fatalf("Loon output did not contain the expected proxy entries: %q", output)
	}
	if strings.Contains(output, "tuic://") {
		t.Fatalf("Loon output must omit unsupported TUIC URI: %q", output)
	}
}

func TestEncodeLoonInjectsNativeShadowsocksIntoPolicyGroups(t *testing.T) {
	path := filepath.Join(t.TempDir(), "loon.conf")
	template := `[Proxy]
__LOON_PROXY_ENTRIES__
[Proxy Group]
Proxy = select,__LOON_ALL_NODES__,DIRECT`
	if err := os.WriteFile(path, []byte(template), 0600); err != nil {
		t.Fatal(err)
	}

	output, err := EncodeLoon([]string{testSSLink("Node A")}, SqlConfig{Loon: path, Udp: true})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output, `Node A = Shadowsocks,example.com,8388,aes-128-gcm,"password",udp=true`) {
		t.Fatalf("Loon output did not contain native Shadowsocks syntax: %q", output)
	}
	if !strings.Contains(output, "Proxy = select,Node A,DIRECT") {
		t.Fatalf("Loon policy group did not reference the injected node: %q", output)
	}
}

func TestEncodeLoonInjectsTemplate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "loon.conf")
	if err := os.WriteFile(path, []byte("[General]\ndns-server = system\n[Proxy]\n[Rule]\nFINAL,DIRECT"), 0600); err != nil {
		t.Fatal(err)
	}
	output, err := EncodeLoon([]string{"trojan://password@example.com:443#node"}, SqlConfig{Loon: path})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output, "[Proxy]\ntrojan://") || !strings.Contains(output, "[Rule]\nFINAL,DIRECT") {
		t.Fatalf("unexpected rendered Loon template: %q", output)
	}
}

func TestEncodeLoonRendersDynamicPolicyGroupNodes(t *testing.T) {
	path := filepath.Join(t.TempDir(), "loon.conf")
	template := `[Proxy]
__LOON_PROXY_ENTRIES__
[Proxy Group]
♻️ 自动选择 = url-test,__LOON_ALL_NODES__,url=http://www.gstatic.com/generate_204,interval=300
🚀 节点选择 = select,♻️ 自动选择,__LOON_ALL_NODES__,DIRECT,missing-node
[Rule]
FINAL,🚀 节点选择`
	if err := os.WriteFile(path, []byte(template), 0600); err != nil {
		t.Fatal(err)
	}

	output, err := EncodeLoon([]string{
		"trojan://password@example.com:443#Po0-SGS",
		"vless://uuid@example.com:443?type=ws#%E5%B9%BF%E6%B8%AF%20IEPL-HKS",
	}, SqlConfig{Loon: path})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(output, "__LOON_") {
		t.Fatalf("Loon output retains placeholder: %q", output)
	}
	for _, expected := range []string{
		"♻️ 自动选择 = url-test,Po0-SGS,广港 IEPL-HKS,url=http://www.gstatic.com/generate_204,interval=300",
		"🚀 节点选择 = select,♻️ 自动选择,Po0-SGS,广港 IEPL-HKS,DIRECT",
	} {
		if !strings.Contains(output, expected) {
			t.Fatalf("Loon output missing %q:\n%s", expected, output)
		}
	}
}

func TestEncodeLoonRejectsUnresolvedInternalPlaceholder(t *testing.T) {
	path := filepath.Join(t.TempDir(), "loon.conf")
	if err := os.WriteFile(path, []byte("[Proxy]\n__LOON_UNKNOWN__"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := EncodeLoon([]string{"trojan://password@example.com:443#node"}, SqlConfig{Loon: path}); err == nil {
		t.Fatal("EncodeLoon accepted an unresolved internal placeholder")
	}
}

func TestEncodeLoonKeepsReferencesToExistingTemplateProxies(t *testing.T) {
	path := filepath.Join(t.TempDir(), "loon.conf")
	template := `[Proxy]
Template Proxy = ss, example.com, 8388
[Proxy Group]
Proxy = select,Template Proxy,missing-node,DIRECT`
	if err := os.WriteFile(path, []byte(template), 0600); err != nil {
		t.Fatal(err)
	}
	output, err := EncodeLoon([]string{"trojan://password@example.com:443#dynamic"}, SqlConfig{Loon: path})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(output, "Proxy = select,Template Proxy,DIRECT") {
		t.Fatalf("Loon output dropped a real template proxy or retained an invalid member: %q", output)
	}
}
