// Package wa wraps the WhatsApp socket. The interface exists so that every
// layer above it — the queue, the API, the rails — is testable without a
// WhatsApp connection.
package wa

import (
	"context"

	"github.com/Heinvv10/CrestaHQ/services/wa-agent-bridge/rails"
)

type Transport interface {
	// Send delivers text to jid and returns the provider message id.
	//
	// media is nil for a plain text message. When it is set, text becomes the
	// attachment's caption. It is a parameter rather than a second SendMedia
	// method because everything above it — the queue's pacing, its
	// serialisation, its timeout and drain handling — must apply identically
	// to an attachment; a parallel method is a parallel path that would
	// eventually stop matching.
	//
	// The type comes from rails, the one package here that imports nothing but
	// the standard library. It means the value the rails evaluated is the same
	// value that goes on the socket, with no second descriptor to keep in step.
	Send(ctx context.Context, jid, text string, media *rails.Media) (string, error)
	Connected() bool
}
