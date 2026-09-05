// Package redact provides loggable stand-ins for WhatsApp message content.
package redact

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// Body returns a loggable stand-in for a WhatsApp message body.
//
// Message bodies must never reach a log file: this service runs on a VPS
// whose logs are not access-controlled, while the bodies themselves belong in
// Firestore where they are. Length is kept because it is the one property
// worth debugging with (a zero-length send is a real bug class) and it
// discloses nothing. It lives in its own package so every caller — this
// service's main package today, an api package later — shares the one
// definition instead of each defining its own and drifting apart.
func Body(s string) string {
	return fmt.Sprintf("<%d chars>", utf8.RuneCountInString(s))
}

// JID masks all but the last 4 digits of the phone number in j, keeping the
// value stable and greppable for debugging without disclosing the number it
// embeds. A WhatsApp JID (e.g. "27821234567@s.whatsapp.net") is the
// customer's phone number, and this service runs on a VPS whose logs are not
// access-controlled — the same reason Body is masked — so under POPIA it
// counts as personal information and must not be logged in full.
func JID(j string) string {
	user, server, hasServer := strings.Cut(j, "@")
	if hasServer {
		server = "@" + server
	}
	if len(user) <= 4 {
		return strings.Repeat("*", len(user)) + server
	}
	return strings.Repeat("*", len(user)-4) + user[len(user)-4:] + server
}
