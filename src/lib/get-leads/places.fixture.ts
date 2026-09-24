/**
 * Hand-written fixture in the documented Places API (New) `places:searchText`
 * response shape. Every name, phone, address and URL is invented.
 */

export function placesPage(
  places: Record<string, unknown>[],
  nextPageToken?: string,
): Record<string, unknown> {
  return nextPageToken ? { places, nextPageToken } : { places };
}

export const FULL_PLACE = {
  id: "ChIJfixture0001",
  displayName: { text: "Fixture Plumbing Co", languageCode: "en" },
  formattedAddress: "12 Example Rd, Sampletown, Gqeberha, 6001, South Africa",
  addressComponents: [
    { longText: "12", shortText: "12", types: ["street_number"], languageCode: "en" },
    { longText: "Example Road", shortText: "Example Rd", types: ["route"], languageCode: "en" },
    { longText: "Sampletown", shortText: "Sampletown", types: ["sublocality_level_1", "sublocality", "political"], languageCode: "en" },
    { longText: "Gqeberha", shortText: "Gqeberha", types: ["locality", "political"], languageCode: "en" },
    { longText: "Eastern Cape", shortText: "EC", types: ["administrative_area_level_1", "political"], languageCode: "en" },
    { longText: "South Africa", shortText: "ZA", types: ["country", "political"], languageCode: "en" },
  ],
  location: { latitude: -33.9601, longitude: 25.6012 },
  nationalPhoneNumber: "041 000 0000",
  internationalPhoneNumber: "+27 41 000 0000",
  websiteUri: "https://fixture-plumbing.example/",
  rating: 4.6,
  userRatingCount: 37,
  primaryTypeDisplayName: { text: "Plumber", languageCode: "en-US" },
};

/** A listing Google returns with almost nothing on it. */
export const SPARSE_PLACE = {
  id: "ChIJfixture0002",
  displayName: { text: "  " },
  location: { latitude: "not-a-number", longitude: 25.6 },
  rating: "4.1",
};

export function makePlaces(count: number, prefix: string): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    displayName: { text: `Invented Business ${prefix} ${i}` },
    location: { latitude: -33.96, longitude: 25.6 },
  }));
}
