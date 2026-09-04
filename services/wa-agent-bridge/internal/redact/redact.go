// Package redact provides loggable stand-ins for WhatsApp message content.
package redact

import (
	"fmt"
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

// JID returns j unchanged. JIDs are safe to log; this function exists purely
// so call sites are uniform and greppable — every logged field goes through
// redact.*, making a future leaked-body bug a one-line grep away instead of
// an audit of every log.Info call.
func JID(j string) string {
	return j
}
