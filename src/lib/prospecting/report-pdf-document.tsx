import { Circle, Document, Image, Link, Page, StyleSheet, Svg, Text, View } from "@react-pdf/renderer";
import { DETAIL_LABELS, LABELS, STATUS_NOTE, detailText, type SectionRow } from "@/lib/prospecting/report-rows";
import { TRAFFIC_LIGHT, aiQuestions, trafficLight, type ReportStory } from "@/lib/prospecting/report-story";

/**
 * The public report as an A4 PDF (R5): the Story page's blocks in the same
 * order, from the same `ReportStory` the page renders. react-pdf cannot
 * reuse the HTML/SVG components, so this is a second renderer over the same
 * data, not a second copy of the rules. Brand colour on the header bar, the
 * numbers and the CTA; the traffic-light colours are fixed.
 */

const INK = "#111827";
const MUTED = "#6B7280";
const LINE = "#E5E7EB";

const s = StyleSheet.create({
  page: { paddingTop: 22, paddingBottom: 48, fontSize: 10, fontFamily: "Helvetica", color: INK },
  bar: { position: "absolute", top: 0, left: 0, right: 0, height: 6 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 40, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: LINE },
  brand: { flexDirection: "row", alignItems: "center" },
  logo: { maxHeight: 28, maxWidth: 140, objectFit: "contain", marginRight: 8 },
  initials: { width: 28, height: 28, borderRadius: 6, color: "#FFFFFF", fontFamily: "Helvetica-Bold", fontSize: 10, textAlign: "center", paddingTop: 8, marginRight: 8 },
  agency: { fontFamily: "Helvetica-Bold", fontSize: 11 },
  meta: { fontSize: 9, color: MUTED },
  hero: { backgroundColor: INK, color: "#FFFFFF", paddingHorizontal: 40, paddingVertical: 24 },
  eyebrow: { fontSize: 8, letterSpacing: 1.2, textTransform: "uppercase", color: "#D1D5DB" },
  bubble: { marginTop: 8, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, fontSize: 10, maxWidth: "85%" },
  h1: { marginTop: 12, fontFamily: "Times-Roman", fontSize: 24 },
  heroSub: { marginTop: 6, color: "#D1D5DB" },
  count: { marginTop: 12, fontSize: 10, color: "#FFFFFF" },
  countNum: { fontFamily: "Helvetica-Bold", fontSize: 16 },
  body: { paddingHorizontal: 40, paddingTop: 20 },
  h2: { fontFamily: "Times-Roman", fontSize: 18, marginBottom: 8, marginTop: 14 },
  grid: { flexDirection: "row", flexWrap: "wrap", marginHorizontal: -4 },
  gridCell: { width: "25%", padding: 4 },
  gridCard: { borderWidth: 1, borderColor: LINE, borderRadius: 6, alignItems: "center", paddingVertical: 8, paddingHorizontal: 4 },
  gridLabel: { marginTop: 4, fontSize: 8, textAlign: "center" },
  fix: { flexDirection: "row", marginBottom: 8 },
  fixNum: { width: 20, fontFamily: "Times-Roman", fontSize: 18, lineHeight: 1 },
  bold: { fontFamily: "Helvetica-Bold" },
  muted: { color: MUTED },
  card: { flexDirection: "row", paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: LINE },
  cardBody: { flex: 1, marginLeft: 10 },
  cardHead: { flexDirection: "row", justifyContent: "space-between", marginBottom: 3 },
  pill: { fontSize: 8, fontFamily: "Helvetica-Bold" },
  line: { marginTop: 2, color: "#374151" },
  question: { marginTop: 3, paddingHorizontal: 6, paddingVertical: 3, backgroundColor: "#F3F4F6", borderRadius: 4 },
  fact: { flexDirection: "row", justifyContent: "space-between", marginTop: 2, fontSize: 8.5 },
  cta: { marginTop: 18, borderWidth: 2, borderRadius: 8, padding: 14 },
  ctaLine: { fontFamily: "Times-Roman", fontSize: 16 },
  ctaLink: { marginTop: 4, fontFamily: "Helvetica-Bold" },
  footer: { position: "absolute", bottom: 20, left: 40, right: 40, flexDirection: "row", justifyContent: "space-between", fontSize: 8, color: MUTED },
});

function Ring({ score, size = 30 }: { score: number; size?: number }) {
  const { color } = TRAFFIC_LIGHT[trafficLight(score)];
  const stroke = size / 10;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, score));
  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <Circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={LINE} strokeWidth={stroke} />
        {clamped > 0 ? (
          <Circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeDasharray={`${(clamped / 100) * c} ${c}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        ) : null}
      </Svg>
      <Text style={{ position: "absolute", top: size / 2 - 4.5, width: size, textAlign: "center", fontSize: 8, fontFamily: "Helvetica-Bold" }}>
        {score}
      </Text>
    </View>
  );
}

function Hero({ story }: { story: ReportStory }) {
  const { hook, top, businessName, area, agency } = story;
  const name = businessName ?? "Your business";
  return (
    <View style={s.hero}>
      {hook ? (
        <>
          <Text style={s.eyebrow}>We asked AI assistants like ChatGPT and Gemini</Text>
          <Text style={[s.bubble, { backgroundColor: agency.brandColor, alignSelf: "flex-end" }]}>{hook.question}</Text>
          {hook.competitors ? (
            <Text style={[s.bubble, { backgroundColor: "#374151" }]}>Across our questions, AI named: {hook.competitors}</Text>
          ) : null}
          <Text style={s.h1}>
            {name} {hook.mentioned === 0 ? "wasn’t mentioned." : `was named in ${hook.mentioned} of ${hook.measured} answers.`}
          </Text>
          <Text style={s.heroSub}>
            We asked {hook.measured} times. {hook.mentioned === 0 ? "None of the answers named you." : `Only ${hook.mentioned} named you.`}
            {top?.impact ? ` ${top.impact}` : ""}
          </Text>
        </>
      ) : (
        <>
          <Text style={s.eyebrow}>Online presence report{businessName ? ` for ${businessName}` : ""}</Text>
          <Text style={s.h1}>{top ? (story.headline ?? top.text) : "No major issues found"}</Text>
          {top?.impact ? <Text style={s.heroSub}>{top.impact}</Text> : null}
          {!top && area.scored > 0 ? (
            <Text style={s.heroSub}>We checked {area.scored} areas and none of them needs work.</Text>
          ) : null}
        </>
      )}
      {area.scored > 0 && area.needWork > 0 ? (
        <Text style={s.count}>
          <Text style={s.countNum}>
            {area.needWork} of {area.scored}
          </Text>{" "}
          areas need work
        </Text>
      ) : null}
    </View>
  );
}

function SectionCard({ row }: { row: SectionRow }) {
  const { s: sec, label, facts, scored } = row;
  const light = scored ? TRAFFIC_LIGHT[trafficLight(sec.score!)] : null;
  const questions = sec.key === "ai_presence" ? aiQuestions(sec) : [];
  const { mentionedIn, answersMeasured, topCompetitors } = sec.details;
  return (
    <View style={s.card} wrap={false}>
      {scored ? <Ring score={sec.score!} /> : <View style={{ width: 30, height: 30, borderRadius: 15, borderWidth: 2, borderColor: LINE, borderStyle: "dashed" }} />}
      <View style={s.cardBody}>
        <View style={s.cardHead}>
          <Text style={s.bold}>{label}</Text>
          {light ? (
            <Text style={[s.pill, { color: light.color }]}>{light.label}</Text>
          ) : sec.status !== "ok" ? (
            <Text style={[s.pill, s.muted]}>{STATUS_NOTE[sec.status]}</Text>
          ) : null}
        </View>
        {sec.status !== "ok" && sec.reason ? <Text style={[s.line, s.muted]}>{sec.reason}</Text> : null}
        {sec.findings.map((f) => (
          <Text key={f.code} style={s.line}>
            {f.text}
          </Text>
        ))}
        {sec.findings.length === 0 && scored ? <Text style={[s.line, s.muted]}>No issues found.</Text> : null}
        {sec.key === "ai_presence" && typeof mentionedIn === "number" && typeof answersMeasured === "number" ? (
          <Text style={s.line}>
            Named in {mentionedIn} of {answersMeasured} AI answers.
            {typeof topCompetitors === "string" ? ` Named instead: ${topCompetitors}.` : ""}
          </Text>
        ) : null}
        {questions.length > 0 ? <Text style={[s.line, s.muted, { fontSize: 8 }]}>QUESTIONS WE ASKED</Text> : null}
        {questions.map((q, i) => (
          <Text key={i} style={s.question}>
            “{q}”
          </Text>
        ))}
        {facts.length > 0 ? (
          <View style={{ marginTop: 4 }}>
            {facts.map(([k, v]) => (
              <View key={k} style={s.fact}>
                <Text style={s.muted}>{DETAIL_LABELS[k] ?? k}</Text>
                <Text>{detailText(k, sec.key, v)}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

export function ReportPdfDocument({ story, logo, bookUrl }: { story: ReportStory; logo: string | null; bookUrl: string | null }) {
  const { agency } = story;
  const scored = story.rows.filter((r) => r.scored);
  const initials = (agency.name ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return (
    <Document title={`Online presence report${story.businessName ? ` for ${story.businessName}` : ""}`} author={agency.name ?? undefined}>
      <Page size="A4" style={s.page}>
        <View style={[s.bar, { backgroundColor: agency.brandColor }]} fixed />
        <View style={s.header}>
          <View style={s.brand}>
            {logo ? (
              // eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image, not an <img>: it takes no alt
              <Image src={logo} style={s.logo} />
            ) : initials ? (
              <Text style={[s.initials, { backgroundColor: agency.brandColor }]}>{initials}</Text>
            ) : null}
            {agency.name ? <Text style={s.agency}>{agency.name}</Text> : null}
          </View>
          <Text style={s.meta}>
            {story.businessName ? `Report for ${story.businessName}` : "Online presence report"}
            {story.generated ? ` · ${story.generated}` : ""}
          </Text>
        </View>

        <Hero story={story} />

        <View style={s.body}>
          {scored.length > 0 ? (
            <View style={s.grid}>
              {scored.map((r) => (
                <View key={r.s.key} style={s.gridCell}>
                  <View style={s.gridCard}>
                    <Ring score={r.s.score!} size={36} />
                    <Text style={s.gridLabel}>{LABELS[r.s.key]}</Text>
                  </View>
                </View>
              ))}
            </View>
          ) : null}

          {story.fixes.length > 0 ? (
            <View wrap={false}>
              <Text style={s.h2}>Fix these next</Text>
              {story.fixes.map((f, i) => (
                <View key={`${f.section}-${f.code}`} style={s.fix}>
                  <Text style={[s.fixNum, { color: agency.brandColor }]}>{i + 1}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={s.bold}>{f.text}</Text>
                    {f.impact ? <Text style={[s.line, s.muted]}>{f.impact}</Text> : null}
                  </View>
                </View>
              ))}
            </View>
          ) : null}

          {/* Keep the heading with its first card, never alone at a page foot. */}
          <Text style={s.h2} minPresenceAhead={80}>
            The rest of your check-up
          </Text>
          {story.rows.map((r) => (
            <SectionCard key={r.s.key} row={r} />
          ))}

          {bookUrl || story.whatsappHref ? (
            <View style={[s.cta, { borderColor: agency.brandColor }]} wrap={false}>
              <Text style={s.ctaLine}>{story.ctaLine ?? "Want help fixing these?"}</Text>
              {agency.name ? <Text style={[s.line, s.muted]}>{agency.name} can help fix the issues above.</Text> : null}
              {bookUrl ? (
                <Link src={bookUrl} style={[s.ctaLink, { color: agency.brandColor }]}>
                  Book a call: {bookUrl}
                </Link>
              ) : null}
              {story.whatsappHref ? (
                <Link src={story.whatsappHref} style={[s.ctaLink, { color: agency.brandColor }]}>
                  WhatsApp us: +{story.whatsappHref.slice("https://wa.me/".length)}
                </Link>
              ) : null}
            </View>
          ) : null}
        </View>

        <View style={s.footer} fixed>
          <Text>{agency.name ? `Prepared by ${agency.name}` : ""}</Text>
          <Text render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
