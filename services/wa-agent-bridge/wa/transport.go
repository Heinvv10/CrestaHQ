// Package wa wraps the WhatsApp socket. The interface exists so that every
// layer above it — the queue, the API, the rails — is testable without a
// WhatsApp connection.
package wa

import "context"

type Transport interface {
	// Send delivers text to jid and returns the provider message id.
	Send(ctx context.Context, jid, text string) (string, error)
	Connected() bool
}
