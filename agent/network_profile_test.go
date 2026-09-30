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
