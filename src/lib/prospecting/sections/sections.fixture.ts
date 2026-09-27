import type { ProspectReportInput } from "@/types";

/** Invented business; 555-style number, example.com addresses only. */
export const BUSINESS: ProspectReportInput = {
  name: "Fixture Plumbing (Pty) Ltd",
  phone: "+27 41 555 0100",
  address: "1 Test Street, Gqeberha",
  website: "https://www.fixture-plumbing.example.com/",
  placeId: "ChIJfixture000",
  rating: 4.6,
  reviewsCount: 37,
  category: "Plumber",
  countryCode: null,
  city: "Gqeberha",
};

/** A homepage with every lead-capture route and a full tech stack. */
export const RICH_HOMEPAGE = `<!doctype html><html><head>
<meta name="generator" content="WordPress 6.6">
<link rel="stylesheet" href="/wp-content/themes/x/style.css">
<script async src="https://www.googletagmanager.com/gtag/js?id=G-FIXTURE"></script>
<script src="https://connect.facebook.net/en_US/fbevents.js"></script>
<script src="https://embed.tawk.to/fixture/default"></script>
</head><body>
<a href="https://wa.me/27415550100">WhatsApp us</a>
<a href="tel:+27415550100">041 555 0100</a>
<a href="https://calendly.com/fixture-plumbing/visit">Book a visit</a>
<a href="https://www.facebook.com/FixturePlumbing/">Facebook</a>
<form action="/contact" method="post"><input name="email"><textarea name="msg"></textarea></form>
</body></html>`;

/** A bare brochure page: nothing to capture a lead, no analytics. */
export const BARE_HOMEPAGE = `<!doctype html><html><head><title>Fixture Plumbing</title></head>
<body><h1>Fixture Plumbing</h1><p>Call 041 555 0100 for a quote.</p></body></html>`;

/** Places Details (New) with every scored field present. */
export const FULL_DETAILS = {
  id: "ChIJfixture000",
  businessStatus: "OPERATIONAL",
  nationalPhoneNumber: "041 555 0100",
  regularOpeningHours: {
    openNow: true,
    weekdayDescriptions: ["Monday: 8:00 AM – 5:00 PM", "Tuesday: 8:00 AM – 5:00 PM"],
  },
  photos: [{ name: "places/ChIJfixture000/photos/p1", widthPx: 800, heightPx: 600 }],
};

/** Places Details for a bare profile: no hours, photos or phone. */
export const BARE_DETAILS = { id: "ChIJfixture000", businessStatus: "OPERATIONAL" };

const FILLER = "<p>" + "Local trade directory listing results. ".repeat(20) + "</p>";

/** A directory result page listing the business with its number. */
export const DIRECTORY_HIT = `<html><body>${FILLER}
<div class="result"><h2>Fixture Plumbing</h2><span>(041) 555-0100</span></div></body></html>`;

/** A directory result page for other businesses only. */
export const DIRECTORY_MISS = `<html><body>${FILLER}
<div class="result"><h2>Other Drains</h2><span>041 555 0199</span></div></body></html>`;

/** A client-rendered shell: no visible text to judge. */
export const DIRECTORY_SHELL = `<html><body><div id="root"></div><script src="/app.js"></script></body></html>`;
