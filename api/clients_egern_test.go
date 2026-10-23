package api

import (
	"net/http/httptest"
	"testing"

	"sublink/models"

	"github.com/gin-gonic/gin"
)

func TestSubscriptionFormatSelectsEgernExplicitly(t *testing.T) {
	context, _ := gin.CreateTestContext(httptest.NewRecorder())
	context.Request = httptest.NewRequest("GET", "/c/?client=egern", nil)
	if got := subscriptionFormat(context, "egern"); got != "egern" {
		t.Fatalf("subscriptionFormat() = %q, want egern", got)
	}
}

func TestSubscriptionFormatDetectsEgernUserAgent(t *testing.T) {
	context, _ := gin.CreateTestContext(httptest.NewRecorder())
	context.Request = httptest.NewRequest("GET", "/c/", nil)
	context.Request.Header.Set("User-Agent", "Egern/1.0")
	if got := subscriptionFormat(context, ""); got != "egern" {
		t.Fatalf("subscriptionFormat() = %q, want egern", got)
	}
}

func TestSubscriptionFormatDetectsLoonUserAgent(t *testing.T) {
	context, _ := gin.CreateTestContext(httptest.NewRecorder())
	context.Request = httptest.NewRequest("GET", "/c/", nil)
	context.Request.Header.Set("User-Agent", "Loon/3.5")
	if got := subscriptionFormat(context, ""); got != "loon" {
		t.Fatalf("subscriptionFormat() = %q, want loon", got)
	}
}

func TestSubscriptionOutputTypeUsesStoredType(t *testing.T) {
	for _, outputType := range []string{"clash", "surge", "egern", "loon"} {
		sub := models.Subcription{
			Name:   "custom name",
			Config: `{"output_type":"` + outputType + `"}`,
		}
		if got := subscriptionOutputType(sub); got != outputType {
			t.Fatalf("subscriptionOutputType(%q) = %q", outputType, got)
		}
	}
}

func TestSubscriptionOutputTypeInfersLegacyNamedSubscriptions(t *testing.T) {
	tests := map[string]string{
		"my nodes":        "clash",
		"Surge Personal":  "surge",
		"Egern Personal":  "egern",
		"egern-订阅":        "egern",
		"Loon Personal":   "loon",
		"surge-subscribe": "surge",
	}
	for name, want := range tests {
		if got := subscriptionOutputType(models.Subcription{Name: name, Config: `{}`}); got != want {
			t.Fatalf("subscriptionOutputType(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestSubscriptionFormatIsLimitedByOutputType(t *testing.T) {
	tests := []struct {
		outputType string
		client     string
		want       string
		allowed    bool
	}{
		{outputType: "clash", client: "clash", want: "clash", allowed: true},
		{outputType: "clash", client: "v2ray", want: "v2ray", allowed: true},
		{outputType: "clash", client: "surge", want: "surge", allowed: false},
		{outputType: "clash", client: "egern", want: "egern", allowed: false},
		{outputType: "surge", client: "surge", want: "surge", allowed: true},
		{outputType: "surge", client: "clash", want: "clash", allowed: false},
		{outputType: "egern", client: "egern", want: "egern", allowed: true},
		{outputType: "egern", client: "v2ray", want: "v2ray", allowed: false},
		{outputType: "loon", client: "loon", want: "loon", allowed: true},
		{outputType: "loon", client: "clash", want: "clash", allowed: false},
		{outputType: "clash", client: "unknown", want: "unknown", allowed: false},
	}

	for _, test := range tests {
		context, _ := gin.CreateTestContext(httptest.NewRecorder())
		context.Request = httptest.NewRequest("GET", "/c/", nil)
		got, allowed := subscriptionFormatForType(context, test.client, test.outputType)
		if got != test.want || allowed != test.allowed {
			t.Fatalf(
				"subscriptionFormatForType(%q, %q) = (%q, %t), want (%q, %t)",
				test.outputType,
				test.client,
				got,
				allowed,
				test.want,
				test.allowed,
			)
		}
	}
}

func TestSubscriptionFormatDefaultsToSingleOutputType(t *testing.T) {
	for _, outputType := range []string{"surge", "egern", "loon"} {
		context, _ := gin.CreateTestContext(httptest.NewRecorder())
		context.Request = httptest.NewRequest("GET", "/c/", nil)
		got, allowed := subscriptionFormatForType(context, "", outputType)
		if !allowed || got != outputType {
			t.Fatalf("default %s format = (%q, %t)", outputType, got, allowed)
		}
	}
}

func TestEgernSubscriptionURLUsesPublicForwardedOrigin(t *testing.T) {
	context, _ := gin.CreateTestContext(httptest.NewRecorder())
	context.Request = httptest.NewRequest(
		"GET",
		"http://internal:8080/c/?token=abc&client=clash",
		nil,
	)
	context.Request.Header.Set("X-Forwarded-Proto", "HTTPS, http")
	context.Request.Header.Set("X-Forwarded-Host", "sub.example.com")

	want := "https://sub.example.com/c/?client=egern&token=abc"
	if got := egernSubscriptionURL(context); got != want {
		t.Fatalf("egernSubscriptionURL() = %q, want %q", got, want)
	}
}

func TestEgernSubscriptionURLUsesRequestOrigin(t *testing.T) {
	context, _ := gin.CreateTestContext(httptest.NewRecorder())
	context.Request = httptest.NewRequest(
		"GET",
		"https://sub.example.com/c/?token=abc",
		nil,
	)

	want := "https://sub.example.com/c/?client=egern&token=abc"
	if got := egernSubscriptionURL(context); got != want {
		t.Fatalf("egernSubscriptionURL() = %q, want %q", got, want)
	}
}
