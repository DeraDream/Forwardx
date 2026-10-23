package models

import "gorm.io/gorm"

type IPEntry struct {
	gorm.Model
	ID      int    `gorm:"primaryKey"`
	Alias   string `gorm:"size:80;not null"`
	Address string `gorm:"size:45;not null;uniqueIndex"`
}
