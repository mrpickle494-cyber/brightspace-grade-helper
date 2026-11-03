// Finds things due on a given day inside loosely written text (announcements,
// schedules). Everything uses your computer's local time zone.
//
// Input is a list of "lines". A line is { cells: [text, ...] }: one cell for a
// sentence or paragraph, several cells for a table row (plus `table`, which
// table it came from, and `width`, how many columns that table has).

const MONTH_NAMES = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const WEEKDAY_NAMES = 'sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?';

const MONTH_DAY = new RegExp(`\\b(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4})\\b)?`, 'gi'); // Oct 5, October 5th, 2026
const DAY_MONTH = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_NAMES})\\b\\.?(?:,?\\s+(\\d{4})\\b)?`, 'gi'); // 5 Oct, 5th of October
const NUMERIC = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/g; // 10/5, 10/5/26
const ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/g; // 2026-10-05
const RELATIVE = /\b(today|tonight|tomorrow)\b/gi;
const WEEKDAY = new RegExp(`\\b(${WEEKDAY_NAMES})\\b\\.?`, 'gi');

const TIME_12H = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m\b\.?/i; // 11:59pm, 5 PM, 9 a.m.
const TIME_RANGE = /\b(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?\s?m\.?)?\s*(?:-|–|—|to)\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m\b/i; // 7:00–9:00 PM
const TIME_24H = /\b([01]?\d|2[0-3]):([0-5]\d)\b/; // 23:59
const TIME_WORD = /\b(noon|midnight)\b/i;

// Words that make a sentence in an announcement look like something you have to do.
const TASK_WORDS = /\b(due|submit|submission|turn(?:ed)? in|deadline|upload|post|complete|finish|read|reading|watch|bring|prepare|quiz|exam|test|midterm|final|draft|essay|paper|assignment|homework|hw|project|presentation|reflection|discussion|response|lab|worksheet|problem set|pset|by)\b/i;

const MONTH_INDEX = (name) => ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(name.slice(0, 3).toLowerCase());
const WEEKDAY_INDEX = (name) => ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(name.slice(0, 3).toLowerCase());

export const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const sameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const DAY = 24 * 60 * 60 * 1000;

// A month/day with no year: pick the year that lands closest to `ref`, and ignore
// it if that's still more than ~4 months away (it's probably not a date, like "1/2 page").
function nearbyDate(month, day, year, ref) {
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  const years = year ? [year] : [ref.getFullYear() - 1, ref.getFullYear(), ref.getFullYear() + 1];
  let best = null;
  for (const y of years) {
    const d = new Date(y, month, day);
    if (d.getMonth() !== month) continue; // e.g. 2/30
    if (!best || Math.abs(d - ref) < Math.abs(best - ref)) best = d;
  }
  if (best && !year && Math.abs(best - ref) > 120 * DAY) return null;
  return best;
}

const fullYear = (y) => (!y ? null : y.length === 2 ? 2000 + Number(y) : Number(y));

// Every date mentioned in `text`. `ref` is when the text was written: it decides
// the year for "Oct 5" and, if `relative` is on, what "tomorrow" or "Tuesday" means.
export function findDates(text, ref, { relative = false } = {}) {
  const found = [];
  for (const m of text.matchAll(MONTH_DAY)) found.push(nearbyDate(MONTH_INDEX(m[1]), Number(m[2]), fullYear(m[3]), ref));
  for (const m of text.matchAll(DAY_MONTH)) found.push(nearbyDate(MONTH_INDEX(m[2]), Number(m[1]), fullYear(m[3]), ref));
  for (const m of text.matchAll(NUMERIC)) found.push(nearbyDate(Number(m[1]) - 1, Number(m[2]), fullYear(m[3]), ref));
  for (const m of text.matchAll(ISO)) found.push(nearbyDate(Number(m[2]) - 1, Number(m[3]), Number(m[1]), ref));
  const explicit = found.filter(Boolean);

  if (relative) {
    const day = startOfDay(ref);
    for (const m of text.matchAll(RELATIVE)) {
      explicit.push(m[1].toLowerCase() === 'tomorrow' ? addDays(day, 1) : day);
    }
    // A bare weekday ("by Tuesday") means the next one after the post date,
    // but only when no real date is written next to it.
    if (!found.some(Boolean)) {
      for (const m of text.matchAll(WEEKDAY)) {
        const ahead = (WEEKDAY_INDEX(m[1]) - day.getDay() + 7) % 7 || 7;
        explicit.push(addDays(day, ahead));
      }
    }
  }
  return explicit;
}

// The first time of day in `text`, as { hours, minutes }, or null.
export function findTime(text) {
  // A range like "7:00–9:00 PM" starts at 7 PM; "11–1 pm" starts at 11 AM.
  let m = text.match(TIME_RANGE);
  if (m && Number(m[1]) <= 12 && Number(m[4]) <= 12) {
    const endHour = (Number(m[4]) % 12) + (m[6].toLowerCase() === 'p' ? 12 : 0);
    let hours = Number(m[1]) % 12;
    if (m[3]) hours += m[3].toLowerCase() === 'p' ? 12 : 0;
    else if (m[6].toLowerCase() === 'p' && hours + 12 <= endHour) hours += 12;
    return { hours, minutes: Number(m[2] ?? 0) };
  }
  m = text.match(TIME_12H);
  if (m) {
    let hours = Number(m[1]) % 12;
    if (m[3].toLowerCase() === 'p') hours += 12;
    return Number(m[1]) <= 12 ? { hours, minutes: Number(m[2] ?? 0) } : null;
  }
  m = text.match(TIME_WORD);
  if (m) return m[1].toLowerCase() === 'noon' ? { hours: 12, minutes: 0 } : { hours: 23, minutes: 59 };
  m = text.match(TIME_24H);
  if (m) return { hours: Number(m[1]), minutes: Number(m[2]) };
  return null;
}

// What's left of a cell once dates, weekdays and times are removed, e.g. "Tue 10/6" -> "".
function withoutDates(text) {
  return text
    .replace(MONTH_DAY, ' ').replace(DAY_MONTH, ' ').replace(NUMERIC, ' ').replace(ISO, ' ')
    .replace(RELATIVE, ' ').replace(WEEKDAY, ' ')
    .replace(new RegExp(TIME_12H.source, 'gi'), ' ').replace(new RegExp(TIME_24H.source, 'g'), ' ')
    .replace(/\b(week|wk|due|by|on|at)\b\.?\s*\d*/gi, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const clip = (s, n = 160) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const tidy = (s) => s.replace(/\s+/g, ' ').replace(/^[\s\-–—:•*|]+|[\s\-–—:•*|]+$/g, '');

// Long paragraphs become one line per sentence, so each result is a readable sentence.
export function splitSentences(lines) {
  return lines.flatMap((line) =>
    line.cells.length === 1 && line.table == null
      ? line.cells[0].split(/(?<=[.!?])\s+(?=[A-Z])/).map((s) => ({ cells: [s] }))
      : [line]
  );
}

// Words that mark a test or quiz. "Final" only counts when it isn't a final draft/paper/etc.
export const TEST_WORDS = /\b(exam(?:s|inations?)?|midterms?|tests?|quiz(?:zes)?|final(?!\s+(?:draft|paper|project|essay|portfolio|version|submission|presentation|reflection|grade)s?\b)s?)\b/i;

// Things that mention a test but aren't one: study sessions, practice, answer keys.
export const NOT_A_TEST = /\b(sample|practice|mock|walk-?throughs?|study (?:sessions?|guides?|groups?|hall)|review (?:sessions?|sheets?|guides?|packets?|questions?)|(?:exam|quiz|test|midterm|final) review|help sessions?|office hours?|solutions?|answer keys?|recitation|tutoring|workshop)\b/i;
export const isTest = (text) => TEST_WORDS.test(text) && !NOT_A_TEST.test(text);

// Every line that mentions a date. Returns
// [{ text, dates: [Date], time: { hours, minutes } | null, kind }] where kind is
// 'row' (table row), 'sentence', or 'listed' (a line under a date heading).
//   ref:      when the text was written (for years, and for relative dates)
//   relative: understand "tomorrow", "by Tuesday" (announcements only)
export function findMentions(lines, { ref, relative = false }) {
  const results = [];
  let heading = null; // a short line that is just a date, like "Tuesday, Oct 6:"
  const carried = new Map(); // table -> date cell from the row above (for merged cells)

  for (const line of splitSentences(lines)) {
    const cells = line.cells.map(tidy);
    const joined = cells.join(' | ');
    const datesHere = findDates(joined, ref, { relative });

    if (line.table != null) {
      // A table row with no date of its own inherits the date from the row above
      // when its first cell is empty or missing (merged "rowspan" date cells).
      let rowText = joined;
      if (!datesHere.length && (cells.length < line.width || !cells[0]) && carried.has(line.table)) {
        rowText = `${carried.get(line.table)} | ${joined}`;
      } else if (datesHere.length) {
        carried.set(line.table, cells.find((c) => findDates(c, ref, { relative }).length) ?? '');
      }
      const dates = findDates(rowText, ref, { relative });
      const what = cells.filter((c) => withoutDates(c).length >= 3).join(' — ');
      if (dates.length && what) results.push({ text: clip(what), dates, time: findTime(rowText), kind: 'row' });
      continue;
    }

    const text = cells[0];
    if (!text) continue;
    // A heading is a line that's (almost) only a date, e.g. "Monday, Oct 5:" or "Class 12 - 10/5".
    if (datesHere.length && withoutDates(text).split(' ').filter(Boolean).length <= 1) {
      heading = { dates: datesHere, time: findTime(text), count: 0 };
      continue;
    }

    if (datesHere.length) {
      heading = null;
      results.push({ text: clip(text), dates: datesHere, time: findTime(text), kind: 'sentence' });
    } else if (heading && heading.count < 10) {
      // Lines listed under a date heading belong to that date.
      heading.count++;
      results.push({ text: clip(text), dates: heading.dates, time: findTime(text) ?? heading.time, kind: 'listed' });
    }
  }
  return results;
}

// Finds everything due on `target` in `lines`.
// Returns [{ text, time: { hours, minutes } | null }].
//   taskWords: outside tables, also require a word like "due" or "submit"
export function findDueOn(lines, target, { ref = target, relative = false, taskWords = false } = {}) {
  return findMentions(lines, { ref, relative })
    .filter((m) => m.dates.some((d) => sameDay(d, target)))
    .filter((m) => !taskWords || m.kind === 'row' || TASK_WORDS.test(m.text))
    .map(({ text, time }) => ({ text, time }));
}
