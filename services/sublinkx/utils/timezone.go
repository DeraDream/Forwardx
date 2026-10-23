package utils

import (
	"log"
	"time"
)

const BeijingTimeZone = "Asia/Shanghai"

var BeijingLocation = time.FixedZone("CST", 8*60*60)

func InitBeijingTimezone() {
	loc, err := time.LoadLocation(BeijingTimeZone)
	if err != nil {
		log.Printf("加载北京时间时区失败，使用 UTC+8 固定时区: %v", err)
		loc = time.FixedZone("CST", 8*60*60)
	}
	BeijingLocation = loc
	time.Local = loc
}

func BeijingNow() time.Time {
	return time.Now().In(BeijingLocation)
}

func FormatBeijingTime(t time.Time) string {
	return t.In(BeijingLocation).Format("2006-01-02 15:04:05")
}
