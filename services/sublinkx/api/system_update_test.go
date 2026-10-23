package api

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestCompareVersions(t *testing.T) {
	tests := []struct {
		left  string
		right string
		want  int
	}{
		{left: "4.28", right: "4.29", want: -1},
		{left: "4.29", right: "4.29", want: 0},
		{left: "4.30", right: "4.29", want: 1},
		{left: "v4.29.1", right: "4.29", want: 1},
	}
	for _, test := range tests {
		if got := compareVersions(test.left, test.right); got != test.want {
			t.Fatalf("compareVersions(%q, %q) = %d, want %d", test.left, test.right, got, test.want)
		}
	}
}

func TestValidReleaseVersion(t *testing.T) {
	for _, version := range []string{"4.29", "4.29.1"} {
		if !validReleaseVersion(version) {
			t.Fatalf("validReleaseVersion(%q) = false", version)
		}
	}
	for _, version := range []string{"", "v4.29", "4.29-beta", "../../tmp"} {
		if validReleaseVersion(version) {
			t.Fatalf("validReleaseVersion(%q) = true", version)
		}
	}
}

func TestUpdateHelperShellSyntax(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("bash is not available")
	}
	updater := NewSystemUpdater("4.28")
	updater.statusPath = filepath.Join(t.TempDir(), "update-status.json")
	helper, err := updater.createUpdateHelper()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(helper) })
	if output, err := exec.Command(bash, "-n", helper).CombinedOutput(); err != nil {
		t.Fatalf("update helper syntax error: %s", output)
	}
}
