package main

import (
	"bufio"
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type networkProfileRequest struct {
	TaskID string `json:"taskId"`
	Family string `json:"family"`
	Mode   string `json:"mode"`
}

type networkProfileReport struct {
	TaskID    string         `json:"taskId"`
	Family    string         `json:"family"`
	Stage     string         `json:"stage"`
	Status    string         `json:"status"`
	Data      any            `json:"data,omitempty"`
	Message   string         `json:"message,omitempty"`
	Completed bool           `json:"completed,omitempty"`
	Failed    bool           `json:"failed,omitempty"`
}

//go:embed dnsbl.list
var profileDNSBLList string


func profileHTTPClient(family string, timeout time.Duration) *http.Client {
	network := "tcp4"
	if strings.EqualFold(strings.TrimSpace(family), "ipv6") {
		network = "tcp6"
	}
	dialer := &net.Dialer{Timeout: 4 * time.Second, KeepAlive: 20 * time.Second}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _ string, address string) (net.Conn, error) {
			return dialer.DialContext(ctx, network, address)
		},
		TLSHandshakeTimeout: 4 * time.Second,
		ResponseHeaderTimeout: 10 * time.Second,
		MaxIdleConns: 8,
		IdleConnTimeout: 20 * time.Second,
	}
	return &http.Client{Transport: transport, Timeout: timeout}
}

func reportNetworkProfile(cfg Config, report networkProfileReport) {
	if err := post(cfg, "/api/agent/network-profile-report", report, &map[string]any{}); err != nil {
		logAgentCommError("network-profile-report", err)
	}
}

func profileGetJSON(client *http.Client, rawURL string, out any) error {
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "ForwardX-Agent/"+Version)
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func profileGetJSONRetry(client *http.Client, rawURL string, out any, attempts int) error {
	if attempts < 1 {
		attempts = 1
	}
	var lastErr error
	for attempt := 0; attempt < attempts; attempt++ {
		req, err := http.NewRequest(http.MethodGet, rawURL, nil)
		if err != nil {
			return err
		}
		req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36")
		req.Header.Set("Accept", "application/json,text/plain,*/*")
		resp, err := client.Do(req)
		if err != nil {
			lastErr = err
		} else {
			func() {
				defer resp.Body.Close()
				if resp.StatusCode < 200 || resp.StatusCode >= 300 {
					lastErr = fmt.Errorf("HTTP %d", resp.StatusCode)
					return
				}
				lastErr = json.NewDecoder(resp.Body).Decode(out)
			}()
			if lastErr == nil {
				return nil
			}
		}
		if attempt+1 < attempts {
			time.Sleep(time.Duration(attempt+1) * 350 * time.Millisecond)
		}
	}
	return lastErr
}

func profilePanelRiskProxy(cfg Config, ip, provider string) (map[string]any, error) {
	var response struct {
		Success bool           `json:"success"`
		Payload map[string]any `json:"payload"`
		Error   string         `json:"error"`
	}
	err := post(cfg, "/api/agent/network-profile-risk-proxy", map[string]any{
		"ip": strings.TrimSpace(ip), "provider": strings.TrimSpace(provider),
	}, &response)
	if err != nil { return nil, err }
	if !response.Success || response.Payload == nil {
		message := strings.TrimSpace(response.Error)
		if message == "" { message = "empty panel proxy response" }
		return nil, fmt.Errorf("%s", message)
	}
	return response.Payload, nil
}

func profileGetJSONWithPanelFallback(cfg Config, client *http.Client, rawURL, ip, provider string) (map[string]any, error) {
	var payload map[string]any
	directErr := profileGetJSONRetry(client, rawURL, &payload, 2)
	if directErr == nil && len(payload) > 0 {
		return payload, nil
	}
	panelPayload, panelErr := profilePanelRiskProxy(cfg, ip, provider)
	if panelErr == nil && len(panelPayload) > 0 {
		return panelPayload, nil
	}
	if directErr == nil {
		directErr = fmt.Errorf("empty direct response")
	}
	if panelErr == nil {
		panelErr = fmt.Errorf("empty panel proxy response")
	}
	return nil, fmt.Errorf("direct %v; panel fallback %v", directErr, panelErr)
}

func detectProfileIP(client *http.Client, family string) (string, error) {
	endpoint := "https://api4.ipify.org?format=json"
	if strings.EqualFold(family, "ipv6") {
		endpoint = "https://api6.ipify.org?format=json"
	}
	var payload struct{ IP string `json:"ip"` }
	if err := profileGetJSONRetry(client, endpoint, &payload, 3); err != nil {
		return "", err
	}
	ip := strings.TrimSpace(payload.IP)
	if net.ParseIP(ip) == nil {
		return "", fmt.Errorf("invalid public IP response")
	}
	return ip, nil
}

func profileMap(value any) map[string]any {
	if value == nil {
		return nil
	}
	result, _ := value.(map[string]any)
	return result
}

func profileString(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return typed.String()
	case float64:
		if typed == float64(int64(typed)) {
			return strconv.FormatInt(int64(typed), 10)
		}
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case int:
		return strconv.Itoa(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	case nil:
		return ""
	default:
		return strings.TrimSpace(fmt.Sprint(typed))
	}
}

func profileNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case json.Number:
		number, err := typed.Float64()
		return number, err == nil
	case string:
		number, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		return number, err == nil
	default:
		return 0, false
	}
}

func profileBool(value any) (bool, bool) {
	switch typed := value.(type) {
	case bool:
		return typed, true
	case string:
		switch strings.ToLower(strings.TrimSpace(typed)) {
		case "true", "yes", "1":
			return true, true
		case "false", "no", "0":
			return false, true
		}
	}
	return false, false
}

var profileBGPCountryPattern = regexp.MustCompile(`(?i)country:\s*(?:&nbsp;|\s)*([A-Z]{2})`)

type profileCountryEvidence struct {
	Provider string `json:"provider"`
	Country  string `json:"country"`
}

func profileCountryCode(value any) string {
	code := strings.ToUpper(strings.TrimSpace(profileString(value)))
	if len(code) != 2 {
		return ""
	}
	for _, ch := range code {
		if ch < 'A' || ch > 'Z' {
			return ""
		}
	}
	return code
}

func profileAddCountryEvidence(items []profileCountryEvidence, provider string, value any) []profileCountryEvidence {
	country := profileCountryCode(value)
	provider = strings.TrimSpace(provider)
	if country == "" || provider == "" {
		return items
	}
	for _, item := range items {
		if strings.EqualFold(item.Provider, provider) && item.Country == country {
			return items
		}
	}
	return append(items, profileCountryEvidence{Provider: provider, Country: country})
}

func profileCountryConsensus(items []profileCountryEvidence) string {
	if len(items) == 0 {
		return ""
	}
	counts := map[string]int{}
	order := make([]string, 0, len(items))
	for _, item := range items {
		country := profileCountryCode(item.Country)
		if country == "" {
			continue
		}
		if _, exists := counts[country]; !exists {
			order = append(order, country)
		}
		counts[country]++
	}
	best := ""
	bestCount := 0
	for _, country := range order {
		if counts[country] > bestCount {
			best = country
			bestCount = counts[country]
		}
	}
	return best
}

func profileIPNatureFromEvidence(actualEvidence, registeredEvidence []profileCountryEvidence) (nature, actualCountry, registeredCountry, reason string) {
	// Match IPQuality's primary semantics first: compare the geolocation country
	// with the registered/abuse country from the same database family.
	type pair struct{ actual, registered, label string }
	pairs := []pair{
		{profileEvidenceCountry(actualEvidence, "IPinfo GeoIP"), profileEvidenceCountry(registeredEvidence, "IPinfo Abuse Country"), "IPinfo"},
	}
	for _, item := range pairs {
		if item.actual == "" || item.registered == "" {
			continue
		}
		if item.actual == item.registered {
			return "native", item.actual, item.registered, item.label + " 使用地与注册地一致"
		}
		return "broadcast", item.actual, item.registered, item.label + " 使用地与注册地不一致"
	}

	actualCountry = profileCountryConsensus(actualEvidence)
	registeredCountry = profileCountryConsensus(registeredEvidence)
	if actualCountry == "" || registeredCountry == "" {
		return "unknown", actualCountry, registeredCountry, "缺少可用的使用地或注册地数据"
	}
	if actualCountry == registeredCountry {
		return "native", actualCountry, registeredCountry, "多源使用地与注册地一致"
	}
	return "broadcast", actualCountry, registeredCountry, "多源使用地与注册地不一致"
}

func profileCountryEvidenceMaps(items []profileCountryEvidence) []map[string]any {
	result := make([]map[string]any, 0, len(items))
	for _, item := range items {
		result = append(result, map[string]any{"provider": item.Provider, "country": item.Country})
	}
	return result
}

func profileIPInfoBasic(client *http.Client, ip string) map[string]any {
	result := map[string]any{}
	var payload map[string]any
	if err := profileGetJSONRetry(client, "https://ipinfo.io/widget/demo/"+url.PathEscape(ip), &payload, 2); err != nil {
		return result
	}
	data := profileMap(payload["data"])
	if data == nil {
		return result
	}
	asn := profileMap(data["asn"])
	abuse := profileMap(data["abuse"])
	result["asn"] = profileASNNumber(asn["asn"])
	result["organization"] = profileString(asn["name"])
	result["city"] = profileString(data["city"])
	result["postalCode"] = profileString(data["postal"])
	result["timezone"] = profileString(data["timezone"])
	result["countryCode"] = profileCountryCode(data["country"])
	result["registeredCountryCode"] = profileCountryCode(abuse["country"])
	if loc := strings.TrimSpace(profileString(data["loc"])); loc != "" {
		parts := strings.SplitN(loc, ",", 2)
		if len(parts) == 2 {
			if lat, err := strconv.ParseFloat(strings.TrimSpace(parts[0]), 64); err == nil {
				result["latitude"] = lat
			}
			if lon, err := strconv.ParseFloat(strings.TrimSpace(parts[1]), 64); err == nil {
				result["longitude"] = lon
			}
		}
	}
	return result
}

func profileEvidenceCountry(items []profileCountryEvidence, provider string) string {
	for _, item := range items {
		if strings.EqualFold(strings.TrimSpace(item.Provider), strings.TrimSpace(provider)) {
			if code := profileCountryCode(item.Country); code != "" {
				return code
			}
		}
	}
	return ""
}

func profileIdentity(cfg Config, client *http.Client, ip string) (map[string]any, error) {
	result := map[string]any{"ip": ip}
	var primaryErr error
	actualEvidence := make([]profileCountryEvidence, 0, 3)
	registeredEvidence := make([]profileCountryEvidence, 0, 3)

	var who map[string]any
	if err := profileGetJSON(client, "https://ipwho.is/"+url.PathEscape(ip), &who); err == nil {
		success, hasSuccess := profileBool(who["success"])
		if !hasSuccess || success {
			connection := profileMap(who["connection"])
			timezone := profileMap(who["timezone"])
			flag := profileMap(who["flag"])
			asnNumber := int64(0)
			if connection != nil {
				asnNumber = profileASNNumber(connection["asn"])
			}
			org := ""
			isp := ""
			domain := ""
			if connection != nil {
				org = profileString(connection["org"])
				isp = profileString(connection["isp"])
				domain = profileString(connection["domain"])
			}
			asnLabel := ""
			if asnNumber > 0 {
				asnLabel = fmt.Sprintf("AS%d", asnNumber)
				if org != "" {
					asnLabel += " " + org
				}
			}
			result["asn"] = asnLabel
			result["asnNumber"] = asnNumber
			result["company"] = firstNonEmpty(org, isp)
			result["isp"] = isp
			result["domain"] = domain
			result["city"] = profileString(who["city"])
			result["region"] = profileString(who["region"])
			result["country"] = profileString(who["country"])
			result["countryCode"] = profileString(who["country_code"])
			result["continent"] = profileString(who["continent"])
			result["timezone"] = profileString(timezone["id"])
			result["latitude"] = who["latitude"]
			result["longitude"] = who["longitude"]
			result["postalCode"] = profileString(who["postal"])
			result["flag"] = profileString(flag["emoji"])
			result["identityProvider"] = "ipwho.is"
			actualEvidence = profileAddCountryEvidence(actualEvidence, "ipwho.is", who["country_code"])
		} else {
			primaryErr = fmt.Errorf("ipwho.is lookup failed")
		}
	} else {
		primaryErr = err
	}

	// ipapi.is switched its useful classification fields to keyed responses.
	// Keep the key on the Panel: when no key is saved, the Panel returns an
	// unavailable response and no external ipapi.is request is made.
	if ipapi, err := profilePanelRiskProxy(cfg, ip, "ipapi"); err == nil {
		for _, key := range []string{"is_datacenter", "is_vpn", "is_proxy", "is_tor", "is_abuser", "is_mobile"} {
			if value, ok := ipapi[key]; ok {
				if _, valid := profileBool(value); valid {
					result[key] = value
				}
			}
		}
		company := profileMap(ipapi["company"])
		asnInfo := profileMap(ipapi["asn"])
		if current := profileString(result["company"]); current == "" && company != nil {
			result["company"] = firstNonEmpty(profileString(company["name"]), profileString(company["domain"]))
		}
		if current := profileString(result["asn"]); current == "" && asnInfo != nil {
			asnNumber := profileASNNumber(asnInfo["asn"])
			asnOrg := firstNonEmpty(profileString(asnInfo["org"]), profileString(asnInfo["name"]))
			if asnNumber > 0 {
				result["asnNumber"] = asnNumber
				result["asn"] = fmt.Sprintf("AS%d %s", asnNumber, asnOrg)
			}
		}
		if location := profileMap(ipapi["location"]); location != nil {
			actualEvidence = profileAddCountryEvidence(actualEvidence, "ipapi.is", location["country_code"])
		}
		result["classificationProvider"] = "ipapi.is"
	}

	ipinfoBasic := profileIPInfoBasic(client, ip)
	if len(ipinfoBasic) > 0 {
		actualEvidence = profileAddCountryEvidence(actualEvidence, "IPinfo GeoIP", ipinfoBasic["countryCode"])
		registeredEvidence = profileAddCountryEvidence(registeredEvidence, "IPinfo Abuse Country", ipinfoBasic["registeredCountryCode"])
		result["ipinfoBasic"] = ipinfoBasic
	}

	if profileString(result["basicProvider"]) == "" && len(ipinfoBasic) > 0 {
		result["basicProvider"] = "IPinfo"
		// IPQuality itself falls back to IPinfo when MaxMind is unavailable.
		if profileASNNumber(result["asnNumber"]) <= 0 && profileASNNumber(ipinfoBasic["asn"]) > 0 {
			result["asnNumber"] = profileASNNumber(ipinfoBasic["asn"])
		}
		if profileString(result["company"]) == "" {
			result["company"] = profileString(ipinfoBasic["organization"])
		}
		if profileString(result["city"]) == "" {
			result["city"] = profileString(ipinfoBasic["city"])
		}
		if profileString(result["postalCode"]) == "" {
			result["postalCode"] = profileString(ipinfoBasic["postalCode"])
		}
		if profileString(result["timezone"]) == "" {
			result["timezone"] = profileString(ipinfoBasic["timezone"])
		}
		if _, ok := result["latitude"]; !ok {
			result["latitude"] = ipinfoBasic["latitude"]
		}
		if _, ok := result["longitude"]; !ok {
			result["longitude"] = ipinfoBasic["longitude"]
		}
	}

	// RDAP is queried even when MaxMind is available. A single provider matching
	// the detected geography is no longer enough to label an address as native.
	var rdap map[string]any
	if err := profileGetJSONRetry(client, "https://rdap.org/ip/"+url.PathEscape(ip), &rdap, 2); err == nil {
		registeredEvidence = profileAddCountryEvidence(registeredEvidence, "RDAP", rdap["country"])
	}

	nature, actualCode, registeredCode, reason := profileIPNatureFromEvidence(actualEvidence, registeredEvidence)
	result["actualCountryCode"] = actualCode
	result["registeredCountryCode"] = registeredCode
	if profileString(result["basicProvider"]) == "" {
		result["basicProvider"] = "ipwho.is"
	}
	result["ipNature"] = nature
	result["ipNatureReason"] = reason
	result["ipNatureGeoEvidence"] = profileCountryEvidenceMaps(actualEvidence)
	result["ipNatureRegisteredEvidence"] = profileCountryEvidenceMaps(registeredEvidence)
	result["ipNatureProvider"] = "multi-source"

	if profileString(result["asn"]) == "" && primaryErr != nil {
		return nil, primaryErr
	}
	return result, nil
}

func profileMergeBGPIPNature(identity map[string]any, bgpTools map[string]any) {
	if identity == nil || bgpTools == nil {
		return
	}
	actualEvidence := make([]profileCountryEvidence, 0, 4)
	registeredEvidence := make([]profileCountryEvidence, 0, 4)
	if raw, ok := identity["ipNatureGeoEvidence"].([]map[string]any); ok {
		for _, item := range raw {
			actualEvidence = profileAddCountryEvidence(actualEvidence, profileString(item["provider"]), item["country"])
		}
	} else if raw, ok := identity["ipNatureGeoEvidence"].([]any); ok {
		for _, value := range raw {
			item := profileMap(value)
			actualEvidence = profileAddCountryEvidence(actualEvidence, profileString(item["provider"]), item["country"])
		}
	}
	if raw, ok := identity["ipNatureRegisteredEvidence"].([]map[string]any); ok {
		for _, item := range raw {
			registeredEvidence = profileAddCountryEvidence(registeredEvidence, profileString(item["provider"]), item["country"])
		}
	} else if raw, ok := identity["ipNatureRegisteredEvidence"].([]any); ok {
		for _, value := range raw {
			item := profileMap(value)
			registeredEvidence = profileAddCountryEvidence(registeredEvidence, profileString(item["provider"]), item["country"])
		}
	}
	registeredEvidence = profileAddCountryEvidence(registeredEvidence, "BGP.Tools WHOIS", bgpTools["registeredCountryCode"])
	nature, actualCode, registeredCode, reason := profileIPNatureFromEvidence(actualEvidence, registeredEvidence)
	identity["actualCountryCode"] = actualCode
	identity["registeredCountryCode"] = registeredCode
	identity["ipNature"] = nature
	identity["ipNatureReason"] = reason
	identity["ipNatureGeoEvidence"] = profileCountryEvidenceMaps(actualEvidence)
	identity["ipNatureRegisteredEvidence"] = profileCountryEvidenceMaps(registeredEvidence)
	identity["ipNatureProvider"] = "multi-source"
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func profileASNNumber(value any) int64 {
	text := strings.TrimSpace(fmt.Sprint(value))
	if text == "" {
		return 0
	}
	fields := strings.Fields(text)
	if len(fields) == 0 {
		return 0
	}
	first := strings.TrimPrefix(strings.ToUpper(fields[0]), "AS")
	asn, _ := strconv.ParseInt(first, 10, 64)
	if asn <= 0 {
		return 0
	}
	return asn
}

func profileRiskLevel(score float64) string {
	switch {
	case score <= 25:
		return "low"
	case score <= 50:
		return "medium"
	case score <= 75:
		return "high"
	default:
		return "very_high"
	}
}

type profileRiskSource struct {
	Name         string `json:"name"`
	Score        *float64 `json:"score,omitempty"`
	Level        string `json:"level,omitempty"`
	Country      string `json:"country,omitempty"`
	IsProxy      *bool `json:"isProxy,omitempty"`
	IsVPN        *bool `json:"isVPN,omitempty"`
	IsTor        *bool `json:"isTor,omitempty"`
	IsDatacenter *bool `json:"isDatacenter,omitempty"`
	IsAbuser     *bool `json:"isAbuser,omitempty"`
	IsBot        *bool `json:"isBot,omitempty"`
	NetworkType  string `json:"networkType,omitempty"`
	CompanyType      string `json:"companyType,omitempty"`
	FallbackProvider string `json:"fallbackProvider,omitempty"`
	Error            string `json:"error,omitempty"`
}

func profileBoolPtr(value any) *bool {
	if parsed, ok := profileBool(value); ok {
		return &parsed
	}
	return nil
}

func profileScorePtr(value any) *float64 {
	if parsed, ok := profileNumber(value); ok {
		if parsed >= 0 {
			return &parsed
		}
	}
	return nil
}

func profileRiskLevelFromText(raw string, score *float64) string {
	value := strings.ToLower(strings.TrimSpace(raw))
	switch value {
	case "none", "very_low", "very low", "safe":
		return "very_low"
	case "low":
		return "low"
	case "medium", "moderate", "elevated":
		return "medium"
	case "high":
		return "high"
	case "critical", "very_high", "very high", "severe":
		return "very_high"
	}
	if score != nil {
		return profileRiskLevel(*score)
	}
	return "unknown"
}

func profileAppendFallbackProvider(current, next string) string {
	current = strings.TrimSpace(current)
	next = strings.TrimSpace(next)
	if next == "" {
		return current
	}
	if current == "" {
		return next
	}
	for _, item := range strings.Split(current, " + ") {
		if strings.EqualFold(strings.TrimSpace(item), next) {
			return current
		}
	}
	return current + " + " + next
}

func profileMergeRiskSourceFallback(target *profileRiskSource, fallback profileRiskSource, provider string) bool {
	if target == nil {
		return false
	}
	changed := false
	if target.Score == nil && fallback.Score != nil {
		target.Score = fallback.Score
		target.Level = fallback.Level
		changed = true
	}
	if strings.TrimSpace(target.Level) == "" && strings.TrimSpace(fallback.Level) != "" {
		target.Level = fallback.Level
		changed = true
	}
	if strings.TrimSpace(target.Country) == "" && strings.TrimSpace(fallback.Country) != "" {
		target.Country = fallback.Country
		changed = true
	}
	if strings.TrimSpace(target.NetworkType) == "" && strings.TrimSpace(fallback.NetworkType) != "" {
		target.NetworkType = fallback.NetworkType
		changed = true
	}
	if strings.TrimSpace(target.CompanyType) == "" && strings.TrimSpace(fallback.CompanyType) != "" {
		target.CompanyType = fallback.CompanyType
		changed = true
	}
	if target.IsProxy == nil && fallback.IsProxy != nil {
		target.IsProxy = fallback.IsProxy
		changed = true
	}
	if target.IsVPN == nil && fallback.IsVPN != nil {
		target.IsVPN = fallback.IsVPN
		changed = true
	}
	if target.IsTor == nil && fallback.IsTor != nil {
		target.IsTor = fallback.IsTor
		changed = true
	}
	if target.IsDatacenter == nil && fallback.IsDatacenter != nil {
		target.IsDatacenter = fallback.IsDatacenter
		changed = true
	}
	if target.IsAbuser == nil && fallback.IsAbuser != nil {
		target.IsAbuser = fallback.IsAbuser
		changed = true
	}
	if target.IsBot == nil && fallback.IsBot != nil {
		target.IsBot = fallback.IsBot
		changed = true
	}
	if changed {
		target.FallbackProvider = profileAppendFallbackProvider(target.FallbackProvider, provider)
		target.Error = ""
	}
	return changed
}

func profileRiskSourceHasUsefulData(source profileRiskSource) bool {
	return source.Score != nil ||
		strings.TrimSpace(source.Country) != "" ||
		strings.TrimSpace(source.NetworkType) != "" ||
		strings.TrimSpace(source.CompanyType) != "" ||
		source.IsProxy != nil || source.IsVPN != nil || source.IsTor != nil ||
		source.IsDatacenter != nil || source.IsAbuser != nil || source.IsBot != nil
}


func profileFFraudSource(client *http.Client, ip string) profileRiskSource {
	source := profileRiskSource{Name: "FFraud"}
	var payload map[string]any
	if err := profileGetJSONRetry(client, "https://api.ffraud.com/public/ip/"+url.PathEscape(ip), &payload, 2); err != nil {
		source.Error = err.Error()
		return source
	}
	if success, ok := profileBool(payload["success"]); ok && !success {
		source.Error = firstNonEmpty(profileString(payload["error"]), profileString(payload["message"]), "FFraud lookup failed")
		return source
	}
	source.Score = profileScorePtr(payload["fraud_score"])
	source.Level = profileRiskLevelFromText(profileString(payload["risk"]), source.Score)
	source.NetworkType = profileString(payload["connection_type"])
	company := profileMap(payload["company"])
	source.CompanyType = profileString(company["type"])
	geo := profileMap(payload["geo"])
	source.Country = profileCountryCode(geo["country"])
	source.IsProxy = profileBoolPtr(payload["proxy"])
	source.IsVPN = profileBoolPtr(payload["vpn"])
	source.IsTor = profileBoolPtr(payload["tor"])
	source.IsDatacenter = profileBoolPtr(payload["hosting"])
	source.IsAbuser = profileBoolPtr(payload["is_abuser"])
	source.IsBot = profileBoolPtr(payload["is_crawler"])
	if !profileRiskSourceHasUsefulData(source) {
		source.Error = "FFraud data unavailable"
	}
	return source
}

func profileIP99Source(client *http.Client, ip string) profileRiskSource {
	source := profileRiskSource{Name: "IP99"}
	var payload map[string]any
	if err := profileGetJSONRetry(client, "https://ip99.com/v1/ip/"+url.PathEscape(ip), &payload, 2); err != nil {
		source.Error = err.Error()
		return source
	}
	network := profileMap(payload["network"])
	risk := profileMap(payload["risk"])
	geo := profileMap(payload["geo"])
	source.Score = profileScorePtr(risk["score"])
	source.Level = profileRiskLevelFromText(profileString(risk["level"]), source.Score)
	source.NetworkType = profileString(network["usage_type"])
	source.Country = profileCountryCode(geo["country"])
	signals := make([]string, 0)
	switch raw := risk["signals"].(type) {
	case []any:
		for _, item := range raw {
			if value := profileString(item); value != "" {
				signals = append(signals, value)
			}
		}
	case []string:
		signals = append(signals, raw...)
	case string:
		if value := strings.TrimSpace(raw); value != "" {
			signals = append(signals, value)
		}
	}
	for _, signal := range signals {
		value := strings.ToLower(strings.TrimSpace(signal))
		switch value {
		case "hosting", "datacenter", "data_center":
			v := true
			source.IsDatacenter = &v
		case "vpn":
			v := true
			source.IsVPN = &v
		case "proxy":
			v := true
			source.IsProxy = &v
		case "tor":
			v := true
			source.IsTor = &v
		case "spam", "abuse", "abuser":
			v := true
			source.IsAbuser = &v
		}
	}
	if !profileRiskSourceHasUsefulData(source) {
		source.Error = "IP99 data unavailable"
	}
	return source
}

var profileHTMLTagPattern = regexp.MustCompile(`(?s)<[^>]+>`)

func profileCleanHTMLText(value string) string {
	value = profileHTMLTagPattern.ReplaceAllString(value, " ")
	value = html.UnescapeString(value)
	return strings.Join(strings.Fields(value), " ")
}

func profileIP2LocationDemoField(body, field string) string {
	pattern := regexp.MustCompile(`(?is)aria-label=["']` + regexp.QuoteMeta(field) + `["'][^>]*>.*?</th>\s*<td[^>]*>(.*?)</td>`)
	match := pattern.FindStringSubmatch(body)
	if len(match) < 2 {
		return ""
	}
	return profileCleanHTMLText(match[1])
}

func profileIP2LocationDemoSource(client *http.Client, ip string) profileRiskSource {
	source := profileRiskSource{Name: "IP2Location"}
	code, body, err := profileReadRetry(client, "https://www.ip2location.com/demo/"+url.PathEscape(ip), map[string]string{
		"Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
	}, 2)
	if err != nil {
		source.Error = err.Error()
		return source
	}
	if code < 200 || code >= 300 {
		source.Error = fmt.Sprintf("IP2Location demo HTTP %d", code)
		return source
	}

	source.NetworkType = profileIP2LocationDemoField(body, "usageType")
	source.CompanyType = profileIP2LocationDemoField(body, "asUsageType")
	fraudText := profileIP2LocationDemoField(body, "px_fraudScore")
	if fields := strings.Fields(fraudText); len(fields) > 0 {
		if score := profileScorePtr(fields[0]); score != nil {
			source.Score = score
		switch {
		case *score < 33:
			source.Level = "low"
		case *score < 66:
			source.Level = "medium"
		default:
			source.Level = "high"
			}
		}
	}
	proxyType := strings.ToUpper(profileIP2LocationDemoField(body, "px_proxyType"))
	if proxyType != "" && proxyType != "-" && proxyType != "NOT DETECTED" {
		value := true
		source.IsProxy = &value
	} else if proxyType == "-" || strings.Contains(proxyType, "NOT DETECTED") {
		value := false
		source.IsProxy = &value
	}
	if match := regexp.MustCompile(`(?i)<title>[^<]*\[([A-Z]{2})\]</title>`).FindStringSubmatch(body); len(match) > 1 {
		source.Country = strings.ToUpper(match[1])
	}
	if !profileRiskSourceHasUsefulData(source) {
		source.Error = "IP2Location demo data unavailable"
	}
	return source
}

func profileIP2LocationDirectSource(client *http.Client, ip string) profileRiskSource {
	source := profileRiskSource{Name: "IP2Location"}
	var payload map[string]any
	if err := profileGetJSONRetry(client, "https://api.ip2location.io/?ip="+url.QueryEscape(ip)+"&format=json", &payload, 2); err != nil {
		source.Error = err.Error()
		return source
	}
	source.Country = profileCountryCode(payload["country_code"])
	source.NetworkType = profileString(payload["usage_type"])
	asInfo := profileMap(payload["as_info"])
	source.CompanyType = profileString(asInfo["as_usage_type"])
	source.Score = profileScorePtr(payload["fraud_score"])
	if source.Score != nil {
		switch {
		case *source.Score < 33:
			source.Level = "low"
		case *source.Score < 66:
			source.Level = "medium"
		default:
			source.Level = "high"
		}
	}
	source.IsProxy = profileBoolPtr(payload["is_proxy"])
	if !profileRiskSourceHasUsefulData(source) {
		source.Error = "IP2Location.io data unavailable"
	}
	return source
}

func profileIP2LocationPrimarySource(client *http.Client, ip string) profileRiskSource {
	// Keep IP2Location data attributable to IP2Location itself. The public demo
	// exposes Usage Type / AS Usage Type / Fraud Score, while the keyless JSON
	// endpoint can supplement country/proxy fields. Never fill this row with a
	// different provider's score.
	source := profileIP2LocationDemoSource(client, ip)
	source.Name = "IP2Location"
	if !profileRiskSourceHasUsefulData(source) || source.Country == "" || source.IsProxy == nil {
		direct := profileIP2LocationDirectSource(client, ip)
		if profileRiskSourceHasUsefulData(direct) {
			profileMergeRiskSourceFallback(&source, direct, "IP2Location.io")
		}
	}
	// Both lookups above are official IP2Location surfaces, so expose them as one
	// provider instead of presenting the second surface as a cross-provider fallback.
	source.FallbackProvider = ""
	if !profileRiskSourceHasUsefulData(source) {
		source.Error = firstNonEmpty(source.Error, "IP2Location data unavailable")
	}
	return source
}

func profileProxyCheckSource(cfg Config, client *http.Client, ip string) profileRiskSource {
	source := profileRiskSource{Name: "ProxyCheck"}
	endpoint := "https://proxycheck.io/v2/" + url.PathEscape(ip) + "?vpn=1&asn=1&risk=1&days=7"
	payload, err := profileGetJSONWithPanelFallback(cfg, client, endpoint, ip, "proxycheck")
	if err != nil {
		source.Error = err.Error()
		return source
	}
	item := profileMap(payload[ip])
	if item == nil {
		source.Error = "no IP record"
		return source
	}
	source.Score = profileScorePtr(item["risk"])
	if source.Score != nil {
		source.Level = profileRiskLevel(*source.Score)
	}
	proxy := strings.EqualFold(profileString(item["proxy"]), "yes")
	source.IsProxy = &proxy
	networkType := profileString(item["type"])
	source.NetworkType = networkType
	lowerType := strings.ToLower(networkType)
	vpn := strings.Contains(lowerType, "vpn")
	tor := strings.Contains(lowerType, "tor")
	server := strings.Contains(lowerType, "hosting") || strings.Contains(lowerType, "server") || strings.Contains(lowerType, "datacenter")
	source.IsVPN = &vpn
	source.IsTor = &tor
	source.IsDatacenter = &server
	source.Country = profileString(item["country"])
	return source
}


func profileIPAPISource(cfg Config, ip string) profileRiskSource {
	source := profileRiskSource{Name: "ipapi.is"}
	payload, err := profilePanelRiskProxy(cfg, ip, "ipapi")
	if err != nil {
		source.Error = err.Error()
		return source
	}
	location := profileMap(payload["location"])
	company := profileMap(payload["company"])
	asn := profileMap(payload["asn"])
	if location != nil {
		source.Country = profileString(location["country_code"])
	}
	if asn != nil {
		source.NetworkType = profileString(asn["type"])
	}
	if company != nil {
		source.CompanyType = profileString(company["type"])
	}
	source.IsProxy = profileBoolPtr(payload["is_proxy"])
	source.IsVPN = profileBoolPtr(payload["is_vpn"])
	source.IsTor = profileBoolPtr(payload["is_tor"])
	source.IsDatacenter = profileBoolPtr(payload["is_datacenter"])
	source.IsAbuser = profileBoolPtr(payload["is_abuser"])
	if source.NetworkType == "" {
		if value := profileBoolPtr(payload["is_mobile"]); value != nil && *value {
			source.NetworkType = "mobile"
		} else if source.IsDatacenter != nil && *source.IsDatacenter {
			source.NetworkType = "hosting"
		}
	}
	if source.Country == "" && source.NetworkType == "" && source.CompanyType == "" &&
		source.IsProxy == nil && source.IsVPN == nil && source.IsTor == nil &&
		source.IsDatacenter == nil && source.IsAbuser == nil {
		source.Error = "ipapi.is classification data unavailable"
	}
	return source
}

func profileIPInfoSource(client *http.Client, ip string) profileRiskSource {
	source := profileRiskSource{Name: "IPinfo"}
	var payload map[string]any
	if err := profileGetJSONRetry(client, "https://ipinfo.io/widget/demo/"+url.PathEscape(ip), &payload, 2); err != nil {
		source.Error = err.Error()
		return source
	}
	data := profileMap(payload["data"])
	if data == nil {
		source.Error = "no IPinfo data"
		return source
	}
	privacy := profileMap(data["privacy"])
	asn := profileMap(data["asn"])
	company := profileMap(data["company"])
	source.Country = profileString(data["country"])
	source.NetworkType = profileString(asn["type"])
	source.CompanyType = profileString(company["type"])
	source.IsProxy = profileBoolPtr(privacy["proxy"])
	source.IsVPN = profileBoolPtr(privacy["vpn"])
	source.IsTor = profileBoolPtr(privacy["tor"])
	source.IsDatacenter = profileBoolPtr(privacy["hosting"])
	if source.Country == "" && source.IsProxy == nil && source.IsVPN == nil && source.IsTor == nil && source.IsDatacenter == nil {
		source.Error = "IPinfo privacy data unavailable"
	}
	return source
}

var profileIPRegistryKeyPattern = regexp.MustCompile(`apiKey=["']([A-Za-z0-9]+)["']`)

func profileIPRegistrySource(client *http.Client, ip string) profileRiskSource {
	source := profileRiskSource{Name: "ipregistry"}
	key := "sb69ksjcajfs4c"
	if _, body, err := profileReadRetry(client, "https://ipregistry.co", nil, 2); err == nil {
		if match := profileIPRegistryKeyPattern.FindStringSubmatch(body); len(match) > 1 {
			key = match[1]
		}
	}
	headers := map[string]string{
		"Accept": "application/json,text/plain,*/*",
		"Origin": "https://ipregistry.co",
		"Referer": "https://ipregistry.co/",
	}
	code, body, err := profileReadRetry(client, "https://api.ipregistry.co/"+url.PathEscape(ip)+"?hostname=true&key="+url.QueryEscape(key), headers, 2)
	if err != nil {
		source.Error = err.Error()
		return source
	}
	if code < 200 || code >= 300 {
		source.Error = fmt.Sprintf("HTTP %d", code)
		return source
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		source.Error = err.Error()
		return source
	}
	location := profileMap(payload["location"])
	country := profileMap(location["country"])
	security := profileMap(payload["security"])
	connection := profileMap(payload["connection"])
	company := profileMap(payload["company"])
	source.Country = profileString(country["code"])
	source.NetworkType = profileString(connection["type"])
	source.CompanyType = profileString(company["type"])
	source.IsProxy = profileBoolPtr(security["is_proxy"])
	source.IsVPN = profileBoolPtr(security["is_vpn"])
	tor := profileBoolPtr(security["is_tor"])
	if tor == nil {
		tor = profileBoolPtr(security["is_tor_exit"])
	}
	source.IsTor = tor
	source.IsDatacenter = profileBoolPtr(security["is_cloud_provider"])
	source.IsAbuser = profileBoolPtr(security["is_abuser"])
	if source.Country == "" && source.IsProxy == nil && source.IsVPN == nil && source.IsTor == nil && source.IsDatacenter == nil {
		source.Error = "ipregistry security data unavailable"
	}
	return source
}

func profilePostRaw(client *http.Client, rawURL, contentType, body string, headers map[string]string) (int, string, error) {
	req, err := http.NewRequest(http.MethodPost, rawURL, strings.NewReader(body))
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36")
	req.Header.Set("Accept", "application/json,text/plain,*/*")
	req.Header.Set("Content-Type", contentType)
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, networkProfileBodyLimit))
	if err != nil {
		return resp.StatusCode, "", err
	}
	return resp.StatusCode, string(raw), nil
}

var profileDBIPKeyPattern = regexp.MustCompile(`data-api-key=["']([^"']+)["']`)

func profileAbuseIPDBSource(cfg Config, client *http.Client, ip string) profileRiskSource {
	source := profileRiskSource{Name: "AbuseIPDB"}
	// AbuseIPDB has no anonymous endpoint suitable for this query. The Panel
	// calls the official API only after an admin saves a key in System Settings.
	payload, err := profilePanelRiskProxy(cfg, ip, "abuseipdb")
	if err != nil {
		source.Error = err.Error()
		return source
	}
	data := profileMap(payload["data"])
	source.Score = profileScorePtr(data["abuseConfidenceScore"])
	if source.Score != nil {
		switch {
		case *source.Score < 25:
			source.Level = "low"
		case *source.Score < 75:
			source.Level = "high"
		default:
			source.Level = "block"
		}
	}
	source.Country = profileString(data["countryCode"])
	source.NetworkType = profileString(data["usageType"])
	server := strings.Contains(strings.ToLower(source.NetworkType), "data center") || strings.Contains(strings.ToLower(source.NetworkType), "hosting")
	source.IsDatacenter = &server
	if source.Country == "" && source.NetworkType == "" && source.Score == nil {
		source.Error = "AbuseIPDB data unavailable"
	}
	return source
}

func profileRiskAnyTrue(sources []profileRiskSource, selector func(profileRiskSource) *bool) any {
	has := false
	for _, source := range sources {
		value := selector(source)
		if value == nil {
			continue
		}
		has = true
		if *value {
			return true
		}
	}
	if has {
		return false
	}
	return nil
}

func profileRisk(cfg Config, client *http.Client, ip string) map[string]any {
	// Risk/type rows must represent the provider named on the row. Keyed
	// providers are proxied through the Panel so credentials never reach Agent.
	checks := []struct {
		name  string
		check func() profileRiskSource
	}{
		{"ProxyCheck", func() profileRiskSource { return profileProxyCheckSource(cfg, client, ip) }},
		{"IPinfo", func() profileRiskSource { return profileIPInfoSource(client, ip) }},
		{"ipapi.is", func() profileRiskSource { return profileIPAPISource(cfg, ip) }},
		{"ipregistry", func() profileRiskSource { return profileIPRegistrySource(client, ip) }},
		{"FFraud", func() profileRiskSource { return profileFFraudSource(client, ip) }},
		{"IP99", func() profileRiskSource { return profileIP99Source(client, ip) }},
		{"IP2Location", func() profileRiskSource { return profileIP2LocationPrimarySource(client, ip) }},
		{"AbuseIPDB", func() profileRiskSource { return profileAbuseIPDBSource(cfg, client, ip) }},
	}

	sources := make([]profileRiskSource, len(checks))
	var wg sync.WaitGroup
	for index, item := range checks {
		index, item := index, item
		wg.Add(1)
		go func() {
			defer wg.Done()
			sources[index] = item.check()
			if strings.TrimSpace(sources[index].Name) == "" {
				sources[index].Name = item.name
			}
		}()
	}
	wg.Wait()

	// Retry transient failures once. A missing AbuseIPDB key remains a clean
	// unavailable source and is hidden by the UI rather than replaced by another
	// database's score.
	for index, item := range checks {
		if strings.TrimSpace(sources[index].Error) == "" {
			continue
		}
		if (item.name == "AbuseIPDB" || item.name == "ipapi.is") && strings.Contains(strings.ToLower(sources[index].Error), "api key") {
			continue
		}
		time.Sleep(250 * time.Millisecond)
		retry := item.check()
		if profileRiskSourceHasUsefulData(retry) || strings.TrimSpace(retry.Error) == "" {
			sources[index] = retry
		}
	}

	var scoreTotal float64
	scoreCount := 0
	networkType := ""
	preferredTypeSources := map[string]bool{
		"IPinfo": true,
		"ipregistry": true,
		"ipapi.is": true,
		"IP2Location": true,
		"AbuseIPDB": true,
	}
	for _, source := range sources {
		if source.Score != nil {
			scoreTotal += *source.Score
			scoreCount++
		}
		if networkType == "" && preferredTypeSources[source.Name] && strings.TrimSpace(source.NetworkType) != "" {
			networkType = source.NetworkType
		}
	}

	var score any
	level := "unknown"
	if scoreCount > 0 {
		average := scoreTotal / float64(scoreCount)
		score = average
		level = profileRiskLevel(average)
	}

	return map[string]any{
		"provider": "direct-multi-source",
		"score": score,
		"level": level,
		"networkType": networkType,
		"isProxy": profileRiskAnyTrue(sources, func(source profileRiskSource) *bool { return source.IsProxy }),
		"isVPN": profileRiskAnyTrue(sources, func(source profileRiskSource) *bool { return source.IsVPN }),
		"isTor": profileRiskAnyTrue(sources, func(source profileRiskSource) *bool { return source.IsTor }),
		"isDatacenter": profileRiskAnyTrue(sources, func(source profileRiskSource) *bool { return source.IsDatacenter }),
		"isAbuser": profileRiskAnyTrue(sources, func(source profileRiskSource) *bool { return source.IsAbuser }),
		"isBot": profileRiskAnyTrue(sources, func(source profileRiskSource) *bool { return source.IsBot }),
		"sources": sources,
	}
}

var profileKnownASNBrands = map[int64]string{
	174: "Cogent",
	701: "Verizon",
	1299: "Arelion",
	2914: "NTT",
	3257: "GTT",
	3320: "DTAG",
	3356: "Lumen",
	3491: "PCCW",
	5511: "Orange",
	6453: "TATA",
	6461: "Zayo",
	6762: "Sparkle",
	6830: "Liberty",
	7018: "AT&T",
	12956: "Telxius",
	4229: "Zenlayer",
	9516: "SAKURA",
	17676: "SoftBank",
	49304: "SAKURA",
	137409: "GSL",
	216211: "Cyberverse",
	213845: "Cylix",
}

func profileShortASNName(asn int64, raw string) string {
	if brand := profileKnownASNBrands[asn]; brand != "" {
		return brand
	}
	value := strings.TrimSpace(raw)
	if value == "" {
		return "Unknown"
	}
	upper := strings.ToUpper(value)
	switch {
	case strings.Contains(upper, "CYBERVERSE"):
		return "Cyberverse"
	case strings.Contains(upper, "COGENT"):
		return "Cogent"
	case strings.Contains(upper, "VERIZON"):
		return "Verizon"
	case strings.Contains(upper, "ARELION") || strings.Contains(upper, "TELIA"):
		return "Arelion"
	case strings.Contains(upper, "CLOUDFLARE"):
		return "Cloudflare"
	}
	// RIPE holder names often look like "BRAND - Legal Company Name".
	if index := strings.Index(value, " - "); index > 0 {
		value = strings.TrimSpace(value[:index])
	}
	for _, suffix := range []string{
		" Pte. Ltd.", " Pte Ltd", " Co., Ltd.", " Co. Ltd.", " Limited",
		" LLC", " Ltd.", " Ltd", " Inc.", " Inc", " Corporation", " Corp.",
	} {
		if strings.HasSuffix(strings.ToLower(value), strings.ToLower(suffix)) {
			value = strings.TrimSpace(value[:len(value)-len(suffix)])
			break
		}
	}
	fields := strings.Fields(value)
	if len(fields) > 2 {
		value = strings.Join(fields[:2], " ")
	}
	runes := []rune(value)
	if len(runes) > 14 {
		value = string(runes[:14])
	}
	if value == "" {
		return "Unknown"
	}
	return value
}

func profileASNName(client *http.Client, asn int64) string {
	if asn <= 0 {
		return ""
	}
	var overview struct {
		Data map[string]any `json:"data"`
	}
	endpoint := "https://stat.ripe.net/data/as-overview/data.json?sourceapp=forwardx&resource=AS" + strconv.FormatInt(asn, 10)
	if err := profileGetJSONRetry(client, endpoint, &overview, 2); err != nil {
		return ""
	}
	return firstNonEmpty(profileString(overview.Data["holder"]), profileString(overview.Data["announced"]))
}

func profileNeighbourList(client *http.Client, raw any) []map[string]any {
	items, ok := raw.([]any)
	if !ok || len(items) == 0 {
		return nil
	}
	type candidate struct {
		asn int64
		relation string
		power float64
	}
	candidates := make([]candidate, 0, len(items))
	seen := map[int64]bool{}
	for _, item := range items {
		row := profileMap(item)
		asn := profileASNNumber(row["asn"])
		if asn <= 0 || seen[asn] {
			continue
		}
		seen[asn] = true
		power, _ := profileNumber(row["power"])
		candidates = append(candidates, candidate{asn: asn, relation: profileString(row["type"]), power: power})
	}
	sort.SliceStable(candidates, func(i, j int) bool { return candidates[i].power > candidates[j].power })
	if len(candidates) > 16 {
		candidates = candidates[:16]
	}
	results := make([]map[string]any, len(candidates))
	sem := make(chan struct{}, 4)
	var wg sync.WaitGroup
	for index, item := range candidates {
		index, item := index, item
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			fullName := profileASNName(client, item.asn)
			<-sem
			results[index] = map[string]any{
				"asn": item.asn,
				"name": profileShortASNName(item.asn, fullName),
				"fullName": fullName,
				"relation": item.relation,
				"power": item.power,
			}
		}()
	}
	wg.Wait()
	return results
}

func profileRouting(client *http.Client, ip string, asnValue any) (map[string]any, error) {
	result := map[string]any{"routingProvider": "RIPEstat"}
	var networkInfo struct {
		Data map[string]any `json:"data"`
	}
	if err := profileGetJSON(client, "https://stat.ripe.net/data/network-info/data.json?sourceapp=forwardx&resource="+url.QueryEscape(ip), &networkInfo); err != nil {
		return nil, err
	}
	prefix := profileString(networkInfo.Data["prefix"])
	result["prefix"] = prefix
	asn := profileASNNumber(asnValue)
	if asn <= 0 {
		switch values := networkInfo.Data["asns"].(type) {
		case []any:
			if len(values) > 0 {
				asn = profileASNNumber(values[0])
			}
		case []string:
			if len(values) > 0 {
				asn = profileASNNumber(values[0])
			}
		case string:
			asn = profileASNNumber(values)
		}
	}
	if asn > 0 {
		result["asn"] = asn
		var neighbourResp struct {
			Data map[string]any `json:"data"`
		}
		if err := profileGetJSONRetry(client, "https://stat.ripe.net/data/asn-neighbours/data.json?sourceapp=forwardx&resource=AS"+strconv.FormatInt(asn, 10), &neighbourResp, 2); err == nil {
			counts := profileMap(neighbourResp.Data["neighbour_counts"])
			if counts != nil {
				result["neighbourUnique"] = counts["unique"]
				result["neighbourLeft"] = counts["left"]
				result["neighbourRight"] = counts["right"]
			}
			if neighbours := profileNeighbourList(client, neighbourResp.Data["neighbours"]); len(neighbours) > 0 {
				result["neighbours"] = neighbours
			}
		}
		if prefix != "" {
			var rpkiResp struct {
				Data map[string]any `json:"data"`
			}
			rpkiURL := "https://stat.ripe.net/data/rpki-validation/data.json?sourceapp=forwardx&resource=" + strconv.FormatInt(asn, 10) + "&prefix=" + url.QueryEscape(prefix)
			if err := profileGetJSON(client, rpkiURL, &rpkiResp); err == nil {
				result["rpki"] = profileString(rpkiResp.Data["status"])
				result["rpkiDescription"] = profileString(rpkiResp.Data["description"])
			}
		}
	}
	return result, nil
}


var profileBGPToolsPrefixPattern = regexp.MustCompile(`(?s)<p id="network-name" class="heading-xlarge">\s*([^<]+)\s*</p>`)
var profileBGPToolsASNPattern = regexp.MustCompile(`(?s)Originated by.*?<strong>\s*([^<]+)\s*</strong>`)
var profileBGPToolsPathImagePattern = regexp.MustCompile(`(?is)<img[^>]+id=["']pathimg["'][^>]+src=["']([^"']+)["']`)
var profileBGPToolsPathImagePatternAlt = regexp.MustCompile(`(?is)<img[^>]+src=["']([^"']+)["'][^>]+id=["']pathimg["']`)

func profileHTMLTableRowCount(body, tableID string) int {
	startToken := `<table id="` + tableID + `"`
	start := strings.Index(body, startToken)
	if start < 0 {
		return -1
	}
	end := strings.Index(body[start:], "</table>")
	if end < 0 {
		return -1
	}
	table := body[start : start+end]
	rows := strings.Count(table, "<tr")
	if rows <= 0 {
		return 0
	}
	return rows - 1
}

func profileBGPToolsGraphPath(body string) string {
	for _, pattern := range []*regexp.Regexp{profileBGPToolsPathImagePattern, profileBGPToolsPathImagePatternAlt} {
		if match := pattern.FindStringSubmatch(body); len(match) > 1 {
			value := html.UnescapeString(strings.TrimSpace(match[1]))
			if strings.HasPrefix(value, "/pathimg/") {
				return value
			}
			if parsed, err := url.Parse(value); err == nil && strings.EqualFold(parsed.Hostname(), "bgp.tools") && strings.HasPrefix(parsed.Path, "/pathimg/") {
				return parsed.RequestURI()
			}
		}
	}
	return ""
}

func profileBGPToolsGraphPathFromPrefix(prefix string) string {
	value := strings.TrimSpace(prefix)
	if value == "" || !strings.Contains(value, "/") {
		return ""
	}
	return "/pathimg/rt-" + strings.ReplaceAll(value, "/", "_")
}

func profileBGPGraphSVGDataURL(body string) (string, error) {
	svg := strings.TrimSpace(body)
	if svg == "" {
		return "", fmt.Errorf("BGP.Tools 返回空图")
	}
	probe := svg
	if len(probe) > 4096 {
		probe = probe[:4096]
	}
	if !strings.Contains(strings.ToLower(probe), "<svg") {
		return "", fmt.Errorf("BGP.Tools 未返回 SVG")
	}
	if strings.Contains(svg, "Not_Visible") && strings.Contains(svg, "in_DFZ") {
		return "", fmt.Errorf("该 Prefix 当前未在 DFZ 中可见")
	}
	return "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(svg)), nil
}

func profileBGPToolsGraphDataURL(client *http.Client, prefix, rawPath string) (string, error) {
	path := strings.TrimSpace(rawPath)
	if path == "" {
		path = profileBGPToolsGraphPathFromPrefix(prefix)
	}
	if path == "" {
		return "", fmt.Errorf("BGP 拓扑图地址为空")
	}
	parsed, err := url.Parse(path)
	if err != nil {
		return "", fmt.Errorf("BGP 拓扑图地址无效")
	}
	if parsed.IsAbs() {
		if !strings.EqualFold(parsed.Hostname(), "bgp.tools") || !strings.HasPrefix(parsed.Path, "/pathimg/") {
			return "", fmt.Errorf("BGP 拓扑图地址无效")
		}
		path = parsed.RequestURI()
	} else if !strings.HasPrefix(parsed.Path, "/pathimg/") {
		return "", fmt.Errorf("BGP 拓扑图地址无效")
	}
	endpoint := "https://bgp.tools" + path
	headers := map[string]string{
		"Accept": "image/svg+xml,image/*;q=0.9,*/*;q=0.2",
		"Referer": "https://bgp.tools/prefix/" + strings.TrimSpace(prefix),
		"Cache-Control": "no-cache",
	}
	code, body, err := profileReadRetry(client, endpoint, headers, 2)
	if err != nil {
		return "", err
	}
	if code < 200 || code >= 300 {
		return "", fmt.Errorf("BGP.Tools HTTP %d", code)
	}
	return profileBGPGraphSVGDataURL(body)
}


func profileBGPTools(client *http.Client, ip string) map[string]any {
	result := map[string]any{"provider": "BGP.Tools"}
	headers := map[string]string{
		"User-Agent": "ForwardX-Agent/" + Version + " (+https://github.com/DeraDream/Forwardx)",
		"Accept": "text/html,application/xhtml+xml",
	}
	code, body, err := profileReadRetry(client, "https://bgp.tools/prefix/"+url.PathEscape(ip), headers, 2)
	if err != nil || code < 200 || code >= 300 || strings.TrimSpace(body) == "" {
		if err != nil {
			result["error"] = err.Error()
		} else {
			result["error"] = fmt.Sprintf("HTTP %d", code)
		}
		return result
	}
	if match := profileBGPToolsPrefixPattern.FindStringSubmatch(body); len(match) > 1 {
		result["prefix"] = strings.TrimSpace(match[1])
	}
	if match := profileBGPToolsASNPattern.FindStringSubmatch(body); len(match) > 1 {
		asnText := strings.TrimSpace(strings.Split(match[1], ",")[0])
		result["asn"] = asnText
	}
	if match := profileBGPCountryPattern.FindStringSubmatch(body); len(match) > 1 {
		result["registeredCountryCode"] = profileCountryCode(match[1])
	}
	if graphPath := profileBGPToolsGraphPath(body); graphPath != "" {
		result["bgpGraphPath"] = graphPath
	}
	if upstreams := profileHTMLTableRowCount(body, "upstreamTable"); upstreams >= 0 {
		if strings.Contains(body, "This network is transit-free.") {
			result["upstreamCount"] = 0
			result["transitFree"] = true
		} else {
			result["upstreamCount"] = upstreams
		}
	}
	if peers := profileHTMLTableRowCount(body, "peersTable"); peers >= 0 {
		result["peerCount"] = peers
	}
	prefix := profileString(result["prefix"])
	if prefix != "" {
		if profileString(result["bgpGraphPath"]) == "" {
			result["bgpGraphPath"] = profileBGPToolsGraphPathFromPrefix(prefix)
		}
		result["bgpGraphPageUrl"] = "https://bgp.tools/prefix/" + prefix + "#connectivity"
		ixCode, ixBody, ixErr := profileReadRetry(client, "https://bgp.tools/ixp-rs-route/"+prefix, headers, 2)
		if ixErr == nil && ixCode >= 200 && ixCode < 300 {
			if ixCount := profileHTMLTableRowCount(ixBody, "upstreamTable"); ixCount >= 0 {
				result["bgpToolsIXPCount"] = ixCount
			}
		}
	}
	return result
}

func profileNetwork(client *http.Client, ip string, asnValue any) (map[string]any, error) {
	result := map[string]any{}
	var errorsFound []string
	if bgpTools := profileBGPTools(client, ip); len(bgpTools) > 0 {
		if errText := profileString(bgpTools["error"]); errText != "" {
			errorsFound = append(errorsFound, "BGP.Tools: "+errText)
		} else {
			for key, value := range bgpTools {
				if key == "provider" {
					result["bgpProvider"] = value
					continue
				}
				result[key] = value
			}
		}
	}
	if peering, err := profilePeering(client, asnValue); err == nil {
		for key, value := range peering {
			result[key] = value
		}
	} else {
		errorsFound = append(errorsFound, "PeeringDB: "+err.Error())
	}
	if routing, err := profileRouting(client, ip, asnValue); err == nil {
		for key, value := range routing {
			result[key] = value
		}
	} else {
		errorsFound = append(errorsFound, "RIPEstat: "+err.Error())
	}
	if len(result) == 0 {
		return nil, fmt.Errorf("%s", strings.Join(errorsFound, "; "))
	}
	if prefix := profileString(result["prefix"]); prefix != "" {
		if profileString(result["bgpGraphPath"]) == "" {
			result["bgpGraphPath"] = profileBGPToolsGraphPathFromPrefix(prefix)
		}
		if profileString(result["bgpGraphPageUrl"]) == "" {
			result["bgpGraphPageUrl"] = "https://bgp.tools/prefix/" + prefix + "#connectivity"
		}
		// Fetch the SVG from the Agent's own egress. The Agent has already reached
		// BGP.Tools for prefix data, while the Panel egress may receive a 200 HTML
		// anti-bot page instead of SVG. Persisting the small data URL makes display
		// independent of the Panel's outbound IP.
		if dataURL, err := profileBGPToolsGraphDataURL(client, prefix, profileString(result["bgpGraphPath"])); err == nil {
			result["bgpGraphDataUrl"] = dataURL
			delete(result, "bgpGraphError")
		} else {
			result["bgpGraphError"] = err.Error()
		}
	}
	if len(errorsFound) > 0 {
		result["warnings"] = errorsFound
	}
	return result, nil
}

func profilePeering(client *http.Client, asnValue any) (map[string]any, error) {
	asn := profileASNNumber(asnValue)
	if asn <= 0 {
		return nil, fmt.Errorf("ASN unavailable")
	}
	var networkResp struct {
		Data []map[string]any `json:"data"`
	}
	if err := profileGetJSON(client, "https://www.peeringdb.com/api/net?asn="+strconv.FormatInt(asn, 10), &networkResp); err != nil {
		return nil, err
	}
	if len(networkResp.Data) == 0 {
		return map[string]any{"asn": asn, "registered": false, "provider": "PeeringDB"}, nil
	}
	network := networkResp.Data[0]
	netID := int64(0)
	switch value := network["id"].(type) {
	case float64:
		netID = int64(value)
	case int64:
		netID = value
	case json.Number:
		netID, _ = value.Int64()
	}
	result := map[string]any{
		"asn": asn,
		"registered": true,
		"provider": "PeeringDB",
		"name": network["name"],
		"aka": network["aka"],
		"website": network["website"],
		"infoType": network["info_type"],
		"policyGeneral": network["policy_general"],
		"ixCount": network["ix_count"],
		"facilityCount": network["fac_count"],
	}
	if netID <= 0 {
		return result, nil
	}

	var ixResp struct {
		Data []map[string]any `json:"data"`
	}
	if err := profileGetJSON(client, "https://www.peeringdb.com/api/ix?net="+strconv.FormatInt(netID, 10)+"&limit=100", &ixResp); err == nil {
		ixps := make([]map[string]any, 0, len(ixResp.Data))
		for _, ix := range ixResp.Data {
			if len(ixps) >= 50 {
				break
			}
			ixps = append(ixps, map[string]any{
				"id": ix["id"],
				"name": ix["name"],
				"nameLong": ix["name_long"],
				"city": ix["city"],
				"country": ix["country"],
				"region": ix["region_continent"],
			})
		}
		result["ixp"] = ixps
	}
	return result, nil
}

const networkProfileBodyLimit = 2 * 1024 * 1024

var netflixRegionPatterns = []*regexp.Regexp{
	regexp.MustCompile(`"requestCountry"\s*:\s*\{[^}]*"id"\s*:\s*"([A-Za-z]{2})"`),
	regexp.MustCompile(`"requestCountry"\s*:\s*"([A-Za-z]{2})"`),
}

func profileRead(client *http.Client, rawURL string, headers map[string]string) (int, string, error) {
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, networkProfileBodyLimit))
	if err != nil {
		return resp.StatusCode, "", err
	}
	return resp.StatusCode, string(raw), nil
}

func profileReadRetry(client *http.Client, rawURL string, headers map[string]string, attempts int) (int, string, error) {
	if attempts < 1 {
		attempts = 1
	}
	var code int
	var body string
	var err error
	for attempt := 0; attempt < attempts; attempt++ {
		code, body, err = profileRead(client, rawURL, headers)
		if err == nil {
			return code, body, nil
		}
		if attempt+1 < attempts {
			time.Sleep(time.Duration(attempt+1) * 150 * time.Millisecond)
		}
	}
	return code, body, err
}

func profilePostForm(client *http.Client, rawURL string, values url.Values, headers map[string]string) (int, string, error) {
	req, err := http.NewRequest(http.MethodPost, rawURL, strings.NewReader(values.Encode()))
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, networkProfileBodyLimit))
	if err != nil {
		return resp.StatusCode, "", err
	}
	return resp.StatusCode, string(raw), nil
}

var youtubeRegionPattern = regexp.MustCompile(`"INNERTUBE_CONTEXT_GL"\s*:\s*"([^"]+)"`)
var steamCurrencyPattern = regexp.MustCompile(`"priceCurrency"\s*:\s*"([^"]+)"`)
var googlePlayRegionPattern = regexp.MustCompile(`<div class="yVZQTb">([^<]+)`)

func netflixRegion(body string) string {
	for _, pattern := range netflixRegionPatterns {
		if match := pattern.FindStringSubmatch(body); len(match) > 1 {
			return strings.ToUpper(match[1])
		}
	}
	return ""
}

func netflixPlayable(body string) bool {
	lower := strings.ToLower(body)
	if strings.Contains(lower, "page-404") || strings.Contains(lower, "nsez-403") || strings.Contains(lower, "not available") {
		return false
	}
	return strings.Contains(lower, "og:video") || strings.Contains(lower, "netflix.reactcontext")
}

func profileNetflixCheck(client *http.Client) map[string]any {
	started := time.Now()
	code1, body1, err1 := profileReadRetry(client, "https://www.netflix.com/title/81280792", nil, 2)
	code2, body2, err2 := profileReadRetry(client, "https://www.netflix.com/title/70143836", nil, 2)
	if err1 != nil || err2 != nil {
		message := ""
		if err1 != nil {
			message = err1.Error()
		} else {
			message = err2.Error()
		}
		return map[string]any{"id": "netflix", "name": "Netflix", "status": "error", "message": message, "latencyMs": time.Since(started).Milliseconds()}
	}
	region := netflixRegion(body1)
	if region == "" {
		region = netflixRegion(body2)
	}
	if region == "" {
		regionPattern := regexp.MustCompile(`"id":"([A-Za-z]{2})"[^}]*"countryName"`)
		if match := regionPattern.FindStringSubmatch(body1); len(match) > 1 {
			region = strings.ToUpper(match[1])
		}
	}
	lower1 := strings.ToLower(body1)
	lower2 := strings.ToLower(body2)
	ohNo1 := strings.Contains(lower1, "oh no!")
	ohNo2 := strings.Contains(lower2, "oh no!")
	if code1 == 403 || code1 == 451 || code2 == 403 || code2 == 451 {
		return map[string]any{"id": "netflix", "name": "Netflix", "status": "blocked", "region": region, "httpStatus": code2, "latencyMs": time.Since(started).Milliseconds(), "note": "Netflix 返回地区/访问限制"}
	}
	if strings.TrimSpace(body1) == "" || strings.TrimSpace(body2) == "" {
		return map[string]any{"id": "netflix", "name": "Netflix", "status": "error", "region": region, "httpStatus": code2, "latencyMs": time.Since(started).Milliseconds(), "note": "Netflix 响应为空，检测失败"}
	}
	if ohNo1 && ohNo2 {
		return map[string]any{"id": "netflix", "name": "Netflix", "status": "unlocked", "region": region, "httpStatus": code2, "latencyMs": time.Since(started).Milliseconds(), "note": "Netflix 可用（仅 Originals）"}
	}
	return map[string]any{"id": "netflix", "name": "Netflix", "status": "unlocked", "region": region, "httpStatus": code2, "latencyMs": time.Since(started).Milliseconds(), "note": "Netflix 完整解锁"}
}

func profileChatGPTCheck(client *http.Client) map[string]any {
	started := time.Now()
	headers := map[string]string{
		"Accept": "application/json, text/plain, */*",
		"Authorization": "Bearer null",
		"Origin": "https://platform.openai.com",
		"Referer": "https://platform.openai.com/",
	}
	apiCode, apiBody, apiErr := profileRead(client, "https://api.openai.com/compliance/cookie_requirements", headers)
	unsupported := strings.Contains(strings.ToLower(apiBody), "unsupported_country")
	traceCode, traceBody, _ := profileRead(client, "https://chatgpt.com/cdn-cgi/trace", nil)
	region := ""
	for _, line := range strings.Split(traceBody, "\n") {
		if strings.HasPrefix(line, "loc=") {
			region = strings.ToUpper(strings.TrimSpace(strings.TrimPrefix(line, "loc=")))
			break
		}
	}
	iosCode, iosBody, iosErr := profileRead(client, "https://ios.chat.openai.com/", nil)
	iosBlocked := iosErr == nil && strings.Contains(strings.ToLower(iosBody), "vpn")
	status := "unlocked"
	note := "Web / App 检测通过"
	if unsupported {
		if iosErr == nil && !iosBlocked {
			status = "app_only"
			note = "仅 App 可用（Web/API 地区受限）"
		} else if iosErr == nil && iosBlocked {
			status = "blocked"
			note = "Web/API 与 App 均受限"
		} else {
			status = "error"
			note = "Web/API 地区受限，App 探测失败"
		}
	} else if apiErr != nil || apiCode == 0 {
		status = "error"
		note = "OpenAI 合规接口检测失败"
	} else if iosErr != nil {
		status = "error"
		note = "Web/API 可用，App 探测失败"
	} else if iosBlocked {
		status = "web_only"
		note = "仅 Web/API 可用（App 受限）"
	}
	return map[string]any{
		"id": "chatgpt", "name": "ChatGPT", "status": status, "region": region,
		"httpStatus": apiCode, "iosHttpStatus": iosCode, "traceHttpStatus": traceCode,
		"latencyMs": time.Since(started).Milliseconds(), "note": note,
	}
}

func profileClaudeCheck(client *http.Client) map[string]any {
	started := time.Now()
	req, err := http.NewRequest(http.MethodGet, "https://claude.ai/", nil)
	if err != nil {
		return map[string]any{"id": "claude", "name": "Claude", "status": "error", "message": err.Error()}
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36")
	resp, err := client.Do(req)
	if err != nil {
		return map[string]any{"id": "claude", "name": "Claude", "status": "error", "message": err.Error()}
	}
	defer resp.Body.Close()
	finalURL := ""
	if resp.Request != nil && resp.Request.URL != nil {
		finalURL = resp.Request.URL.String()
	}
	status := "blocked"
	note := "Claude 未通过可用性判定"
	if strings.HasPrefix(finalURL, "https://claude.ai/") {
		status = "unlocked"
		note = "Claude 可用"
	} else if strings.Contains(finalURL, "anthropic.com/app-unavailable-in-region") {
		status = "blocked"
		note = "Claude 当前地区不可用"
	}
	return map[string]any{"id": "claude", "name": "Claude", "status": status, "httpStatus": resp.StatusCode, "latencyMs": time.Since(started).Milliseconds(), "note": note, "finalUrl": finalURL}
}

func profileGeminiCheck(client *http.Client) map[string]any {
	started := time.Now()
	code, body, err := profileReadRetry(client, "https://gemini.google.com/", nil, 2)
	if err != nil {
		return map[string]any{"id": "gemini", "name": "Gemini", "status": "error", "message": err.Error()}
	}
	available := strings.Contains(body, "45631641,null,true")
	region := ""
	regionPattern := regexp.MustCompile(`,2,1,200,"([A-Z]{3})"`)
	if match := regionPattern.FindStringSubmatch(body); len(match) > 1 {
		region = match[1]
	}
	status := "blocked"
	note := "Gemini 当前地区不可用"
	if available {
		status = "unlocked"
		note = "Gemini 可用"
	}
	return map[string]any{"id": "gemini", "name": "Gemini", "status": status, "region": region, "httpStatus": code, "latencyMs": time.Since(started).Milliseconds(), "note": note}
}

func profilePrimeVideoCheck(client *http.Client) map[string]any {
	started := time.Now()
	code, body, err := profileReadRetry(client, "https://www.primevideo.com/", nil, 2)
	if err != nil {
		return map[string]any{"id": "prime", "name": "Prime Video", "status": "error", "message": err.Error()}
	}
	lower := strings.ToLower(body)
	region := ""
	regionPattern := regexp.MustCompile(`"currentTerritory"\s*:\s*"([^"]+)"`)
	if match := regionPattern.FindStringSubmatch(body); len(match) > 1 {
		region = strings.ToUpper(match[1])
	}
	status := "unlocked"
	note := "Prime Video 页面可用"
	if strings.Contains(lower, "isservicerestricted") {
		status = "blocked"
		note = "Prime Video 当前地区不可用"
	} else if region != "" {
		status = "unlocked"
		note = "Prime Video 可用"
	}
	return map[string]any{"id": "prime", "name": "Prime Video", "status": status, "region": region, "httpStatus": code, "latencyMs": time.Since(started).Milliseconds(), "note": note}
}

func profileMaxCheck(client *http.Client) map[string]any {
	started := time.Now()
	code, body, err := profileReadRetry(client, "https://www.max.com/", nil, 2)
	if err != nil {
		return map[string]any{"id": "max", "name": "Max", "status": "error", "message": err.Error()}
	}
	region := ""
	regionPattern := regexp.MustCompile(`countryCode=([A-Z]{2})`)
	if match := regionPattern.FindStringSubmatch(body); len(match) > 1 {
		region = match[1]
	}
	lower := strings.ToLower(body)
	status := "unlocked"
	note := "Max 页面可用"
	if strings.Contains(lower, "not available in your region") || strings.Contains(lower, "not available in your country") {
		status = "blocked"
		note = "Max 当前地区不可用"
	} else if region != "" {
		status = "unlocked"
		note = "Max 可用"
	}
	return map[string]any{"id": "max", "name": "Max", "status": status, "region": region, "httpStatus": code, "latencyMs": time.Since(started).Milliseconds(), "note": note}
}

func profileYouTubeCheck(client *http.Client) map[string]any {
	started := time.Now()
	code, body, err := profileReadRetry(client, "https://www.youtube.com/premium", map[string]string{"Accept-Language": "en-US,en;q=0.9"}, 2)
	if err != nil {
		return map[string]any{"id": "youtube", "name": "YouTube Premium", "status": "error", "message": err.Error()}
	}
	region := ""
	if match := youtubeRegionPattern.FindStringSubmatch(body); len(match) > 1 {
		region = strings.ToUpper(match[1])
	}
	lower := strings.ToLower(body)
	status := "unlocked"
	note := "YouTube Premium 页面可用"
	if strings.Contains(lower, "premium is not available in your country") || strings.Contains(lower, "www.google.cn") {
		status = "blocked"
		note = "YouTube Premium 当前地区不可用"
	} else if strings.Contains(lower, "ad-free") || strings.Contains(lower, "youtube premium") {
		status = "unlocked"
		note = "YouTube Premium 页面确认可用"
	}
	return map[string]any{"id": "youtube", "name": "YouTube Premium", "status": status, "region": region, "httpStatus": code, "latencyMs": time.Since(started).Milliseconds(), "note": note}
}

func profileSpotifyCheck(client *http.Client) map[string]any {
	started := time.Now()
	values := url.Values{
		"birth_day": {"11"}, "birth_month": {"11"}, "birth_year": {"2000"},
		"collect_personal_info": {"undefined"}, "creation_flow": {""},
		"creation_point": {"https://www.spotify.com/"}, "displayname": {"ForwardX"},
		"gender": {"male"}, "iagree": {"1"}, "key": {"a1e486e2729f46d6bb368d6b2bcda326"}, "platform": {"www"}, "send-email": {"0"}, "thirdpartyemail": {"0"},
	}
	code, body, err := profilePostForm(client, "https://spclient.wg.spotify.com/signup/public/v1/account", values, map[string]string{"Accept": "application/json"})
	if err != nil {
		return map[string]any{"id": "spotify", "name": "Spotify", "status": "error", "message": err.Error()}
	}
	var payload map[string]any
	if json.Unmarshal([]byte(body), &payload) != nil {
		return map[string]any{"id": "spotify", "name": "Spotify", "status": "error", "httpStatus": code, "latencyMs": time.Since(started).Milliseconds(), "note": "Spotify 返回格式无法识别"}
	}
	statusCode := int64(0)
	if number, ok := profileNumber(payload["status"]); ok {
		statusCode = int64(number)
	}
	region := strings.ToUpper(profileString(payload["country"]))
	launched, hasLaunched := profileBool(payload["is_country_launched"])
	status := "unlocked"
	note := "Spotify 接口可用"
	if statusCode == 320 || statusCode == 120 || (hasLaunched && !launched) {
		status = "blocked"
		note = "Spotify 当前地区不可注册"
	} else if statusCode == 311 && (!hasLaunched || launched) {
		status = "unlocked"
		note = "Spotify 注册可用"
	}
	return map[string]any{"id": "spotify", "name": "Spotify", "status": status, "region": region, "httpStatus": code, "latencyMs": time.Since(started).Milliseconds(), "note": note}
}

func profileSteamCheck(client *http.Client) map[string]any {
	started := time.Now()
	code, body, err := profileReadRetry(client, "https://store.steampowered.com/app/761830", nil, 2)
	if err != nil {
		return map[string]any{"id": "steam", "name": "Steam", "status": "error", "message": err.Error()}
	}
	currency := ""
	if match := steamCurrencyPattern.FindStringSubmatch(body); len(match) > 1 {
		currency = strings.ToUpper(match[1])
	}
	status := "unlocked"
	note := "Steam 商店可用"
	if currency == "" {
		status = "unlocked"
		note = "Steam 商店可用，未识别币种"
	}
	return map[string]any{"id": "steam", "name": "Steam", "status": status, "region": currency, "httpStatus": code, "latencyMs": time.Since(started).Milliseconds(), "note": note}
}

func profileAppleRegionCheck(client *http.Client) map[string]any {
	started := time.Now()
	code, body, err := profileReadRetry(client, "https://gspe1-ssl.ls.apple.com/pep/gcc", nil, 2)
	if err != nil {
		return map[string]any{"id": "apple", "name": "Apple Region", "status": "error", "message": err.Error()}
	}
	region := strings.ToUpper(strings.TrimSpace(body))
	status := "unlocked"
	return map[string]any{"id": "apple", "name": "Apple Region", "status": status, "region": region, "httpStatus": code, "latencyMs": time.Since(started).Milliseconds(), "note": "Apple 出口地区"}
}

func profileGooglePlayCheck(client *http.Client) map[string]any {
	started := time.Now()
	code, body, err := profileReadRetry(client, "https://play.google.com/", map[string]string{"Accept-Language": "en-US,en;q=0.9"}, 2)
	if err != nil {
		return map[string]any{"id": "googleplay", "name": "Google Play", "status": "error", "message": err.Error()}
	}
	region := ""
	if match := googlePlayRegionPattern.FindStringSubmatch(body); len(match) > 1 {
		region = strings.TrimSpace(match[1])
	}
	status := "unlocked"
	return map[string]any{"id": "googleplay", "name": "Google Play", "status": status, "region": region, "httpStatus": code, "latencyMs": time.Since(started).Milliseconds(), "note": "Google Play 商店区域"}
}

func profileBilibiliHKMCTWCheck(client *http.Client) map[string]any {
	started := time.Now()
	target := "https://api.bilibili.com/pgc/player/web/playurl?avid=18281381&cid=29892777&qn=0&type=&otype=json&ep_id=183799&fourk=1&fnver=0&fnval=16&module=bangumi"
	code, body, err := profileReadRetry(client, target, nil, 2)
	if err != nil {
		return map[string]any{"id": "bilibili_hmt", "name": "Bilibili 港澳台", "status": "error", "message": err.Error()}
	}
	var payload map[string]any
	_ = json.Unmarshal([]byte(body), &payload)
	resultCode := int64(-99999)
	if number, ok := profileNumber(payload["code"]); ok {
		resultCode = int64(number)
	}
	status := "blocked"
	note := "未通过港澳台内容可用性判定"
	if resultCode == 0 {
		status = "unlocked"
		note = "港澳台限定内容可播放"
	} else if resultCode == -10403 {
		status = "blocked"
		note = "港澳台限定内容不可播放"
	}
	return map[string]any{"id": "bilibili_hmt", "name": "Bilibili 港澳台", "status": status, "httpStatus": code, "latencyMs": time.Since(started).Milliseconds(), "note": note}
}

func profileTikTokCheck(client *http.Client) map[string]any {
	started := time.Now()
	code, body, err := profileReadRetry(client, "https://www.tiktok.com/", map[string]string{"Accept-Language": "en-US,en;q=0.9"}, 2)
	if err != nil {
		return map[string]any{"id": "tiktok", "name": "TikTok", "status": "error", "message": err.Error()}
	}
	if strings.Contains(body, "Please wait...") {
		code, body, err = profileReadRetry(client, "https://www.tiktok.com/explore", map[string]string{"Accept-Language": "en-US,en;q=0.9"}, 2)
	}
	if err != nil {
		return map[string]any{"id": "tiktok", "name": "TikTok", "status": "error", "message": err.Error()}
	}
	pattern := regexp.MustCompile(`"region"\s*:\s*"([A-Za-z]{2})"`)
	region := ""
	if match := pattern.FindStringSubmatch(body); len(match) > 1 {
		region = strings.ToUpper(match[1])
	}
	status := "unlocked"
	note := "TikTok 页面可用"
	if region != "" {
		status = "unlocked"
		note = "TikTok 地区识别成功"
	}
	return map[string]any{"id": "tiktok", "name": "TikTok", "status": status, "region": region, "httpStatus": code, "latencyMs": time.Since(started).Milliseconds(), "note": note}
}

func profileRedditCheck(client *http.Client) map[string]any {
	started := time.Now()
	code, body, err := profileReadRetry(client, "https://www.reddit.com/svc/shreddit/reddit-chat", nil, 2)
	if err != nil {
		return map[string]any{"id": "reddit", "name": "Reddit", "status": "error", "message": err.Error()}
	}
	region := ""
	pattern := regexp.MustCompile(`country="([^"]+)"`)
	if match := pattern.FindStringSubmatch(body); len(match) > 1 {
		region = strings.ToUpper(match[1])
	}
	status := "unlocked"
	note := "Reddit 可用"
	if code == 200 {
		status = "unlocked"
		note = "Reddit 可用"
	} else if code == 403 {
		status = "blocked"
		note = "Reddit 拒绝当前出口"
	}
	return map[string]any{"id": "reddit", "name": "Reddit", "status": status, "region": region, "httpStatus": code, "latencyMs": time.Since(started).Milliseconds(), "note": note}
}


func profileSameIPv4Subnet(a, b net.IP) bool {
	a4 := a.To4()
	b4 := b.To4()
	return a4 != nil && b4 != nil && a4[0] == b4[0] && a4[1] == b4[1] && a4[2] == b4[2]
}

func profileSuspiciousDNSAnswer(answer, source net.IP) bool {
	if answer == nil {
		return false
	}
	if answer.IsLoopback() || answer.IsPrivate() || answer.IsLinkLocalUnicast() || answer.IsLinkLocalMulticast() || answer.IsUnspecified() {
		return true
	}
	return profileSameIPv4Subnet(answer, source)
}

func profileUnlockMethod(target, family, sourceIP string) string {
	parsed, err := url.Parse(target)
	if err != nil || parsed.Hostname() == "" {
		return "native"
	}
	host := parsed.Hostname()
	source := net.ParseIP(sourceIP)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err == nil {
		for _, addr := range addrs {
			if family == "ipv4" && addr.IP.To4() == nil {
				continue
			}
			if family == "ipv6" && (addr.IP.To4() != nil || addr.IP.To16() == nil) {
				continue
			}
			if profileSuspiciousDNSAnswer(addr.IP, source) {
				return "dns"
			}
		}
	}
	randomHost := fmt.Sprintf("forwardx-%d.%s", time.Now().UnixNano(), host)
	randomCtx, randomCancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer randomCancel()
	if wildcard, wildcardErr := net.DefaultResolver.LookupIPAddr(randomCtx, randomHost); wildcardErr == nil && len(wildcard) > 0 {
		return "dns"
	}
	return "native"
}

type profileMailProviderResult struct {
	Name      string `json:"name"`
	Available bool   `json:"available"`
	Detail    string `json:"detail,omitempty"`
}

func profileSMTPAvailable(family, host string, timeout time.Duration) (bool, string) {
	network := "tcp4"
	if strings.EqualFold(family, "ipv6") {
		network = "tcp6"
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	dialer := &net.Dialer{Timeout: timeout}
	conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(host, "25"))
	if err != nil {
		return false, err.Error()
	}
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(timeout))
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil {
		return false, err.Error()
	}
	line = strings.TrimSpace(line)
	if strings.HasPrefix(line, "220") {
		_, _ = conn.Write([]byte("QUIT\r\n"))
		return true, line
	}
	return false, line
}

func profileMailProviderCheck(family, name, domain string) profileMailProviderResult {
	result := profileMailProviderResult{Name: name}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	mx, err := net.DefaultResolver.LookupMX(ctx, domain)
	if err != nil || len(mx) == 0 {
		if err != nil {
			result.Detail = err.Error()
		}
		return result
	}
	sort.Slice(mx, func(i, j int) bool { return mx[i].Pref < mx[j].Pref })
	for _, record := range mx {
		host := strings.TrimSuffix(record.Host, ".")
		if ok, detail := profileSMTPAvailable(family, host, 4*time.Second); ok {
			result.Available = true
			result.Detail = detail
			return result
		} else if result.Detail == "" {
			result.Detail = detail
		}
	}
	return result
}

var profileDNSBLDomainPattern = regexp.MustCompile(`(?i)^[a-z0-9][a-z0-9.-]*[a-z0-9]$`)

func profileDNSBLDomains() []string {
	seen := map[string]struct{}{}
	result := make([]string, 0, 450)
	for _, line := range strings.Split(profileDNSBLList, "\n") {
		value := strings.TrimSpace(line)
		if value == "" || strings.HasPrefix(value, "#") || !profileDNSBLDomainPattern.MatchString(value) {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func profileDNSBLCheck(ip string) map[string]any {
	parsed := net.ParseIP(ip)
	if parsed == nil || parsed.To4() == nil {
		return map[string]any{"supported": false, "reason": "DNSBL 仅检测 IPv4"}
	}
	octets := parsed.To4()
	reversed := fmt.Sprintf("%d.%d.%d.%d", octets[3], octets[2], octets[1], octets[0])
	domains := profileDNSBLDomains()
	type outcome struct {
		domain string
		kind   string
	}
	results := make(chan outcome, len(domains))
	sem := make(chan struct{}, 40)
	var wg sync.WaitGroup
	for _, domain := range domains {
		domain := domain
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			ctx, cancel := context.WithTimeout(context.Background(), 2500*time.Millisecond)
			defer cancel()
			hosts, err := net.DefaultResolver.LookupHost(ctx, reversed+"."+domain)
			if err != nil || len(hosts) == 0 {
				results <- outcome{domain: domain, kind: "clean"}
				return
			}
			kind := "marked"
			for _, host := range hosts {
				if host == "127.0.0.2" {
					kind = "blacklisted"
					break
				}
				if strings.HasPrefix(host, "127.255.255.") {
					kind = "clean"
				}
			}
			results <- outcome{domain: domain, kind: kind}
		}()
	}
	wg.Wait()
	close(results)

	clean, marked, blacklisted := 0, 0, 0
	markedBy := make([]string, 0, 12)
	blacklistedBy := make([]string, 0, 12)
	for item := range results {
		switch item.kind {
		case "blacklisted":
			blacklisted++
			if len(blacklistedBy) < 12 {
				blacklistedBy = append(blacklistedBy, item.domain)
			}
		case "marked":
			marked++
			if len(markedBy) < 12 {
				markedBy = append(markedBy, item.domain)
			}
		default:
			clean++
		}
	}
	return map[string]any{
		"supported": true,
		"total": len(domains),
		"clean": clean,
		"marked": marked,
		"blacklisted": blacklisted,
		"markedBy": markedBy,
		"blacklistedBy": blacklistedBy,
	}
}

func profileMailAndBlacklist(family, ip string) map[string]any {
	outboundOK, outboundDetail := profileSMTPAvailable(family, "smtp.mailgun.org", 8*time.Second)
	providers := []struct{ name, domain string }{
		{"Gmail", "gmail.com"},
		{"Outlook", "outlook.com"},
		{"Yahoo", "yahoo.com"},
		{"Apple", "me.com"},
		{"QQ", "qq.com"},
		{"Mail.ru", "mail.ru"},
		{"AOL", "aol.com"},
		{"GMX", "gmx.com"},
		{"Mail.com", "mail.com"},
		{"163", "163.com"},
		{"Sohu", "sohu.com"},
		{"Sina", "sina.com"},
	}
	checks := make([]profileMailProviderResult, len(providers))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 4)
	for index, provider := range providers {
		index, provider := index, provider
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			checks[index] = profileMailProviderCheck(family, provider.name, provider.domain)
			<-sem
		}()
	}
	wg.Wait()
	return map[string]any{
		"outbound25": map[string]any{"available": outboundOK, "detail": outboundDetail},
		"providers": checks,
		"dnsbl": profileDNSBLCheck(ip),
	}
}

func profileGenericAppCheck(client *http.Client, id, name, target string) map[string]any {
	started := time.Now()
	code, _, err := profileReadRetry(client, target, nil, 2)
	if err != nil {
		return map[string]any{"id": id, "name": name, "status": "error", "message": err.Error()}
	}
	status := "unlocked"
	note := "服务入口可用"
	if code == http.StatusForbidden || code == http.StatusUnavailableForLegalReasons {
		status = "blocked"
		note = "服务拒绝当前出口"
	} else if code >= 500 {
		status = "error"
		note = "站点响应异常，无法完成探测"
	}
	return map[string]any{
		"id": id, "name": name, "status": status, "httpStatus": code,
		"latencyMs": time.Since(started).Milliseconds(), "note": note,
	}
}

func profileAppCheck(client *http.Client, id, name, target string) map[string]any {
	switch id {
	case "netflix":
		return profileNetflixCheck(client)
	case "chatgpt":
		return profileChatGPTCheck(client)
	case "claude":
		return profileClaudeCheck(client)
	case "gemini":
		return profileGeminiCheck(client)
	case "youtube":
		return profileYouTubeCheck(client)
	case "prime":
		return profilePrimeVideoCheck(client)
	case "max":
		return profileMaxCheck(client)
	case "spotify":
		return profileSpotifyCheck(client)
	case "tiktok":
		return profileTikTokCheck(client)
	case "reddit":
		return profileRedditCheck(client)
	case "steam":
		return profileSteamCheck(client)
	case "apple":
		return profileAppleRegionCheck(client)
	case "googleplay":
		return profileGooglePlayCheck(client)
	case "bilibili_hmt":
		return profileBilibiliHKMCTWCheck(client)
	default:
		return profileGenericAppCheck(client, id, name, target)
	}
}

func runNetworkProfile(cfg Config, request networkProfileRequest) {
	startedAt := time.Now()
	request.TaskID = strings.TrimSpace(request.TaskID)
	request.Family = strings.ToLower(strings.TrimSpace(request.Family))
	request.Mode = strings.ToLower(strings.TrimSpace(request.Mode))
	if request.TaskID == "" || (request.Family != "ipv4" && request.Family != "ipv6") {
		return
	}
	client := profileHTTPClient(request.Family, 12*time.Second)
	report := func(stage, status string, data any, message string) {
		reportNetworkProfile(cfg, networkProfileReport{
			TaskID: request.TaskID, Family: request.Family, Stage: stage,
			Status: status, Data: data, Message: message,
		})
	}

	report("ip", "running", nil, "")
	ip, err := detectProfileIP(client, request.Family)
	if err != nil {
		reportNetworkProfile(cfg, networkProfileReport{
			TaskID: request.TaskID, Family: request.Family, Stage: "ip",
			Status: "error", Message: err.Error(), Completed: true, Failed: true,
		})
		return
	}
	report("ip", "success", map[string]any{"address": ip, "family": request.Family}, "")

	report("identity", "running", nil, "")
	identity, identityErr := profileIdentity(cfg, client, ip)
	if identityErr != nil {
		report("identity", "error", nil, identityErr.Error())
	} else {
		report("identity", "success", identity, "")
	}

	report("network", "running", nil, "")
	asnValue := identity["asnNumber"]
	if profileASNNumber(asnValue) <= 0 {
		asnValue = identity["asn"]
	}
	network, networkErr := profileNetwork(client, ip, asnValue)
	if networkErr != nil {
		report("network", "error", map[string]any{"asn": profileASNNumber(asnValue)}, networkErr.Error())
	} else {
		report("network", "success", network, "")
		// BGP.Tools WHOIS is an additional allocation-country signal. Recompute
		// IP nature only after the network stage so we reuse the same page fetch
		// that also provides prefix/connectivity data.
		profileMergeBGPIPNature(identity, network)
		report("identity", "success", identity, "")
	}

	report("risk", "running", nil, "")
	risk := profileRisk(cfg, client, ip)
	if risk["isDatacenter"] == nil {
		risk["isDatacenter"] = identity["is_datacenter"]
	}
	if risk["isVPN"] == nil {
		risk["isVPN"] = identity["is_vpn"]
	}
	if risk["isProxy"] == nil {
		risk["isProxy"] = identity["is_proxy"]
	}
	if risk["isTor"] == nil {
		risk["isTor"] = identity["is_tor"]
	}
	if risk["isAbuser"] == nil {
		risk["isAbuser"] = identity["is_abuser"]
	}
	report("risk", "success", risk, "")

	apps := []struct{ id, name, target string }{
		{"chatgpt", "ChatGPT", "https://chatgpt.com/"},
		{"claude", "Claude", "https://claude.ai/"},
		{"gemini", "Gemini", "https://gemini.google.com/"},
		{"youtube", "YouTube", "https://www.youtube.com/premium"},
		{"netflix", "Netflix", "https://www.netflix.com/"},
		{"disney", "Disney+", "https://www.disneyplus.com/"},
		{"tiktok", "TikTok", "https://www.tiktok.com/"},
		{"reddit", "Reddit", "https://www.reddit.com/"},
	}
	if request.Mode == "full" {
		apps = append(apps,
			struct{ id, name, target string }{"prime", "Prime Video", "https://www.primevideo.com/"},
			struct{ id, name, target string }{"max", "Max", "https://www.max.com/"},
			struct{ id, name, target string }{"spotify", "Spotify", "https://www.spotify.com/"},
			struct{ id, name, target string }{"grok", "Grok", "https://grok.com/"},
			struct{ id, name, target string }{"perplexity", "Perplexity", "https://www.perplexity.ai/"},
			struct{ id, name, target string }{"steam", "Steam", "https://store.steampowered.com/"},
			struct{ id, name, target string }{"apple", "Apple Region", "https://gspe1-ssl.ls.apple.com/pep/gcc"},
			struct{ id, name, target string }{"googleplay", "Google Play", "https://play.google.com/"},
			struct{ id, name, target string }{"bilibili_hmt", "Bilibili 港澳台", "https://api.bilibili.com/"},
		)
	}

	report("unlock", "running", map[string]any{"total": len(apps)}, "")
	var wg sync.WaitGroup
	sem := make(chan struct{}, 5)
	for _, item := range apps {
		item := item
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			result := profileAppCheck(client, item.id, item.name, item.target)
			if statusText := profileString(result["status"]); statusText != "blocked" && statusText != "error" {
				result["unlockMethod"] = profileUnlockMethod(item.target, request.Family, ip)
			}
			<-sem
			status := "success"
			if result["status"] == "error" {
				status = "error"
			}
			report("app:"+item.id, status, result, "")
		}()
	}
	wg.Wait()
	report("unlock", "success", map[string]any{"total": len(apps)}, "")

	if request.Mode == "full" {
		report("mail", "running", nil, "")
		mail := profileMailAndBlacklist(request.Family, ip)
		report("mail", "success", mail, "")
	} else {
		report("mail", "skip", map[string]any{"reason": "完整检测时执行"}, "")
	}

	reportNetworkProfile(cfg, networkProfileReport{
		TaskID: request.TaskID, Family: request.Family, Stage: "complete",
		Status: "success", Data: map[string]any{
			"ip": ip,
			"durationSeconds": strconv.FormatFloat(time.Since(startedAt).Seconds(), 'f', 1, 64),
		}, Completed: true,
	})
}
