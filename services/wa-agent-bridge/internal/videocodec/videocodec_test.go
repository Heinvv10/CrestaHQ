package videocodec

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fixtureDir holds the real MP4s the TypeScript inspector is tested against
// too (see generate.sh there). Read by relative path, never copied, so the two
// rules cannot drift on a real file without one suite going red.
var fixtureDir = filepath.Join("..", "..", "..", "..", "src", "lib", "comms", "whatsapp", "__fixtures__", "video")

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(fixtureDir, name))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	return b
}

func topLevel(t *testing.T, b []byte, typ string) int {
	t.Helper()
	for at := 0; at+8 <= len(b); at += int(binary.BigEndian.Uint32(b[at:])) {
		if string(b[at+4:at+8]) == typ {
			return at
		}
	}
	t.Fatalf("no top-level %s", typ)
	return 0
}

func mkbox(typ string, payload []byte) []byte {
	out := make([]byte, 8, 8+len(payload))
	binary.BigEndian.PutUint32(out, uint32(8+len(payload)))
	copy(out[4:], typ)
	return append(out, payload...)
}

func wantAllowed(t *testing.T, name string, b []byte) {
	t.Helper()
	if r := Check(b); r != nil {
		t.Fatalf("%s: want allowed, got %+v", name, *r)
	}
}

func wantRefused(t *testing.T, name string, b []byte, code string) *Refusal {
	t.Helper()
	r := Check(b)
	if r == nil || r.Code != code {
		t.Fatalf("%s: want refusal %s, got %+v", name, code, r)
	}
	return r
}

func TestRealFilesAllowed(t *testing.T) {
	for _, name := range []string{"h264-aac-faststart.mp4", "h264-aac-moov-at-end.mp4", "h264-no-audio.mp4"} {
		wantAllowed(t, name, fixture(t, name))
	}
}

func TestHEVCRefusedByName(t *testing.T) {
	for _, name := range []string{"hevc-hvc1-aac.mp4", "hevc-hev1-aac.mp4"} {
		r := wantRefused(t, name, fixture(t, name), CodeUnsupported)
		want := "This video is HEVC (H.265), which WhatsApp can't play. Export it as H.264 MP4 and try again."
		if r.Message != want {
			t.Fatalf("%s: message %q, want %q", name, r.Message, want)
		}
	}
}

func TestOpusAudioRefused(t *testing.T) {
	r := wantRefused(t, "opus", fixture(t, "h264-opus.mp4"), CodeUnsupported)
	if !strings.Contains(r.Message, `sound is "Opus"`) {
		t.Fatalf("message does not name the audio codec: %q", r.Message)
	}
}

// mp4a holding MP3 is not AAC, including when only the SECOND audio track is.
func TestMP3InMp4aRefused(t *testing.T) {
	want := "This video's sound is MP3, which WhatsApp can't play. Export it with AAC audio and try again."
	for _, name := range []string{"h264-mp3.mp4", "h264-aac-then-mp3.mp4"} {
		if r := wantRefused(t, name, fixture(t, name), CodeUnsupported); r.Message != want {
			t.Fatalf("%s: message %q, want %q", name, r.Message, want)
		}
	}
}

// esdsOti locates the first esds and its OTI byte. ffmpeg writes 4-byte
// expandable sizes: FullBox(4) · 0x03 size(4) ES_ID(2) flags(1) · 0x04 size(4) · OTI.
func esdsOti(t *testing.T, b []byte) (esds, oti int) {
	t.Helper()
	esds = bytes.Index(b, []byte("esds"))
	if esds < 0 || b[esds+8] != 0x03 || b[esds+16] != 0x04 {
		t.Fatal("fixture esds layout changed")
	}
	return esds, esds + 21
}

func TestAACObjectTypeIndications(t *testing.T) {
	for oti, allowed := range map[byte]bool{0x40: true, 0x66: true, 0x67: true, 0x68: true, 0x69: false, 0x6b: false, 0x20: false} {
		b := bytes.Clone(fixture(t, "h264-aac-faststart.mp4"))
		_, at := esdsOti(t, b)
		b[at] = oti
		if got := Check(b) == nil; got != allowed {
			t.Fatalf("OTI 0x%02x: allowed=%v, want %v (%+v)", oti, got, allowed, Check(b))
		}
	}
	b := bytes.Clone(fixture(t, "h264-aac-faststart.mp4"))
	_, at := esdsOti(t, b)
	b[at] = 0x20
	if r := Check(b); r == nil || !strings.Contains(r.Message, "not AAC (object type 0x20)") {
		t.Fatalf("an unknown OTI is not named: %+v", r)
	}
}

func TestMissingOrBrokenEsdsRefused(t *testing.T) {
	noEsds := bytes.Clone(fixture(t, "h264-aac-faststart.mp4"))
	esds, _ := esdsOti(t, noEsds)
	copy(noEsds[esds:], "xxxx")
	wantRefused(t, "no esds", noEsds, CodeUnsupported)

	for name, size := range map[string][]byte{
		"descriptor size overruns esds": {0xff, 0xff, 0xff, 0x7f},
		"expandable size needs 5 bytes": {0x80, 0x80, 0x80, 0x80},
	} {
		b := bytes.Clone(fixture(t, "h264-aac-faststart.mp4"))
		esds, _ := esdsOti(t, b)
		copy(b[esds+9:], size)
		wantRefused(t, name, b, CodeUnsupported)
	}
}

func TestTrailingPaddingToleratedAtTopLevelOnly(t *testing.T) {
	src := fixture(t, "h264-aac-faststart.mp4")
	for _, n := range []int{1, 7} {
		wantAllowed(t, fmt.Sprintf("%d trailing bytes", n), append(bytes.Clone(src), make([]byte, n)...))
	}
	// Three junk bytes inside moov, after its last child: must stay strict.
	moov := topLevel(t, src, "moov")
	moovEnd := moov + int(binary.BigEndian.Uint32(src[moov:]))
	nested := bytes.Join([][]byte{src[:moovEnd], {0, 0, 0}, src[moovEnd:]}, nil)
	binary.BigEndian.PutUint32(nested[moov:], uint32(moovEnd-moov+3))
	wantRefused(t, "trailing bytes inside moov", nested, CodeUnreadable)
}

func TestUnreadableRefusedWithoutPanic(t *testing.T) {
	for _, name := range []string{"garbage.mp4", "truncated.mp4"} {
		wantRefused(t, name, fixture(t, name), CodeUnreadable)
	}
	wantRefused(t, "empty", nil, CodeUnreadable)
}

// The pair that proves boxes are parsed rather than bytes scanned.
func TestCodecBytesInsideMdatAreIgnored(t *testing.T) {
	h264 := fixture(t, "h264-with-hevc-bytes-in-mdat.mp4")
	if !bytes.Contains(h264, []byte("hvc1")) {
		t.Fatal("fixture lost its decoy")
	}
	wantAllowed(t, "h264 with hvc1 in mdat", h264)

	hevc := fixture(t, "hevc-with-avc1-bytes-in-mdat.mp4")
	if !bytes.Contains(hevc, []byte("avc1")) {
		t.Fatal("fixture lost its decoy")
	}
	wantRefused(t, "hevc with avc1 in mdat", hevc, CodeUnsupported)
}

// free(8) + mdat header(8) rewritten as one 16-byte largesize mdat header:
// same length, so every chunk offset still holds.
func TestLargesizeHeaderFollowed(t *testing.T) {
	b := bytes.Clone(fixture(t, "h264-aac-moov-at-end.mp4"))
	free := topLevel(t, b, "free")
	if string(b[free+12:free+16]) != "mdat" {
		t.Fatal("fixture layout changed: mdat does not follow free")
	}
	mdatSize := binary.BigEndian.Uint32(b[free+8:])
	binary.BigEndian.PutUint32(b[free:], 1)
	copy(b[free+4:], "mdat")
	binary.BigEndian.PutUint64(b[free+8:], uint64(8+mdatSize))
	wantAllowed(t, "largesize mdat", b)
}

func TestSizeZeroRunsToEndOfFile(t *testing.T) {
	b := bytes.Clone(fixture(t, "h264-aac-faststart.mp4"))
	binary.BigEndian.PutUint32(b[topLevel(t, b, "mdat"):], 0)
	wantAllowed(t, "size-0 mdat", b)
}

func TestHostileStructureRefusedAndBounded(t *testing.T) {
	oversize := bytes.Clone(fixture(t, "h264-aac-faststart.mp4"))
	binary.BigEndian.PutUint32(oversize[topLevel(t, oversize, "moov"):], 0x7fffffff)
	wantRefused(t, "box larger than buffer", oversize, CodeUnreadable)

	tiny := make([]byte, 16)
	binary.BigEndian.PutUint32(tiny, 4)
	wantRefused(t, "size below header", tiny, CodeUnreadable)

	large := make([]byte, 32)
	binary.BigEndian.PutUint32(large, 1)
	copy(large[4:], "moov")
	binary.BigEndian.PutUint64(large[8:], 1<<63)
	wantRefused(t, "largesize beyond buffer", large, CodeUnreadable)

	var inner []byte
	for i := 0; i < 5000; i++ {
		inner = mkbox("trak", inner)
	}
	wantRefused(t, "deeply nested trak", bytes.Join([][]byte{mkbox("ftyp", make([]byte, 8)), mkbox("moov", inner), mkbox("mdat", []byte{0})}, nil), CodeUnreadable)

	moov := mkbox("moov", nil)
	wantRefused(t, "two moov", append(bytes.Clone(moov), moov...), CodeUnreadable)

	many := bytes.Repeat(mkbox("free", nil), 200000)
	started := time.Now()
	wantRefused(t, "200k empty boxes", many, CodeUnreadable)
	if d := time.Since(started); d > time.Second {
		t.Fatalf("box budget did not bound the walk: %v", d)
	}
}

// Every prefix of a real file must be answered, never panic.
func TestEveryTruncationIsSafe(t *testing.T) {
	b := fixture(t, "h264-aac-faststart.mp4")
	for n := 0; n < len(b); n++ {
		if r := Check(b[:n]); r == nil {
			t.Fatalf("a %d-byte prefix of a %d-byte file was allowed", n, len(b))
		}
	}
}

// Two direct esds (MP3) plus wave{esds(AAC)} is ambiguous and must be refused
// as unconfirmed, the same as the TS inspector. This once fell back to wave
// whenever finding exactly one esds failed, so Go allowed what TS refused.
func TestTwoEsdsDoNotFallBackToWave(t *testing.T) {
	const name = "mp3-esds-twice-aac-in-wave.mp4"
	want := "This video's sound couldn't be confirmed as AAC, which is all WhatsApp plays. Export it with AAC audio and try again."
	if r := wantRefused(t, name, fixture(t, name), CodeUnsupported); r.Message != want {
		t.Fatalf("%s: message %q, want %q", name, r.Message, want)
	}
}
