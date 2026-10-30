/**
 * Technology fingerprints for the homepage HTML (tech_stack and lead_capture
 * share this table).
 *
 * These rules are ORIGINAL, written for this codebase. They follow the
 * categories of the open-source Wappalyzer rule set (CMS, analytics, chat,
 * booking…) but copy none of its rule text: that set is GPL-licensed and this
 * repo is sold as a white-label template, so GPL text cannot be vendored here.
 *
 * Matching is plain `includes()` on the lower-cased HTML — linear time, no
 * regex, so an owner-controlled page cannot make detection backtrack. Every
 * pattern must be lower-case. A rule matches when ANY of its patterns occurs.
 */

export type TechCategory =
  | "cms"
  | "analytics"
  | "ads_pixel"
  | "chat"
  | "booking"
  | "cdn"
  | "framework";

export interface TechRule {
  name: string;
  category: TechCategory;
  patterns: string[];
}

export const TECH_RULES: TechRule[] = [
  // CMS / site builders
  { name: "WordPress", category: "cms", patterns: ["/wp-content/", "/wp-includes/", 'content="wordpress'] },
  { name: "Wix", category: "cms", patterns: ["static.wixstatic.com", "static.parastorage.com", 'content="wix.com'] },
  { name: "Squarespace", category: "cms", patterns: ["static1.squarespace.com", "squarespace-cdn.com"] },
  { name: "Shopify", category: "cms", patterns: ["cdn.shopify.com", "shopify.theme"] },
  { name: "Webflow", category: "cms", patterns: ["data-wf-page", "assets.website-files.com", "cdn.prod.website-files.com"] },
  { name: "Joomla", category: "cms", patterns: ['content="joomla', "/media/jui/"] },
  { name: "Drupal", category: "cms", patterns: ['content="drupal', "/sites/default/files/", "drupal-settings-json"] },
  { name: "GoDaddy Website Builder", category: "cms", patterns: ["img1.wsimg.com", 'content="go daddy website builder', "godaddy website builder"] },
  { name: "Weebly", category: "cms", patterns: ["editmysite.com", "weebly.com/weebly/"] },
  { name: "Duda", category: "cms", patterns: ["irp.cdn-website.com", "dudamobile.com", "multiscreensite.com"] },
  { name: "Jimdo", category: "cms", patterns: ["jimdo.com", "jimstatic.com"] },
  { name: "Framer", category: "cms", patterns: ["framerusercontent.com", 'content="framer'] },
  { name: "Google Sites", category: "cms", patterns: ["sites.google.com/", "ssl.gstatic.com/atari/"] },
  { name: "HubSpot CMS", category: "cms", patterns: ["hs-sites.com", "hubspotusercontent"] },

  // Analytics / tag management
  { name: "Google Analytics", category: "analytics", patterns: ["googletagmanager.com/gtag/js", "google-analytics.com/analytics.js", "google-analytics.com/ga.js"] },
  { name: "Google Tag Manager", category: "analytics", patterns: ["googletagmanager.com/gtm.js", "googletagmanager.com/ns.html"] },
  { name: "Microsoft Clarity", category: "analytics", patterns: ["clarity.ms/tag"] },
  { name: "Hotjar", category: "analytics", patterns: ["static.hotjar.com", "hotjar.com/c/hotjar-"] },
  { name: "Plausible", category: "analytics", patterns: ["plausible.io/js"] },
  { name: "Matomo", category: "analytics", patterns: ["matomo.js", "piwik.js"] },

  // Ad / retargeting pixels
  { name: "Meta Pixel", category: "ads_pixel", patterns: ["fbevents.js", "facebook.com/tr?id="] },
  { name: "Google Ads", category: "ads_pixel", patterns: ["googleadservices.com/pagead/conversion", "gtag/js?id=aw-"] },
  { name: "TikTok Pixel", category: "ads_pixel", patterns: ["analytics.tiktok.com"] },
  { name: "LinkedIn Insight", category: "ads_pixel", patterns: ["snap.licdn.com/li.lms-analytics"] },

  // Live chat widgets
  { name: "Tawk.to", category: "chat", patterns: ["embed.tawk.to"] },
  { name: "Intercom", category: "chat", patterns: ["widget.intercom.io", "js.intercomcdn.com"] },
  { name: "Drift", category: "chat", patterns: ["js.driftt.com", "drift.com/include"] },
  { name: "Crisp", category: "chat", patterns: ["client.crisp.chat"] },
  { name: "Tidio", category: "chat", patterns: ["code.tidio.co"] },
  { name: "LiveChat", category: "chat", patterns: ["cdn.livechatinc.com"] },
  { name: "Zendesk Chat", category: "chat", patterns: ["static.zdassets.com", "v2.zopim.com"] },
  { name: "HubSpot Chat", category: "chat", patterns: ["js.usemessages.com"] },
  { name: "Facebook Messenger chat", category: "chat", patterns: ["xfbml.customerchat", "fb-customerchat"] },
  { name: "Freshchat", category: "chat", patterns: ["wchat.freshchat.com"] },

  // Online booking
  { name: "Calendly", category: "booking", patterns: ["calendly.com/"] },
  { name: "Acuity Scheduling", category: "booking", patterns: ["acuityscheduling.com"] },
  { name: "SimplyBook.me", category: "booking", patterns: ["simplybook.me", "simplybook.it"] },
  { name: "Setmore", category: "booking", patterns: ["setmore.com"] },
  { name: "Booksy", category: "booking", patterns: ["booksy.com"] },
  { name: "Fresha", category: "booking", patterns: ["fresha.com"] },
  { name: "Square Appointments", category: "booking", patterns: ["squareup.com/appointments", "square.site/book"] },
  { name: "Timely", category: "booking", patterns: ["gettimely.com"] },
  { name: "Google Calendar booking", category: "booking", patterns: ["calendar.google.com/calendar/appointments", "calendar.app.google/"] },

  // Infrastructure / frameworks
  { name: "Cloudflare", category: "cdn", patterns: ["/cdn-cgi/", "cdnjs.cloudflare.com"] },
  { name: "jQuery", category: "framework", patterns: ["jquery.min.js", "jquery.js", "/jquery-"] },
  { name: "Next.js", category: "framework", patterns: ["/_next/static/", "__next_data__"] },
  { name: "React", category: "framework", patterns: ["data-reactroot", "react-dom.production.min.js"] },
];

/** Every rule that matches the page, in table order. */
export function detectTech(html: string): TechRule[] {
  const page = html.toLowerCase();
  return TECH_RULES.filter((rule) => rule.patterns.some((p) => page.includes(p)));
}
