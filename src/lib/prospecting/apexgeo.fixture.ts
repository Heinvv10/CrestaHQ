/**
 * Recorded ApexGEO v1 scan responses. The completed payload is ApexGEO's
 * production live proof (`docs/api/scans-live-proof-2026-09-25.json` in the
 * ApexGEO repo), with the business, its URL and the competitor names
 * replaced by example names. Everything else — shapes, nulls, the Perplexity
 * `insufficient_quota` error on every prompt — is as recorded.
 */

const QUOTA_ERROR =
  'API error: {"error":{"message":"You exceeded your current quota, add credits at https://console.perplexity.ai/project/billing.","type":"insufficient_quota","code":401}}\n';

interface Engine {
  key: string;
  error: string | null;
  model: string;
  position: number | null;
  cited_url: string | null;
  mentioned: boolean;
  competitors_named: string[];
}

const engine = (key: string, model: string, over: Partial<Engine> = {}): Engine => ({
  key,
  error: null,
  model,
  position: null,
  cited_url: null,
  mentioned: false,
  competitors_named: [],
  ...over,
});

const perplexityDown = engine("perplexity", "sonar", { error: QUOTA_ERROR });

export function completedScan() {
  return {
    id: "scan_fixture_1",
    status: "completed",
    url: "https://www.example-plumbers.test/",
    created_at: "2026-09-25T04:28:50.765Z",
    completed_at: "2026-09-25T04:29:37.860Z",
    credits_charged: 7,
    technical: {
      https: true,
      issues: [
        {
          id: "lxvylzewjja9zn58ksrrtg98",
          title: "No FAQ Schema Found",
          impact: "Could improve visibility in AI responses by 5-15%",
          category: "schema",
          severity: "high",
          description: "Pages lack FAQPage structured data",
          recommendation: "Add FAQPage JSON-LD.",
        },
      ],
      overall_score: 78,
      category_scores: [
        { key: "structure", score: 100 },
        { key: "schema", score: 45 },
        { key: "clarity", score: 69 },
        { key: "metadata", score: 87 },
        { key: "accessibility", score: 100 },
      ],
      core_web_vitals: { cls: 0, fcp_ms: 2292, lcp_ms: 6204, tbt_ms: 1166, speed_index_ms: 6024 },
      mobile_viewport: true,
      js_rendering_error: null,
      core_web_vitals_error: null,
      mobile_viewport_error: null,
      js_rendering_dependent: false,
    },
    ai_readiness: {
      robots: {
        GPTBot: "allowed",
        Bingbot: "allowed",
        ClaudeBot: "allowed",
        PerplexityBot: "allowed",
        "Google-Extended": "allowed",
      },
      robots_txt: "found",
      robots_error: null,
      schema_types_found: ["WebPage", "ImageObject", "BreadcrumbList", "WebSite", "Organization"],
      local_business_schema: false,
    },
    ai_visibility: {
      prompts: [
        {
          text: "best plumber in Exampletown",
          engines: [
            engine("gemini", "gemini-2.5-flash", {
              competitors_named: ["Alpha Plumbing", "Beta Drains", "Gamma Plumbing Exampletown"],
            }),
            perplexityDown,
            engine("chatgpt", "gpt-4o-mini"),
          ],
        },
        {
          text: "plumber near me in Exampletown, who should I call",
          engines: [
            engine("gemini", "gemini-2.5-flash", { competitors_named: ["Delta Plumbquick"] }),
            perplexityDown,
            engine("chatgpt", "gpt-4o-mini"),
          ],
        },
        {
          text: "recommended plumber Exampletown reviews",
          engines: [
            engine("gemini", "gemini-2.5-flash", {
              competitors_named: ["Alpha Plumbing", "Beta Drains", "Epsilon Electrical", "Zeta Plumbing"],
            }),
            perplexityDown,
            engine("chatgpt", "gpt-4o-mini"),
          ],
        },
      ],
      summary: {
        of: 6,
        mentioned_in: 0,
        share_of_voice: [{ name: "Beta Drains", count: 2, is_target: false }],
      },
    },
    error: null,
  };
}

/** The same scan with every engine answering in error. */
export function allEnginesErrored() {
  const scan = completedScan();
  for (const p of scan.ai_visibility.prompts) {
    p.engines = p.engines.map((e) => ({ ...e, error: e.error ?? "API error: timeout", competitors_named: [] }));
  }
  return scan;
}

export const RESPONSES = {
  started: { status: 202, body: { data: { id: "scan_fixture_1", status: "queued", credits_reserved: 7 } } },
  replayed: {
    status: 200,
    body: { data: { id: "scan_fixture_1", status: "completed", credits_reserved: 7, replayed: true } },
  },
  insufficientCredits: {
    status: 409,
    body: {
      error: {
        code: "insufficient_credits",
        message: "This scan needs 7 credits; 2 are available.",
        docs_url: "https://apex.dev/api/docs#errors-insufficient_credits",
      },
    },
  },
  conflict: {
    status: 409,
    body: {
      error: {
        code: "conflict",
        message: 'external_ref "r1" already names a scan of a different target.',
        docs_url: "https://apex.dev/api/docs#errors-conflict",
      },
    },
  },
  invalid: {
    status: 400,
    body: {
      error: {
        code: "invalid_request",
        message: "city: Too small: expected string to have >=1 characters",
        docs_url: "https://apex.dev/api/docs#errors-invalid_request",
      },
    },
  },
  unauthorized: {
    status: 401,
    body: {
      error: {
        code: "unauthorized",
        message: "Missing or invalid credentials. Provide a Bearer API key or sign-in cookie.",
        docs_url: "https://apex.dev/api/docs#auth",
      },
    },
  },
  notFound: {
    status: 404,
    body: {
      error: {
        code: "not_found",
        message: 'Scan "scan_other_org" not found.',
        docs_url: "https://apex.dev/api/docs#errors-not_found",
      },
    },
  },
  serverError: {
    status: 500,
    body: {
      error: { code: "internal_error", message: "Internal error", docs_url: "https://apex.dev/api/docs#errors-internal_error" },
    },
  },
} as const;
