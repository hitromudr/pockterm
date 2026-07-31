// Package tmuxcmd builds tmux invocations; it never runs them.
package tmuxcmd

// Attach returns the argv attaching a web client to its own grouped
// session sharing windows with target. A grouped session gets an
// independent window size, so a phone client does not shrink the
// laptop's view. The trailing set-option makes the grouped session
// self-destroy when its last client detaches; ";" is tmux's command
// separator (a plain argv element, no shell involved). -A makes
// reconnects attach instead of failing on an existing name.
func Attach(target, webSession string) []string {
	return []string{
		"tmux", "new-session", "-A", "-s", webSession, "-t", target,
		";", "set-option", "destroy-unattached", "on",
	}
}

// Bootstrap returns the argv creating the detached target session.
// Empty cmd starts the user's login shell (tmux default), keeping the
// public tool generic; deployments set POCKTERM_BOOTSTRAP.
func Bootstrap(target, cmd string) []string {
	args := []string{"tmux", "new-session", "-d", "-s", target}
	if cmd != "" {
		args = append(args, cmd)
	}
	return args
}

// HasSession returns the probe argv; exit status 0 means the exact
// session exists ("=" disables tmux prefix matching).
func HasSession(target string) []string {
	return []string{"tmux", "has-session", "-t", "=" + target}
}
