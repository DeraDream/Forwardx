package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/time/rate"
)

const (
	defaultAgentProbePort            = 9811
	agentProbeProtocolVersion        = 1
	agentProbeTransportTCP      byte = 1
	agentProbeTransportUDP      byte = 2
	agentProbeRequestSize            = 64
	agentProbeResponseSize           = 56
	agentProbeMaxTicketLifetime      = 10 * time.Minute
	agentProbeClockSkew              = time.Minute
	agentProbeConnectionTimeout      = 2 * time.Second
	agentProbeMaxTCPConcurrency      = 128
	agentProbeGlobalRate             = 500
	agentProbeGlobalBurst            = 1000
	agentProbePortEnv                = "FORWARDX_AGENT_PROBE_PORT"
)

var (
	agentProbeRequestMagic  = [4]byte{'F', 'X', 'P', '1'}
	agentProbeResponseMagic = [4]byte{'F', 'X', 'R', '1'}
	agentProbeStatusValue   atomic.Value
)

type agentProbeStatus struct {
	Version  int    `json:"version"`
	Port     int    `json:"port"`
	TCPReady bool   `json:"tcpReady"`
	UDPReady bool   `json:"udpReady"`
	Message  string `json:"message,omitempty"`
}

type agentProbeServer struct {
	token       []byte
	port        int
	tcpListener net.Listener
	udpConn     net.PacketConn
	tcpSlots    chan struct{}
	limiter     *rate.Limiter
	closeOnce   sync.Once
	closed      chan struct{}
}

func init() {
	agentProbeStatusValue.Store(agentProbeStatus{
		Version: agentProbeProtocolVersion,
		Port:    defaultAgentProbePort,
		Message: "probe listener not started",
	})
}

func resolveAgentProbePort(cfg Config) (int, error) {
	port := cfg.ProbePort
	if raw, exists := os.LookupEnv(agentProbePortEnv); exists {
		value := strings.TrimSpace(raw)
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed < 1 || parsed > 65535 || strconv.Itoa(parsed) != value {
			return 0, fmt.Errorf("%s must be an integer in 1-65535", agentProbePortEnv)
		}
		port = parsed
	}
	if port == 0 {
		port = defaultAgentProbePort
	}
	if port < 1 || port > 65535 {
		return 0, fmt.Errorf("probePort must be in 1-65535")
	}
	return port, nil
}

func currentAgentProbeStatus() agentProbeStatus {
	if value := agentProbeStatusValue.Load(); value != nil {
		if status, ok := value.(agentProbeStatus); ok {
			return status
		}
	}
	return agentProbeStatus{Version: agentProbeProtocolVersion, Port: defaultAgentProbePort}
}

func publishAgentProbeStatus(status agentProbeStatus) {
	if status.Version <= 0 {
		status.Version = agentProbeProtocolVersion
	}
	if status.Port <= 0 {
		status.Port = defaultAgentProbePort
	}
	status.Message = strings.TrimSpace(status.Message)
	agentProbeStatusValue.Store(status)
}

func startAgentProbeServer(port int, token string) *agentProbeServer {
	server := &agentProbeServer{
		token:    []byte(token),
		port:     port,
		tcpSlots: make(chan struct{}, agentProbeMaxTCPConcurrency),
		limiter:  rate.NewLimiter(rate.Limit(agentProbeGlobalRate), agentProbeGlobalBurst),
		closed:   make(chan struct{}),
	}
	status := agentProbeStatus{Version: agentProbeProtocolVersion, Port: port}
	if port < 0 || port > 65535 || strings.TrimSpace(token) == "" {
		status.Message = "invalid probe listener configuration"
		publishAgentProbeStatus(status)
		return server
	}

	tcpListener, tcpErr := net.Listen("tcp", net.JoinHostPort("", strconv.Itoa(port)))
	if tcpErr == nil {
		server.tcpListener = tcpListener
		status.TCPReady = true
		if port == 0 {
			if address, ok := tcpListener.Addr().(*net.TCPAddr); ok {
				server.port = address.Port
				status.Port = address.Port
			}
		}
	}

	udpPort := server.port
	udpConn, udpErr := net.ListenPacket("udp", net.JoinHostPort("", strconv.Itoa(udpPort)))
	if udpErr == nil {
		server.udpConn = udpConn
		status.UDPReady = true
		if status.Port == 0 {
			if address, ok := udpConn.LocalAddr().(*net.UDPAddr); ok {
				server.port = address.Port
				status.Port = address.Port
			}
		}
	}

	messages := make([]string, 0, 2)
	if tcpErr != nil {
		messages = append(messages, "tcp: "+tcpErr.Error())
	}
	if udpErr != nil {
		messages = append(messages, "udp: "+udpErr.Error())
	}
	status.Message = strings.Join(messages, "; ")
	publishAgentProbeStatus(status)

	if server.tcpListener != nil {
		go server.serveTCP()
	}
	if server.udpConn != nil {
		go server.serveUDP()
	}
	if status.TCPReady || status.UDPReady {
		logf("agent probe listener started port=%d tcp=%v udp=%v", status.Port, status.TCPReady, status.UDPReady)
	} else {
		logf("agent probe listener unavailable port=%d error=%s", status.Port, status.Message)
	}
	return server
}

func (server *agentProbeServer) Close() error {
	if server == nil {
		return nil
	}
	var closeErr error
	server.closeOnce.Do(func() {
		close(server.closed)
		if server.tcpListener != nil {
			if err := server.tcpListener.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
				closeErr = err
			}
		}
		if server.udpConn != nil {
			if err := server.udpConn.Close(); err != nil && !errors.Is(err, net.ErrClosed) && closeErr == nil {
				closeErr = err
			}
		}
	})
	return closeErr
}

func (server *agentProbeServer) serveTCP() {
	for {
		conn, err := server.tcpListener.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			select {
			case <-server.closed:
				return
			default:
			}
			server.markTransportUnavailable("tcp", err)
			return
		}
		if !server.limiter.Allow() {
			_ = conn.Close()
			continue
		}
		select {
		case server.tcpSlots <- struct{}{}:
			go func() {
				defer func() { <-server.tcpSlots }()
				server.handleTCP(conn)
			}()
		default:
			_ = conn.Close()
		}
	}
}

func (server *agentProbeServer) handleTCP(conn net.Conn) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(agentProbeConnectionTimeout))
	request := make([]byte, agentProbeRequestSize)
	if _, err := io.ReadFull(conn, request); err != nil {
		return
	}
	response, ok := verifyAgentProbeRequest(server.token, agentProbeTransportTCP, request, time.Now())
	if !ok {
		return
	}
	_, _ = conn.Write(response)
}

func (server *agentProbeServer) serveUDP() {
	buffer := make([]byte, 256)
	for {
		n, address, err := server.udpConn.ReadFrom(buffer)
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			select {
			case <-server.closed:
				return
			default:
			}
			server.markTransportUnavailable("udp", err)
			return
		}
		if n != agentProbeRequestSize || !server.limiter.Allow() {
			continue
		}
		response, ok := verifyAgentProbeRequest(server.token, agentProbeTransportUDP, buffer[:n], time.Now())
		if !ok {
			continue
		}
		_, _ = server.udpConn.WriteTo(response, address)
	}
}

func (server *agentProbeServer) markTransportUnavailable(transport string, err error) {
	status := currentAgentProbeStatus()
	if transport == "tcp" {
		status.TCPReady = false
	} else if transport == "udp" {
		status.UDPReady = false
	}
	message := strings.TrimSpace(status.Message)
	next := fmt.Sprintf("%s listener stopped: %v", transport, err)
	if message == "" {
		status.Message = next
	} else if !strings.Contains(message, next) {
		status.Message = message + "; " + next
	}
	publishAgentProbeStatus(status)
	wakeHeartbeat()
}

func verifyAgentProbeRequest(token []byte, transport byte, request []byte, now time.Time) ([]byte, bool) {
	if len(token) == 0 || len(request) != agentProbeRequestSize {
		return nil, false
	}
	if !hmac.Equal(request[:4], agentProbeRequestMagic[:]) || request[4] != agentProbeProtocolVersion || request[5] != transport {
		return nil, false
	}
	if binary.BigEndian.Uint16(request[6:8]) != 0 {
		return nil, false
	}
	expiresAt := int64(binary.BigEndian.Uint64(request[8:16]))
	nowUnix := now.Unix()
	if expiresAt < nowUnix-int64(agentProbeClockSkew/time.Second) || expiresAt > nowUnix+int64(agentProbeMaxTicketLifetime/time.Second) {
		return nil, false
	}
	expected := agentProbeMAC(token, request[:32])
	if !hmac.Equal(request[32:], expected) {
		return nil, false
	}
	response := make([]byte, agentProbeResponseSize)
	copy(response[:4], agentProbeResponseMagic[:])
	response[4] = agentProbeProtocolVersion
	response[5] = transport
	copy(response[8:24], request[16:32])
	copy(response[24:], agentProbeMAC(token, response[:24]))
	return response, true
}

func buildAgentProbeRequest(token []byte, transport byte, expiresAt time.Time, nonce [16]byte) []byte {
	request := make([]byte, agentProbeRequestSize)
	copy(request[:4], agentProbeRequestMagic[:])
	request[4] = agentProbeProtocolVersion
	request[5] = transport
	binary.BigEndian.PutUint64(request[8:16], uint64(expiresAt.Unix()))
	copy(request[16:32], nonce[:])
	copy(request[32:], agentProbeMAC(token, request[:32]))
	return request
}

func expectedAgentProbeResponse(token []byte, transport byte, nonce [16]byte) []byte {
	response := make([]byte, agentProbeResponseSize)
	copy(response[:4], agentProbeResponseMagic[:])
	response[4] = agentProbeProtocolVersion
	response[5] = transport
	copy(response[8:24], nonce[:])
	copy(response[24:], agentProbeMAC(token, response[:24]))
	return response
}

func agentProbeMAC(token []byte, payload []byte) []byte {
	mac := hmac.New(sha256.New, token)
	_, _ = mac.Write(payload)
	return mac.Sum(nil)
}

func actionAgentProbePortConflict(a action, probePort int) int {
	if a.Op != "apply" || probePort <= 0 {
		return 0
	}
	ports := []int{a.SourcePort}
	if a.Fxp != nil {
		ports = append(ports, a.Fxp.ListenPort, a.Fxp.UDPListenPort)
		for _, entry := range a.Fxp.Entries {
			ports = append(ports, entry.ListenPort, entry.UDPListenPort)
		}
	}
	if a.Failover != nil {
		ports = append(ports, a.Failover.ListenPort)
	}
	if a.WireGuard != nil {
		ports = append(ports, a.WireGuard.ListenPort)
	}
	for _, port := range ports {
		if port == probePort {
			return port
		}
	}
	return 0
}

func rejectAgentProbePortAction(cfg Config, a action) bool {
	port := actionAgentProbePortConflict(a, cfg.ProbePort)
	if port == 0 {
		return false
	}
	message := fmt.Sprintf("reserved-agent-probe-port: port %d is reserved for the ForwardX Agent probe listener", port)
	logf("action rejected reason=reserved-agent-probe-port port=%d %s", port, actionLogSummary(a))
	if strings.TrimSpace(a.StatusType) == "runtime" {
		rememberRuntimeActionResult(a, false)
	}
	if shouldReportActionStatus(a) {
		succeeded := false
		a.ActionSucceeded = &succeeded
		reportActionStatus(cfg, a, false, message)
	}
	invalidateLocalRuntimeReadinessCache()
	requestLocalRuntimeStateUpload()
	return true
}
