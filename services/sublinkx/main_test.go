package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestTemplateinitCreatesAndRepairsTraversableDirectory(t *testing.T) {
	original, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(original) })

	Templateinit()
	info, err := os.Stat("template")
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0700 != 0700 {
		t.Fatalf("template permissions = %04o", info.Mode().Perm())
	}
	file := filepath.Join("template", "loon.conf")
	if err := os.WriteFile(file, []byte("custom template"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod("template", 0600); err != nil {
		t.Fatal(err)
	}
	Templateinit()
	info, err = os.Stat("template")
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0700 != 0700 {
		t.Fatalf("repaired template permissions = %04o", info.Mode().Perm())
	}
	content, err := os.ReadFile(file)
	if err != nil || string(content) != "custom template" {
		t.Fatalf("existing template changed: %q, %v", content, err)
	}
}
