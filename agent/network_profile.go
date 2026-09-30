package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
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

func profileAppCheck(client *http.Client, id, name, target string) map[string]any {
	started := time.Now()
	req, err := http.NewRequest(http.MethodGet, target, nil)
	if err != nil {
		return map[string]any{"id": id, "name": name, "status": "error", "message": err.Error()}
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 ForwardX-NetworkProfile")
	resp, err := client.Do(req)
	if err != nil {
		return map[string]any{"id": id, "name": name, "status": "error", "message": err.Error()}
	}
	defer resp.Body.Close()
	status := "reachable"
	if resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusUnavailableForLegalReasons {
		status = "blocked"
	} else if resp.StatusCode >= 500 {
		status = "unknown"
	}
	return map[string]any{
		"id": id,
		"name": name,
		"status": status,
		"httpStatus": resp.StatusCode,
		"latencyMs": time.Since(started).Milliseconds(),
		"note": "基础可达性结果；地区/原生/仅 App 判定将在对应 checker 中继续细化",
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
