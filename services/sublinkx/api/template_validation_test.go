package api

import (
	"strings"
	"testing"
)

func TestValidateYAMLTemplateRejectsIndentTabs(t *testing.T) {
	err := validateYAMLTemplate("clash.yaml", "proxy-groups:\n\t- name: bad\n")
	if err == nil {
		t.Fatal("validateYAMLTemplate() expected an error")
	}
	if !strings.Contains(err.Error(), "第2行") || !strings.Contains(err.Error(), "Tab") {
		t.Fatalf("validateYAMLTemplate() error = %q, want line and tab message", err.Error())
	}
}

func TestValidateYAMLTemplateReportsParserLine(t *testing.T) {
	err := validateYAMLTemplate("clash.yaml", "proxy-groups:\n  - name: ok\n    proxies: [DIRECT\n")
	if err == nil {
		t.Fatal("validateYAMLTemplate() expected an error")
	}
	if !strings.Contains(err.Error(), "第2行") {
		t.Fatalf("validateYAMLTemplate() error = %q, want parser line", err.Error())
	}
}

func TestValidateYAMLTemplateSkipsNonYAMLFiles(t *testing.T) {
	if err := validateYAMLTemplate("surge.conf", "[Proxy Group]\nA = select,DIRECT\n"); err != nil {
		t.Fatalf("validateYAMLTemplate() error = %v, want nil for non-yaml", err)
	}
}

func TestDetectVisualTemplateType(t *testing.T) {
	cases := []struct {
		name, file, content, want string
	}{
		{"clash yaml", "profile.yaml", "proxy-groups: []\n", "clash"},
		{"egern yaml", "profile.yaml", "policy_groups: []\nrules: []\n", "egern"},
		{"loon conf", "profile.conf", "[Proxy Group]\nA = select,DIRECT\n", "loon"},
		{"loon content despite yaml name", "profile.yaml", "[Proxy Group]\nA = select,DIRECT\n", "loon"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := detectVisualTemplateType(tc.file, tc.content); got != tc.want {
				t.Fatalf("detectVisualTemplateType() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestValidateVisualTemplateLoonRequiresSection(t *testing.T) {
	if _, err := validateVisualTemplate("profile.conf", "DOMAIN,example.com,DIRECT", "loon"); err == nil {
		t.Fatal("validateVisualTemplate() accepted a Loon document without INI sections")
	}
}
