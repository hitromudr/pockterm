package term

import (
	"strings"
	"testing"
	"time"
)

func readUntil(t *testing.T, tm *Term, want string) string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	var out strings.Builder
	buf := make([]byte, 4096)
	for time.Now().Before(deadline) {
		tm.File.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
		n, _ := tm.File.Read(buf)
		out.Write(buf[:n])
		if strings.Contains(out.String(), want) {
			return out.String()
		}
	}
	t.Fatalf("did not see %q in output: %q", want, out.String())
	return ""
}

func TestEchoThroughPTY(t *testing.T) {
	tm, err := Start([]string{"sh", "-c", "echo ready; cat"}, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer tm.Close()

	readUntil(t, tm, "ready")
	if _, err := tm.File.Write([]byte("hello\n")); err != nil {
		t.Fatal(err)
	}
	readUntil(t, tm, "hello")
}

func TestResize(t *testing.T) {
	tm, err := Start([]string{"cat"}, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer tm.Close()
	if err := tm.Resize(120, 40); err != nil {
		t.Fatal(err)
	}
}
