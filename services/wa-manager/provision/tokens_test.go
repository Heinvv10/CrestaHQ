package provision

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Heinvv10/CrestaHQ/services/wa-manager/store"
)

func TestNewTokenIsLongAndUnique(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		tok := NewToken()
		if len(tok) < 32 {
			t.Fatalf("a token that can send as a WhatsApp number must not be guessable; got %d chars", len(tok))
		}
		// The token is written into a pipe-separated, comma-separated,
		// newline-separated .env line. A separator inside it would silently
		// split one credential into two fields.
		if strings.ContainsAny(tok, "|,\n\r= ") {
			t.Fatalf("token %q contains a separator used by the .env format", tok)
		}
		if seen[tok] {
			t.Fatalf("token collision after %d draws: %q", i, tok)
		}
		seen[tok] = true
	}
}

// The reader's whole job is to agree with renderEnv. This drives a REAL
// provisioned instance rather than a hand-written fixture, so the two cannot
// drift: change the .env format and this goes red.
func TestManagerTokenForReadsWhatCreateWrote(t *testing.T) {
	const testAppToken, testManagerToken = "app-tok-fixed", "mgr-tok-fixed"
	root := t.TempDir()
	st, err := store.Open(filepath.Join(root, "mgr.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	p := New(st, newFakeCtl(), Opts{
		Root: root, PortBase: 33100, PortCount: 20,
		AppToken:     func() string { return testAppToken },
		ManagerToken: func() string { return testManagerToken },
		WebhookURL:   func(id string) string { return "http://127.0.0.1:8787/wa/" + id },
	})

	if _, err := p.Create("acme", "Acme"); err != nil {
		t.Fatal(err)
	}
	ts := TokenSource{Root: root}
	got, err := ts.ForInstance("acme")
	if err != nil {
		t.Fatalf("the manager must be able to recover its own admin token: %v", err)
	}
	if got != testManagerToken {
		t.Fatalf("read back %q, want the token Create wrote (%q)", got, testManagerToken)
	}
	// And never the app's — the app consumer is not admin, so presenting it
	// would silently lose the manager the two verbs it exists to perform.
	if got == testAppToken {
		t.Fatal("the reader returned the APP token; the manager would lose its admin privileges")
	}
}

// A missing or unreadable .env must be an ERROR, not an empty string. An empty
// token presented to a bridge is a 401 that reads like the bridge refusing the
// operator, sending them to debug the wrong service.
func TestManagerTokenForFailsLoudlyWhenThereIsNoEnv(t *testing.T) {
	ts := TokenSource{Root: t.TempDir()}
	if _, err := ts.ForInstance("nope"); err == nil {
		t.Fatal("a missing .env must be an error, not an empty token")
	}
}

func TestManagerTokenForFailsWhenTheEnvHasNoManagerConsumer(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "acme")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	const env = "LISTEN_ADDR=127.0.0.1:1\nCONSUMERS=app|tok-app|http://x|100|500\n"
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte(env), 0o600); err != nil {
		t.Fatal(err)
	}
	ts := TokenSource{Root: root}
	if _, err := ts.ForInstance("acme"); err == nil {
		t.Fatal("an .env with no manager consumer must be an error, not an empty token")
	}
}

// The instance name reaches a filesystem path. Anything that could climb out
// of the root is refused here as well as at the API boundary — this reader is
// callable from anywhere in the process.
func TestManagerTokenForRefusesAnUnsafeInstanceName(t *testing.T) {
	for _, bad := range []string{"../../etc", "a/b", "", "A-CAPITAL", "-leading"} {
		ts := TokenSource{Root: t.TempDir()}
		if _, err := ts.ForInstance(bad); err == nil {
			t.Fatalf("instance %q reaches a filesystem path and must be refused", bad)
		}
	}
}
