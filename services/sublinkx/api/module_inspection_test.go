package api

import (
	"os"
	"strings"
	"testing"
)

func TestInspectModuleRecognizesRealLoonPluginSections(t *testing.T) {
	result, err := inspectModule(`#!name= Loon example plugin1
#!desc= Netflix评分
#!author= Loon0x00
#!homepage= https://github.com/Loon0x00
#!icon= https://example.com/icon.png

[Url Rewrite]
^https?://(www.)?g.cn https://www.google.com 302
^https?://union.click.jd.com/jda? http://union.click.jd.com/jda?adblock= header

[Script]
http-request ^https?://example.com script-path=https://example.com/a.js
http-response ^https?://example.com requires-body=1,script-path=https://example.com/b.js

[MITM]
hostname = example.com
`)
	if err != nil {
		t.Fatal(err)
	}
	if result.Kind != "loon" || result.Name != "Loon example plugin1" || result.Sections["URL Rewrite"] != 2 || result.Sections["Script"] != 2 || result.Sections["MITM"] != 1 {
		t.Fatalf("unexpected Loon inspection: %#v", result)
	}
}

func TestInspectModuleRecognizesSurgeScript(t *testing.T) {
	result, err := inspectModule("#!name=Surge Example\n[Script]\nDemo = type=http-response,pattern=^https://example.com,script-path=https://example.com/a.js\n[MITM]\nhostname = example.com\n")
	if err != nil {
		t.Fatal(err)
	}
	if result.Kind != "surge" || result.Name != "Surge Example" || result.Sections["Script"] != 1 {
		t.Fatalf("unexpected surge inspection: %#v", result)
	}
}

func TestInspectModuleRejectsMalformedLoonScript(t *testing.T) {
	if _, err := inspectModule("#!name=broken\n[Script]\nhttp-response ^https://example.com\n"); err == nil || !strings.Contains(err.Error(), "[Script]") {
		t.Fatalf("malformed Loon script must produce an INI error, got: %v", err)
	}
}

func TestInspectModuleSubStoreEgernFixture(t *testing.T) {
	// Snapshot of sub-store-org/Sub-Store config/Egern.yaml, including its
	// unquoted Egern compat_arguments placeholders.
	content, err := os.ReadFile("testdata/sub-store-egern.yaml")
	if err != nil {
		t.Fatal(err)
	}
	result, err := inspectModule(string(content))
	if err != nil {
		t.Fatal(err)
	}
	if result.Kind != "egern" || result.Name != "Sub-Store" || result.Sections["Script"] != 4 || result.Icon != "https://raw.githubusercontent.com/cc63/ICON/main/Sub-Store.png" || result.Content != string(content) {
		t.Fatalf("unexpected Sub-Store inspection: %#v", result)
	}
}

func TestInspectModuleEgernArgumentPlaceholders(t *testing.T) {
	// Egern substitutes unquoted placeholders before parsing numeric values.
	content := `name: Custom Module
compat_arguments:
  TIMEOUT: 30
  REGION: cn
rules:
  - domain_suffix:
      match: "{{{REGION}}}.example.com"
      policy: DIRECT
scriptings:
  - http_request:
      name: Example
      timeout: {{{TIMEOUT}}}
`
	result, err := inspectModule(content)
	if err != nil {
		t.Fatal(err)
	}
	if result.Kind != "egern" || result.Sections["Rule"] != 1 || result.Sections["Script"] != 1 || result.Content != content {
		t.Fatalf("unexpected inspection: %#v", result)
	}
}

func TestInspectModuleReportsHTMLInsteadOfYAMLError(t *testing.T) {
	_, err := inspectModule("<!DOCTYPE html><html><body>not found</body></html>")
	if err == nil || !strings.Contains(err.Error(), "HTML") {
		t.Fatalf("expected HTML response error, got: %v", err)
	}
}

func TestInspectModuleRecognizesLegacySurgeScript(t *testing.T) {
	result, err := inspectModule("#!name=Demo\n[Script]\nMy Script = script-path=https://example.com/a.js, requires-body=true\n[Map Local]\n^https://example.com data=abc\n")
	if err != nil {
		t.Fatal(err)
	}
	if result.Kind != "surge" || result.Sections["Script"] != 1 || result.Sections["Map Local"] != 1 {
		t.Fatalf("unexpected inspection: %#v", result)
	}
}

func TestInspectModuleRecognizesEgernModule(t *testing.T) {
	result, err := inspectModule(`name: YouTube Clean
description: demo
author: ForwardX
version: v1.2.0
url_rewrites:
  - match: ^https://example.com
    status_code: 200
header_rewrites:
  - match: ^https://example.com
    request:
      X-Demo: enabled
scriptings:
  - http_response:
      name: clean
mitm:
  hostnames:
    - example.com
rules:
  - domain_suffix: example.com
    policy: DIRECT
dns:
  hijack:
    - 8.8.8.8:53
`)
	if err != nil {
		t.Fatal(err)
	}
	if result.Kind != "egern" || result.Name != "YouTube Clean" || result.Version != "v1.2.0" || result.Sections["Rewrite"] != 2 || result.Sections["Script"] != 1 || result.Sections["MITM"] != 1 || result.Sections["Rule"] != 1 || result.Sections["DNS"] != 1 {
		t.Fatalf("unexpected Egern inspection: %#v", result)
	}
}

func TestInspectModuleRejectsGenericYAML(t *testing.T) {
	if _, err := inspectModule("proxies:\n  - name: not-a-module\n"); err == nil {
		t.Fatal("generic YAML was accepted as an Egern module")
	}
}
