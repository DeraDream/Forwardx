package main

import "testing"

func TestIptablesNftVersionOutput(t *testing.T) {
	cases := []struct {
		version string
		want    bool
	}{
		{"iptables v1.8.10 (nf_tables)", true},
		{"ip6tables v1.8.9 (nf_tables)", true},
		{"iptables v1.8.10 (legacy)", false},
		{"", false},
	}
	for _, tc := range cases {
		if got := iptablesNftVersionOutput(tc.version); got != tc.want {
			t.Errorf("iptablesNftVersionOutput(%q) = %v, want %v", tc.version, got, tc.want)
		}
	}
}
