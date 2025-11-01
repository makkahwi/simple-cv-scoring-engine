// engine.cjs — JSON-driven CV scoring engine
// Run: node engine.cjs
// Requires: npm i pdf-parse mammoth glob json2csv

const fs = require("fs/promises");
const fssync = require("fs");
const path = require("path");
const pdf = require("pdf-parse"); // CJS export = function(buffer)
const mammoth = require("mammoth");
const { glob } = require("glob");
const { parse: toCSV } = require("json2csv");

const ROOT = process.cwd();
const CVS_DIR = path.join(ROOT, "cvs");
const OUT_DIR = path.join(ROOT, "reports");
const CONFIG_PATH = path.join(ROOT, "scoring.config.json");

// -------------------- helpers --------------------
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const MONTH_ABBR = MONTHS.map((m) => m.slice(0, 3));

function norm(s) {
  return (s || "")
    .replace(/\u00A0/g, " ")
    .replace(/[‐-–—]/g, "-")
    .toLowerCase();
}

const re = {
  // date ranges like: Jan 2023 – Present | 2021 - 2024 | March 2020 to Jun 2022 | 05/2022 - 10/2023
  range: new RegExp(
    `\\b(?:(${MONTHS.join("|")}|${MONTH_ABBR.join(
      "|"
    )})\\s+)?(20\\d{2}|19\\d{2}|\\d{1,2}[\\/\\-]\\d{2,4})\\s*(?:to|–|-|—)\\s*(?:(${MONTHS.join(
      "|"
    )}|${MONTH_ABBR.join(
      "|"
    )})\\s+)?(present|current|now|20\\d{2}|19\\d{2}|\\d{1,2}[\\/\\-]\\d{2,4})\\b`,
    "i"
  ),
  li: {
    linkedin: /(https?:\/\/)?(www\.)?linkedin\.com\/[A-Za-z0-9/_\-?&%=+.]+/i,
    github: /(https?:\/\/)?(www\.)?github\.com\/[A-Za-z0-9._\-\/]+/i,
    website: /(https?:\/\/)([A-Za-z0-9\-]+\.)+[A-Za-z]{2,}(\/[^\s]*)?/i,
  },
  classify: {
    internship: /\b(intern|internship)\b/i,
    parttime: /\b(part-?time)\b/i,
    freelance: /\b(freelance|self[- ]?employed|consultant|contractor)\b/i,
    contract: /\b(contract|contractor|outsourced)\b/i,
    fulltime: /\b(full[- ]?time|permanent)\b/i,
  },
};

function parseMonthToken(tok) {
  if (!tok) return null;
  const s = tok.toLowerCase();
  let idx = MONTHS.indexOf(s);
  if (idx >= 0) return idx;
  idx = MONTH_ABBR.indexOf(s.slice(0, 3));
  if (idx >= 0) return idx;
  return null;
}

function parseY(yRaw) {
  // handles "2023" or "05/2023" etc.
  const s = String(yRaw);
  const m = s.match(/(\d{1,2})[\/\-](\d{2,4})/);
  if (m) {
    const mm = Math.max(1, Math.min(12, parseInt(m[1], 10))) - 1;
    const yyyy = parseInt(m[2].length === 2 ? "20" + m[2] : m[2], 10);
    return { y: yyyy, m: mm };
  }
  return { y: parseInt(s, 10), m: 0 };
}

function monthsBetween(a, b) {
  // a, b: { y:YYYY, m:0..11 }
  return (b.y - a.y) * 12 + (b.m - a.m) + 1; // +1 to count inclusive months
}

function clampMonthYear(obj) {
  if (!obj) return null;
  const y = Math.max(1900, Math.min(2200, obj.y || 0));
  const m = Math.max(0, Math.min(11, obj.m || 0));
  return { y, m };
}

function extractRanges(text, presentWords) {
  // scan lines for ranges; tag each line with "type" by keywords
  const lines = text.split(/\r?\n/);
  const items = [];
  for (const line of lines) {
    const m = line.match(re.range);
    if (!m) continue;
    // groups: (m1) MonFrom? (y1) From (m2) MonTo? (y2) To/present
    const monFromIdx = parseMonthToken(m[1]);
    const from = parseY(m[2]);
    const monToIdx = parseMonthToken(m[3]);
    const toRaw = m[4];
    let to;
    if (new RegExp(presentWords.join("|"), "i").test(toRaw)) {
      const now = new Date();
      to = { y: now.getFullYear(), m: now.getMonth() };
    } else {
      to = parseY(toRaw);
    }
    const fromObj = clampMonthYear({ y: from.y, m: monFromIdx ?? from.m ?? 0 });
    const toObj = clampMonthYear({ y: to.y, m: monToIdx ?? to.m ?? 0 });
    if (!fromObj || !toObj) continue;

    // classify by keywords in same line
    let type = "unspecified";
    if (re.classify.internship.test(line)) type = "internship";
    else if (re.classify.parttime.test(line)) type = "parttime";
    else if (re.classify.freelance.test(line)) type = "freelance";
    else if (re.classify.contract.test(line)) type = "contract";
    else if (re.classify.fulltime.test(line)) type = "fulltime";

    // capture location tokens on same/near lines
    const loc =
      /saudi arabia|ksa|riyadh|jeddah|dammam|khobar|amman|jordan|uae|dubai|turkey|pakistan|egypt/i.exec(
        line
      )?.[0] ?? null;

    items.push({ line, from: fromObj, to: toObj, type, loc });
  }
  return items;
}

function sumExperienceMonths(ranges, weightsByType) {
  let totalWeighted = 0;
  let byType = {
    fulltime: 0,
    parttime: 0,
    freelance: 0,
    contract: 0,
    internship: 0,
    unspecified: 0,
  };
  for (const r of ranges) {
    const months = Math.max(0, monthsBetween(r.from, r.to));
    const w = weightsByType[r.type] ?? 1.0;
    totalWeighted += months * w;
    byType[r.type] = (byType[r.type] || 0) + months;
  }
  return { totalWeightedMonths: totalWeighted, byTypeMonths: byType };
}

function monthsInRequiredLocation(ranges, requiredAny) {
  const wanted = new RegExp(requiredAny.join("|").replace(/\s+/g, "\\s+"), "i");
  let m = 0;
  for (const r of ranges) {
    if (r.loc && wanted.test(r.loc)) {
      m += Math.max(0, monthsBetween(r.from, r.to));
    }
  }
  return m;
}

re.li.websiteGlobal =
  /(https?:\/\/)(?:www\.)?[-a-z0-9@:%._+~#=]{1,256}\.[a-z]{2,}\b(?:[\/?][^\s]*)?/gi;

function findLinks(rawText) {
  // use the RAW text (not normalized) to keep original URL casing
  const t = rawText || "";
  const out = { linkedin: null, github: null, website: null };

  // single matches are fine here (don’t need global)
  const li = t.match(re.li.linkedin);
  if (li) out.linkedin = li[0];

  const gh = t.match(re.li.github);
  if (gh) out.github = gh[0];

  // collect all URLs using a GLOBAL regex
  const urls = t.match(re.li.websiteGlobal) || [];

  // prefer a portfolio-ish URL that is not LI/GH; otherwise first non-LI/GH; otherwise null
  const nonGhLi = urls.filter((u) => !/linkedin|github/i.test(u));
  const preferred =
    nonGhLi.find((u) => /portfolio|resume|cv|personal|about/i.test(u)) ||
    nonGhLi[0] ||
    null;

  out.website = preferred;
  return out;
}

function hasAny(text, arr) {
  return arr.some((a) => text.includes(a.toLowerCase()));
}

function hasSkill(text, skill) {
  // exact-ish term match (case-insensitive), allow dots and + signs
  const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rx = new RegExp(`\\b${escaped}\\b`, "i");
  return rx.test(text);
}

function scoreSkills(text, list) {
  let pts = 0;
  const details = [];
  for (const item of list) {
    const foundMain = hasSkill(text, item.name);
    const foundAlt = (item.alternatives || []).some((a) => hasSkill(text, a));
    let credit = 0;
    if (foundMain) credit = 1;
    else if (foundAlt) credit = 0.6; // alternative credit
    const add = (item.weight || 0) * credit;
    pts += add;
    details.push({
      name: item.name,
      matched: foundMain ? "main" : foundAlt ? "alternative" : "none",
      weight: item.weight || 0,
      pts: +add.toFixed(2),
      altHit: foundAlt
        ? (item.alternatives || []).find((a) => hasSkill(text, a))
        : null,
    });
  }
  return { pts, details };
}

function scoreLanguages(text, cfg) {
  const ok = (cfg.mustAny || []).every((group) =>
    group.some((l) => hasSkill(text, l))
  );
  return { pts: ok ? cfg.weight || 0 : 0, groups: cfg.mustAny || [], ok };
}

function scoreLocationPresence(text, cfg, ranges) {
  let pts = 0;
  const mentioned = hasAny(text, cfg.requiredAny || []);
  if (mentioned) pts += (cfg.weight || 0) * 0.4; // 40% if merely present in text
  let months = 0;
  if (cfg.countMonthsInRequired && ranges.length) {
    months = monthsInRequiredLocation(ranges, cfg.requiredAny || []);
    // give up to 60% of weight from months (cap at 24 months for full credit of this portion)
    const frac = Math.min(1, months / 24);
    pts += (cfg.weight || 0) * 0.6 * frac;
  }
  return { pts: +pts.toFixed(2), monthsInRequired: months, mentioned };
}

function scoreExperienceBlock(text, cfg) {
  const ranges = extractRanges(
    text,
    cfg.presentWords || ["present", "current", "now"]
  );
  const { totalWeightedMonths, byTypeMonths } = sumExperienceMonths(
    ranges,
    cfg.weightsByType || {}
  );
  const years = totalWeightedMonths / 12;
  const ok =
    years >= (cfg.minYears || 0)
      ? 1
      : Math.max(0, years / Math.max(1, cfg.minYears || 1));
  const pts = ok * (cfg.weight || 0);
  return {
    pts: +pts.toFixed(2),
    years: +years.toFixed(2),
    ranges,
    byTypeMonths,
  };
}

// -------------------- file i/o --------------------
async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const buf = await fs.readFile(filePath);
  if (ext === ".pdf") {
    const result = await pdf(buf);
    return result?.text || "";
  }
  if (ext === ".docx") {
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return value || "";
  }
  if (ext === ".txt" || ext === ".md") {
    return buf.toString("utf8");
  }
  return "";
}

async function ensureOutDir() {
  if (!fssync.existsSync(OUT_DIR)) {
    await fs.mkdir(OUT_DIR, { recursive: true });
  }
}

function calcTotalScore(parts) {
  return +(
    parts.mustSkills.pts +
    parts.niceSkills.pts +
    parts.experience.pts +
    parts.location.pts +
    parts.languages.pts
  ).toFixed(2);
}

// -------------------- main --------------------
(async () => {
  if (!fssync.existsSync(CONFIG_PATH)) {
    console.error("Missing scoring.config.json");
    process.exit(1);
  }
  const cfg = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
  await ensureOutDir();

  const files = await glob("**/*.{pdf,docx,txt,md}", {
    cwd: CVS_DIR,
    absolute: true,
    nodir: true,
    nocase: true,
  });
  if (!files.length) {
    console.log("No CV files found in ./cvs");
    process.exit(0);
  }

  const rows = [];
  for (const file of files) {
    const base = path.basename(file);
    const raw = await extractText(file);
    const text = norm(raw);

    // scoring components
    const mustSkills = scoreSkills(text, cfg.mustSkills || []);
    const niceSkills = scoreSkills(text, cfg.niceSkills || []);
    const experience = scoreExperienceBlock(text, cfg.experience || {});
    const location = scoreLocationPresence(
      text,
      cfg.location || {},
      experience.ranges || []
    );
    const languages = scoreLanguages(text, cfg.languages || {});
    const links = findLinks(raw); // use raw (keep URL case)

    // missing required skills with alt suggestions
    const missingMust = (mustSkills.details || [])
      .filter((d) => d.matched === "none")
      .map((d) => ({
        skill: d.name,
        alternativesAvailable:
          (cfg.mustSkills || []).find((s) => s.name === d.name)?.alternatives ||
          [],
      }));

    const total = calcTotalScore({
      mustSkills,
      niceSkills,
      experience,
      location,
      languages,
    });

    rows.push({
      candidate: base,
      total,
      mustSkillsPts: mustSkills.pts,
      niceSkillsPts: niceSkills.pts,
      expYearsWeighted: experience.years,
      expByTypeMonths: experience.byTypeMonths,
      locationMonthsInRequired: location.monthsInRequired,
      languagesOk: languages.ok ? "yes" : "no",
      linkedin: links.linkedin || "",
      github: links.github || "",
      website: links.website || "",
      missingMust,
    });

    // per-candidate markdown
    const md = `# ${base}
**Total Score:** ${total}

## Skills
- MUST total: ${mustSkills.pts}  
${mustSkills.details
  .map(
    (d) =>
      `  - ${d.name}: ${d.matched}${d.altHit ? ` (alt: ${d.altHit})` : ""} — +${
        d.pts
      }`
  )
  .join("\n")}
- NICE total: ${niceSkills.pts}

## Experience
- Weighted years: ${experience.years}
- By type (months): ${Object.entries(experience.byTypeMonths)
      .map(([k, v]) => `${k}:${v}`)
      .join(", ")}

## Location
- Months in required: ${location.monthsInRequired}
- Presence credit: ${location.mentioned ? "yes" : "no"} (points: ${
      location.pts
    })

## Languages
- Requirement satisfied: ${languages.ok ? "yes" : "no"}

## Missing MUST Skills
${
  missingMust.length
    ? missingMust
        .map(
          (m) =>
            `- ${m.skill} (alternatives: ${
              m.alternativesAvailable.join(", ") || "none"
            })`
        )
        .join("\n")
    : "- None"
}

## Links
- LinkedIn: ${links.linkedin || "-"}
- GitHub: ${links.github || "-"}
- Website/Portfolio: ${links.website || "-"}
`;
    await fs.writeFile(path.join(OUT_DIR, `${base}.md`), md, "utf8");
  }

  // rank & export
  rows.sort((a, b) => b.total - a.total);

  // CSV (flatten objects)
  const flat = rows.map((r) => ({
    candidate: r.candidate,
    total: r.total,
    mustSkillsPts: r.mustSkillsPts,
    niceSkillsPts: r.niceSkillsPts,
    expYearsWeighted: r.expYearsWeighted,
    exp_fulltime_m: r.expByTypeMonths.fulltime || 0,
    exp_parttime_m: r.expByTypeMonths.parttime || 0,
    exp_freelance_m: r.expByTypeMonths.freelance || 0,
    exp_contract_m: r.expByTypeMonths.contract || 0,
    exp_internship_m: r.expByTypeMonths.internship || 0,
    exp_unspecified_m: r.expByTypeMonths.unspecified || 0,
    locationMonthsInRequired: r.locationMonthsInRequired,
    languagesOk: r.languagesOk,
    linkedin: r.linkedin,
    github: r.github,
    website: r.website,
    missingMust: r.missingMust
      .map(
        (m) => `${m.skill}{alt:${(m.alternativesAvailable || []).join("|")}}`
      )
      .join("; "),
  }));

  const csv = toCSV(flat, {
    fields: Object.keys(flat[0] || { candidate: "", total: 0 }),
  });
  await fs.writeFile(path.join(OUT_DIR, "results.csv"), csv, "utf8");
  await fs.writeFile(
    path.join(OUT_DIR, "results.json"),
    JSON.stringify(rows, null, 2),
    "utf8"
  );

  console.log(`Processed ${rows.length} CV(s).`);
  console.log(`→ reports/results.csv`);
  console.log(`→ reports/results.json`);
  console.log(`→ reports/*.md (per-candidate)`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
