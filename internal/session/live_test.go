package session

import "testing"

// fakeProcs is a process tree as /proc would show it: argv, the children and
// the environment of each pid.
type fakeProcs struct {
	argv map[int][]string
	kids map[int][]int
	env  map[int]map[string]string
}

func (f fakeProcs) Argv(pid int) []string        { return f.argv[pid] }
func (f fakeProcs) Children(pid int) []int       { return f.kids[pid] }
func (f fakeProcs) Env(pid int, k string) string { return f.env[pid][k] }

// The buttons as they stood on ser8 on 2026-11-18.
var liveButtons = []Custom{
	{ID: "yolo", Label: "Claude W (yolo)", Mark: "❄️"},
	{ID: "b2", Label: "Claude W Cont (yolo)", Target: "cont-yolo", Mark: "❄️"},
	{ID: "b9", Label: "Claude G (yolo)", Cmd: "claude-ge-safe --dangerously-skip-permissions", Mark: "❄️"},
	{ID: "b11", Label: "Claude GLM (yolo)", Cmd: "claude-glm-safe --dangerously-skip-permissions", Mark: "☀️"},
	{ID: "b12", Label: "Claude GLM Cont (yolo)", Cmd: "claude-glm-safe -c --dangerously-skip-permissions", Mark: "☀️"},
	{ID: "b7", Label: "Gemini 4 W (yolo)", Cmd: "gemini-key-safe --yolo -m gemini-4-argon", Mark: "✴️"},
	{ID: "b13", Label: "Gemini 4 G (yolo)", Cmd: "gemini-sub-safe --yolo -m gemini-4-argon", Mark: "✴️"},
}

// relayStart is what a claude-relay successor's pane was created with since
// 15.11.2026: the command went into a script file and argv carries its path, so
// the start command names no agent at all.
const relayStart = `"exec bash /home/dms/.cache/claude-relay/da042ad8.sh"`

func TestLiveKindReadsTheWrapperThatRuns(t *testing.T) {
	// con-glm on ser8, 2026-11-18: stamped a bare `custom` by whoever raised the
	// tab, running claude-glm-safe — drawn as ⭐ instead of the GLM button.
	p := fakeProcs{
		argv: map[int][]string{
			10: {"bash", "/home/dms/.cache/claude-relay/da042ad8.sh"},
			11: {"bash", "/usr/local/bin/claude-glm-safe", "--model", "glm-5.3", "--permission-mode", "auto", "--session-id", "da04", "[ЭСТАФЕТА; prompt]"},
			12: {"/home/dms/.local/bin/.claude-real", "--model", "glm-5.3"},
		},
		kids: map[int][]int{10: {11}, 11: {12}},
	}
	if got := LiveKind(liveButtons, p, "custom", relayStart, 10); got != "custom:b11" {
		t.Errorf("relay tab running claude-glm-safe: got %q, want custom:b11", got)
	}
	// The same tab raised from a W session keeps the W session's stamp: the
	// stamp is who raised it, the process is what runs in it.
	if got := LiveKind(liveButtons, p, "yolo", relayStart, 10); got != "custom:b11" {
		t.Errorf("relay glm tab under a W stamp: got %q, want custom:b11", got)
	}
	// A Gemini successor raised in a Claude G tab.
	g := fakeProcs{
		argv: map[int][]string{
			10: {"bash", "/home/dms/.cache/claude-relay/5c8c.sh"},
			11: {"bash", "/usr/local/bin/gemini-key-safe", "--yolo", "-m", "gemini-4-argon", "--session-id", "5c8c"},
			12: {"/home/dms/.local/share/node/v24/bin/node", "/home/dms/.local/libexec/gemini/gemini", "--yolo"},
		},
		kids: map[int][]int{10: {11}, 11: {12}},
	}
	if got := LiveKind(liveButtons, g, "custom:b9", relayStart, 10); got != "custom:b7" {
		t.Errorf("gemini-key successor in a G tab: got %q, want custom:b7", got)
	}
}

func TestLiveKindReadsAgentRunByItsEnvironment(t *testing.T) {
	// agent-run is the launcher of every agent: what runs behind it is its
	// AGENT_COMMAND, and none at all is plain Claude (W).
	tree := func(env map[string]string) fakeProcs {
		return fakeProcs{
			argv: map[int][]string{
				10: {"bash", "/home/dms/.cache/claude-relay/ac64.sh"},
				11: {"bash", "/usr/local/bin/agent-run", "--dangerously-skip-permissions", "--session-id", "ac64"},
				12: {"/home/dms/.local/bin/.claude-real", "--dangerously-skip-permissions"},
			},
			kids: map[int][]int{10: {11}, 11: {12}},
			env:  map[int]map[string]string{11: env},
		}
	}
	if got := LiveKind(liveButtons, tree(nil), "custom:b11", relayStart, 10); got != "yolo" {
		t.Errorf("plain agent-run in a GLM tab: got %q, want yolo", got)
	}
	if got := LiveKind(liveButtons, tree(map[string]string{"AGENT_COMMAND": "claude-ge-safe"}), "yolo", relayStart, 10); got != "custom:b9" {
		t.Errorf("agent-run with claude-ge-safe under a W stamp: got %q, want custom:b9", got)
	}
	// W Cont stays W Cont: the same agent, and the stamp knows the button.
	if got := LiveKind(liveButtons, tree(nil), "custom:b2", relayStart, 10); got != "custom:b2" {
		t.Errorf("W Cont tab running W: got %q, want custom:b2", got)
	}
}

func TestLiveKindLeavesAProjectLauncherAlone(t *testing.T) {
	// xnt-lr on the RPi5, 2026-11-18: exante's xnt-seed behind agent-run picks
	// the account itself and sets it in an environment that Claude Code does not
	// let anybody read. Nothing on the outside says which account, so the stamp
	// stands — a guess of W would be a wrong answer that looks like the right one.
	start := `"env -u KIND AGENT_COMMAND=/home/dms/work/exante/tools/xnt-seed agent-run 'lr' '--claude' '--ge'"`
	p := fakeProcs{
		argv: map[int][]string{
			10: {"bash", "-c", "t0=$(date +%s); env -u KIND AGENT_COMMAND=/home/dms/work/exante/tools/xnt-seed agent-run 'lr'"},
			11: {"bash", "/usr/local/bin/agent-run", "lr", "--claude", "--ge", "--start"},
			12: {"/home/dms/.local/bin/.claude-real", "--append-system-prompt", "…"},
		},
		kids: map[int][]int{10: {11}, 11: {12}},
		env:  map[int]map[string]string{11: {"AGENT_COMMAND": "/home/dms/work/exante/tools/xnt-seed"}},
	}
	for _, stamp := range []string{"yolo", "custom:b9"} {
		if got := LiveKind(liveButtons, p, stamp, start, 10); got != stamp {
			t.Errorf("project launcher under %q: got %q", stamp, got)
		}
	}
}

func TestLiveKindDoesNotReadTheAgentsOwnTools(t *testing.T) {
	// A W session that asks Gemini for a second opinion runs gemini-safe as its
	// own child. That is the agent's tool, not the agent: the walk stops at the
	// first program that is not a shell.
	p := fakeProcs{
		argv: map[int][]string{
			10: {"bash", "/home/dms/.cache/claude-relay/ac64.sh"},
			11: {"/home/dms/.local/bin/.claude-real", "--dangerously-skip-permissions"},
			12: {"/bin/bash", "-c", "gemini-safe -p 'second opinion'"},
			13: {"bash", "/usr/local/bin/gemini-safe", "-p", "second opinion"},
		},
		kids: map[int][]int{10: {11}, 11: {12}, 12: {13}},
	}
	if got := LiveKind(liveButtons, p, "yolo", relayStart, 10); got != "yolo" {
		t.Errorf("agent's own tool relabelled the tab: got %q, want yolo", got)
	}
	// A start command that already names the agent is not second-guessed.
	start := `"env AGENT_COMMAND=claude-glm-safe agent-run --dangerously-skip-permissions"`
	if got := LiveKind(liveButtons, p, "custom:b11", start, 10); got != "custom:b11" {
		t.Errorf("start naming an agent was overridden: got %q", got)
	}
	// No pid (an older line, a session that is gone): the stamp as it was.
	if got := LiveKind(liveButtons, p, "custom", relayStart, 0); got != "custom" {
		t.Errorf("no pid: got %q", got)
	}
}
