package node

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"gopkg.in/yaml.v3"
)

func writeEgernTestTemplate(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "egern.yaml")
	template := `proxies: []
policy_groups:
  - select:
      name: Proxy
      policies:
        - DIRECT
  - external:
      name: External Auto
      type: auto_test
      filter: ".*"
      update_interval: 86400
      urls: []
  - external:
      name: External Balance
      type: load_balance
      algorithm: hash
      filter: ".*"
      update_interval: 86400
      urls:
        - https://placeholder.example.com/subscription
  - conditional:
      name: Conditional
      rules:
        - ssid:
            match: Home
            policy: Proxy
      default_policy: DIRECT
rules:
  - default:
      policy: Proxy
`
	if err := os.WriteFile(path, []byte(template), 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestEncodeEgernUsesNativeProxyShape(t *testing.T) {
	vmessJSON, err := json.Marshal(Vmess{
		V:    "2",
		Ps:   "VMess Node",
		Add:  "vmess.example.com",
		Port: "443",
		Id:   "27848739-7e62-4138-9fd3-098a63964b6b",
		Scy:  "auto",
		Net:  "ws",
		Path: "/ws",
		Host: "cdn.example.com",
		Tls:  "tls",
	})
	if err != nil {
		t.Fatal(err)
	}

	links := []string{
		EncodeSSURL(Ss{
			Name:   "SS Node",
			Server: "ss.example.com",
			Port:   8388,
			Param: Param{
				Cipher:   "aes-256-gcm",
				Password: "secret",
			},
		}),
		"vmess://" + Base64Encode(string(vmessJSON)),
		"trojan://password@trojan.example.com:443?sni=trojan.example.com#Trojan%20Node",
		"vless://27848739-7e62-4138-9fd3-098a63964b6b@vless.example.com:443?security=tls&sni=vless.example.com&type=tcp#VLESS%20Node",
		"hy2://password@hy2.example.com:443?sni=hy2.example.com&obfs=salamander&obfs-password=obfs#HY2%20Node",
		"tuic://27848739-7e62-4138-9fd3-098a63964b6b:password@tuic.example.com:443?sni=tuic.example.com#TUIC%20Node",
	}

	output, err := EncodeEgern(links, SqlConfig{
		Egern: writeEgernTestTemplate(t),
		Udp:   true,
		Cert:  true,
	})
	if err != nil {
		t.Fatal(err)
	}

	var profile map[string]interface{}
	if err := yaml.Unmarshal(output, &profile); err != nil {
		t.Fatal(err)
	}
	proxies, ok := profile["proxies"].([]interface{})
	if !ok || len(proxies) != len(links) {
		t.Fatalf("proxies = %#v, want %d native Egern proxies", profile["proxies"], len(links))
	}

	wantProtocols := []string{"shadowsocks", "vmess", "trojan", "vless", "hysteria2", "tuic"}
	for index, protocol := range wantProtocols {
		item, ok := proxies[index].(map[string]interface{})
		if !ok {
			t.Fatalf("proxy %d = %#v", index, proxies[index])
		}
		if _, ok := item[protocol].(map[string]interface{}); !ok {
			t.Fatalf("proxy %d does not use Egern %q wrapper: %#v", index, protocol, item)
		}
		if _, exists := item["type"]; exists {
			t.Fatalf("proxy %d unexpectedly uses Clash type field", index)
		}
	}

	vmess := proxies[1].(map[string]interface{})["vmess"].(map[string]interface{})
	transport := vmess["transport"].(map[string]interface{})
	if _, ok := transport["wss"]; !ok {
		t.Fatalf("vmess transport = %#v, want wss", transport)
	}
}

func TestEncodeEgernInjectsSelectedNodesIntoPolicyGroups(t *testing.T) {
	links := []string{
		EncodeSSURL(Ss{
			Name:   "Node A",
			Server: "a.example.com",
			Port:   8388,
			Param:  Param{Cipher: "aes-128-gcm", Password: "a"},
		}),
		EncodeSSURL(Ss{
			Name:   "Node B",
			Server: "b.example.com",
			Port:   8388,
			Param:  Param{Cipher: "aes-128-gcm", Password: "b"},
		}),
	}
	template := writeEgernTestTemplate(t)
	output, err := EncodeEgern(links, SqlConfig{
		Egern:                      template,
		EgernUpdateURL:             "https://sub.example.com/c/?token=abc&client=egern",
		EgernUpdateIntervalMinutes: 30,
		GroupNodesTemplate:         template,
		GroupNodes: map[string]PolicyGroupNodeRule{
			"Proxy":         {Mode: "include", Nodes: []string{"Node B"}},
			"External Auto": {Mode: "include", Nodes: []string{"Node A"}},
			"External Balance": {
				Mode:  "include",
				Nodes: []string{"Node B"},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	var profile map[string]interface{}
	if err := yaml.Unmarshal(output, &profile); err != nil {
		t.Fatal(err)
	}
	groups := profile["policy_groups"].([]interface{})
	selectGroup := groups[0].(map[string]interface{})["select"].(map[string]interface{})
	policies := selectGroup["policies"].([]interface{})
	if len(policies) != 2 || policies[0] != "DIRECT" || policies[1] != "Node B" {
		t.Fatalf("policies = %#v, want [DIRECT Node B]", policies)
	}
	autoGroupItem := groups[1].(map[string]interface{})
	if _, exists := autoGroupItem["external"]; exists {
		t.Fatalf("external group was not converted to a local group: %#v", autoGroupItem)
	}
	autoGroup := autoGroupItem["auto_test"].(map[string]interface{})
	autoPolicies := autoGroup["policies"].([]interface{})
	if len(autoPolicies) != 1 || autoPolicies[0] != "Node A" {
		t.Fatalf("auto_test policies = %#v, want [Node A]", autoPolicies)
	}
	for _, field := range []string{"type", "urls", "update_interval", "filter"} {
		if _, exists := autoGroup[field]; exists {
			t.Fatalf("converted auto_test group retained external-only field %q: %#v", field, autoGroup)
		}
	}
	balanceGroupItem := groups[2].(map[string]interface{})
	if _, exists := balanceGroupItem["external"]; exists {
		t.Fatalf("external group was not converted to a local group: %#v", balanceGroupItem)
	}
	balanceGroup := balanceGroupItem["load_balance"].(map[string]interface{})
	balancePolicies := balanceGroup["policies"].([]interface{})
	if len(balancePolicies) != 1 || balancePolicies[0] != "Node B" {
		t.Fatalf("load_balance policies = %#v, want [Node B]", balancePolicies)
	}
	if balanceGroup["algorithm"] != "hash" {
		t.Fatalf("load_balance algorithm = %#v, want hash", balanceGroup["algorithm"])
	}
	for _, field := range []string{"type", "urls", "update_interval", "filter"} {
		if _, exists := balanceGroup[field]; exists {
			t.Fatalf("converted load_balance group retained external-only field %q: %#v", field, balanceGroup)
		}
	}
	conditionalGroup := groups[3].(map[string]interface{})["conditional"].(map[string]interface{})
	if _, exists := conditionalGroup["policies"]; exists {
		t.Fatalf("conditional group should not receive local proxy policies: %#v", conditionalGroup)
	}
}

func TestEncodeEgernInjectsNodesIntoSmartPolicyGroups(t *testing.T) {
	templatePath := filepath.Join(t.TempDir(), "egern-smart.yaml")
	template := `proxies: []
policy_groups:
  - smart:
      name: Smart
      policies: []
      priorities:
        "^Node A$": 0.8
  - external:
      name: External Smart
      type: smart
      priorities:
        "^Node B$": 0.8
      urls: []
`
	if err := os.WriteFile(templatePath, []byte(template), 0600); err != nil {
		t.Fatal(err)
	}

	output, err := EncodeEgern([]string{testSSLink("Node A"), testSSLink("Node B")}, SqlConfig{
		Egern:              templatePath,
		GroupNodesTemplate: templatePath,
		GroupNodes: map[string]PolicyGroupNodeRule{
			"Smart":          {Mode: "include", Nodes: []string{"Node A"}},
			"External Smart": {Mode: "include", Nodes: []string{"Node B"}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	var profile map[string]interface{}
	if err := yaml.Unmarshal(output, &profile); err != nil {
		t.Fatal(err)
	}
	groups := profile["policy_groups"].([]interface{})

	smart := groups[0].(map[string]interface{})["smart"].(map[string]interface{})
	if policies := smart["policies"].([]interface{}); len(policies) != 1 || policies[0] != "Node A" {
		t.Fatalf("smart policies = %#v, want [Node A]", policies)
	}
	if smart["priorities"].(map[string]interface{})["^Node A$"] != 0.8 {
		t.Fatalf("smart priorities = %#v", smart["priorities"])
	}

	external := groups[1].(map[string]interface{})
	if _, exists := external["external"]; exists {
		t.Fatalf("external smart group was not converted: %#v", external)
	}
	converted := external["smart"].(map[string]interface{})
	if policies := converted["policies"].([]interface{}); len(policies) != 1 || policies[0] != "Node B" {
		t.Fatalf("external smart policies = %#v, want [Node B]", policies)
	}
	for _, field := range []string{"type", "urls", "update_interval", "filter"} {
		if _, exists := converted[field]; exists {
			t.Fatalf("converted smart group retained external-only field %q: %#v", field, converted)
		}
	}
}

func TestEncodeEgernInjectsDynamicAutoUpdate(t *testing.T) {
	templatePath := filepath.Join(t.TempDir(), "egern-auto-update.yaml")
	template := `auto_update:
  url: https://stale.example.com/old
  interval: 60
proxies: []
policy_groups:
  - select:
      name: Proxy
      policies:
        - DIRECT
`
	if err := os.WriteFile(templatePath, []byte(template), 0600); err != nil {
		t.Fatal(err)
	}

	output, err := EncodeEgern(nil, SqlConfig{
		Egern:                      templatePath,
		EgernUpdateURL:             "https://sub.example.com/c/?token=abc&client=egern",
		EgernUpdateIntervalMinutes: 30,
	})
	if err != nil {
		t.Fatal(err)
	}

	var profile map[string]interface{}
	if err := yaml.Unmarshal(output, &profile); err != nil {
		t.Fatal(err)
	}
	autoUpdate, ok := profile["auto_update"].(map[string]interface{})
	if !ok {
		t.Fatalf("auto_update = %#v", profile["auto_update"])
	}
	if autoUpdate["url"] != "https://sub.example.com/c/?token=abc&client=egern" {
		t.Fatalf("auto_update.url = %#v", autoUpdate["url"])
	}
	if autoUpdate["interval"] != 1800 {
		t.Fatalf("auto_update.interval = %#v, want 1800", autoUpdate["interval"])
	}
}

func TestEncodeEgernDefaultsAutoUpdateToOneDay(t *testing.T) {
	output, err := EncodeEgern(nil, SqlConfig{
		Egern:          writeEgernTestTemplate(t),
		EgernUpdateURL: "https://sub.example.com/c/?token=abc&client=egern",
	})
	if err != nil {
		t.Fatal(err)
	}
	var profile map[string]interface{}
	if err := yaml.Unmarshal(output, &profile); err != nil {
		t.Fatal(err)
	}
	autoUpdate := profile["auto_update"].(map[string]interface{})
	if autoUpdate["interval"] != 86400 {
		t.Fatalf("auto_update.interval = %#v, want 86400", autoUpdate["interval"])
	}
}

func TestEncodeEgernSkipsUnsupportedProtocols(t *testing.T) {
	output, err := EncodeEgern([]string{
		"ssr://unsupported",
		"vless://id@reality.example.com:443?security=reality#Reality",
	}, SqlConfig{Egern: writeEgernTestTemplate(t)})
	if err != nil {
		t.Fatal(err)
	}
	var profile map[string]interface{}
	if err := yaml.Unmarshal(output, &profile); err != nil {
		t.Fatal(err)
	}
	if proxies := profile["proxies"].([]interface{}); len(proxies) != 0 {
		t.Fatalf("unsupported proxies were not skipped: %#v", proxies)
	}
}
