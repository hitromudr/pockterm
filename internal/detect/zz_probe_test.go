package detect

import (
	"os"
	"strings"
	"testing"
)

func TestZZProbe(t *testing.T) {
	b, _ := os.ReadFile(os.Getenv("PROBE"))
	l := strings.Split(string(b), "\n")
	m := Question(l)
	t.Logf("menu=%+v box=%d live=%v", m, InputBoxAt(l), Live(l))
}
