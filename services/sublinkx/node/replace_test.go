package node

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestReplaceServerAddress(t *testing.T) {
	tests := []struct {
		name        string
		link        string
		target      string
		wantHost    string
		wantPort    int
		wantContain string
	}{
		{
			name:        "sip002 preserves query and updated remark",
			link:        "ss://YWVzLTI1Ni1nY206cGFzcw==@203.0.113.10:8388?plugin=x%3Bmode%3Dfast#新备注",
			target:      "198.51.100.24",
			wantHost:    "203.0.113.10",
			wantPort:    8388,
			wantContain: "@198.51.100.24:8388?plugin=x%3Bmode%3Dfast#新备注",
		},
		{
			name:        "vless changes authority only",
			link:        "vless://8f67f063-aaaa-bbbb-cccc-41f6efec97e8@landing.example.com:443?security=reality&sni=landing.example.com&host=origin.example.com#香港落地",
			target:      "192.0.2.80",
			wantHost:    "landing.example.com",
			wantPort:    443,
			wantContain: "@192.0.2.80:443?security=reality&sni=landing.example.com&host=origin.example.com#香港落地",
		},
		{
			name:        "vless target ipv6 is bracketed",
			link:        "vless://user@203.0.113.9:8443?type=tcp#node",
			target:      "2001:db8::18",
			wantHost:    "203.0.113.9",
			wantPort:    8443,
			wantContain: "@[2001:db8::18]:8443?type=tcp#node",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := ReplaceServerAddress(test.link, test.target)
			if err != nil {
				t.Fatalf("ReplaceServerAddress() error = %v", err)
			}
			if got.OriginalHost != test.wantHost || got.Port != test.wantPort {
				t.Fatalf("metadata = %#v", got)
			}
			if !strings.Contains(got.Link, test.wantContain) {
				t.Fatalf("link = %q, want it to contain %q", got.Link, test.wantContain)
			}
		})
	}
}

func TestReplaceLegacySSServerPreservesEncodingAndSuffix(t *testing.T) {
	payload := base64.RawURLEncoding.EncodeToString([]byte("aes-256-cfb:password@54.169.35.228:31444"))
	result, err := ReplaceServerAddress("ss://"+payload+"#修改后的备注", "198.51.100.24")
	if err != nil {
		t.Fatalf("ReplaceServerAddress() error = %v", err)
	}
	encoded := strings.TrimSuffix(strings.TrimPrefix(result.Link, "ss://"), "#修改后的备注")
	decoded, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("replacement is not raw URL base64: %v", err)
	}
	if string(decoded) != "aes-256-cfb:password@198.51.100.24:31444" {
		t.Fatalf("decoded replacement = %q", decoded)
	}
}

func TestReplaceServerAddressRejectsInvalidInput(t *testing.T) {
	tests := []struct {
		name   string
		link   string
		target string
	}{
		{"invalid target", "vless://user@203.0.113.9:443#node", "1.2.3.999"},
		{"target contains port", "vless://user@203.0.113.9:443#node", "198.51.100.24:80"},
		{"unsupported protocol", "trojan://pass@203.0.113.9:443#node", "198.51.100.24"},
		{"missing port", "vless://user@203.0.113.9#node", "198.51.100.24"},
		{"invalid original host", "vless://user@bad_host:443#node", "198.51.100.24"},
		{"invalid original ipv4", "vless://user@999.2.3.4:443#node", "198.51.100.24"},
		{"invalid ss base64", "ss://not-base64#node", "198.51.100.24"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := ReplaceServerAddress(test.link, test.target); err == nil {
				t.Fatal("ReplaceServerAddress() expected an error")
			}
		})
	}
}
