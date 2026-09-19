package wa

import (
	"math"

	"go.mau.fi/whatsmeow/proto/waE2E"
)

// InboundLocation is a location the customer shared (📎 → Location).
//
// The coordinates are customer personal data — usually their home — so no log
// line anywhere in this bridge may carry them. Name, Address and URL are the
// sender's own text; the consumer validates and caps them.
type InboundLocation struct {
	Latitude  float64
	Longitude float64
	Name      string
	Address   string
	URL       string
}

// validCoordinates refuses what is not a point on Earth. It is also what keeps
// the POST alive: encoding/json refuses NaN and ±Inf, and a location that
// failed to marshal would take the whole message down with it.
func validCoordinates(lat, lng float64) bool {
	return !math.IsNaN(lat) && !math.IsNaN(lng) &&
		lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
}

// locationFrom finds a shared location in a message. It returns the location
// (nil when there is none or its coordinates are unusable), any text the
// customer typed with it (a static pin's Comment, a live one's Caption), and whether the message tried to carry one at all.
//
// A LIVE location is taken as its current position only. WhatsApp follows it
// with a stream of updates for the sharing period; those are not followed, so
// the row shows where the customer was when they started sharing.
func locationFrom(m *waE2E.Message) (loc *InboundLocation, caption string, present bool) {
	if m == nil {
		return nil, "", false
	}
	if v := m.GetLocationMessage(); v != nil {
		lat, lng := v.GetDegreesLatitude(), v.GetDegreesLongitude()
		// Comment is what the customer typed with a static pin; it is their
		// message text, exactly as a live location's Caption is.
		if !validCoordinates(lat, lng) {
			return nil, v.GetComment(), true
		}
		return &InboundLocation{lat, lng, v.GetName(), v.GetAddress(), v.GetURL()}, v.GetComment(), true
	}
	if v := m.GetLiveLocationMessage(); v != nil {
		lat, lng := v.GetDegreesLatitude(), v.GetDegreesLongitude()
		if !validCoordinates(lat, lng) {
			return nil, v.GetCaption(), true
		}
		return &InboundLocation{Latitude: lat, Longitude: lng}, v.GetCaption(), true
	}
	return nil, "", false
}
