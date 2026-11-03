import {
  getMe, getCourses, getCourseGrade, getCourseItems, routeStats, resetRouteStats, NotLoggedInError,
  getHomeEvents, eventUrl,
} from './api.js';
import { scanTomorrow, sortByTime, tomorrowDate } from './tomorrow.js';
import { scanTests, sortTests, TEST_DAYS } from './tests.js';
import { checkFolder, savedCheck, scanUpcomingChecks, sortChecks, CHECK_DAYS } from './checker.js';
import { checkBadge } from './checkview.js';
import { startOfDay, addDays, sameDay } from './dates.js';
import { localDay } from './scan.js';

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const formatDate = (d) =>
  d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// Which classes are expanded, by course id, so Refresh keeps them open.
const openCourses = new Set();

// ---------- Sorting ----------

// Splits one class's items into the three columns and sorts each one.
function sortColumns(items, now = new Date()) {
  const dated = (xs) => xs.filter((i) => i.due);
  const undated = (xs) => xs.filter((i) => !i.due);
  const byDue = (a, b) => a.due - b.due;

  // Earliest due first, which puts overdue items at the top. No due date goes last.
  const todo = items.filter((i) => i.status === 'todo');
  const todoSorted = [...dated(todo).sort(byDue), ...undated(todo)];

  // Most recently submitted first.
  const done = items.filter((i) => i.status === 'done');
  const doneSorted = [
    ...done.filter((i) => i.submitted).sort((a, b) => b.submitted - a.submitted),
    ...done.filter((i) => !i.submitted),
  ];

  // Upcoming soonest first, then past dates (most recent first), then no date.
  const misc = items.filter((i) => i.status === 'misc');
  const upcoming = dated(misc).filter((i) => i.due >= now).sort(byDue);
  const past = dated(misc).filter((i) => i.due < now).sort((a, b) => b.due - a.due);
  const miscSorted = [...upcoming, ...past, ...undated(misc)];

  return { todo: todoSorted, done: doneSorted, misc: miscSorted };
}

// ---------- Columns ----------

function itemCard(item, lines) {
  const li = el('li', 'item');
  const link = el('a', 'item-name', item.name);
  link.href = item.url;
  link.target = '_blank';
  link.rel = 'noopener';
  li.append(el('div', 'kind', item.kind), link);
  for (const line of lines) if (line) li.append(line);
  return li;
}

const meta = (text) => el('div', 'item-meta', text);

function todoCard(item, now) {
  let due = meta(item.due ? `Due ${formatDate(item.due)}` : 'No due date');
  if (item.due && item.due < now) {
    const line = el('div', 'item-meta');
    line.append(el('span', 'badge', 'Overdue'), due.textContent);
    due = line;
  }
  return itemCard(item, [due, item.folderId != null && meta('⭕ Not submitted yet')]);
}

// The submission check under a submitted assignment: the saved result if this
// submission was already checked, otherwise a button to check it now (read-only).
function checkArea(course, item) {
  const area = el('div');
  const saved = savedCheck(String(course.id), String(item.folderId));
  const stale = saved && item.submitted && new Date(saved.submittedAt) < item.submitted;
  if (saved && !stale) {
    area.append(checkBadge(saved));
    return area;
  }
  const button = el('button', 'check-run', 'Check submission');
  button.type = 'button';
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Checking…';
    try {
      area.replaceChildren(checkBadge(await checkFolder(course.id, item.folderId), { open: true }));
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Check submission';
      area.append(meta(`Couldn't check: ${err.message}`));
    }
  });
  area.append(button);
  return area;
}

function doneCard(item, course) {
  return itemCard(item, [
    meta(item.submitted ? `Submitted ${formatDate(item.submitted)}` : 'Submitted'),
    meta(item.score ? `Score: ${item.score}` : 'Not graded yet'),
    item.folderId != null && checkArea(course, item),
  ]);
}

function miscCard(item) {
  return itemCard(item, [
    item.due && meta(formatDate(item.due)),
    item.note && meta(item.note),
    item.score && meta(`Score: ${item.score}`),
  ]);
}

function column(title, className, items, render) {
  const section = el('section', `col ${className}`);
  section.append(el('h3', '', `${title} (${items.length})`));
  if (items.length) {
    const list = el('ul', 'items');
    list.append(...items.map(render));
    section.append(list);
  } else {
    section.append(el('p', 'empty muted', 'Nothing here'));
  }
  return section;
}

function renderColumns(body, items, course) {
  const now = new Date();
  const { todo, done, misc } = sortColumns(items, now);
  const columns = el('div', 'columns');
  columns.append(
    column('To Do', 'todo', todo, (i) => todoCard(i, now)),
    column('Completed', 'done', done, (i) => doneCard(i, course)),
    column('Miscellaneous', 'misc', misc, miscCard)
  );
  body.replaceChildren(columns);
}

// ---------- Class rows ----------

function classRow(course) {
  const li = el('li', 'class');
  li.classList.toggle('open', openCourses.has(course.id));

  const row = el('button', 'class-row');
  row.type = 'button';
  row.append(
    el('span', 'class-name', course.name),
    el('span', 'class-grade', course.grade ?? '—'),
    el('span', 'chevron', '▼')
  );
  row.addEventListener('click', () => {
    const open = li.classList.toggle('open');
    if (open) openCourses.add(course.id);
    else openCourses.delete(course.id);
  });

  const body = el('div', 'class-body');
  body.append(el('p', 'muted', 'Loading assignments…'));

  li.append(row, body);
  return li;
}

// ---------- Next 7 days calendar ----------

const WEEK_DAYS = 7;
const WEEK_STATUS = { todo: 'Not submitted', done: 'Submitted', misc: '' };

const clockTime = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function weekItem(item, now) {
  const overdue = item.status === 'todo' && item.due < now;
  const li = el('li', `week-item ${item.status}${item.kind === 'Event' ? ' event' : ''}`);
  const link = el('a', 'item-name', item.name);
  link.href = item.url;
  link.target = '_blank';
  link.rel = 'noopener';
  const status = overdue ? 'Overdue' : WEEK_STATUS[item.status] || item.note;
  const kind = item.kind === 'Assignment' ? '' : ` · ${item.kind}`;
  li.append(
    el('div', 'week-time', item.allDay ? 'All day' : clockTime(item.due)),
    link,
    el('div', 'item-meta', `${item.course.short}${kind}`),
    status ? el('div', `week-status${overdue ? ' overdue' : ''}`, status) : ''
  );
  return li;
}

// Calendar events (from the home page's "Upcoming events") as calendar items.
// An event made by an assignment or quiz is skipped on the day that item is already
// shown, so a due date isn't listed twice. All-day events that span several days
// show on each of those days; a timed event that started earlier shows on today.
function eventItems(events, items, courseById, today) {
  const lastDay = addDays(today, WEEK_DAYS - 1);
  const result = [];
  for (const e of events) {
    const type = e.AssociatedEntity?.AssociatedEntityType ?? '';
    const entityId = String(e.AssociatedEntity?.AssociatedEntityId ?? '');
    const twin = (day) =>
      items.some((it) =>
        it.due && sameDay(it.due, day) &&
        ((/dropbox/i.test(type) && String(it.folderId) === entityId) || (/quiz/i.test(type) && String(it.quizId) === entityId))
      );
    const course = courseById.get(String(e.OrgUnitId));
    const base = {
      kind: /discussion/i.test(type) ? 'Discussion' : 'Event',
      name: e.Title,
      url: eventUrl(course ?? { id: e.OrgUnitId }, e),
      status: 'misc',
      note: '',
      course: { short: course?.short ?? e.OrgUnitCode ?? e.OrgUnitName ?? 'USC' },
    };
    if (e.IsAllDayEvent) {
      const first = localDay(e.StartDay ?? e.StartDateTime);
      const last = localDay(e.EndDay ?? e.EndDateTime ?? e.StartDateTime);
      for (let d = first < today ? today : first; d <= last && d <= lastDay; d = addDays(d, 1)) {
        if (!twin(d)) result.push({ ...base, due: d, allDay: true });
      }
    } else {
      const start = new Date(e.StartDateTime);
      const end = new Date(e.EndDateTime ?? e.StartDateTime);
      if (end < today) continue;
      const due = start < today ? today : start;
      if (!twin(due)) result.push({ ...base, due, allDay: start < today });
    }
  }
  return result;
}

// One column per day starting today: assignments, quizzes, and calendar events by time.
function renderWeek(items, events = [], courses = []) {
  const now = new Date();
  const today = startOfDay(now);
  const courseById = new Map(courses.map((c) => [String(c.id), c]));
  const all = [...items.filter((it) => it.due), ...eventItems(events, items, courseById, today)];
  const days = [];
  for (let i = 0; i < WEEK_DAYS; i++) {
    const day = addDays(today, i);
    // All-day events first, then by time.
    const due = all
      .filter((it) => sameDay(it.due, day))
      .sort((a, b) => (b.allDay ? 1 : 0) - (a.allDay ? 1 : 0) || a.due - b.due);
    const col = el('div', `week-day${i === 0 ? ' today' : ''}`);
    const head = el('div', 'week-head');
    head.append(
      el('span', 'week-weekday', i === 0 ? 'Today' : day.toLocaleDateString([], { weekday: 'short' })),
      el('span', 'week-date', day.toLocaleDateString([], { month: 'short', day: 'numeric' }))
    );
    col.append(head);
    if (due.length) {
      const list = el('ul', 'week-list');
      list.append(...due.map((it) => weekItem(it, now)));
      col.append(list);
    } else {
      col.append(el('p', 'week-empty', 'Nothing scheduled'));
    }
    days.push(col);
  }
  $('week-days').replaceChildren(...days);
  $('week').hidden = false;
}

// ---------- Data sources ----------

function renderSources() {
  $('sources').replaceChildren(
    ...Object.entries(routeStats).map(([label, s]) =>
      el('li', '', `${label}: Brightspace API — ${s.ok} ok` +
        (s.failed ? `, ${s.failed} failed (${s.lastError})` : ''))
    )
  );
}

// ---------- Load ----------

let lastLoaded = 0;

async function load() {
  $('refresh').disabled = true;
  $('login').hidden = true;
  $('error').hidden = true;
  resetRouteStats();

  try {
    const [me, courses] = await Promise.all([getMe(), getCourses()]);
    $('greeting').textContent = `Hi ${me.FirstName} — ${courses.current.length} classes`;

    await Promise.all(
      courses.current.map(async (course) => {
        course.grade = await getCourseGrade(course).catch(() => null);
      })
    );
    const rows = courses.current.map(classRow);
    $('classes').replaceChildren(...rows);

    // Re-checked from Brightspace on every load, so submitted work moves to Completed.
    const weekItems = [];
    let weekEvents = [];
    const showWeek = () => renderWeek(weekItems, weekEvents, courses.current);
    const today = startOfDay(new Date());
    const eventsLoaded = getHomeEvents(courses.current, today, addDays(today, WEEK_DAYS))
      .then((events) => {
        weekEvents = events;
        showWeek();
      })
      .catch(() => {
        // Assignments and quizzes still show; the failure is listed under Data sources.
      });
    await Promise.all(
      courses.current.map(async (course, i) => {
        const body = rows[i].querySelector('.class-body');
        try {
          const items = await getCourseItems(course, me.Identifier);
          renderColumns(body, items, course);
          // Assignments and quizzes go on the calendar, filled in as each class loads.
          weekItems.push(...items.filter((it) => ['Assignment', 'Quiz'].includes(it.kind)).map((it) => ({ ...it, course })));
          showWeek();
        } catch (err) {
          body.replaceChildren(el('p', 'error', `Couldn't load this class: ${err.message}`));
        }
      })
    );
    await eventsLoaded;
    lastLoaded = Date.now();
    $('updated').textContent =
      `Last updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  } catch (err) {
    $('greeting').textContent = '';
    if (err instanceof NotLoggedInError) {
      $('login').hidden = false;
    } else {
      $('error').hidden = false;
      $('error').textContent = `Something went wrong: ${err.message}`;
    }
  } finally {
    renderSources();
    $('refresh').disabled = false;
  }
}

$('refresh').addEventListener('click', load);

// Coming back to this tab (e.g. after submitting in Brightspace) re-checks automatically,
// at most once a minute.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !$('refresh').disabled && Date.now() - lastLoaded > 60_000) {
    load();
  }
});

// ---------- Dropdowns (Due tomorrow, Tests & quizzes) ----------

const CACHE_MS = 15 * 60 * 1000; // re-scan at most every 15 minutes unless you click Refresh
const SOURCE_NAMES = {
  assignment: 'Assignment', quiz: 'Quiz', calendar: 'Calendar', schedule: 'Schedule', announcement: 'Announcement',
};
const DATE_FIELDS = ['time', 'day', 'opens']; // turned back into Dates when read from the cache

const timeLabel = (d) => (d ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'Time not listed');
const dayLabel = (d) => d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

function newTabLink(text, url, className = '') {
  const a = el('a', className, text);
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener';
  return a;
}

const foundIn = (item) => `Found in: ${item.sources.map((s) => SOURCE_NAMES[s]).join(', ')}`;

const dropdowns = [];

// One dropdown. `prefix` matches the element ids in dashboard.html ("tomorrow" -> #tomorrow-toggle, ...).
//   scan({ onStart, onCourse }): checks every class
//   renderItems(results): list items for everything found
//   cacheId(): results are only reused while this stays the same (e.g. tomorrow's date)
function scanDropdown({ prefix, scan, renderItems, subtitle, emptyText, cacheId }) {
  const part = (name) => $(`${prefix}-${name}`);
  const cacheKey = `dropdown-${prefix}`;
  // courses: classes being checked; results: course id -> { course, items, problems, failed }
  const state = { id: null, courses: [], results: new Map(), scanning: false, checkedAt: null, loginNeeded: false, error: null };

  const isFresh = (checkedAt, id) => checkedAt && Date.now() - checkedAt < CACHE_MS && id === cacheId();

  // Saved in this browser only (localStorage), so reopening the dashboard can reuse it.
  function save() {
    try {
      localStorage.setItem(cacheKey, JSON.stringify({
        id: state.id, checkedAt: state.checkedAt, courses: state.courses, results: [...state.results.values()],
      }));
    } catch {
      // Storage unavailable; the in-memory copy still works while this tab is open.
    }
  }

  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(cacheKey));
      if (!saved || !isFresh(saved.checkedAt, saved.id)) return false;
      const revive = (item) => {
        const copy = { ...item };
        for (const f of DATE_FIELDS) if (copy[f]) copy[f] = new Date(copy[f]);
        return copy;
      };
      Object.assign(state, {
        id: saved.id,
        checkedAt: saved.checkedAt,
        courses: saved.courses,
        results: new Map(saved.results.map((r) => [r.course.id, { ...r, items: r.items.map(revive) }])),
      });
      return true;
    } catch {
      return false;
    }
  }

  async function rescan() {
    Object.assign(state, {
      id: cacheId(), courses: [], results: new Map(), scanning: true,
      checkedAt: null, loginNeeded: false, error: null,
    });
    render();
    try {
      await getMe();
      await scan({
        onStart: (courses) => {
          state.courses = courses;
          render();
        },
        onCourse: (result) => {
          state.results.set(result.course.id, result);
          render();
        },
      });
      state.checkedAt = Date.now();
      // Don't keep results where a whole class failed, so the next click tries again.
      if (![...state.results.values()].some((r) => r.failed)) save();
    } catch (err) {
      if (err instanceof NotLoggedInError) state.loginNeeded = true;
      else state.error = err.message;
    } finally {
      state.scanning = false;
      render();
    }
  }

  function render() {
    const results = state.courses.map((c) => state.results.get(c.id)).filter(Boolean);
    const nodes = renderItems(results);

    part('day').textContent = subtitle();
    part('refresh').disabled = state.scanning;

    const status = part('status');
    if (state.loginNeeded) {
      status.replaceChildren("You're not logged in. ", newTabLink('Log in to Brightspace', 'https://brightspace.usc.edu/d2l/login'), ', then click Refresh.');
    } else if (state.error) {
      status.textContent = `Something went wrong: ${state.error}`;
    } else if (state.scanning) {
      status.textContent = state.courses.length
        ? `Checking classes… ${results.length} of ${state.courses.length} done`
        : 'Finding your classes…';
    } else if (state.checkedAt) {
      status.textContent = `Checked ${state.courses.length} classes at ${timeLabel(new Date(state.checkedAt))}`;
    }

    part('problems').replaceChildren(
      ...results.flatMap((r) =>
        r.failed
          ? [el('li', '', `${r.course.short}: couldn't load this class. ${r.problems[0]?.text ?? ''}`)]
          : r.problems.map((p) => {
              const li = el('li', '', `${r.course.short}: ${p.text}`);
              if (p.url) li.append(' (', newTabLink('open', p.url), ')');
              return li;
            })
      )
    );

    part('list').replaceChildren(...nodes);

    const finished = !state.scanning && !state.loginNeeded && !state.error && state.checkedAt;
    part('empty').hidden = !(finished && nodes.length === 0);
    part('empty').textContent = results.some((r) => r.failed) ? `${emptyText} in the classes that loaded.` : `${emptyText}.`;
  }

  function open() {
    if (state.scanning || isFresh(state.checkedAt, state.id) || restore()) render();
    else rescan();
  }

  function setOpen(isOpen) {
    part('panel').hidden = !isOpen;
    part('toggle').setAttribute('aria-expanded', String(isOpen));
    if (isOpen) open();
  }

  part('toggle').addEventListener('click', () => {
    const opening = part('panel').hidden;
    // Only one dropdown open at a time, so they don't cover each other.
    if (opening) for (const d of dropdowns) if (d !== dropdown) d.setOpen(false);
    setOpen(opening);
  });
  part('refresh').addEventListener('click', rescan);

  const dropdown = { setOpen };
  dropdowns.push(dropdown);
}

// ----- Due tomorrow -----

// Not submitted, or likely the wrong file: these go first, in red.
const isUrgent = (item) => item.submitted === false || ['none', 'bad'].includes(item.check?.status);

function tomorrowItem(item) {
  const li = el('li', `drop-item${isUrgent(item) ? ' urgent' : ''}`);
  const top = el('div', 'item-meta');
  top.append(el('span', 'drop-time', timeLabel(item.time)), ` · ${item.course.name}`);
  li.append(top, newTabLink(item.title, item.url, 'item-name'), el('div', 'item-meta', foundIn(item)));
  if (item.check) li.append(checkBadge(item.check));
  return li;
}

function sortTomorrow(items) {
  const sorted = sortByTime(items);
  return [...sorted.filter(isUrgent), ...sorted.filter((i) => !isUrgent(i))];
}

scanDropdown({
  prefix: 'tomorrow',
  scan: (callbacks) => scanTomorrow({ day: tomorrowDate(), ...callbacks }),
  renderItems: (results) => sortTomorrow(results.flatMap((r) => r.items)).map(tomorrowItem),
  subtitle: () => dayLabel(tomorrowDate()),
  emptyText: 'Nothing due tomorrow',
  cacheId: () => tomorrowDate().toDateString(),
});

// ----- Tests & quizzes -----

function relativeDay(day) {
  const days = Math.round((day - new Date(new Date().toDateString())) / (24 * 60 * 60 * 1000));
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return `In ${days} days`;
}

function testItem(item) {
  const li = el('li', `drop-item ${item.kind === 'Exam' ? 'exam' : 'quiz'}`);
  const top = el('div', 'item-meta');
  // Online quizzes are listed by when they close.
  const time = item.sources.includes('quiz') && item.time ? `Closes ${timeLabel(item.time)}` : timeLabel(item.time);
  top.append(el('span', 'drop-time', time), ' · ', el('span', 'kind-tag', item.kind), ` · ${item.course.name}`);
  li.append(top, newTabLink(item.title, item.url, 'item-name'));
  if (item.opens) li.append(el('div', 'item-meta', `Opens ${dayLabel(item.opens)}, ${timeLabel(item.opens)}`));
  li.append(el('div', 'item-meta', foundIn(item)));
  return li;
}

// Grouped under a heading per day: "Mon, Oct 12 · In 8 days".
function renderTests(results) {
  const nodes = [];
  let lastDay = null;
  for (const item of sortTests(results.flatMap((r) => r.items))) {
    if (!lastDay || item.day.getTime() !== lastDay.getTime()) {
      lastDay = item.day;
      nodes.push(el('li', 'drop-day', `${dayLabel(item.day)} · ${relativeDay(item.day)}`));
    }
    nodes.push(testItem(item));
  }
  return nodes;
}

scanDropdown({
  prefix: 'tests',
  scan: scanTests,
  renderItems: renderTests,
  subtitle: () => `next ${Math.round(TEST_DAYS / 30)} months`,
  emptyText: 'No tests or quizzes found',
  cacheId: () => new Date().toDateString(),
});

// ----- Check my submissions -----

function checkItem(item) {
  const li = el('li', `drop-item${['none', 'bad'].includes(item.check.status) ? ' urgent' : ''}`);
  const top = el('div', 'item-meta');
  top.append(el('span', 'drop-time', `Due ${dayLabel(item.time)}, ${timeLabel(item.time)}`), ` · ${item.course.name}`);
  li.append(top, newTabLink(item.title, item.url, 'item-name'), checkBadge(item.check));
  return li;
}

scanDropdown({
  prefix: 'checks',
  scan: scanUpcomingChecks,
  renderItems: (results) => sortChecks(results.flatMap((r) => r.items)).map(checkItem),
  subtitle: () => `due in the next ${CHECK_DAYS} days`,
  emptyText: `No assignments due in the next ${CHECK_DAYS} days`,
  cacheId: () => new Date().toDateString(),
});

load();
