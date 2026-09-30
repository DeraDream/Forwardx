package main

import (
	"context"
	"encoding/json"
	"fmt"
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
		ResponseHeaderTimeout: 5 * time.Second,
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

func profileIdentity(client *http.Client, ip string) (map[string]any, error) {
	result := map[string]any{"ip": ip}
	var primaryErr error

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
			result["flag"] = profileString(flag["emoji"])
			result["identityProvider"] = "ipwho.is"
		} else {
			primaryErr = fmt.Errorf("ipwho.is lookup failed")
		}
	} else {
		primaryErr = err
	}

	var ipapi map[string]any
	if err := profileGetJSON(client, "https://api.ipapi.is/?q="+url.QueryEscape(ip), &ipapi); err == nil {
		for _, key := range []string{"is_datacenter", "is_vpn", "is_proxy", "is_tor", "is_abuser"} {
			if value, ok := ipapi[key]; ok {
				if _, valid := profileBool(value); valid {
					result[key] = value
				}
			}
		}
		if current := profileString(result["company"]); current == "" {
			if company := profileString(ipapi["company"]); company != "" && !strings.HasPrefix(company, "map[") {
				result["company"] = company
			}
		}
		if current := profileString(result["asn"]); current == "" {
			if asn := profileString(ipapi["asn"]); asn != "" && !strings.HasPrefix(asn, "map[") {
				result["asn"] = asn
				result["asnNumber"] = profileASNNumber(asn)
			}
		}
		result["classificationProvider"] = "ipapi.is"
	}

	var ipinfo map[string]any
	if err := profileGetJSONRetry(client, "https://ipinfo.io/widget/demo/"+url.PathEscape(ip), &ipinfo, 2); err == nil {
		data := profileMap(ipinfo["data"])
		if data != nil {
			actual := strings.ToUpper(profileString(data["country"]))
			abuse := profileMap(data["abuse"])
			registered := strings.ToUpper(profileString(abuse["country"]))
			result["registeredCountryCode"] = registered
			if actual == "" {
				actual = strings.ToUpper(profileString(result["countryCode"]))
			}
			if actual != "" && registered != "" {
				if actual == registered {
					result["ipNature"] = "native"
				} else {
					result["ipNature"] = "broadcast"
				}
			}
		}
	}
	if profileString(result["ipNature"]) == "" {
		result["ipNature"] = "unknown"
	}

	if profileString(result["asn"]) == "" && primaryErr != nil {
		return nil, primaryErr
	}
	return result, nil
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
	Error        string `json:"error,omitempty"`
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

func profileRiskFromCheckPlace(client *http.Client, ip, db string) (map[string]any, error) {
	var payload map[string]any
	endpoint := "https://ipinfo.check.place/" + url.PathEscape(ip) + "?db=" + url.QueryEscape(db)
	if err := profileGetJSONRetry(client, endpoint, &payload, 3); err != nil {
		return nil, err
	}
	return payload, nil
}

func profileProxyCheckSource(client *http.Client, ip string) profileRiskSource {
	source := profileRiskSource{Name: "ProxyCheck"}
	var payload map[string]any
	endpoint := "https://proxycheck.io/v2/" + url.PathEscape(ip) + "?vpn=1&asn=1&risk=1&days=7"
	if err := profileGetJSONRetry(client, endpoint, &payload, 3); err != nil {
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

func profileScamalyticsSource(client *http.Client, ip string) profileRiskSource {
	source := profileRiskSource{Name: "Scamalytics"}
	payload, err := profileRiskFromCheckPlace(client, ip, "scamalytics")
	if err != nil {
		source.Error = err.Error()
		return source
	}
	scam := profileMap(payload["scamalytics"])
	proxy := profileMap(scam["scamalytics_proxy"])
	external := profileMap(payload["external_datasources"])
	firehol := profileMap(external["firehol"])
	x4b := profileMap(external["x4bnet"])
	maxmind := profileMap(external["maxmind_geolite2"])
	source.Score = profileScorePtr(scam["scamalytics_score"])
	if source.Score != nil {
		source.Level = profileRiskLevel(*source.Score)
	}
	source.IsVPN = profileBoolPtr(proxy["is_vpn"])
	source.IsDatacenter = profileBoolPtr(proxy["is_datacenter"])
	source.IsProxy = profileBoolPtr(firehol["is_proxy"])
	source.IsTor = profileBoolPtr(x4b["is_tor"])
	source.IsAbuser = profileBoolPtr(scam["is_blacklisted_external"])
	source.Country = profileString(maxmind["ip_country_code"])
	return source
}

func profileIPQSSource(client *http.Client, ip string) profileRiskSource {
	source := profileRiskSource{Name: "IPQS"}
	payload, err := profileRiskFromCheckPlace(client, ip, "ipqualityscore")
	if err != nil {
		source.Error = err.Error()
		return source
	}
	source.Score = profileScorePtr(payload["fraud_score"])
	if source.Score != nil {
		source.Level = profileRiskLevel(*source.Score)
	}
	source.Country = profileString(payload["country_code"])
	source.IsProxy = profileBoolPtr(payload["proxy"])
	source.IsVPN = profileBoolPtr(payload["vpn"])
	source.IsTor = profileBoolPtr(payload["tor"])
	source.IsAbuser = profileBoolPtr(payload["recent_abuse"])
	source.IsBot = profileBoolPtr(payload["bot_status"])
	return source
}

func profileIPAPISource(client *http.Client, ip string) profileRiskSource {
	source := profileRiskSource{Name: "ipapi"}
	payload, err := profileRiskFromCheckPlace(client, ip, "ipapi")
	if err != nil {
		source.Error = err.Error()
		return source
	}
	company := profileMap(payload["company"])
	scoreText := profileString(company["abuser_score"])
	if scoreText != "" {
		fields := strings.Fields(scoreText)
		if len(fields) > 0 {
			if raw, err := strconv.ParseFloat(fields[0], 64); err == nil {
				score := raw
				if raw <= 1 {
					score = raw * 100
				}
				source.Score = &score
				source.Level = profileRiskLevel(score)
			}
		}
	}
	location := profileMap(payload["location"])
	source.Country = profileString(location["country_code"])
	source.IsProxy = profileBoolPtr(payload["is_proxy"])
	source.IsVPN = profileBoolPtr(payload["is_vpn"])
	source.IsTor = profileBoolPtr(payload["is_tor"])
	source.IsDatacenter = profileBoolPtr(payload["is_datacenter"])
	source.IsAbuser = profileBoolPtr(payload["is_abuser"])
	source.IsBot = profileBoolPtr(payload["is_crawler"])
	return source
}

func profileAbuseIPDBSource(client *http.Client, ip string) profileRiskSource {
	source := profileRiskSource{Name: "AbuseIPDB"}
	payload, err := profileRiskFromCheckPlace(client, ip, "abuseipdb")
	if err != nil {
		source.Error = err.Error()
		return source
	}
	data := profileMap(payload["data"])
	source.Score = profileScorePtr(data["abuseConfidenceScore"])
	if source.Score != nil {
		source.Level = profileRiskLevel(*source.Score)
	}
	source.Country = profileString(data["countryCode"])
	source.NetworkType = profileString(data["usageType"])
	server := strings.Contains(strings.ToLower(source.NetworkType), "data center") || strings.Contains(strings.ToLower(source.NetworkType), "hosting")
	source.IsDatacenter = &server
	return source
}

func profileIP2LocationSource(client *http.Client, ip string) profileRiskSource {
	source := profileRiskSource{Name: "IP2Location"}
	payload, err := profileRiskFromCheckPlace(client, ip, "ip2location")
	if err != nil {
		source.Error = err.Error()
		return source
	}
	source.Country = profileString(payload["country_code"])
	source.NetworkType = profileString(payload["usage_type"])
	proxyType := strings.ToUpper(profileString(payload["proxy_type"]))
	if proxyType != "" && proxyType != "-" {
		proxy := true
		source.IsProxy = &proxy
	}
	lowerType := strings.ToLower(source.NetworkType)
	server := strings.Contains(lowerType, "data center") || strings.Contains(lowerType, "hosting") || strings.HasPrefix(strings.ToUpper(source.NetworkType), "DCH")
	source.IsDatacenter = &server
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

func profileRisk(client *http.Client, ip string) map[string]any {
	sources := make([]profileRiskSource, 6)
	var wg sync.WaitGroup
	checks := []func() profileRiskSource{
		func() profileRiskSource { return profileProxyCheckSource(client, ip) },
		func() profileRiskSource { return profileScamalyticsSource(client, ip) },
		func() profileRiskSource { return profileIPQSSource(client, ip) },
		func() profileRiskSource { return profileIPAPISource(client, ip) },
		func() profileRiskSource { return profileAbuseIPDBSource(client, ip) },
		func() profileRiskSource { return profileIP2LocationSource(client, ip) },
	}
	for index := range checks {
		index := index
		wg.Add(1)
		go func() {
			defer wg.Done()
			if index > 0 {
				// check.place-backed databases are more reliable when requests are not fired
				// as a same-millisecond burst from one VPS address.
				time.Sleep(time.Duration(index-1) * 220 * time.Millisecond)
			}
			sources[index] = checks[index]()
		}()
	}
	wg.Wait()

	// Public risk APIs occasionally rate-limit bursts from VPS addresses.
	// Retry only failed sources one-by-one so a transient failure does not collapse
	// the matrix to ProxyCheck-only results.
	for index := range sources {
		if strings.TrimSpace(sources[index].Error) == "" {
			continue
		}
		time.Sleep(650 * time.Millisecond)
		retry := checks[index]()
		if strings.TrimSpace(retry.Error) == "" {
			sources[index] = retry
		}
	}

	var scoreTotal float64
	scoreCount := 0
	networkType := ""
	for _, source := range sources {
		if source.Score != nil {
			scoreTotal += *source.Score
			scoreCount++
		}
		if networkType == "" && source.NetworkType != "" {
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
		"provider": "multi-source",
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
	case strings.Contains(upper, "CLOUDflare"):
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

func profileNetwork(client *http.Client, ip string, asnValue any) (map[string]any, error) {
	result := map[string]any{}
	var errorsFound []string
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
		return map[string]any{"id": "netflix", "name": "Netflix", "status": "originals_only", "region": region, "httpStatus": code2, "latencyMs": time.Since(started).Milliseconds(), "note": "仅 Netflix Originals"}
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
	iosBlocked := iosErr != nil || strings.Contains(strings.ToLower(iosBody), "vpn")
	status := "unlocked"
	note := "Web / App 检测通过"
	if unsupported {
		if !iosBlocked {
			status = "app_only"
			note = "Web/API 地区受限，仅 App 探测可用"
		} else {
			status = "blocked"
			note = "OpenAI 返回 unsupported_country"
		}
	} else if apiErr != nil || apiCode == 0 {
		status = "unknown"
		note = "OpenAI 合规接口检测失败"
	} else if iosBlocked {
		status = "web_only"
		note = "Web/API 可用，App 探测受限"
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
	status := "unknown"
	note := "无法确认 Premium 可用状态"
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
		return map[string]any{"id": "spotify", "name": "Spotify", "status": "unknown", "httpStatus": code, "latencyMs": time.Since(started).Milliseconds(), "note": "Spotify 返回格式无法识别"}
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
	client := profileHTTPClient(request.Family, 8*time.Second)
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
	identity, identityErr := profileIdentity(client, ip)
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
	}

	report("risk", "running", nil, "")
	risk := profileRisk(client, ip)
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

	reportNetworkProfile(cfg, networkProfileReport{
		TaskID: request.TaskID, Family: request.Family, Stage: "complete",
		Status: "success", Data: map[string]any{
			"ip": ip,
			"durationSeconds": strconv.FormatFloat(time.Since(startedAt).Seconds(), 'f', 1, 64),
		}, Completed: true,
	})
}
