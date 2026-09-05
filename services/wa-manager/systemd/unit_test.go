package systemd

import (
	"strings"
	"testing"
)

func TestCommandsTargetTheTemplatedInstance(t *testing.T) {
	var got []string
	c := &systemctl{unit: "wa-agent-bridge", run: func(args ...string) (string, error) {
		got = append(got, strings.Join(args, " "))
		return "", nil
	}}

	c.Enable("blitz")
	c.Start("blitz")
	c.Stop("blitz")
	c.Disable("blitz")

	want := []string{
		"--user enable wa-agent-bridge@blitz",
		"--user start wa-agent-bridge@blitz",
		"--user stop wa-agent-bridge@blitz",
		"--user disable wa-agent-bridge@blitz",
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("step %d: want %q, got %q", i, want[i], got[i])
		}
	}
}

func TestInstanceNamesAreRefusedIfTheyCouldEscapeTheUnit(t *testing.T) {
	c := &systemctl{unit: "wa-agent-bridge", run: func(args ...string) (string, error) {
		t.Fatalf("a rejected instance name must never reach systemctl: %v", args)
		return "", nil
	}}
	for _, bad := range []string{"", "a b", "../etc", "a@b", "a/b", "a;rm -rf /"} {
		if err := c.Start(bad); err == nil {
			t.Fatalf("instance name %q must be refused", bad)
		}
	}
}

func TestIsActiveReadsSystemctlOutput(t *testing.T) {
	c := &systemctl{unit: "u", run: func(...string) (string, error) { return "active\n", nil }}
	if ok, err := c.IsActive("x"); err != nil || !ok {
		t.Fatalf("want active, got %v %v", ok, err)
	}
	// systemctl exits non-zero for an inactive unit; that is not an error.
	c.run = func(...string) (string, error) { return "inactive\n", errExit }
	if ok, err := c.IsActive("x"); err != nil || ok {
		t.Fatalf("inactive must be (false, nil), got %v %v", ok, err)
	}
}
