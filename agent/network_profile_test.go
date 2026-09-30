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


func TestProfileIPNature(t *testing.T) {
	cases := []struct {
		actual     string
		registered string
		want       string
	}{
		{"SG", "SG", "native"},
		{"sg", "SG", "native"},
		{"SG", "US", "broadcast"},
		{"", "SG", "unknown"},
		{"SG", "", "unknown"},
		{"Singapore", "SG", "unknown"},
	}
	for _, tc := range cases {
		if got := profileIPNature(tc.actual, tc.registered); got != tc.want {
			t.Fatalf("profileIPNature(%q, %q)=%q want=%q", tc.actual, tc.registered, got, tc.want)
		}
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
