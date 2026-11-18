package session

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Procs is what LiveKind reads of the running processes: /proc on a host, a
// fixed tree in a test.
type Procs interface {
	Argv(pid int) []string
	Children(pid int) []int
	Env(pid int, key string) string
}

// ProcFS reads the processes of this host from /proc. Only the owner's own are
// readable, and only as far as they let themselves be: Claude Code makes itself
// non-dumpable, so its environment is closed even to the same user — which is
// why the walk reads the wrappers in front of it and never the agent.
type ProcFS struct{}

func (ProcFS) Argv(pid int) []string {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/cmdline")
	if err != nil || len(b) == 0 {
		return nil
	}
	return strings.Split(strings.TrimRight(string(b), "\x00"), "\x00")
}

func (ProcFS) Children(pid int) []int {
	p := strconv.Itoa(pid)
	b, err := os.ReadFile("/proc/" + p + "/task/" + p + "/children")
	if err != nil {
		return nil
	}
	var out []int
	for _, f := range strings.Fields(string(b)) {
		if n, err := strconv.Atoi(f); err == nil {
			out = append(out, n)
		}
	}
	return out
}

func (ProcFS) Env(pid int, key string) string {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/environ")
	if err != nil {
		return ""
	}
	for _, kv := range strings.Split(string(b), "\x00") {
		if v, ok := strings.CutPrefix(kv, key+"="); ok {
			return v
		}
	}
	return ""
}

// LiveKind is MatchStartKind for a pane whose start command names no agent, read
// off what actually runs in it.
//
// The stamp says which button raised the tab, and a tab can be raised by one
// agent for another: claude-relay since 15.11.2026 starts its successor from a
// script file (`exec bash …/claude-relay/<id>.sh`), so the start command says
// nothing and the session keeps whatever stamp the tab had — a GLM successor
// drawn as ⭐ under a bare `custom`, a Gemini one as ❄️ in a Claude tab (ser8,
// 2026-11-18). The wrapper that runs is the answer to "which agent, which
// account"; who started it is not.
//
// Where nothing on the outside says (a project's own launcher behind agent-run,
// exante's xnt-seed), the stamp stands: a guess would be a wrong mark that looks
// exactly like a right one.
func LiveKind(buttons []Custom, procs Procs, kind, start string, pid int) string {
	if a, _, _ := startAgent(start); a != "" || pid <= 0 || procs == nil {
		return MatchStartKind(buttons, kind, start)
	}
	live := liveStart(procs, pid)
	if live == "" {
		return MatchStartKind(buttons, kind, start)
	}
	return MatchStartKind(buttons, kind, live)
}

// Interpreters the walk looks through: a shell running a script, env setting a
// variable, node running an agent written in JavaScript.
var interpreters = map[string]bool{
	"sh": true, "bash": true, "zsh": true, "dash": true, "env": true, "node": true,
}

// liveStart walks the pane's process tree down through shells and returns the
// agent's command line in the form startAgent reads, or "" when the walk meets
// a program that is not an agent (the agent itself behind a wrapper it has
// already been read from, or a launcher nobody can see into).
func liveStart(procs Procs, root int) string {
	queue := []int{root}
	for seen := 0; len(queue) > 0 && seen < 32; seen++ {
		pid := queue[0]
		queue = queue[1:]
		cmd, descend := readProc(procs, pid)
		if cmd != "" {
			return cmd
		}
		if descend {
			queue = append(queue, procs.Children(pid)...)
		}
	}
	return ""
}

// readProc reads one process: the agent command when it is an agent or the
// wrapper of one, and whether its children are worth reading. Only shells are
// looked through, so an agent's own tools (a `gemini-safe -p` for a second
// opinion under a Claude session) never decide its tab.
func readProc(procs Procs, pid int) (string, bool) {
	argv := procs.Argv(pid)
	if len(argv) == 0 {
		return "", false
	}
	i, base := 0, ""
	for i < len(argv) && interpreters[filepath.Base(argv[i])] {
		base = filepath.Base(argv[i])
		i++
		for i < len(argv) {
			a := argv[i]
			if a == "-c" && base != "env" && base != "node" {
				// A shell running a line: the pane's own `bash -c <start>`. The
				// line has been read as the start command already; its children
				// are what it started.
				return "", true
			}
			if a == "-u" && base == "env" {
				i += 2
				continue
			}
			if strings.HasPrefix(a, "-") || (base == "env" && strings.Contains(a, "=")) {
				i++
				continue
			}
			break
		}
	}
	if i >= len(argv) {
		return "", false
	}
	prog, args := argv[i], argv[i+1:]
	if filepath.Base(prog) == "agent-run" {
		// The launcher of every agent: what it runs is its AGENT_COMMAND, and
		// none at all is plain Claude. A command that is not an agent (a
		// project's own launcher) ends the walk with no answer.
		ac := procs.Env(pid, "AGENT_COMMAND")
		if ac == "" {
			return words(prog, args), false
		}
		if normAgent(ac) != "" {
			return words(ac, args), false
		}
		return "", false
	}
	if normAgent(prog) != "" {
		return words(prog, args), false
	}
	// A shell script that is not an agent (claude-relay's own) is looked
	// through; a program, node's included, is the end of the branch.
	return "", i > 0 && base != "node" && base != "env"
}

// words joins argv into the space-separated form startAgent reads. A word it
// could split (a prompt with spaces or a semicolon) becomes a placeholder: only
// the flags in front of it are read anyway.
func words(prog string, args []string) string {
	out := []string{prog}
	for _, a := range args {
		if a == "" || strings.ContainsAny(a, " \t\n;\"'") {
			a = "_"
		}
		out = append(out, a)
	}
	return strings.Join(out, " ")
}
