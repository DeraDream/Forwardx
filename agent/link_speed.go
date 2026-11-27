//go:build !iptablesonly

package main

// Full-link speed tests use the deployed forwarding rule and its final
// Shadowsocks landing. sslocal runs in fixed tunnel mode; no SOCKS listener or
// temporary Shadowsocks server is created.
import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

type linkSpeedTask struct {
	TaskID        string  `json:"taskId"`
	JobID         string  `json:"jobId"`
	Op            string  `json:"op"`
	Token         string  `json:"token"`
	Protocol      string  `json:"protocol"`
	Duration      int     `json:"duration"`
	RateMbps      float64 `json:"rateMbps"`
	ExpiresAt     int64   `json:"expiresAt"`
	EntryAddress  string  `json:"entryAddress"`
	EntryPort     int     `json:"entryPort"`
	EntryMode     string  `json:"entryMode"`
	SSMethod      string  `json:"ssMethod"`
	SSPassword    string  `json:"ssPassword"`
	BenchmarkHost string  `json:"benchmarkHost"`
	BenchmarkPort int     `json:"benchmarkPort"`
	Target        string  `json:"-"`
}

type linkSpeedLogBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (b *linkSpeedLogBuffer) Write(value []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.Write(value)
}

func (b *linkSpeedLogBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.String()
}

type linkSpeedSession struct {
	ctx     context.Context
	cancel  context.CancelFunc
	mu      sync.Mutex
	closed  bool
	running bool
	target  string
	cmd     *exec.Cmd
	output  *linkSpeedLogBuffer
	cleanup func()
}

var linkSpeedSessionsMu sync.Mutex
var linkSpeedSessions = map[string]*linkSpeedSession{}
var linkSpeedSeen = map[string]time.Time{}

func (s *linkSpeedSession) diagnosticOutput() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.output == nil {
		return ""
	}
	value := strings.TrimSpace(s.output.String())
	if len(value) > 4000 {
		value = value[len(value)-4000:]
	}
	return value
}

func (s *linkSpeedSession) close() {
	s.cancel()
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	cmd := s.cmd
	cleanup := s.cleanup
	s.cleanup = nil
	s.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
	if cleanup != nil {
		cleanup()
	}
}

func speedReport(cfg Config, task linkSpeedTask, result map[string]any) error {
	result["taskId"], result["jobId"] = task.TaskID, task.JobID
	return post(cfg, "/api/agent/link-speed-result", map[string]any{"result": result}, &map[string]any{})
}

func speedReportFinal(cfg Config, task linkSpeedTask, result map[string]any) {
	var lastErr error
	for i := 0; i < 3; i++ {
		if lastErr = speedReport(cfg, task, result); lastErr == nil {
			return
		}
		time.Sleep(150 * time.Millisecond)
	}
	logf("link speed final report failed job=%s task=%s op=%s state=%v error=%v", task.JobID, task.TaskID, task.Op, result["state"], lastErr)
}

func validateLinkSpeedTaskAt(task linkSpeedTask, now time.Time) error {
	if len(task.JobID) != 36 || len(task.TaskID) != 36 || len(task.Token) != 64 {
		return errors.New("invalid speed test identifiers")
	}
	if task.Protocol != "tcp" && task.Protocol != "udp" {
		return errors.New("unsupported speed test protocol")
	}
	if task.Duration < 3 || task.Duration > 30 || task.RateMbps < 0 || task.RateMbps > 1000 {
		return errors.New("invalid speed test limits")
	}
	if task.Protocol == "udp" && task.RateMbps < 1 {
		return errors.New("UDP speed test rate must be 1-1000 Mbps")
	}
	if task.ExpiresAt <= now.UnixMilli() {
		return errors.New("speed test lease expired")
	}
	if task.ExpiresAt > now.Add(3*time.Minute).UnixMilli() {
		return errors.New("speed test lease is too far in the future")
	}
	if task.Op != "prepare" && task.Op != "run" && task.Op != "stop" {
		return errors.New("unsupported speed test operation")
	}
	if task.EntryMode != "" && task.EntryMode != "listener" && task.EntryMode != "iptables" {
		return errors.New("unsupported speed test entry mode")
	}
	if task.EntryPort < 1 || task.EntryPort > 65535 || task.BenchmarkPort < 1 || task.BenchmarkPort > 65535 {
		return errors.New("invalid speed test port")
	}
	if strings.TrimSpace(task.SSMethod) == "" || strings.TrimSpace(task.SSPassword) == "" {
		return errors.New("missing Shadowsocks method or password")
	}
	return nil
}

func benchmarkHost(cfg Config, configured string) (string, error) {
	if host := strings.TrimSpace(configured); host != "" {
		return strings.Trim(host, "[]"), nil
	}
	parsed, err := url.Parse(strings.TrimSpace(cfg.PanelURL))
	if err != nil || parsed.Hostname() == "" {
		return "", errors.New("无法从面板地址确定测速服务器，请配置 FORWARDX_LINK_SPEED_HOST")
	}
	return parsed.Hostname(), nil
}

func pickLinkSpeedLocalPort(protocol string) (int, error) {
	if protocol == "udp" {
		conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.ParseIP("127.0.0.1")})
		if err != nil {
			return 0, err
		}
		defer conn.Close()
		return conn.LocalAddr().(*net.UDPAddr).Port, nil
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port, nil
}

const linkSpeedSSVersion = "1.25.0"
const linkSpeedSSLocal = "/usr/local/lib/forwardx/shadowsocks/sslocal"

func ensureLinkSpeedSSLocal(ctx context.Context) error {
	if runtime.GOOS != "linux" {
		return errors.New("全链路 SS 测速当前仅支持 Linux Agent")
	}
	if info, err := os.Stat(linkSpeedSSLocal); err == nil && info.Mode()&0111 != 0 {
		return nil
	}
	script := fmt.Sprintf(`set -eu
for bin in curl tar xz sha256sum awk find install uname; do command -v "$bin" >/dev/null 2>&1 || { echo "missing dependency: $bin" >&2; exit 1; }; done
arch=$(uname -m)
case "$arch" in
  x86_64|amd64) asset="shadowsocks-v%s.x86_64-unknown-linux-musl.tar.xz" ;;
  aarch64|arm64) asset="shadowsocks-v%s.aarch64-unknown-linux-musl.tar.xz" ;;
  *) echo "unsupported CPU architecture: $arch" >&2; exit 1 ;;
esac
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
base="https://github.com/shadowsocks/shadowsocks-rust/releases/download/v%s"
curl -fL --retry 3 --connect-timeout 15 "$base/$asset" -o "$tmp/runtime.tar.xz"
curl -fL --retry 3 --connect-timeout 15 "$base/$asset.sha256" -o "$tmp/runtime.tar.xz.sha256"
expected=$(awk '{print $1}' "$tmp/runtime.tar.xz.sha256")
printf '%%s  %%s\n' "$expected" "$tmp/runtime.tar.xz" | sha256sum -c -
tar -xJf "$tmp/runtime.tar.xz" -C "$tmp"
bin=$(find "$tmp" -type f -name sslocal -perm -u+x | head -n 1)
test -n "$bin"
install -d -m 0755 /usr/local/lib/forwardx/shadowsocks
install -m 0755 "$bin" %s
`, linkSpeedSSVersion, linkSpeedSSVersion, linkSpeedSSVersion, linkSpeedSSLocal)
	cmd := exec.CommandContext(ctx, "sh", "-c", script)
	var output bytes.Buffer
	cmd.Stdout, cmd.Stderr = &output, &output
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("准备 Shadowsocks 测速客户端失败: %v: %s", err, strings.TrimSpace(output.String()))
	}
	return nil
}

type linkSpeedNetworkNamespace struct {
	name        string
	hostIf      string
	hostAddress string
	peerAddress string
}

func runLinkSpeedIP(args ...string) error {
	cmd := exec.Command("ip", args...)
	var output bytes.Buffer
	cmd.Stdout, cmd.Stderr = &output, &output
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("ip %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(output.String()))
	}
	return nil
}

func cleanupLinkSpeedNetworkNamespace(namespace linkSpeedNetworkNamespace) {
	_ = exec.Command("ip", "netns", "del", namespace.name).Run()
	_ = exec.Command("ip", "link", "del", namespace.hostIf).Run()
}

func cleanupStaleLinkSpeedNetworkNamespaces() {
	if runtime.GOOS != "linux" {
		return
	}
	if output, err := exec.Command("ip", "netns", "list").Output(); err == nil {
		for _, line := range strings.Split(string(output), "\n") {
			name := strings.Fields(line)
			if len(name) > 0 && len(name[0]) == 14 && strings.HasPrefix(name[0], "fwxls-") {
				if _, parseErr := strconv.ParseUint(name[0][6:], 16, 32); parseErr == nil {
					_ = exec.Command("ip", "netns", "del", name[0]).Run()
				}
			}
		}
	}
	if output, err := exec.Command("ip", "-o", "link", "show").Output(); err == nil {
		for _, line := range strings.Split(string(output), "\n") {
			fields := strings.Fields(line)
			if len(fields) < 2 {
				continue
			}
			name := strings.TrimSuffix(strings.SplitN(fields[1], "@", 2)[0], ":")
			if len(name) == 12 && strings.HasPrefix(name, "fxlh") {
				if _, parseErr := strconv.ParseUint(name[4:], 16, 32); parseErr == nil {
					_ = exec.Command("ip", "link", "del", name).Run()
				}
			}
		}
	}
}

func setupLinkSpeedNetworkNamespace(task linkSpeedTask) (linkSpeedNetworkNamespace, error) {
	if _, err := exec.LookPath("ip"); err != nil {
		return linkSpeedNetworkNamespace{}, errors.New("iptables 入口测速需要 iproute2 的 ip 命令")
	}
	suffix := strings.ReplaceAll(task.TaskID, "-", "")
	if len(suffix) < 8 {
		return linkSpeedNetworkNamespace{}, errors.New("invalid speed test namespace identifier")
	}
	suffix = suffix[:8]
	value, _ := strconv.ParseUint(suffix[:4], 16, 16)
	second := 18 + int(value>>15)
	third := int((value >> 7) & 0xff)
	base := int(value&0x3f) * 4
	namespace := linkSpeedNetworkNamespace{
		name:        "fwxls-" + suffix,
		hostIf:      "fxlh" + suffix,
		hostAddress: fmt.Sprintf("198.%d.%d.%d", second, third, base+1),
		peerAddress: fmt.Sprintf("198.%d.%d.%d", second, third, base+2),
	}
	cleanupLinkSpeedNetworkNamespace(namespace)
	commands := [][]string{
		{"netns", "add", namespace.name},
		{"link", "add", namespace.hostIf, "type", "veth", "peer", "name", "fxln" + suffix},
		{"link", "set", "fxln" + suffix, "netns", namespace.name},
		{"addr", "add", namespace.hostAddress + "/30", "dev", namespace.hostIf},
		{"link", "set", namespace.hostIf, "up"},
		{"netns", "exec", namespace.name, "ip", "link", "set", "lo", "up"},
		{"netns", "exec", namespace.name, "ip", "addr", "add", namespace.peerAddress + "/30", "dev", "fxln" + suffix},
		{"netns", "exec", namespace.name, "ip", "link", "set", "fxln" + suffix, "up"},
		{"netns", "exec", namespace.name, "ip", "route", "replace", "default", "via", namespace.hostAddress},
	}
	for _, args := range commands {
		if err := runLinkSpeedIP(args...); err != nil {
			cleanupLinkSpeedNetworkNamespace(namespace)
			return linkSpeedNetworkNamespace{}, fmt.Errorf("准备 iptables 入口测速网络命名空间失败: %w", err)
		}
	}
	return namespace, nil
}

func startLinkSpeedSSLocal(cfg Config, session *linkSpeedSession, task linkSpeedTask) error {
	if err := ensureLinkSpeedSSLocal(session.ctx); err != nil {
		return err
	}
	host, err := benchmarkHost(cfg, task.BenchmarkHost)
	if err != nil {
		return err
	}
	localPort, err := pickLinkSpeedLocalPort(task.Protocol)
	if err != nil {
		return fmt.Errorf("分配本地测速端口失败: %w", err)
	}
	entryHost := strings.TrimSpace(task.EntryAddress)
	if entryHost == "" {
		entryHost = "127.0.0.1"
	}
	localAddr := net.JoinHostPort("127.0.0.1", strconv.Itoa(localPort))
	command := linkSpeedSSLocal
	commandPrefix := []string{}
	if task.EntryMode == "iptables" {
		namespace, setupErr := setupLinkSpeedNetworkNamespace(task)
		if setupErr != nil {
			return setupErr
		}
		entryHost = namespace.hostAddress
		localAddr = net.JoinHostPort(namespace.peerAddress, strconv.Itoa(localPort))
		command = "ip"
		commandPrefix = []string{"netns", "exec", namespace.name, linkSpeedSSLocal}
		session.mu.Lock()
		session.cleanup = func() { cleanupLinkSpeedNetworkNamespace(namespace) }
		session.mu.Unlock()
		logf("link speed iptables ingress namespace ready job=%s namespace=%s ingress=%s:%d", task.JobID, namespace.name, namespace.hostAddress, task.EntryPort)
	}
	args := []string{
		"--protocol", "tunnel",
		"-b", localAddr,
		"-s", net.JoinHostPort(strings.Trim(entryHost, "[]"), strconv.Itoa(task.EntryPort)),
		"-m", task.SSMethod,
		"-k", task.SSPassword,
		"-f", net.JoinHostPort(strings.Trim(host, "[]"), strconv.Itoa(task.BenchmarkPort)),
		"--log-without-time",
		"-v",
	}
	if task.Protocol == "udp" {
		args = append(args, "-u", "--udp-timeout", "90")
	}
	cmd := exec.CommandContext(session.ctx, command, append(commandPrefix, args...)...)
	output := &linkSpeedLogBuffer{}
	cmd.Stdout, cmd.Stderr = output, output
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("启动 Shadowsocks 测速客户端失败: %w", err)
	}
	session.mu.Lock()
	session.cmd = cmd
	session.output = output
	session.target = localAddr
	session.mu.Unlock()
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case err := <-exited:
			return fmt.Errorf("Shadowsocks 测速客户端提前退出: %v: %s", err, strings.TrimSpace(output.String()))
		default:
		}
		if task.Protocol == "tcp" {
			conn, dialErr := net.DialTimeout("tcp", localAddr, 250*time.Millisecond)
			if dialErr == nil {
				_ = conn.Close()
				return nil
			}
		} else if time.Until(deadline) < 7*time.Second {
			return nil
		}
		time.Sleep(120 * time.Millisecond)
	}
	return fmt.Errorf("Shadowsocks 测速客户端未就绪: %s", strings.TrimSpace(output.String()))
}

func handleLinkSpeedTask(cfg Config, task linkSpeedTask) {
	logf("link speed task received job=%s task=%s op=%s protocol=%s duration=%ds", task.JobID, task.TaskID, task.Op, task.Protocol, task.Duration)
	panelNow := encryptedResponseNow(currentPanelURL(cfg))
	if err := validateLinkSpeedTaskAt(task, panelNow); err != nil {
		logf("link speed task rejected job=%s task=%s op=%s error=%v leaseExpiresAt=%d panelNow=%d localNow=%d clockOffset=%s", task.JobID, task.TaskID, task.Op, err, task.ExpiresAt, panelNow.UnixMilli(), time.Now().UnixMilli(), panelNow.Sub(time.Now()).Round(time.Second))
		speedReportFinal(cfg, task, map[string]any{"state": "error", "error": err.Error()})
		return
	}
	var claim struct {
		Allowed bool `json:"allowed"`
	}
	var claimErr error
	for attempt := 1; attempt <= 3; attempt++ {
		claim.Allowed = false
		claimErr = post(cfg, "/api/agent/link-speed-claim", map[string]any{"jobId": task.JobID, "taskId": task.TaskID}, &claim)
		if claimErr == nil {
			break
		}
		logf("link speed claim failed job=%s task=%s op=%s attempt=%d/3 error=%v", task.JobID, task.TaskID, task.Op, attempt, claimErr)
		if attempt < 3 {
			time.Sleep(time.Duration(attempt) * 300 * time.Millisecond)
		}
	}
	if claimErr != nil {
		logf("link speed task abandoned after claim errors job=%s task=%s op=%s error=%v", task.JobID, task.TaskID, task.Op, claimErr)
		return
	}
	if !claim.Allowed {
		logf("link speed claim rejected job=%s task=%s op=%s", task.JobID, task.TaskID, task.Op)
		return
	}
	logf("link speed claim accepted job=%s task=%s op=%s", task.JobID, task.TaskID, task.Op)
	linkSpeedSessionsMu.Lock()
	for id, at := range linkSpeedSeen {
		if time.Since(at) > 4*time.Minute {
			delete(linkSpeedSeen, id)
		}
	}
	if _, seen := linkSpeedSeen[task.TaskID]; seen {
		linkSpeedSessionsMu.Unlock()
		logf("link speed duplicate task ignored job=%s task=%s op=%s", task.JobID, task.TaskID, task.Op)
		return
	}
	linkSpeedSeen[task.TaskID] = time.Now()
	session := linkSpeedSessions[task.JobID]
	if task.Op == "stop" {
		if session != nil {
			delete(linkSpeedSessions, task.JobID)
		}
		linkSpeedSessionsMu.Unlock()
		if session != nil {
			session.close()
		}
		logf("link speed stop completed job=%s task=%s sessionFound=%v", task.JobID, task.TaskID, session != nil)
		speedReportFinal(cfg, task, map[string]any{"state": "stopped"})
		return
	}
	if task.Op == "prepare" {
		if session != nil {
			linkSpeedSessionsMu.Unlock()
			return
		}
		leaseRemaining := time.UnixMilli(task.ExpiresAt).Sub(panelNow)
		ctx, cancel := context.WithTimeout(context.Background(), leaseRemaining)
		session = &linkSpeedSession{ctx: ctx, cancel: cancel}
		linkSpeedSessions[task.JobID] = session
	}
	linkSpeedSessionsMu.Unlock()
	if session == nil {
		speedReportFinal(cfg, task, map[string]any{"state": "error", "error": "测速客户端尚未准备完成"})
		return
	}
	fail := func(err error) {
		diagnostic := session.diagnosticOutput()
		if diagnostic != "" {
			err = fmt.Errorf("%w; sslocal: %s", err, diagnostic)
		}
		logf("link speed task failed job=%s task=%s op=%s error=%v", task.JobID, task.TaskID, task.Op, err)
		session.close()
		speedReportFinal(cfg, task, map[string]any{"state": "error", "error": err.Error()})
	}
	if task.Op == "prepare" {
		logf("link speed prepare started job=%s task=%s entry=%s:%d benchmark=%s:%d", task.JobID, task.TaskID, task.EntryAddress, task.EntryPort, task.BenchmarkHost, task.BenchmarkPort)
		if err := startLinkSpeedSSLocal(cfg, session, task); err != nil {
			fail(err)
			return
		}
		logf("link speed prepare ready job=%s task=%s", task.JobID, task.TaskID)
		speedReportFinal(cfg, task, map[string]any{"state": "ready"})
		return
	}
	session.mu.Lock()
	if session.closed || session.running {
		session.mu.Unlock()
		return
	}
	session.running = true
	task.Target = session.target
	session.mu.Unlock()
	logf("link speed run started job=%s task=%s protocol=%s duration=%ds", task.JobID, task.TaskID, task.Protocol, task.Duration)
	updates := make(chan speedSample, 640)
	var updatesMu sync.Mutex
	updatesClosed := false
	reportsDone := make(chan struct{})
	go func() {
		defer close(reportsDone)
		reportSpeedSamples(updates, speedReportInterval, func(samples []speedSample) {
			_ = speedReport(cfg, task, map[string]any{"samples": samples})
		})
	}()
	emit := func(sample speedSample) {
		updatesMu.Lock()
		defer updatesMu.Unlock()
		if updatesClosed {
			return
		}
		select {
		case updates <- sample:
		default:
		}
	}
	upload, download, err := runLinkSpeed(session.ctx, task, emit, func(direction string, result speedMeasurement) {
		_ = speedReport(cfg, task, map[string]any{direction: result})
	})
	updatesMu.Lock()
	updatesClosed = true
	close(updates)
	updatesMu.Unlock()
	select {
	case <-reportsDone:
	case <-time.After(3 * time.Second):
	}
	if err != nil {
		fail(err)
		return
	}
	logf("link speed run completed job=%s task=%s uploadMbps=%.2f downloadMbps=%.2f", task.JobID, task.TaskID, upload.Mbps, download.Mbps)
	speedReportFinal(cfg, task, map[string]any{"state": "completed", "upload": upload, "download": download})
}

func reportSpeedSamples(updates <-chan speedSample, interval time.Duration, report func([]speedSample)) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	batch := make([]speedSample, 0, 64)
	flush := func() {
		if len(batch) > 0 {
			report(batch)
			batch = make([]speedSample, 0, 64)
		}
	}
	for {
		select {
		case sample, ok := <-updates:
			if !ok {
				flush()
				return
			}
			batch = append(batch, sample)
			if len(batch) == 64 {
				flush()
			}
		case <-ticker.C:
			flush()
		}
	}
}

func linkSpeedDirectionOrder() [2]string {
	return [2]string{"download", "upload"}
}

func runLinkSpeed(ctx context.Context, task linkSpeedTask, emit func(speedSample), complete func(string, speedMeasurement)) (speedMeasurement, speedMeasurement, error) {
	var upload, download speedMeasurement
	for _, direction := range linkSpeedDirectionOrder() {
		if ctx.Err() != nil {
			return upload, download, ctx.Err()
		}
		emit(speedSample{Direction: direction})
		var result speedMeasurement
		var err error
		if task.Protocol == "udp" {
			result, err = runSpeedUDP(ctx, task, direction, emit)
		} else {
			result, err = runSpeedTCP(ctx, task, direction, emit)
		}
		if err != nil {
			label := "上传"
			if direction == "download" {
				label = "下载"
			}
			return upload, download, fmt.Errorf("%s测速失败: %w", label, err)
		}
		if direction == "upload" {
			upload = result
		} else {
			download = result
		}
		if complete != nil {
			complete(direction, result)
		}
	}
	return upload, download, nil
}

func speedPayload(size int) []byte { b := make([]byte, size); _, _ = rand.Read(b); return b }
func speedWait(ctx context.Context, until time.Time) error {
	delay := time.Until(until)
	if delay <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func speedAddressValid(target string) bool {
	host, port, err := net.SplitHostPort(target)
	number, _ := strconv.Atoi(port)
	return err == nil && strings.TrimSpace(host) != "" && number > 0 && number <= 65535
}
