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
	SSMethod      string  `json:"ssMethod"`
	SSPassword    string  `json:"ssPassword"`
	BenchmarkHost string  `json:"benchmarkHost"`
	BenchmarkPort int     `json:"benchmarkPort"`
	Target        string  `json:"-"`
}

type linkSpeedSession struct {
	ctx     context.Context
	cancel  context.CancelFunc
	mu      sync.Mutex
	closed  bool
	running bool
	target  string
	cmd     *exec.Cmd
}

var linkSpeedSessionsMu sync.Mutex
var linkSpeedSessions = map[string]*linkSpeedSession{}
var linkSpeedSeen = map[string]time.Time{}

func (s *linkSpeedSession) close() {
	s.cancel()
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	cmd := s.cmd
	s.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}

func speedReport(cfg Config, task linkSpeedTask, result map[string]any) error {
	result["taskId"], result["jobId"] = task.TaskID, task.JobID
	return post(cfg, "/api/agent/link-speed-result", map[string]any{"result": result}, &map[string]any{})
}

func speedReportFinal(cfg Config, task linkSpeedTask, result map[string]any) {
	for i := 0; i < 3; i++ {
		if speedReport(cfg, task, result) == nil {
			return
		}
		time.Sleep(150 * time.Millisecond)
	}
}

func validateLinkSpeedTask(task linkSpeedTask) error {
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
	if task.ExpiresAt <= time.Now().UnixMilli() || task.ExpiresAt > time.Now().Add(3*time.Minute).UnixMilli() {
		return errors.New("speed test lease expired")
	}
	if task.Op != "prepare" && task.Op != "run" && task.Op != "stop" {
		return errors.New("unsupported speed test operation")
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
	args := []string{
		"--protocol", "tunnel",
		"-b", localAddr,
		"-s", net.JoinHostPort(strings.Trim(entryHost, "[]"), strconv.Itoa(task.EntryPort)),
		"-m", task.SSMethod,
		"-k", task.SSPassword,
		"-f", net.JoinHostPort(strings.Trim(host, "[]"), strconv.Itoa(task.BenchmarkPort)),
		"--log-without-time",
	}
	if task.Protocol == "udp" {
		args = append(args, "-u", "--udp-timeout", "90")
	}
	cmd := exec.CommandContext(session.ctx, linkSpeedSSLocal, args...)
	var output bytes.Buffer
	cmd.Stdout, cmd.Stderr = &output, &output
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("启动 Shadowsocks 测速客户端失败: %w", err)
	}
	session.mu.Lock()
	session.cmd = cmd
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
	if err := validateLinkSpeedTask(task); err != nil {
		speedReportFinal(cfg, task, map[string]any{"state": "error", "error": err.Error()})
		return
	}
	var claim struct {
		Allowed bool `json:"allowed"`
	}
	if err := post(cfg, "/api/agent/link-speed-claim", map[string]any{"jobId": task.JobID, "taskId": task.TaskID}, &claim); err != nil || !claim.Allowed {
		return
	}
	linkSpeedSessionsMu.Lock()
	for id, at := range linkSpeedSeen {
		if time.Since(at) > 4*time.Minute {
			delete(linkSpeedSeen, id)
		}
	}
	if _, seen := linkSpeedSeen[task.TaskID]; seen {
		linkSpeedSessionsMu.Unlock()
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
		speedReportFinal(cfg, task, map[string]any{"state": "stopped"})
		return
	}
	if task.Op == "prepare" {
		if session != nil {
			linkSpeedSessionsMu.Unlock()
			return
		}
		ctx, cancel := context.WithDeadline(context.Background(), time.UnixMilli(task.ExpiresAt))
		session = &linkSpeedSession{ctx: ctx, cancel: cancel}
		linkSpeedSessions[task.JobID] = session
	}
	linkSpeedSessionsMu.Unlock()
	if session == nil {
		speedReportFinal(cfg, task, map[string]any{"state": "error", "error": "测速客户端尚未准备完成"})
		return
	}
	fail := func(err error) {
		session.close()
		speedReportFinal(cfg, task, map[string]any{"state": "error", "error": err.Error()})
	}
	if task.Op == "prepare" {
		if err := startLinkSpeedSSLocal(cfg, session, task); err != nil {
			fail(err)
			return
		}
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

func runLinkSpeed(ctx context.Context, task linkSpeedTask, emit func(speedSample), complete func(string, speedMeasurement)) (speedMeasurement, speedMeasurement, error) {
	var upload, download speedMeasurement
	for _, direction := range []string{"upload", "download"} {
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
