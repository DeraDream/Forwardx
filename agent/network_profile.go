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
		Proxy: http.ProxyFromEnvironment,
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

func detectProfileIP(client *http.Client, family string) (string, error) {
	endpoint := "https://api4.ipify.org?format=json"
	if strings.EqualFold(family, "ipv6") {
		endpoint = "https://api6.ipify.org?format=json"
	}
	var payload struct{ IP string `json:"ip"` }
	if err := profileGetJSON(client, endpoint, &payload); err != nil {
		return "", err
	}
	ip := strings.TrimSpace(payload.IP)
	if net.ParseIP(ip) == nil {
		return "", fmt.Errorf("invalid public IP response")
	}
	return ip, nil
}

func profileIdentity(client *http.Client, ip string) (map[string]any, error) {
	var payload map[string]any
	if err := profileGetJSON(client, "https://api.ipapi.is/?q="+url.QueryEscape(ip), &payload); err != nil {
		return nil, err
	}
	result := map[string]any{
		"ip": ip,
		"company": payload["company"],
		"asn": payload["asn"],
		"city": payload["city"],
		"region": payload["region"],
		"country": payload["country"],
		"timezone": payload["timezone"],
	}
	for _, key := range []string{"is_datacenter", "is_vpn", "is_proxy", "is_tor", "is_abuser", "datacenter"} {
		if value, ok := payload[key]; ok {
			result[key] = value
		}
	}
	return result, nil
}

const networkProfileBodyLimit = 2 * 1024 * 1024

var netflixRegionPatterns = []*regexp.Regexp{
	regexp.MustCompile(`"requestCountry"\\s*:\\s*\\{[^}]*"id"\\s*:\\s*"([A-Za-z]{2})"`),
	regexp.MustCompile(`"requestCountry"\\s*:\\s*"([A-Za-z]{2})"`),
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
	originalCode, originalBody, originalErr := profileRead(client, "https://www.netflix.com/title/81280792", nil)
	if originalErr != nil {
		return map[string]any{"id": "netflix", "name": "Netflix", "status": "error", "message": originalErr.Error()}
	}
	region := netflixRegion(originalBody)
	originalOK := originalCode >= 200 && originalCode < 400 && netflixPlayable(originalBody)
	if !originalOK {
		return map[string]any{
			"id": "netflix", "name": "Netflix", "status": "blocked", "region": region,
			"httpStatus": originalCode, "latencyMs": time.Since(started).Milliseconds(),
			"note": "Netflix 测试标题不可用",
		}
	}
	regionalCode, regionalBody, regionalErr := profileRead(client, "https://www.netflix.com/title/70143836", nil)
	if region == "" {
		region = netflixRegion(regionalBody)
	}
	if regionalErr == nil && regionalCode >= 200 && regionalCode < 400 && netflixPlayable(regionalBody) {
		return map[string]any{
			"id": "netflix", "name": "Netflix", "status": "unlocked", "region": region,
			"httpStatus": regionalCode, "latencyMs": time.Since(started).Milliseconds(),
			"note": "完整片库测试通过",
		}
	}
	return map[string]any{
		"id": "netflix", "name": "Netflix", "status": "originals_only", "region": region,
		"httpStatus": regionalCode, "latencyMs": time.Since(started).Milliseconds(),
		"note": "仅 Netflix Originals",
	}
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

func profileGenericAppCheck(client *http.Client, id, name, target string) map[string]any {
	started := time.Now()
	code, _, err := profileRead(client, target, nil)
	if err != nil {
		return map[string]any{"id": id, "name": name, "status": "error", "message": err.Error()}
	}
	status := "reachable"
	if code == http.StatusForbidden || code == http.StatusUnavailableForLegalReasons {
		status = "blocked"
	} else if code >= 500 {
		status = "unknown"
	}
	return map[string]any{
		"id": id, "name": name, "status": status, "httpStatus": code,
		"latencyMs": time.Since(started).Milliseconds(),
		"note": "当前为官方站点可达性检测，未把可达误标为完整解锁",
	}
}

func profileAppCheck(client *http.Client, id, name, target string) map[string]any {
	switch id {
	case "netflix":
		return profileNetflixCheck(client)
	case "chatgpt":
		return profileChatGPTCheck(client)
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

	report("network", "success", map[string]any{
		"asn": identity["asn"],
		"peeringSource": "PeeringDB",
		"status": "queued-for-enrichment",
	}, "ASN/IXP 详细信息由 Panel 根据 ASN 继续补全")

	risk := map[string]any{
		"score": nil,
		"level": "unknown",
		"isDatacenter": identity["is_datacenter"],
		"isVPN": identity["is_vpn"],
		"isProxy": identity["is_proxy"],
		"isTor": identity["is_tor"],
		"isAbuser": identity["is_abuser"],
		"provider": "ipapi.is",
	}
	report("risk", "success", risk, "未配置风险数据源密钥时仅展示可获得字段")

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
