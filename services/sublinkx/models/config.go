package models

import (
	"fmt"
	"log"
	"os"
	"sublink/utils"
	"sync"

	"gopkg.in/yaml.v3"
)

// type Config struct {
// 	ID    int
// 	Key   string
// 	Value string
// }

// Config 配置结构体
type Config struct {
	JwtSecret  string         `yaml:"jwt_secret"`
	ExpireDays int            `yaml:"expire_days"`
	Port       int            `yaml:"port"`
	Telegram   TelegramConfig `yaml:"telegram"`
}

type TelegramConfig struct {
	Enabled       bool   `yaml:"enabled"`
	Token         string `yaml:"token"`
	AdminChatIDs  string `yaml:"admin_chat_ids"`
	Language      string `yaml:"language"`
	APIBaseURL    string `yaml:"api_base_url"`
	PublicBaseURL string `yaml:"public_base_url"`
}

var comment string = `# jwt_secret: JWT密钥
# expire_days: token 过期天数
# port: 启动端口
# telegram: Telegram 机器人配置
`
var configMu sync.RWMutex

// 初始化配置
func ConfigInit() {
	if err := os.MkdirAll("./db", 0755); err != nil {
		log.Println("创建配置目录失败:", err)
		return
	}

	// 检查配置文件是否存在
	if _, err := os.Stat("./db/config.yaml"); os.IsNotExist(err) {
		R := utils.RandString(31) // 生成随机字符串作为JWT密钥
		// 如果不存在则创建默认配置文件
		defaultConfig := Config{
			JwtSecret:  R, // 生成随机JWT密钥
			ExpireDays: 14,
			Port:       8000, // 默认端口
			Telegram: TelegramConfig{
				Language:      "zh-CN",
				APIBaseURL:    "https://api.telegram.org",
				PublicBaseURL: "https://sublink.yforward7.com",
			},
		}

		// 生成yaml文件
		data, err := yaml.Marshal(&defaultConfig)
		if err != nil {
			log.Println("生成默认配置文件失败:", err)
			return
		}
		data = []byte(comment + string(data)) // 添加注释
		err = os.WriteFile("./db/config.yaml", data, 0644)
		if err != nil {
			fmt.Println("写入文件失败:", err)
			return
		}
		log.Println("配置文件不存在，已创建默认配置文件")
	}
}

// 读取配置
func ReadConfig() Config {
	configMu.RLock()
	defer configMu.RUnlock()
	file, err := os.ReadFile("./db/config.yaml")
	if err != nil {
		log.Println(err)
	}
	cfg := Config{}
	yaml.Unmarshal(file, &cfg)
	return cfg
}

// 设置配置
func SetConfig(newCfg Config) {
	configMu.Lock()
	defer configMu.Unlock()
	oldCfg := readConfigLocked()
	if newCfg.JwtSecret != "" {
		oldCfg.JwtSecret = newCfg.JwtSecret
	}
	if newCfg.ExpireDays != 0 {
		oldCfg.ExpireDays = newCfg.ExpireDays
	}
	if newCfg.Port != 0 {
		oldCfg.Port = newCfg.Port
	}
	if err := writeConfigLocked(oldCfg); err != nil {
		log.Println(err)
	}
}

func SetTelegramConfig(telegramConfig TelegramConfig) error {
	configMu.Lock()
	defer configMu.Unlock()
	oldCfg := readConfigLocked()
	if telegramConfig.Token == "" {
		telegramConfig.Token = oldCfg.Telegram.Token
	}
	if telegramConfig.Language == "" {
		telegramConfig.Language = "zh-CN"
	}
	if telegramConfig.APIBaseURL == "" {
		telegramConfig.APIBaseURL = "https://api.telegram.org"
	}
	if telegramConfig.PublicBaseURL == "" {
		telegramConfig.PublicBaseURL = oldCfg.Telegram.PublicBaseURL
	}
	if telegramConfig.PublicBaseURL == "" {
		telegramConfig.PublicBaseURL = "https://sublink.yforward7.com"
	}
	oldCfg.Telegram = telegramConfig
	return writeConfigLocked(oldCfg)
}

func readConfigLocked() Config {
	file, err := os.ReadFile("./db/config.yaml")
	if err != nil {
		log.Println(err)
		return Config{}
	}
	cfg := Config{}
	if err := yaml.Unmarshal(file, &cfg); err != nil {
		log.Println(err)
	}
	return cfg
}

func writeConfigLocked(cfg Config) error {
	// 写入文件
	data, err := yaml.Marshal(&cfg)
	if err != nil {
		return err
	}
	data = []byte(comment + string(data)) // 添加注释
	return os.WriteFile("./db/config.yaml", data, 0644)
}
