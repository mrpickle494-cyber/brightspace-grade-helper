// Shared by the "Due tomorrow" and "Tests & quizzes" dropdowns: reading announcements
// and schedule pages, merging duplicates, and checking every class.

import { BASE, LE, apiGet, apiGetText, apiGetBinary, tracked, mapLimit, getCourses } from './api.js';
import { addDays, TEST_WORDS } from './dates.js';
import { extractText } from './extract.js';
import { extensionOf } from './analyze.js';

// A day plus a { hours, minutes } time -> Date, or null if the time isn't known.
export const atTime = (day, time) =>
  time ? new Date(day.getFullYear(), day.getMonth(), day.getDate(), time.hours, time.minutes) : null;

// "2026-10-05T00:00:00.000Z" -> Oct 5 in local time (all-day events have no real time).
export const localDay = (s) => {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
};

// Content pages and announcement titles that look like a schedule.
const SCHEDULE = /schedule|calendar|timeline|due dates|deadlines|work ?plan|weekly plan|agenda|syllabus/i;

// ---------- Reading HTML ----------

const clean = (s) => s.replace(/\s+/g, ' ').trim();
const BLOCK = /^(P|DIV|LI|H[1-6]|UL|OL|SECTION|ARTICLE|BLOCKQUOTE|PRE|HEADER|FOOTER|DT|DD|TR)$/;

// Turns HTML into the "lines" dates.js reads: one per paragraph/list item,
// and one per table row with its cells kept separate.
export function htmlToLines(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const lines = [];
  let buffer = '';
  let tables = 0;
  const flush = () => {
    const text = clean(buffer);
    if (text) lines.push({ cells: [text] });
    buffer = '';
  };
  const cellText = (cell) => {
    cell.querySelectorAll('br, p, div, li').forEach((n) => n.before(' '));
    return clean(cell.textContent);
  };
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      buffer += node.textContent;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || /^(SCRIPT|STYLE)$/.test(node.tagName)) return;
    if (node.tagName === 'BR') return flush();
    if (node.tagName === 'TABLE') {
      flush();
      const table = tables++;
      const rows = [...node.rows];
      const width = Math.max(0, ...rows.map((r) => r.cells.length));
      for (const row of rows) {
        const cells = [...row.cells].map(cellText);
        if (cells.some(Boolean)) lines.push({ cells, table, width });
      }
      return;
    }
    const block = BLOCK.test(node.tagName);
    if (block) flush();
    node.childNodes.forEach(walk);
    if (block) flush();
  };
  if (doc.body) walk(doc.body);
  flush();
  return lines;
}

const textToLines = (text) => text.split(/\r?\n/).map((t) => ({ cells: [clean(t)] })).filter((l) => l.cells[0]);

// ---------- Reading files (PDF, Word, text) ----------

const READABLE_FILES = ['.pdf', '.docx', '.txt', '.md', '.csv'];

// Downloaded files, kept while the dashboard is open so the two dropdowns
// don't download the same syllabus twice. path -> Promise<{ text } | { text: null, readError }>
const fileCache = new Map();
function readRemoteFile(path, name) {
  if (!fileCache.has(path)) {
    fileCache.set(
      path,
      tracked('Content files', () => apiGetBinary(path))
        .then((buffer) => extractText(name, buffer))
        .catch((err) => {
          fileCache.delete(path);
          throw err;
        })
    );
  }
  return fileCache.get(path);
}

// ---------- Announcements ----------

// Announcements posted in the last `days` days, as
// [{ posted (Date), lines, url, isSchedule }]. Attached PDF/Word files that look like
// a schedule, syllabus, or exam info are read too and returned as their own entries.
export async function readAnnouncements(course, days) {
  const news = await tracked('Announcements', () => apiGet(`/d2l/api/le/${LE}/${course.id}/news/`));
  const now = new Date();
  const oldest = addDays(now, -days);
  const recent = news
    .map((n) => ({ n, posted: new Date(n.StartDate ?? n.CreatedDate ?? now) }))
    .filter(({ posted }) => posted >= oldest && posted <= now);

  const entries = recent.map(({ n, posted }) => ({
    posted,
    lines: [
      { cells: [n.Title ?? ''] },
      ...(n.Body?.Html ? htmlToLines(n.Body.Html) : textToLines(n.Body?.Text ?? '')),
    ],
    url: `${BASE}/d2l/le/news/${course.id}/${n.Id}/view`,
    isSchedule: SCHEDULE.test(n.Title ?? ''),
  }));

  const attachments = recent
    .flatMap(({ n, posted }) =>
      (n.Attachments ?? []).map((a) => ({ n, posted, a }))
    )
    .filter(({ n, a }) =>
      READABLE_FILES.includes(extensionOf(a.FileName)) &&
      [a.FileName, n.Title ?? ''].some((t) => SCHEDULE.test(t) || TEST_WORDS.test(t))
    )
    .slice(0, 4);
  await mapLimit(attachments, 2, async ({ n, posted, a }) => {
    try {
      const { text } = await readRemoteFile(`/d2l/api/le/${LE}/${course.id}/news/${n.Id}/attachments/${a.FileId}`, a.FileName);
      if (text) {
        entries.push({
          posted,
          lines: [{ cells: [a.FileName] }, ...textToLines(text)],
          url: `${BASE}/d2l/le/news/${course.id}/${n.Id}/view`,
          isSchedule: true,
        });
      }
    } catch {
      // Skip an attachment that won't download; the announcement text is still read.
    }
  });
  return entries;
}

// ---------- Content (schedule pages) ----------

// Topics in the course content tree whose title, or whose module's title, looks like
// a schedule (or matches `extraTitles`, e.g. "Exam 2 info"). Also returns matching
// modules (their description can hold one) and every title that contains a number,
// since titles alone are sometimes dated ("Exam 2 - Tue 10/6").
function scheduleCandidates(toc, extraTitles) {
  const topics = [];
  const modules = [];
  const titles = [];
  const wanted = (title) => SCHEDULE.test(title ?? '') || Boolean(extraTitles?.test(title ?? ''));
  const visit = (module, inSchedule) => {
    const match = inSchedule || SCHEDULE.test(module.Title ?? '');
    if (/\d/.test(module.Title ?? '')) titles.push({ title: module.Title, topic: null });
    if (wanted(module.Title) && module.Description?.Html) modules.push(module);
    for (const t of module.Topics ?? []) {
      if (t.IsHidden) continue;
      if (match || wanted(t.Title)) topics.push(t);
      if (/\d/.test(t.Title ?? '')) titles.push({ title: t.Title, topic: t });
    }
    for (const child of module.Modules ?? []) visit(child, match);
  };
  for (const m of toc.Modules ?? []) visit(m, false);
  return { topics: topics.slice(0, 12), modules, titles };
}

// Schedule pages in a course's Content, as { docs: [{ lines, url }], unreadable: [{ title, url }] }.
// HTML pages, PDFs, Word and text files are read; "unreadable" lists the rest (e.g. PowerPoint).
//   extraTitles: also read topics whose title matches this (besides schedules/syllabi)
export async function readSchedules(course, { extraTitles = null } = {}) {
  const toc = await tracked('Content', () => apiGet(`/d2l/api/le/${LE}/${course.id}/content/toc`));
  const { topics, modules, titles } = scheduleCandidates(toc, extraTitles);
  const home = `${BASE}/d2l/le/content/${course.id}/Home`;
  const topicUrl = (t) => `${BASE}/d2l/le/content/${course.id}/viewContent/${t.TopicId}/View`;

  const docs = [
    ...modules.map((m) => ({ lines: htmlToLines(m.Description.Html), url: home })),
    ...titles.map(({ title, topic }) => ({ lines: [{ cells: [title] }], url: topic ? topicUrl(topic) : home })),
  ];
  const unreadable = [];

  await mapLimit(topics, 3, async (t) => {
    const fileName = (t.Url ?? '').split('?')[0];
    const ext = extensionOf(fileName);
    if (t.TypeIdentifier === 'Link') return; // external website
    const filePath = `/d2l/api/le/${LE}/${course.id}/content/topics/${t.TopicId}/file`;
    if (ext === '.html' || ext === '.htm') {
      // Read as HTML so schedule tables keep their rows and columns.
      const { text } = await tracked('Content files', () => apiGetText(filePath));
      docs.push({ lines: htmlToLines(text), url: topicUrl(t) });
    } else if (READABLE_FILES.includes(ext)) {
      const { text, readError } = await readRemoteFile(filePath, fileName);
      if (text) docs.push({ lines: textToLines(text), url: topicUrl(t) });
      else unreadable.push({ title: `${t.Title} (${readError})`, url: topicUrl(t) });
    } else if (/\.(pptx?|doc|xlsx?)$/i.test(ext)) {
      unreadable.push({ title: t.Title, url: topicUrl(t) });
    }
  });
  return { docs, unreadable };
}

// ---------- Merging duplicates ----------

const FILLER = new RegExp(
  [
    'due', 'is', 'are', 'submit', 'submission', 'turn', 'in', 'deadline', 'tonight', 'tomorrow', 'today',
    'by', 'at', 'on', 'the', 'your', 'a', 'an', 'of', 'to', 'for', 'and', 'please', 'reminder', 'will', 'be',
    'availability', 'ends', 'end', 'date', 'am', 'pm', 'brightspace',
    'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
    'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
    'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  ].map((w) => `\\b${w}\\b`).join('|'),
  'g'
);

const words = (title) =>
  new Set(
    title.toLowerCase()
      .replace(/\d{1,2}\/\d{1,2}(\/\d{2,4})?|\d{1,2}(:\d{2})?\s*[ap]\.?m\.?/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(FILLER, ' ')
      .split(' ')
      .filter(Boolean)
  );

const STRUCTURED = ['assignment', 'quiz', 'calendar'];
const RANK = { assignment: 0, quiz: 0, calendar: 1, schedule: 2, announcement: 3 };
const best = (item) => Math.min(...item.sources.map((s) => RANK[s]));

function isSame(a, b) {
  if (a.course.id !== b.course.id) return false;
  // Items that carry a day (tests) must be on the same day: "Weekly quiz" every week isn't one item.
  if (a.day && b.day && a.day.getTime() !== b.day.getTime()) return false;
  if (a.folderId != null && b.folderId != null) return String(a.folderId) === String(b.folderId);
  const wa = words(a.title);
  const wb = words(b.title);
  if (!wa.size || !wb.size) return false;
  const shared = [...wa].filter((w) => wb.has(w)).length;
  if (shared / (wa.size + wb.size - shared) >= 0.5) return true;
  // A sentence from an announcement/schedule that contains an assignment's whole name.
  const freeText = (x) => !x.sources.some((s) => STRUCTURED.includes(s));
  const smaller = Math.min(wa.size, wb.size);
  return freeText(a) !== freeText(b) && smaller >= 2 && shared === smaller;
}

// Lists each thing once. The assignment/quiz/calendar version wins for title and
// link; the "found in" list keeps every place it showed up.
export function mergeDuplicates(items) {
  const merged = [];
  for (const item of [...items].sort((a, b) => best(a) - best(b))) {
    const twin = merged.find((m) => isSame(m, item));
    if (!twin) {
      merged.push({ ...item, sources: [...item.sources] });
      continue;
    }
    for (const s of item.sources) if (!twin.sources.includes(s)) twin.sources.push(s);
    twin.time ??= item.time;
    twin.opens ??= item.opens;
    twin.folderId ??= item.folderId;
    twin.submitted ??= item.submitted;
    twin.check ??= item.check;
  }
  return merged;
}

// ---------- Checking every class ----------

// sources: [[label, fn(course)]], where fn returns a list of items or
// { items, unreadable }. Returns { course, items, problems: [{ text, url? }], failed }.
async function scanCourse(course, sources) {
  const results = await Promise.allSettled(sources.map(([, fn]) => fn(course)));
  const items = [];
  const problems = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      problems.push({ text: `Couldn't check ${sources[i][0]} (${r.reason?.message ?? 'error'})` });
      return;
    }
    const value = r.value;
    if (Array.isArray(value)) {
      items.push(...value);
    } else {
      items.push(...value.items);
      for (const u of value.unreadable) {
        problems.push({ text: `Can't read "${u.title}". Check it yourself`, url: u.url });
      }
    }
  });
  const failed = results.every((r) => r.status === 'rejected');
  return { course, items: mergeDuplicates(items), problems, failed };
}

// Checks every current class, two at a time. Calls onStart(courses) once the class
// list is known, then onCourse(result) as each class finishes.
export async function scanAll({ sources, onStart, onCourse }) {
  const { current } = await getCourses();
  onStart?.(current);
  await mapLimit(current, 2, async (course) => {
    let result;
    try {
      result = await scanCourse(course, sources);
    } catch (err) {
      result = { course, items: [], problems: [{ text: `Couldn't load (${err.message})` }], failed: true };
    }
    onCourse?.(result);
  });
}
