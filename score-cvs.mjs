import fs from "fs/promises";
import { glob } from "glob";
import { parse as csvStringify } from "json2csv";
import mammoth from "mammoth";
import path from "path";
import pdf from "pdf-parse";

const ROOT = process.cwd();
const CVS_DIR = path.join(ROOT, "cvs");
const OUT_DIR = path.join(ROOT, "reports");

const readText = async (p) => (await fs.readFile(p, "utf8")).toString();

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const buf = await fs.readFile(filePath);
  if (ext === ".pdf") {
    const data = await pdf(buf);
    return data.text || "";
  }
  if (ext === ".docx") {
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return value || "";
  }
  if (ext === ".txt" || ext === ".md") {
    return buf.toString("utf8");
  }
  return ""; // unknown formats skipped
}

function norm(s) {
  return (s || "").toLowerCase().replace(/\s+/g, " ");
}

function scoreKeywords(text, items) {
  let total = 0;
  const details = [];
  for (const it of items) {
    const hits = it.keywords.reduce(
      (acc, k) => acc + (text.includes(k.toLowerCase()) ? 1 : 0),
      0
    );
    const matched = hits > 0 ? 1 : 0;
    const pts = matched * it.weight;
    total += pts;
    details.push({ name: it.name, matched, weight: it.weight, pts });
  }
  return { total, details };
}

function extractYears(text) {
  // naive capture like "5 years", "3+ years", "since 2018"
  const yearsRegex = /(\d+)\s*\+?\s*(?:years?|yrs?)/gi;
  let max = 0;
  let m;
  while ((m = yearsRegex.exec(text)) !== null) {
    const val = parseInt(m[1], 10);
    if (!Number.isNaN(val)) max = Math.max(max, val);
  }
  return max;
}

function scoreExperience(text, cfg) {
  const y = extractYears(text);
  const ok = y >= cfg.minYears ? 1 : Math.max(0, y / cfg.minYears);
  const pts = ok * cfg.weight;
  return { yearsDetected: y, pts, weight: cfg.weight };
}

function scoreEducation(text, cfg) {
  const has = cfg.preferred.some((p) => text.includes(p.toLowerCase()));
  return {
    matched: has ? 1 : 0,
    pts: (has ? 1 : 0) * cfg.weight,
    weight: cfg.weight,
  };
}

function scoreLocation(text, cfg) {
  const has = cfg.preferred.some((p) => text.includes(p.toLowerCase()));
  return {
    matched: has ? 1 : 0,
    pts: (has ? 1 : 0) * cfg.weight,
    weight: cfg.weight,
  };
}

function scoreLanguages(text, cfg) {
  // any of the groups
  const ok = cfg.requiredAny.some((group) =>
    group.some((l) => text.includes(l.toLowerCase()))
  );
  return {
    matched: ok ? 1 : 0,
    pts: (ok ? 1 : 0) * cfg.weight,
    weight: cfg.weight,
  };
}

function scoreGithub(text, cfg) {
  const has = /(github\.com\/[A-Za-z0-9._-]+)/i.test(text);
  return {
    matched: has ? 1 : 0,
    pts: (has ? 1 : 0) * cfg.weight,
    weight: cfg.weight,
  };
}

function scoreRecency(text, cfg) {
  // very rough: count years mentioned >= (currentYear - N)
  const thisYear = new Date().getFullYear();
  const years = [...text.matchAll(/\b(20\d{2})\b/g)].map((m) =>
    parseInt(m[1], 10)
  );
  const recent = years.filter((y) => y >= thisYear - cfg.years).length;
  const ok =
    recent >= cfg.projectsInLastYears
      ? 1
      : Math.min(1, recent / cfg.projectsInLastYears);
  return { recentMentions: recent, pts: ok * cfg.weight, weight: cfg.weight };
}

async function llmBoostScore(cvText, jdText, cfg) {
  const key = process.env[cfg.enabledEnvVar];
  if (!key) return { pts: 0, reason: "LLM disabled (no API key)" };

  // Lightweight cosine via embeddings or a quick prompt—keep it simple:
  // We’ll use a minimal grading prompt to return 0..1.
  // Using fetch to OpenAI; adjust model if needed.
  const fetch = (await import("node-fetch")).default;
  const body = {
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content:
          "You grade CV-to-JD fit. Return ONLY a number between 0 and 1.",
      },
      {
        role: "user",
        content: `JD:\n${jdText}\n\nCV:\n${cvText}\n\nScore (0..1):`,
      },
    ],
    temperature: 0,
  };
  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const json = await resp.json();
    const raw = json.choices?.[0]?.message?.content?.trim() ?? "0";
    const n = Math.max(0, Math.min(1, parseFloat(raw)));
    return { pts: n * cfg.weight, reason: `LLM factor=${n.toFixed(2)}` };
  } catch (e) {
    return { pts: 0, reason: "LLM error (ignored)" };
  }
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const rubric = JSON.parse(await readText(path.join(ROOT, "rubric.json")));
  const jdText = norm(await readText(path.join(ROOT, "jd.txt")));

  const files = await glob(`${CVS_DIR}/*.{pdf,docx,txt,md}`, { nocase: true });
  const rows = [];

  for (const file of files) {
    const base = path.basename(file);
    const raw = await extractText(file);
    const cv = norm(raw);

    const must = scoreKeywords(cv, rubric.mustHaves);
    const nice = scoreKeywords(cv, rubric.niceToHaves);
    const exp = scoreExperience(cv, rubric.experience);
    const edu = scoreEducation(cv, rubric.education);
    const loc = scoreLocation(cv, rubric.location);
    const lang = scoreLanguages(cv, rubric.languages);
    const gh = scoreGithub(cv, rubric.githubPresence);
    const rec = scoreRecency(cv, rubric.recency);
    const llm = await llmBoostScore(cv, jdText, rubric.llmBoost);

    const total =
      must.total +
      nice.total +
      exp.pts +
      edu.pts +
      loc.pts +
      lang.pts +
      gh.pts +
      rec.pts +
      llm.pts;

    // simple knockout if a must-have completely missing
    const missingMust = must.details
      .filter((d) => d.matched === 0)
      .map((d) => d.name);

    rows.push({
      candidate: base,
      total: +total.toFixed(2),
      missingMust: missingMust.join("; "),
      mustScore: must.total,
      niceScore: nice.total,
      expYears: exp.yearsDetected,
      expPts: +exp.pts.toFixed(2),
      recencyPts: +rec.pts.toFixed(2),
      github: gh.pts > 0 ? "yes" : "no",
    });

    // write per-candidate mini report
    const report = `# ${base}
Total Score: ${total.toFixed(2)}
Missing MUST-HAVEs: ${missingMust.length ? missingMust.join(", ") : "None"}

## Breakdown
- MUST-HAVEs: ${must.total} (details: ${must.details
      .map((d) => `${d.name}:${d.pts}`)
      .join(", ")})
- NICE-TO-HAVEs: ${nice.total}
- Experience: ${exp.yearsDetected} years → ${exp.pts.toFixed(2)} / ${exp.weight}
- Education: ${edu.pts} / ${edu.weight}
- Location: ${loc.pts} / ${loc.weight}
- Languages: ${lang.pts} / ${lang.weight}
- GitHub presence: ${gh.pts} / ${gh.weight}
- Recency: ${rec.pts.toFixed(2)} / ${rec.weight}
- LLM Boost: ${llm.pts.toFixed(2)} / ${rubric.llmBoost.weight} (${llm.reason})

## Notes
- Heuristic keyword matching is case-insensitive.
- Weights come from rubric.json (tune freely).
- Set ${rubric.llmBoost.enabledEnvVar} to enable semantic fit scoring.
`;
    await fs.writeFile(path.join(OUT_DIR, `${base}.md`), report, "utf8");
  }

  rows.sort((a, b) => b.total - a.total);

  const csv = csvStringify(rows, { fields: Object.keys(rows[0] || {}) });
  await fs.writeFile(path.join(ROOT, "results.csv"), csv, "utf8");

  console.log(`Scored ${rows.length} CV(s).`);
  console.log(`→ results.csv`);
  console.log(`→ reports/*.md`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
