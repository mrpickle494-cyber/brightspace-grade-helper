// Compares a submission against its assignment's guidelines with simple rules:
// course codes, assignment names, file type, length, and keyword overlap.
// A quick skim for obvious mistakes, not a grade. When unsure it says "warn", not "bad".
//
// No Brightspace or browser code here, so it can be tested on its own.

// ---------- Small helpers ----------

const LEVELS = { ok: 0, info: 0, warn: 1, bad: 2 };
const worst = (levels) => levels.reduce((a, b) => (LEVELS[b] > LEVELS[a] ? b : a), 'ok');

export const extensionOf = (name) => (name.match(/\.[a-z0-9]+$/i)?.[0] ?? '').toLowerCase();

const IMAGE_TYPES = ['.png', '.jpg', '.jpeg', '.gif', '.heic', '.webp', '.bmp'];
const CODE_TYPES = ['.py', '.r', '.rmd', '.qmd', '.ipynb', '.java', '.c', '.cpp', '.h', '.js', '.ts', '.sql', '.m', '.sas', '.do', '.jl', '.sh', '.html', '.css'];
const isCode = (ext) => CODE_TYPES.includes(ext);

const countWords = (text) => (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
const clip = (s, n = 160) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const words = (s) => s.toLowerCase().replace(/([a-z])(\d)/g, '$1 $2').match(/[a-z0-9]+/g) ?? [];

// "chem105_lab1_FINAL.pdf" -> "chem 105 lab 1 FINAL"
const nameAsText = (fileName) => fileName.replace(/\.[a-z0-9]+$/i, '').replace(/[_.]+/g, ' ').replace(/([a-z])(\d)/gi, '$1 $2');

const NUMBER_WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20 };
const toNumber = (s) => NUMBER_WORDS[s.toLowerCase()] ?? Number(s.replace(/,/g, ''));

// ---------- Courses ----------

// "BUAD-312: Marketing" -> { key: "BUAD312", subject: "BUAD", label: "BUAD-312", title: "Marketing" }
export function courseInfo(course) {
  const m = course.short.match(/^([A-Z]{2,5})[\s_-]?(\d{3})/i);
  const title = course.name.includes(':') ? course.name.split(':').slice(1).join(':').trim() : '';
  return m
    ? { key: (m[1] + m[2]).toUpperCase(), subject: m[1].toUpperCase(), label: course.short, title }
    : { key: null, subject: null, label: course.short, title };
}

// Course keys from `courses` that `text` mentions, e.g. "CHEM 105", "chem-105a", "CHEM105".
function mentionedCourses(text, courses) {
  const found = new Set();
  for (const m of text.matchAll(/\b([A-Za-z]{2,5})[\s_-]?(\d{3})[A-Za-z]{0,2}\b/g)) {
    const key = (m[1] + m[2]).toUpperCase();
    if (courses.some((c) => c.key === key)) found.add(key);
  }
  return found;
}

const hasPhrase = (text, phrase) =>
  phrase.split(' ').length >= 2 && text.toLowerCase().includes(phrase.toLowerCase());

function checkCourse(file, course, otherCourses) {
  const all = [course, ...otherCourses].filter((c) => c.key);
  const nameText = nameAsText(file.name);
  const head = (file.text ?? '').slice(0, 2000);
  const top = (file.text ?? '').slice(0, 300); // title / header area
  const inName = mentionedCourses(nameText, all);
  const inHead = mentionedCourses(head, all);
  const inTop = mentionedCourses(top, all);
  const thisMentioned = course.key && (inName.has(course.key) || inHead.has(course.key) || hasPhrase(head, course.title));
  const label = (key) => all.find((c) => c.key === key)?.label ?? key;
  const others = (set) => [...set].filter((k) => k !== course.key);

  const check = { label: 'Class', guideline: `This is ${course.label}${course.title ? ` (${course.title})` : ''}` };
  const otherInName = others(inName);
  if (otherInName.length && !inName.has(course.key)) {
    return { ...check, level: 'bad', found: `File name mentions ${otherInName.map(label).join(', ')}`, reason: `File name says ${label(otherInName[0])}, but this is ${course.label}` };
  }
  const otherInHead = others(inHead);
  if (otherInHead.length && !thisMentioned) {
    const strong = others(inTop).length > 0;
    return {
      ...check,
      level: strong ? 'bad' : 'warn',
      found: `File ${strong ? 'header' : 'text'} mentions ${otherInHead.map(label).join(', ')}, never ${course.label}`,
      reason: `File mentions ${label(otherInHead[0])}, but this is ${course.label}`,
    };
  }
  // Subject only ("chem_lab1.pdf") or another class's title near the top.
  const nameWords = new Set(words(nameText));
  const subjectHit = otherCourses.find(
    (c) => c.subject && c.subject !== course.subject && nameWords.has(c.subject.toLowerCase())
  );
  if (subjectHit && !(course.subject && nameWords.has(course.subject.toLowerCase()))) {
    return { ...check, level: 'warn', found: `File name contains "${subjectHit.subject}"`, reason: `File name mentions ${subjectHit.subject}, but this is ${course.label}` };
  }
  const titleHit = otherCourses.find((c) => c.title && hasPhrase(top, c.title));
  if (titleHit && !thisMentioned) {
    return { ...check, level: 'warn', found: `File header mentions "${titleHit.title}"`, reason: `File looks like it's for ${titleHit.label} (${titleHit.title})` };
  }
  return { ...check, level: 'ok', found: thisMentioned ? `Mentions ${course.label}` : 'No other class mentioned' };
}

// ---------- Assignment ----------

const LABEL_TYPES = [
  ['lab', /lab/], ['assignment', /assignment|assgn|asgn|assn/], ['homework', /hw|homework/],
  ['problem set', /problem set|pset|ps/], ['project', /project|proj/], ['essay', /essay/],
  ['writing project', /wp|writing project/], ['quiz', /quiz/], ['exercise', /exercise|ex/],
  ['case study', /case study|case/], ['reflection', /reflection/], ['memo', /memo/],
  ['worksheet', /worksheet/], ['activity', /activity/], ['paper', /paper/],
];
const LABEL = /\b(lab|assignment|assgn|asgn|assn|hw|homework|problem set|pset|ps|project|proj|essay|wp|writing project|quiz|exercise|ex|case study|case|reflection|memo|worksheet|activity|paper)[\s#.-]*(\d{1,2})\b/gi;

function labelsIn(text) {
  const labels = [];
  for (const m of text.matchAll(LABEL)) {
    const word = m[1].toLowerCase();
    const type = LABEL_TYPES.find(([, re]) => new RegExp(`^(${re.source})$`).test(word))?.[0] ?? word;
    labels.push({ type, n: Number(m[2]), text: m[0] });
  }
  return labels;
}
const sameLabel = (a, b) => a.type === b.type && a.n === b.n;
const pretty = (l) => `${l.type[0].toUpperCase()}${l.type.slice(1)} ${l.n}`;

const FILLER_NAME_WORDS = new Set(['final', 'draft', 'submission', 'submit', 'v', 'version', 'copy', 'my', 'the', 'and', 'of', 'for', 'a', 'doc', 'file', 'new', 'edited', 'revised']);

function checkAssignment(file, folder) {
  const check = { label: 'Assignment', guideline: `This is "${folder.name}"` };
  const folderLabels = labelsIn(folder.name);
  const nameText = nameAsText(file.name);
  const nameLabels = labelsIn(nameText);
  const topLabels = labelsIn((file.text ?? '').slice(0, 300));
  const fileLabels = [...nameLabels, ...topLabels];
  const siblings = folder.siblingNames ?? [];

  if (folderLabels.length && fileLabels.length && !fileLabels.some((l) => folderLabels.some((f) => sameLabel(l, f)))) {
    const clash =
      fileLabels.find((l) => folderLabels.some((f) => f.type === l.type)) ??
      nameLabels.find((l) => !['exercise', 'paper', 'case study'].includes(l.type));
    if (clash) {
      const sibling = siblings.find((s) => labelsIn(s).some((l) => sameLabel(l, clash)));
      const inName = nameLabels.includes(clash);
      return {
        ...check,
        level: inName && sibling ? 'bad' : 'warn',
        found: `File ${inName ? 'name' : 'header'} says "${clash.text}"${sibling ? ` (this class also has "${sibling}")` : ''}`,
        reason: `File says ${pretty(clash)}, but this is "${folder.name}"`,
      };
    }
  }

  // File name that matches a different assignment's name better than this one.
  const nameSet = new Set(words(nameText).filter((w) => w.length > 2 && !FILLER_NAME_WORDS.has(w)));
  const overlap = (title) => words(title).filter((w) => nameSet.has(w)).length;
  const here = overlap(folder.name);
  const better = siblings.find((s) => overlap(s) >= 2 && overlap(s) > here + 1);
  if (better && here === 0) {
    return { ...check, level: 'warn', found: `File name "${file.name}" matches "${better}"`, reason: `File name looks like it's for "${better}"` };
  }
  return { ...check, level: 'ok', found: fileLabels.length ? `Mentions ${fileLabels.map((l) => `"${l.text}"`).join(', ')}` : 'Nothing pointing to another assignment' };
}

// ---------- File type ----------

const TYPE_HINTS = [
  [/\bpdfs?\b/i, ['.pdf']],
  [/\bword (doc(ument)?|file)\b|\bdocx?\b/i, ['.doc', '.docx']],
  [/\br ?markdown\b|\brmd\b/i, ['.rmd']],
  [/\bquarto\b|\bqmd\b/i, ['.qmd']],
  [/\bjupyter\b|\bipynb\b|\bipython notebook\b/i, ['.ipynb']],
  [/\bpython (file|script|code)\b|\.py\b/i, ['.py']],
  [/\br script\b|(^|\s)\.r\b/i, ['.r']],
  [/\bexcel\b|\bxlsx?\b/i, ['.xlsx', '.xls']],
  [/\bpowerpoint\b|\bpptx?\b|\bslide deck\b/i, ['.pptx', '.ppt']],
  [/\bzip(ped)? (file|folder)\b|\.zip\b/i, ['.zip']],
  [/\.java\b|\bjava file\b/i, ['.java']],
  [/\.cpp\b|\bc\+\+ (file|source)/i, ['.cpp']],
  [/\.sql\b|\bsql (file|script)\b/i, ['.sql']],
  [/\.csv\b|\bcsv file\b/i, ['.csv']],
];

// File types the instructions ask for, from sentences about submitting/uploading.
export function typesFromInstructions(text) {
  const types = new Set();
  for (const sentence of text.split(/(?<=[.!?\n])\s+/)) {
    if (!/\b(submit|upload|save|turn in|hand in|export|knit|as an?|format|file type|attach)\b/i.test(sentence)) continue;
    for (const [re, exts] of TYPE_HINTS) if (re.test(sentence)) exts.forEach((e) => types.add(e));
  }
  // A knitted R Markdown / notebook is usually turned in as HTML or PDF too.
  if (/\bknit/i.test(text)) ['.html', '.pdf'].forEach((e) => types.add(e));
  return [...types];
}

function checkType(file, folder) {
  const ext = extensionOf(file.name) || '(no extension)';
  const allowed = folder.allowedTypes?.length ? folder.allowedTypes.map((t) => t.toLowerCase()) : null;
  const asked = allowed ?? typesFromInstructions(folder.instructions ?? '');
  const check = { label: 'File type', guideline: asked.length ? `${allowed ? 'Allowed' : 'Instructions mention'}: ${asked.join(', ')}` : 'No file type specified', found: ext };
  if (!asked.length || asked.includes(ext)) return { ...check, level: 'ok' };
  const wantsCode = asked.some(isCode);
  if (wantsCode && IMAGE_TYPES.includes(ext)) {
    return { ...check, level: 'bad', reason: `Uploaded an image (${ext}), but the assignment asks for ${asked.filter(isCode).join(' / ')}` };
  }
  if (allowed) return { ...check, level: 'bad', reason: `${ext} isn't an allowed file type (${allowed.join(', ')})` };
  return { ...check, level: 'warn', reason: `Instructions mention ${asked.join(' / ')}, but this is ${ext}` };
}

// ---------- Empty / template ----------

const PLACEHOLDER = /\[(?:your|insert|type|enter|add)[^\]]{0,40}\]|<(?:your|insert)[^>]{0,40}>|type (?:your )?(?:answer|response|text) here|(?:your )?answer here|lorem ipsum|click (?:or tap )?here to enter text/i;

function jaccard(a, b) {
  const A = new Set(words(a));
  const B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  const shared = [...A].filter((w) => B.has(w)).length;
  return shared / (A.size + B.size - shared);
}

function checkContent(file, folder) {
  const check = { label: 'Content', guideline: 'A filled-in file' };
  const ext = extensionOf(file.name);
  if (file.size === 0) return { ...check, level: 'bad', found: '0 bytes', reason: 'The file is empty (0 bytes)' };
  const text = file.text.trim();
  const wordCount = countWords(text);

  if (isCode(ext) && ext !== '.html') {
    const lines = text.split('\n').filter((l) => l.trim()).length;
    if (lines < 3) return { ...check, level: 'bad', found: `${lines} non-blank lines`, reason: `The code file is nearly empty (${lines} lines)` };
  } else if (wordCount === 0) {
    return ext === '.pdf'
      ? { ...check, level: 'warn', found: 'No selectable text', reason: "The PDF has no selectable text (a scan or image?), so its content couldn't be checked" }
      : { ...check, level: 'bad', found: 'No text', reason: 'The file has no text in it' };
  } else if (wordCount < 25) {
    return { ...check, level: 'warn', found: `${wordCount} words`, reason: `The file is nearly empty (${wordCount} words)` };
  }

  const placeholder = text.match(PLACEHOLDER);
  if (placeholder) {
    return { ...check, level: 'warn', found: `Contains "${placeholder[0]}"`, reason: `Still has template text: "${placeholder[0]}"` };
  }
  for (const a of folder.attachments ?? []) {
    if (a.text && countWords(a.text) >= 30 && jaccard(text, a.text) >= 0.85 && wordCount <= countWords(a.text) * 1.15) {
      return { ...check, level: 'warn', found: `Almost identical to "${a.name}"`, reason: `Looks like the unfilled template "${a.name}"` };
    }
  }
  return { ...check, level: 'ok', found: `${wordCount} words` };
}

// ---------- Required parts ----------

const QUESTION = /\b(?:question|q|problem|prob|exercise|task)\s*#?\s*(\d{1,2})\b/gi;
const ASKED_COUNT = /\b(?:answer|complete|respond to|address|solve)\s+(?:all\s+|the following\s+|each of the\s+)?(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)\s+(?:questions|problems|prompts|exercises)/i;

function highestQuestion(text, { numberedLines = false } = {}) {
  let max = 0;
  for (const m of text.matchAll(QUESTION)) if (Number(m[1]) <= 30) max = Math.max(max, Number(m[1]));
  if (numberedLines) {
    for (const m of text.matchAll(/^\s*(\d{1,2})[.)]\s+\S/gm)) if (Number(m[1]) <= 30) max = Math.max(max, Number(m[1]));
  }
  return max;
}

// Minimum words/pages the instructions ask for, or null.
export function lengthRequirement(text) {
  const num = '(\\d[\\d,]*|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)';
  const patterns = [
    [new RegExp(`${num}\\s*(?:-|–|to)\\s*${num}\\s*[- ]?(words?|pages?)\\b`, 'i'), 1, 3],
    [new RegExp(`(?:at least|minimum(?: of)?|no (?:fewer|less) than|a min\\.? of)\\s*${num}\\s*[- ]?(words?|pages?)\\b`, 'i'), 1, 2],
    [new RegExp(`\\b${num}\\+?\\s*[- ]?(words?|pages?)\\b`, 'i'), 1, 2],
  ];
  for (const [re, n, unit] of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const value = toNumber(m[n]);
    const kind = m[unit].toLowerCase().startsWith('page') ? 'pages' : 'words';
    // "a 1-page summary" is fine; ignore tiny/odd word counts that are probably something else.
    if (kind === 'words' && value < 100) continue;
    if (kind === 'pages' && (value < 1 || value > 50)) continue;
    return { kind, value, text: m[0] };
  }
  return null;
}

function checkParts(file, folder) {
  const instructions = folder.instructions ?? '';
  const checks = [];
  const ext = extensionOf(file.name);
  const text = file.text;

  const asked = Math.max(highestQuestion(instructions), toNumber(instructions.match(ASKED_COUNT)?.[1] ?? '0') || 0);
  if (asked >= 3) {
    const answered = highestQuestion(text, { numberedLines: true });
    const check = { label: 'Questions', guideline: `Instructions go up to question ${asked}` };
    if (answered && answered < asked) {
      checks.push({ ...check, level: 'warn', found: `File seems to stop at question ${answered}`, reason: `Instructions go up to question ${asked}, but the file seems to stop at ${answered}` });
    } else {
      checks.push({ ...check, level: 'ok', found: answered ? `Goes up to question ${answered}` : "Couldn't tell which questions are answered" });
    }
  }

  const need = isCode(ext) ? null : lengthRequirement(instructions);
  if (need) {
    const wordCount = countWords(text);
    const check = { label: 'Length', guideline: `Instructions: "${need.text}"` };
    if (need.kind === 'words') {
      const short = wordCount < need.value * 0.6;
      checks.push({ ...check, level: short ? 'warn' : 'ok', found: `About ${wordCount} words`, ...(short && { reason: `About ${wordCount} words; instructions ask for ${need.value}` }) });
    } else {
      const pages = file.pages ?? null;
      const short = pages != null ? pages < need.value * 0.6 : wordCount < need.value * 150;
      const found = pages != null ? `${pages} page${pages === 1 ? '' : 's'}` : `About ${wordCount} words (≈${Math.max(1, Math.round(wordCount / 300))} pages)`;
      checks.push({ ...check, level: short ? 'warn' : 'ok', found, ...(short && { reason: `${found}; instructions ask for ${need.value} pages` }) });
    }
  }
  return checks;
}

// ---------- Keyword overlap ----------

const STOP = new Set(('about above after again against because before being below between could doing during each further having other ourselves should their there these those through under until where which while would yourself '
  + 'assignment assignments submit submission submissions upload uploaded points point rubric format deadline please include including following brightspace students student grade grading graded late policy words pages file files document documents class course instructor professor canvas email questions question answer answers complete completed using write written response responses check below above make sure note notes example examples order total score').split(' '));

function checkKeywords(file, folder) {
  const ext = extensionOf(file.name);
  const instructions = folder.instructions ?? '';
  if (isCode(ext) || countWords(instructions) < 40 || countWords(file.text) < 150) return null;
  const keys = [...new Set(words(instructions).filter((w) => w.length >= 5 && !STOP.has(w) && !/^\d+$/.test(w)))];
  if (keys.length < 12) return null;
  const have = new Set(words(file.text));
  const found = keys.filter((k) => have.has(k));
  const share = found.length / keys.length;
  const check = { label: 'Topic', guideline: `Key words from the instructions: ${keys.slice(0, 8).join(', ')}…`, found: found.length ? `Shares ${found.length} of ${keys.length}: ${found.slice(0, 8).join(', ')}` : `Shares none of ${keys.length}` };
  return share < 0.05
    ? { ...check, level: 'warn', reason: "The file shares almost none of the instructions' key words" }
    : { ...check, level: 'ok' };
}

// ---------- Putting it together ----------

// input: {
//   course: { short, name }, otherCourses: [{ short, name }],
//   folder: { name, instructions, allowedTypes: ['.pdf'] | null, attachments: [{ name, text }], siblingNames: [] },
//   submission: null | { date, files: [{ name, size, text|null, pages|null, readError|null }] },
// }
// Returns { status: 'none'|'ok'|'warn'|'bad', reason, checks: [{ file, label, guideline, found, level, reason? }], ... }
export function analyze({ course, otherCourses, folder, submission }) {
  if (!submission || !submission.files?.length) {
    return { status: 'none', reason: 'Not submitted yet', checks: [] };
  }
  const me = courseInfo(course);
  const others = otherCourses.map(courseInfo).filter((c) => c.key !== me.key || !me.key);
  const checks = [];

  for (const file of submission.files) {
    const add = (c) => c && checks.push({ file: file.name, ...c });
    add(checkType(file, folder));
    if (file.text == null) {
      add(checkCourse({ ...file, text: '' }, me, others));
      add(checkAssignment({ ...file, text: '' }, folder));
      add({
        label: 'Content', level: 'warn', guideline: 'A readable file', found: file.readError ?? "Couldn't read this file type",
        reason: `${file.readError ?? "Couldn't read this file type"}; only the file name and type were checked`,
      });
      continue;
    }
    add(checkCourse(file, me, others));
    add(checkAssignment(file, folder));
    add(checkContent(file, folder));
    checkParts(file, folder).forEach(add);
    add(checkKeywords(file, folder));
  }

  const status = worst(checks.map((c) => c.level));
  const first = checks.find((c) => c.level === status && c.reason);
  return {
    status,
    reason: status === 'ok' ? 'Looks right' : first?.reason ?? 'Possible problem',
    checks,
  };
}
