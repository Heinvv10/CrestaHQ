// Stub — see publish/README.md. Neutralised webinar offer (LeadStack-only
// marketing content). Same shape as the real export so anything importing it
// still type-checks; the /founderx page + its components are stubbed too.
export const WEBINAR_OFFER = {
  dealName: "",
  couponCode: "",
  creditUsd: 0,
  dealPrice: 0,
  afterCodePrice: 0,
  retailPrice: 0,
  bonuses: [] as { label: string; title: string; body: string; value: string }[],
} as const;
