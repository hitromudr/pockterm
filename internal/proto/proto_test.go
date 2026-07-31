package proto

import "testing"

func TestParseResize(t *testing.T) {
	c, err := Parse([]byte(`{"type":"resize","cols":80,"rows":24}`))
	if err != nil {
		t.Fatal(err)
	}
	if c.Type != "resize" || c.Cols != 80 || c.Rows != 24 {
		t.Fatalf("unexpected control: %+v", c)
	}
}

func TestParsePing(t *testing.T) {
	c, err := Parse([]byte(`{"type":"ping"}`))
	if err != nil || c.Type != "ping" {
		t.Fatalf("ping: %+v, %v", c, err)
	}
}

func TestRejects(t *testing.T) {
	for _, bad := range []string{
		`{"type":"resize","cols":0,"rows":24}`,
		`{"type":"resize","cols":80,"rows":-1}`,
		`{"type":"exec","cmd":"rm"}`,
		`not json`,
	} {
		if _, err := Parse([]byte(bad)); err == nil {
			t.Fatalf("expected error for %s", bad)
		}
	}
}
