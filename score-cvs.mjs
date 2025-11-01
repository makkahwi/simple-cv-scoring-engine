// score-cvs.mjs
import fs from "fs/promises";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

/** Robustly resolve a callable function from a CJS/ESM module */
function resolveCallable(mod) {
  if (typeof mod === "function") return mod;
  if (mod && typeof mod.default === "function") return mod.default;
  // some bundlers nest more than once
  if (mod && mod.default && typeof mod.default.default === "function")
    return mod.default.default;
  return null;
}

// ---- Load libs (works across CJS/ESM permutations) ----
const pdfMod = (() => {
  try {
    return require("pdf-parse");
  } catch {
    return null;
  }
})();
const pdf = resolveCallable(pdfMod);

const mammothMod = (() => {
  try {
    return require("mammoth");
  } catch {
    return null;
  }
})();
const mammoth = mammothMod; // mammoth.extractRawText is a function on the object

const json2csvMod = (() => {
  try {
    return require("json2csv");
  } catch {
    return null;
  }
})();
const csvStringify =
  json2csvMod?.parse ?? ((rows) => rows.map(String).join("\n"));

const globPkg = (() => {
  try {
    return require("glob");
  } catch {
    return null;
  }
})();
const glob = globPkg?.glob ?? globPkg; // glob v10 exposes { glob }, older versions export fn

// ---- Config ----
const ROOT = process.cwd();
const CVS_DIR = path.join(ROOT, "cvs");
const OUT_DIR = path.join(ROOT, "reports");

// ---- Utils ----
const readText = async (p) => (await fs.readFile(p, "utf8")).toString();

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const buf = await fs.readFile(filePath);

  if (ext === ".pdf") {
    if (!pdf) {
      throw new Error(
        "pdf-parse could not be resolved as a function. Try: `npm i pdf-parse@1` or use CommonJS (.cjs)."
      );
    }
    const data = await pdf(buf);
    return data?.text || "";
  }

  if (ext === ".docx") {
    if (!mammoth?.extractRawText) {
      throw new Error("mammoth is unavailable. Run: `npm i mammoth`.");
    }
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

function scoreKeywords(text, items = []) {
  let total = 0;
  const details = [];
  for (const it of items) {
    const hits = (it.keywords || []).reduce(
      (acc, k) => acc + (text.includes(String(k).toLowerCase()) ? 1 : 0),
      0
    );
    const matched = hits > 0 ? 1 : 0;
    const pts = matched * (it.weight || 0);
    total += pts;
    details.push({ name: it.name, matched, weight: it.weight || 0, pts });
  }
  return { total, details };
}

function extractYears(text) {
  const yearsRegex = /(\d+)\s*\+?\s*(?:years?|yrs?)/gi;
  let max = 0;
  let m;
  while ((m = yearsRegex.exec(text)) !== null) {
    const val = parseInt(m[1], 10);
    if (!Number.isNaN(val)) max = Math.max(max, val);
  }
  return max;
}

function scoreExperience(text, cfg = { minYears: 0, weight: 0 }) {
  const y = extractYears(text);
  const ok = y >= cfg.minYears ? 1 : Math.max(0, y / (cfg.minYears || 1));
  const pts = ok * (cfg.weight || 0);
  return { yearsDetected: y, pts, weight: cfg.weight || 0 };
}

function simplePresence(text, list = []) {
  return list.some((p) => text.includes(String(p).toLowerCase()));
}

function scoreEducation(text, cfg = { preferred: [], weight: 0 }) {
  const has = simplePresence(text, cfg.preferred);
  return {
    matched: has ? 1 : 0,
    pts: (has ? 1 : 0) * (cfg.weight || 0),
    weight: cfg.weight || 0,
  };
}

function scoreLocation(text, cfg = { preferred: [], weight: 0 }) {
  const has = simplePresence(text, cfg.preferred);
  return {
    matched: has ? 1 : 0,
    pts: (has ? 1 : 0) * (cfg.weight || 0),
    weight: cfg.weight || 0,
  };
}

function scoreLanguages(text, cfg = { requiredAny: [], weight: 0 }) {
  const ok = (cfg.requiredAny || []).some((group) =>
    group.some((l) => text.includes(String(l).toLowerCase()))
  );
  return {
    matched: ok ? 1 : 0,
    pts: (ok ? 1 : 0) * (cfg.weight || 0),
    weight: cfg.weight || 0,
  };
}

function scoreGithub(text, cfg = { weight: 0 }) {
  const has = /(github\.com\/[A-Za-z0-9._-]+)/i.test(text);
  return {
    matched: has ? 1 : 0,
    pts: (has ? 1 : 0) * (cfg.weight || 0),
    weight: cfg.weight || 0,
  };
}

function scoreRecency(
  text,
  cfg = { years: 2, projectsInLastYears: 1, weight: 0 }
) {
  const thisYear = new Date().getFullYear();
  const years = [...text.matchAll(/\b(20\d{2})\b/g)].map((m) =>
    parseInt(m[1], 10)
  );
  const recent = years.filter((y) => y >= thisYear - (cfg.years || 0)).length;
  const ok =
    recent >= (cfg.projectsInLastYears || 1)
      ? 1
      : Math.min(1, recent / (cfg.projectsInLastYears || 1));
  return {
    recentMentions: recent,
    pts: ok * (cfg.weight || 0),
    weight: cfg.weight || 0,
  };
}

async function getFetch() {
  if (globalThis.fetch) return globalThis.fetch;
  const nf = require("node-fetch");
  return nf.default || nf;
}

async function llmBoostScore(
  cvText,
  jdText,
  cfg = { enabledEnvVar: "", weight: 0 }
) {
  try {
    const key = cfg.enabledEnvVar ? process.env[cfg.enabledEnvVar] : null;
    if (!key) return { pts: 0, reason: "LLM disabled (no API key)" };

    const fetch = await getFetch();
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

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const json = await resp.json();
    const raw = json?.choices?.[0]?.message?.content?.trim() ?? "0";
    const n = Math.max(0, Math.min(1, parseFloat(raw)));
    if (!Number.isFinite(n))
      return { pts: 0, reason: "LLM parse error (ignored)" };
    return { pts: n * (cfg.weight || 0), reason: `LLM factor=${n.toFixed(2)}` };
  } catch {
    return { pts: 0, reason: "LLM error (ignored)" };
  }
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const rubric = JSON.parse(await readText(path.join(ROOT, "rubric.json")));
  const jdText = norm(await readText(path.join(ROOT, "jd.txt")));

  if (!glob) {
    throw new Error("glob is not available. Run: `npm i glob`");
  }

  const files = await glob("**/*.{pdf,docx,txt,md}", {
    cwd: CVS_DIR,
    nocase: true,
    absolute: true,
    nodir: true,
  });

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
`;
    await fs.writeFile(path.join(OUT_DIR, `${base}.md`), report, "utf8");
  }

  rows.sort((a, b) => b.total - a.total);
  const fields = rows.length
    ? Object.keys(rows[0])
    : [
        "candidate",
        "total",
        "missingMust",
        "mustScore",
        "niceScore",
        "expYears",
        "expPts",
        "recencyPts",
        "github",
      ];
  const csv = csvStringify(rows, { fields });
  await fs.writeFile(path.join(ROOT, "results.csv"), csv, "utf8");

  console.log(`Scored ${rows.length} CV(s).`);
  console.log(`→ results.csv`);
  console.log(`→ reports/*.md`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
