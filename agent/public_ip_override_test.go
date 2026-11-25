package main

import "testing"

func TestConfigurePublicIPv4(t *testing.T) {
	previousOverride, previousCache := configuredPublicIPv4, publicIPv4Cache
	defer func() {
		configuredPublicIPv4 = previousOverride
		publicIPMu.Lock()
		publicIPv4Cache = previousCache
		publicIPMu.Unlock()
	}()
	for _, invalid := range []string{"invalid", "127.0.0.1", "192.168.1.1", "2001:db8::1", "999.999.999.999"} {
		if err := configurePublicIPv4(invalid); err == nil {
			t.Fatalf("accepted invalid publicIpv4 %q", invalid)
		}
	}
	if err := configurePublicIPv4("42.193.170.239"); err != nil {
		t.Fatal(err)
	}
	if configuredPublicIPv4 != "42.193.170.239" || publicIPv4Cache != configuredPublicIPv4 {
		t.Fatal("manual IP not saved for register and heartbeats")
	}
}
