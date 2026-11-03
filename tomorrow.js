// "Due tomorrow": checks every class for anything due tomorrow, from four places:
// the calendar, assignment folders, announcements, and schedule pages in Content.

import {
  LE, apiGet, tracked, mapLimit, getCalendarEvents, assignmentUrl, eventUrl,
} from './api.js';
import { findDueOn, startOfDay, addDays, sameDay } from './dates.js';
import { atTime, localDay, readAnnouncements, readSchedules, scanAll } from './scan.js';
import { checkFolder } from './checker.js';

// Item: { course, title, time (Date|null, null = time unknown), url,
//         sources: ['assignment'|'calendar'|'schedule'|'announcement'], submitted, folderId,
//         check (submission-check result, assignments only) }

export const tomorrowDate = () => addDays(startOfDay(new Date()), 1);

async function fromCalendar(course, day) {
  const events = await getCalendarEvents(course, addDays(day, -1), addDays(day, 2));
  const items = [];
  for (const e of events) {
    // "Quiz 3 - Availability Starts" isn't something to do.
    if (/\b(availability starts|start date|starts)\s*$/i.test(e.Title)) continue;
    let time = null;
    if (e.IsAllDayEvent) {
      const start = localDay(e.StartDay ?? e.StartDateTime);
      const end = localDay(e.EndDay ?? e.EndDateTime ?? e.StartDateTime);
      if (start > day || end < day) continue;
    } else {
      const start = new Date(e.StartDateTime);
      const end = new Date(e.EndDateTime ?? e.StartDateTime);
      if (sameDay(end, day)) time = end;
      else if (sameDay(start, day)) time = start;
      else continue;
    }
    const type = e.AssociatedEntity?.AssociatedEntityType ?? '';
    items.push({
      course,
      title: e.Title.replace(/\s*[-–]\s*(due|availability ends|end date)\s*$/i, ''),
      time,
      url: eventUrl(course, e),
      sources: ['calendar'],
      folderId: /dropbox/i.test(type) ? e.AssociatedEntity.AssociatedEntityId : null,
    });
  }
  return items;
}

async function fromAssignments(course, day) {
  const folders = await tracked('Assignment list', () =>
    apiGet(`/d2l/api/le/${LE}/${course.id}/dropbox/folders/`)
  );
  const dueTomorrow = folders.filter((f) => !f.IsHidden && f.DueDate && sameDay(new Date(f.DueDate), day));
  return mapLimit(dueTomorrow, 4, async (f) => {
    let submitted = null;
    try {
      const entries = [
        await tracked('Assignment submissions', () =>
          apiGet(`/d2l/api/le/${LE}/${course.id}/dropbox/folders/${f.Id}/submissions/mysubmissions/`)
        ),
      ].flat();
      submitted = entries.some((e) => e?.Submissions?.length);
    } catch {
      // Unknown; still list it.
    }
    // Submitted work gets the submission check (read-only) so a wrong file shows up here.
    let check = null;
    if (submitted === false) check = { status: 'none', reason: 'Not submitted yet', checks: [] };
    if (submitted) {
      check = await checkFolder(course.id, f.Id).catch((err) => ({
        status: 'warn', reason: `Couldn't check the submission (${err.message})`, checks: [],
      }));
    }
    return {
      course,
      title: f.Name,
      time: new Date(f.DueDate),
      url: assignmentUrl(course, f.Id),
      sources: ['assignment'],
      submitted,
      folderId: f.Id,
      check,
    };
  });
}

// Only announcements from the last 4 weeks; older ones are about older work.
async function fromAnnouncements(course, day) {
  const items = [];
  for (const a of await readAnnouncements(course, 28)) {
    for (const found of findDueOn(a.lines, day, { ref: a.posted, relative: true, taskWords: !a.isSchedule })) {
      items.push({
        course,
        title: found.text,
        time: atTime(day, found.time),
        url: a.url,
        sources: [a.isSchedule ? 'schedule' : 'announcement'],
      });
    }
  }
  return items;
}

async function fromContent(course, day) {
  const { docs, unreadable } = await readSchedules(course);
  const items = docs.flatMap((doc) =>
    findDueOn(doc.lines, day).map((found) => ({
      course,
      title: found.text,
      time: atTime(day, found.time),
      url: doc.url,
      sources: ['schedule'],
    }))
  );
  return { items, unreadable };
}

// Timed items first by time, then items with no known time; ties by class name.
export function sortByTime(items) {
  return [...items].sort(
    (a, b) =>
      (a.time ? 0 : 1) - (b.time ? 0 : 1) ||
      (a.time && b.time ? a.time - b.time : 0) ||
      a.course.name.localeCompare(b.course.name)
  );
}

export function scanTomorrow({ day = tomorrowDate(), onStart, onCourse }) {
  return scanAll({
    sources: [
      ['calendar', (c) => fromCalendar(c, day)],
      ['assignments', (c) => fromAssignments(c, day)],
      ['announcements', (c) => fromAnnouncements(c, day)],
      ['course content', (c) => fromContent(c, day)],
    ],
    onStart,
    onCourse,
  });
}
