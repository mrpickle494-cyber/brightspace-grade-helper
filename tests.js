// "Tests & quizzes": every upcoming exam, midterm, final, and quiz in the next few
// months, from quizzes, the calendar, announcements, and schedule pages in Content.

import { getAllQuizzes, getCalendarEvents, quizUrl, eventUrl } from './api.js';
import { findMentions, TEST_WORDS, NOT_A_TEST, isTest, startOfDay, addDays } from './dates.js';
import { atTime, localDay, readAnnouncements, readSchedules, scanAll } from './scan.js';

// Item: { course, title, kind ('Exam'|'Quiz'), day (Date, midnight), time (Date|null),
//         opens (Date|null, when an online quiz opens), url,
//         sources: ['quiz'|'calendar'|'schedule'|'announcement'] }

export const TEST_DAYS = 120; // how far ahead to look (covers finals)

const kindOf = (title) => (/\b(exam|midterm|final|test)s?\b/i.test(title) ? 'Exam' : 'Quiz');

// Online quizzes in Brightspace. Listed on the day they close (or open, if they never close).
async function fromQuizzes(course, from, to) {
  // Practice/sample quizzes aren't real tests.
  const quizzes = (await getAllQuizzes(course)).filter((q) => q.IsActive && !NOT_A_TEST.test(q.Name));
  const items = [];
  for (const q of quizzes) {
    const closes = q.DueDate ? new Date(q.DueDate) : q.EndDate ? new Date(q.EndDate) : null;
    const opens = q.StartDate ? new Date(q.StartDate) : null;
    const when = closes ?? opens;
    if (!when || when < from || when >= to) continue;
    items.push({
      course,
      title: q.Name,
      kind: kindOf(q.Name),
      day: startOfDay(when),
      time: when,
      opens: closes && opens && opens > new Date() ? opens : null,
      url: quizUrl(course, q.QuizId),
      sources: ['quiz'],
    });
  }
  return items;
}

// Calendar events with "exam", "midterm", "quiz", etc. in the title. Events made by
// Brightspace quizzes are skipped since fromQuizzes already has them with better dates.
async function fromCalendar(course, from, to) {
  const events = await getCalendarEvents(course, from, to);
  const items = [];
  for (const e of events) {
    if (/quiz/i.test(e.AssociatedEntity?.AssociatedEntityType ?? '')) continue;
    if (!isTest(e.Title)) continue;
    const day = e.IsAllDayEvent ? localDay(e.StartDay ?? e.StartDateTime) : startOfDay(new Date(e.StartDateTime));
    if (day < from || day >= to) continue;
    const title = e.Title.replace(/\s*[-–]\s*(due|availability ends|end date)\s*$/i, '');
    items.push({
      course,
      title,
      kind: kindOf(title),
      day,
      time: e.IsAllDayEvent ? null : new Date(e.StartDateTime),
      opens: null,
      url: eventUrl(course, e),
      sources: ['calendar'],
    });
  }
  return items;
}

// Sentences/rows that mention a test word and a date in range.
function mentionsToItems(course, lines, { ref, relative, from, to, url, source }) {
  const items = [];
  for (const m of findMentions(lines, { ref, relative })) {
    if (!isTest(m.text)) continue;
    const day = m.dates.map(startOfDay).find((d) => d >= from && d < to);
    if (!day) continue;
    items.push({
      course,
      title: m.text,
      kind: kindOf(m.text),
      day,
      time: atTime(day, m.time),
      opens: null,
      url,
      sources: [source],
    });
  }
  return items;
}

// Announcements from the last ~2 months (exam dates are often announced early).
async function fromAnnouncements(course, from, to) {
  return (await readAnnouncements(course, 60)).flatMap((a) =>
    mentionsToItems(course, a.lines, {
      ref: a.posted, relative: true, from, to, url: a.url,
      source: a.isSchedule ? 'schedule' : 'announcement',
    })
  );
}

async function fromContent(course, from, to) {
  const { docs, unreadable } = await readSchedules(course, { extraTitles: TEST_WORDS });
  const items = docs.flatMap((doc) =>
    mentionsToItems(course, doc.lines, { ref: new Date(), relative: false, from, to, url: doc.url, source: 'schedule' })
  );
  return { items, unreadable };
}

// By day, then by time within the day (unknown times last), then class name.
export function sortTests(items) {
  return [...items].sort(
    (a, b) =>
      a.day - b.day ||
      (a.time ? 0 : 1) - (b.time ? 0 : 1) ||
      (a.time && b.time ? a.time - b.time : 0) ||
      a.course.name.localeCompare(b.course.name)
  );
}

export function scanTests({ onStart, onCourse }) {
  const from = startOfDay(new Date());
  const to = addDays(from, TEST_DAYS);
  return scanAll({
    sources: [
      ['quizzes', (c) => fromQuizzes(c, from, to)],
      ['calendar', (c) => fromCalendar(c, from, to)],
      ['announcements', (c) => fromAnnouncements(c, from, to)],
      ['course content', (c) => fromContent(c, from, to)],
    ],
    onStart,
    onCourse,
  });
}
