package node

import (
	"fmt"
	"log"
	"net"
	"net/url"
	"strconv"
	"strings"
)

// ss匹配规则
type Ss struct {
	Param  Param
	Server string
	Port   int
	Name   string
	Type   string
}
type Param struct {
	Cipher   string
	Password string
}

func CompatibleSSPassword(cipher, password string) string {
	if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(cipher)), "2022-") {
		return password
	}
	parts := strings.Split(password, ":")
	for i := len(parts) - 1; i >= 0; i-- {
		part := strings.TrimSpace(parts[i])
		if part != "" {
			return part
		}
	}
	return password
}

func (s Ss) ClientPassword() string {
	return CompatibleSSPassword(s.Param.Cipher, s.Param.Password)
}

func parsingSS(s string) (string, string, string) {
	/* ss url编码分为三部分：加密方式、服务器地址和端口、备注
	://和@之前为第一部分 @到#之间为第二部分 #之后为第三部分
	第一部分 为加密方式和密码，格式为：加密方式:密码	示例：aes-128-gcm:123456
	第二部分 为服务器地址和端口，格式为：服务器地址:端口	示例：xxx.xxx:12345
	第三部分 为备注，格式为：#备注	示例：#备注
	*/
	u, err := url.Parse(s)
	if err != nil {
		log.Println("ss url parse fail.", err)
		return "", "", ""
	}
	if u.Scheme != "ss" {
		log.Println("ss url parse fail, not ss url.")
		return "", "", ""
	}
	name := u.Fragment
	// 处理url全编码的情况
	if u.User == nil {
		// 截取ss://后的字符串
		raw := s[5:]
		if index := strings.IndexAny(raw, "?#"); index >= 0 {
			raw = raw[:index]
		}
		s = "ss://" + Base64Decode(raw)
		u, err = url.Parse(s)
		if err != nil {
			log.Println("ss url parse fail.", err)
			return "", "", ""
		}
		if name != "" && u.Fragment == "" {
			u.Fragment = name
		}
	}
	var auth, addr string
	auth = u.User.String()
	if u.Host != "" {
		addr = u.Host
	}
	if u.Fragment != "" {
		name = u.Fragment
	}
	return auth, addr, name
}

func decodeSSAuth(auth string) (string, string, error) {
	auth = strings.TrimSpace(auth)
	if auth == "" {
		return "", "", fmt.Errorf("invalid SS URL auth")
	}
	for i := 0; i < 3; i++ {
		decoded, err := url.PathUnescape(auth)
		if err != nil || decoded == auth {
			break
		}
		auth = decoded
	}
	if !strings.Contains(auth, ":") {
		decoded := Base64Decode(auth)
		if decoded != auth || strings.Contains(decoded, ":") {
			auth = decoded
		}
	}
	parts := strings.SplitN(auth, ":", 2)
	if len(parts) != 2 || strings.TrimSpace(parts[0]) == "" || parts[1] == "" {
		return "", "", fmt.Errorf("invalid SS URL auth")
	}
	return parts[0], parts[1], nil
}

// 开发者测试
func CallSSURL() {
	ss := Ss{}
	// ss.Name = "测试"
	ss.Server = "baidu.com"
	ss.Port = 443
	ss.Param.Cipher = "2022-blake3-aes-256-gcm"
	ss.Param.Password = "asdasd"
	fmt.Println(EncodeSSURL(ss))
}

// ss 编码输出
func EncodeSSURL(s Ss) string {
	//编码格式 ss://base64(base64(method:password)@hostname:port)
	p := Base64Encode(s.Param.Cipher + ":" + s.ClientPassword())
	// 假设备注没有使用服务器加端口命名
	if s.Name == "" {
		s.Name = s.Server + ":" + strconv.Itoa(s.Port)
	}
	param := fmt.Sprintf("%s@%s:%s#%s",
		p,
		s.Server,
		strconv.Itoa(s.Port),
		s.Name,
	)
	return "ss://" + param
}

func DecodeSSURL(s string) (Ss, error) {
	// 解析ss链接
	param, addr, name := parsingSS(s)
	// 判断是否为空
	if param == "" || addr == "" {
		return Ss{}, fmt.Errorf("invalid SS URL")
	}
	cipher, password, err := decodeSSAuth(param)
	if err != nil {
		return Ss{}, err
	}
	server, portText, err := net.SplitHostPort(addr)
	if err != nil {
		parts := strings.Split(addr, ":")
		if len(parts) < 2 {
			return Ss{}, fmt.Errorf("invalid SS URL address")
		}
		portText = parts[len(parts)-1]
		server = strings.TrimSuffix(ValRetIPv6Addr(addr), ":"+portText)
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port <= 0 || port > 65535 || strings.TrimSpace(server) == "" {
		return Ss{}, fmt.Errorf("invalid SS URL address")
	}
	// 如果没有备注则使用服务器加端口命名
	if name == "" {
		name = addr
	}
	// 开发环境输出结果
	if CheckEnvironment() {
		fmt.Println("Param:", cipher+":***")
		fmt.Println("Server", server)
		fmt.Println("Port", port)
		fmt.Println("Name:", name)
		fmt.Println("Cipher:", cipher)
	}
	// 返回结果
	return Ss{
		Param: Param{
			Cipher:   cipher,
			Password: password,
		},
		Server: server,
		Port:   port,
		Name:   name,
		Type:   "ss",
	}, nil
}
