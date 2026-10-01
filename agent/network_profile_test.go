package main

import "testing"

func TestProfileASNNumber(t *testing.T) {
	cases := map[any]int64{
		"AS63150 BAGE CLOUD LLC": 63150,
		"63150": 63150,
		float64(63150): 63150,
	}
	for input, expected := range cases {
		if got := profileASNNumber(input); got != expected {
			t.Fatalf("profileASNNumber(%v)=%d want=%d", input, got, expected)
		}
	}
}

func TestProfileRiskLevel(t *testing.T) {
	cases := []struct {
		score float64
		want string
	}{
		{0, "low"}, {25, "low"}, {26, "medium"}, {50, "medium"},
		{51, "high"}, {75, "high"}, {76, "very_high"}, {100, "very_high"},
	}
	for _, tc := range cases {
		if got := profileRiskLevel(tc.score); got != tc.want {
			t.Fatalf("profileRiskLevel(%v)=%q want=%q", tc.score, got, tc.want)
		}
	}
}

func TestNetworkProfilePatterns(t *testing.T) {
	youtube := `{"INNERTUBE_CONTEXT_GL":"HK"} YouTube Premium ad-free`
	match := youtubeRegionPattern.FindStringSubmatch(youtube)
	if len(match) < 2 || match[1] != "HK" {
		t.Fatalf("youtube region parse failed: %#v", match)
	}

	steam := `<meta itemprop="priceCurrency" content="HKD"><script>{"priceCurrency":"HKD"}</script>`
	match = steamCurrencyPattern.FindStringSubmatch(steam)
	if len(match) < 2 || match[1] != "HKD" {
		t.Fatalf("steam currency parse failed: %#v", match)
	}
}

func TestProfileShortASNName(t *testing.T) {
	cases := []struct {
		asn  int64
		raw  string
		want string
	}{
		{174, "COGENT-174 - Cogent Communications", "Cogent"},
		{701, "UUNET - MCI Communications Services, Inc.", "Verizon"},
		{1299, "TWELVE99 - Arelion Sweden AB", "Arelion"},
		{216211, "CYBERVERSE-BACKBONE - Cyberverse LLC", "Cyberverse"},
		{213845, "Cylix Cylix Pte. Ltd.", "Cylix"},
	}
	for _, tc := range cases {
		if got := profileShortASNName(tc.asn, tc.raw); got != tc.want {
			t.Fatalf("profileShortASNName(%d, %q)=%q want=%q", tc.asn, tc.raw, got, tc.want)
		}
	}
}


func TestProfileIPNatureFromEvidence(t *testing.T) {
	cases := []struct {
		name       string
		actual     []profileCountryEvidence
		registered []profileCountryEvidence
		want       string
	}{
		{
			name: "maxmind same country is native like IPQuality",
			actual: []profileCountryEvidence{{Provider: "MaxMind GeoIP", Country: "SG"}},
			registered: []profileCountryEvidence{{Provider: "MaxMind RegisteredCountry", Country: "SG"}},
			want: "native",
		},
		{
			name: "maxmind different country is broadcast like IPQuality",
			actual: []profileCountryEvidence{{Provider: "MaxMind GeoIP", Country: "SG"}},
			registered: []profileCountryEvidence{{Provider: "MaxMind RegisteredCountry", Country: "HK"}},
			want: "broadcast",
		},
		{
			name: "ipinfo fallback same country is native",
			actual: []profileCountryEvidence{{Provider: "IPinfo GeoIP", Country: "SG"}},
			registered: []profileCountryEvidence{{Provider: "IPinfo Abuse Country", Country: "SG"}},
			want: "native",
		},
		{
			name: "consensus fallback compares countries",
			actual: []profileCountryEvidence{{Provider: "ipwho.is", Country: "SG"}},
			registered: []profileCountryEvidence{{Provider: "RDAP", Country: "US"}},
			want: "broadcast",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, _, _, _ := profileIPNatureFromEvidence(tc.actual, tc.registered)
			if got != tc.want {
				t.Fatalf("profileIPNatureFromEvidence()=%q want=%q", got, tc.want)
			}
		})
	}
}

func TestProfileBGPToolsGraphPath(t *testing.T) {
	cases := []struct {
		body string
		want string
	}{
		{`<img id="pathimg" src="/pathimg/rt-209.33.171.0_24?abc&amp;loggedin">`, "/pathimg/rt-209.33.171.0_24?abc&loggedin"},
		{`<img class="x" src="https://bgp.tools/pathimg/rt-1.1.1.0_24?xyz" id="pathimg">`, "/pathimg/rt-1.1.1.0_24?xyz"},
		{`<img id="other" src="/pathimg/nope">`, ""},
	}
	for _, tc := range cases {
		if got := profileBGPToolsGraphPath(tc.body); got != tc.want {
			t.Fatalf("profileBGPToolsGraphPath(%q)=%q want=%q", tc.body, got, tc.want)
		}
	}
}


func TestProfileBGPToolsGraphPathFromPrefix(t *testing.T) {
	cases := map[string]string{
		"155.103.50.0/24": "/pathimg/rt-155.103.50.0_24",
		"2401:a4a0:2:4bc::/64": "/pathimg/rt-2401:a4a0:2:4bc::_64",
	}
	for input, want := range cases {
		if got := profileBGPToolsGraphPathFromPrefix(input); got != want {
			t.Fatalf("profileBGPToolsGraphPathFromPrefix(%q)=%q want=%q", input, got, want)
		}
	}
}

func TestProfileDNSBLDomains(t *testing.T) {
	domains := profileDNSBLDomains()
	if len(domains) < 350 {
		t.Fatalf("profileDNSBLDomains() returned only %d entries", len(domains))
	}
	seen := map[string]bool{}
	for _, domain := range domains {
		if seen[domain] {
			t.Fatalf("duplicate DNSBL domain %q", domain)
		}
		seen[domain] = true
	}
}


func TestProfileHTMLTableRowCount(t *testing.T) {
	html := `<html><table id="upstreamTable"><tr><th>AS</th></tr><tr><td>AS1</td></tr><tr class="x"><td>AS2</td></tr></table></html>`
	if got := profileHTMLTableRowCount(html, "upstreamTable"); got != 2 {
		t.Fatalf("profileHTMLTableRowCount()=%d want=2", got)
	}
	if got := profileHTMLTableRowCount(html, "peersTable"); got != -1 {
		t.Fatalf("missing table count=%d want=-1", got)
	}
}

func TestProfileBGPCountryPattern(t *testing.T) {
	body := "<pre>netname: TEST\ncountry: US\nsource: ARIN</pre>"
	match := profileBGPCountryPattern.FindStringSubmatch(body)
	if len(match) < 2 || match[1] != "US" {
		t.Fatalf("profileBGPCountryPattern failed: %#v", match)
	}
}


func TestProfileMergeRiskSourceFallback(t *testing.T) {
	score := 20.0
	hosting := true
	fallback := profileRiskSource{
		Name: "FFraud",
		Score: &score,
		Level: "low",
		Country: "SG",
		NetworkType: "Data Center",
		CompanyType: "hosting",
		IsDatacenter: &hosting,
	}
	target := profileRiskSource{Name: "IP2Location", Error: "HTTP 403"}
	if !profileMergeRiskSourceFallback(&target, fallback, "FFraud") {
		t.Fatal("expected fallback merge to change target")
	}
	if target.Error != "" {
		t.Fatalf("fallback should clear error, got %q", target.Error)
	}
	if target.FallbackProvider != "FFraud" {
		t.Fatalf("fallback provider=%q", target.FallbackProvider)
	}
	if target.Score == nil || *target.Score != 20 {
		t.Fatalf("score=%v", target.Score)
	}
	if target.NetworkType != "Data Center" || target.CompanyType != "hosting" || target.Country != "SG" {
		t.Fatalf("merged target=%+v", target)
	}
	if target.IsDatacenter == nil || !*target.IsDatacenter {
		t.Fatalf("datacenter flag not merged: %+v", target)
	}
}

func TestProfileMergeRiskSourceFallbackPreservesExactData(t *testing.T) {
	exactScore := 4.0
	fallbackScore := 80.0
	target := profileRiskSource{
		Name: "ipapi",
		Score: &exactScore,
		Level: "very_low",
		NetworkType: "hosting",
	}
	fallback := profileRiskSource{
		Score: &fallbackScore,
		Level: "high",
		NetworkType: "Data Center",
		CompanyType: "hosting",
	}
	profileMergeRiskSourceFallback(&target, fallback, "FFraud")
	if target.Score == nil || *target.Score != 4 || target.Level != "very_low" || target.NetworkType != "hosting" {
		t.Fatalf("exact data overwritten: %+v", target)
	}
	if target.CompanyType != "hosting" {
		t.Fatalf("missing field not supplemented: %+v", target)
	}
	if target.FallbackProvider != "FFraud" {
		t.Fatalf("fallback provider=%q", target.FallbackProvider)
	}
}

func TestProfileRiskLevelFromText(t *testing.T) {
	score := 95.0
	cases := map[string]string{
		"none": "very_low",
		"low": "low",
		"medium": "medium",
		"high": "high",
		"critical": "very_high",
	}
	for input, want := range cases {
		if got := profileRiskLevelFromText(input, &score); got != want {
			t.Fatalf("profileRiskLevelFromText(%q)=%q want=%q", input, got, want)
		}
	}
}
