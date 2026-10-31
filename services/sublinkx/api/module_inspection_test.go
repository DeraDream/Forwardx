package api

import "testing"

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

func TestInspectModuleRejectsMalformedLoonScript(t *testing.T) {
	if _, err := inspectModule("#!name=broken\n[Script]\nhttp-response ^https://example.com\n"); err == nil {
		t.Fatal("malformed Loon script was accepted")
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
