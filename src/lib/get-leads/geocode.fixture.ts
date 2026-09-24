/**
 * Hand-written fixtures in the documented Google Geocoding API
 * (`/maps/api/geocode/json`) response shape. Coordinates are approximate
 * public town centres; nothing here is a real business or person.
 */

export const GEOCODE_OK = {
  status: "OK",
  results: [
    {
      formatted_address: "Gqeberha, South Africa",
      geometry: { location: { lat: -33.9608, lng: 25.6022 } },
      place_id: "ChIJgeocodeFixture01",
    },
    {
      formatted_address: "Gqeberha Central, Gqeberha, South Africa",
      geometry: { location: { lat: -33.96, lng: 25.61 } },
    },
  ],
};

export const GEOCODE_ZERO_RESULTS = { status: "ZERO_RESULTS", results: [] };

export const GEOCODE_OVER_QUERY_LIMIT = {
  status: "OVER_QUERY_LIMIT",
  error_message: "You have exceeded your daily request quota for this API.",
  results: [],
};

export const GEOCODE_OVER_DAILY_LIMIT = {
  status: "OVER_DAILY_LIMIT",
  error_message: "Billing is not enabled or the daily limit was exceeded.",
  results: [],
};

export const GEOCODE_REQUEST_DENIED = {
  status: "REQUEST_DENIED",
  error_message: "This API project is not authorized to use this API.",
  results: [],
};
