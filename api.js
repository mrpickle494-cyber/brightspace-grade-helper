// All calls to Brightspace live here. The browser attaches your existing
// Brightspace login cookies to these requests (allowed by host_permissions
// in manifest.json), so no password is ever stored or sent by us.

export const BASE = 'https://brightspace.usc.edu';
const LP = '1.63'; // "Learning Platform" API: users, enrollments
export const LE = '1.99'; // "Learning Environment" API: assignments, quizzes, grades

export class NotLoggedInError extends Error {}

export class ApiError extends Error {
  constructor(status, path) {
    super(status ? `HTTP ${status}` : 'not JSON (logged out?)');
    this.status = status;
    this.path = path;
  }
}

export async function apiGet(path) {
  const res = await fetch(BASE + path, { credentials: 'include' });
  if (!res.ok) throw new ApiError(res.status, path);
  // A logged-out session can redirect to the login page (HTML, not JSON).
  if (!(res.headers.get('content-type') || '').includes('json')) throw new ApiError(0, path);
  return res.json();
}

// Downloads a file (e.g. your submitted PDF) as raw bytes.
export async function apiGetBinary(path) {
  const res = await fetch(BASE + path, { credentials: 'include' });
  if (!res.ok) throw new ApiError(res.status, path);
  if (res.redirected && res.url.includes('/d2l/login')) throw new ApiError(0, path);
  return res.arrayBuffer();
}

// For files that aren't JSON (e.g. an HTML schedule page in a course's content).
export async function apiGetText(path) {
  const res = await fetch(BASE + path, { credentials: 'include' });
  if (!res.ok) throw new ApiError(res.status, path);
  if (res.redirected && res.url.includes('/d2l/login')) throw new ApiError(0, path);
  return { text: await res.text(), type: res.headers.get('content-type') || '' };
}

// Which routes worked, so the dashboard can say where its data came from.
// { 'Quizzes': { ok: 5, failed: 1, lastError: 'HTTP 403' }, ... }
export const routeStats = {};

export function resetRouteStats() {
  for (const key of Object.keys(routeStats)) delete routeStats[key];
}

export async function tracked(label, fn) {
  const s = (routeStats[label] ??= { ok: 0, failed: 0, lastError: '' });
  try {
    const result = await fn();
    s.ok++;
    return result;
  } catch (err) {
    s.failed++;
    s.lastError = err.message;
    throw err;
  }
}

// Runs fn over items with at most `limit` requests in flight, to be gentle on Brightspace.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function getMe() {
  try {
    return await tracked('Who am I', () => apiGet(`/d2l/api/lp/${LP}/users/whoami`));
  } catch (err) {
    if (err instanceof ApiError) throw new NotLoggedInError();
    throw err;
  }
}

// ---------- Courses ----------

// Returns every course enrollment, following Brightspace's paging "bookmark".
async function getAllCourseEnrollments() {
  const items = [];
  let bookmark = '';
  do {
    const page = await tracked('Enrollments', () =>
      apiGet(
        `/d2l/api/lp/${LP}/enrollments/myenrollments/?orgUnitTypeId=3` +
          (bookmark ? `&bookmark=${encodeURIComponent(bookmark)}` : '')
      )
    );
    items.push(...page.Items);
    bookmark = page.PagingInfo.HasMoreItems ? page.PagingInfo.Bookmark : '';
  } while (bookmark);
  return items;
}

// Real class sections have codes like "20263_14476" (term_section). This skips
// non-class sites such as "LAS-NR_MATH_20263_00001" (Math Placement Exam).
const CLASS_CODE = /^\d{5}_\d+$/;

// A course counts as "current" if it's a real class, it's active, you can open
// it, and today is within its start/end dates (missing dates count as "no limit").
function isCurrent(enrollment, now = new Date()) {
  if (!CLASS_CODE.test(enrollment.OrgUnit.Code)) return false;
  const a = enrollment.Access;
  if (!a.IsActive || !a.CanAccess) return false;
  if (a.StartDate && new Date(a.StartDate) > now) return false;
  if (a.EndDate && new Date(a.EndDate) < now) return false;
  return true;
}

function toCourse(enrollment) {
  const { OrgUnit } = enrollment;
  // "20263_14476 BUAD-112: AI for Business" -> name "BUAD-112: AI for Business", short "BUAD-112"
  const name = OrgUnit.Name.replace(/^\d+_\d+\s+/, '');
  const short = name.includes(':') ? name.split(':')[0].trim() : name;
  return {
    id: OrgUnit.Id,
    name,
    short,
    code: OrgUnit.Code,
    url: `${BASE}/d2l/home/${OrgUnit.Id}`,
  };
}

export async function getCourses() {
  const all = await getAllCourseEnrollments();
  const byName = (x, y) => x.name.localeCompare(y.name);
  return {
    current: all.filter((e) => isCurrent(e)).map(toCourse).sort(byName),
    other: all.filter((e) => !isCurrent(e)).map(toCourse).sort(byName),
  };
}

// ---------- Grades ----------

// The course's overall grade as Brightspace shows it, e.g. "92.5%", or null if
// Brightspace doesn't release one (it answers 404 in that case).
export async function getCourseGrade(course) {
  let value;
  try {
    value = await tracked('Overall grade', () =>
      apiGet(`/d2l/api/le/${LE}/${course.id}/grades/final/values/myGradeValue`)
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
  if (!value) return null;
  if (value.PointsNumerator != null && value.PointsDenominator) {
    const pct = (value.PointsNumerator / value.PointsDenominator) * 100;
    return `${Math.round(pct * 10) / 10}%`;
  }
  return value.DisplayedGrade?.trim() || null;
}


// ---------- Assignments, quizzes, and everything else ----------
// Each item: { kind, name, due (Date|null), url, status, submitted (Date|null), score, note }
// status: 'todo' (Brightspace has no submission/attempt) -> To Do column
//         'done' (Brightspace has a submission/attempt)  -> Completed column
//         'misc' (anything we can't clearly place)       -> Miscellaneous column

const toDate = (s) => (s ? new Date(s) : null);
const latest = (dates) => dates.filter(Boolean).sort((a, b) => b - a)[0] ?? null;
const round = (n) => Math.round(n * 100) / 100;
const formatScore = (num, den) => (den ? `${round(num)} / ${round(den)}` : `${round(num)}`);

// Follows a relative or absolute "Next" link from Brightspace back into an API path.
export const toPath = (link) => {
  const url = new URL(link, BASE);
  return url.pathname + url.search;
};

function gradeText(g) {
  if (!g) return null;
  if (g.PointsNumerator != null && g.PointsDenominator) {
    return formatScore(g.PointsNumerator, g.PointsDenominator);
  }
  return g.DisplayedGrade?.trim() || null;
}

// Grade object types worth showing on their own (numeric, pass/fail, select box).
// Skips text comments, calculated totals, and categories.
const SHOWN_GRADE_TYPES = [1, 2, 3];

// Your released grades in one course. Assignments and quizzes "take" their grade
// out of here; whatever is left over is a graded item with no submission folder.
class GradeLookup {
  constructor(values) {
    this.values = values;
    this.taken = new Set();
  }

  take(gradeItemId, name) {
    const g =
      this.values.find((v) => gradeItemId != null && String(v.GradeObjectIdentifier) === String(gradeItemId)) ??
      this.values.find((v) => v.GradeObjectName?.trim().toLowerCase() === name.trim().toLowerCase());
    if (g) this.taken.add(g);
    return g ?? null;
  }

  leftovers(course) {
    return this.values
      .filter((v) => !this.taken.has(v) && SHOWN_GRADE_TYPES.includes(v.GradeObjectType))
      .map((v) => ({
        kind: 'Grade item',
        name: v.GradeObjectName,
        due: null,
        url: `${BASE}/d2l/lms/grades/my_grades/main.d2l?ou=${course.id}`,
        status: 'misc',
        submitted: null,
        score: gradeText(v),
        note: 'Graded item with no submission folder',
      }));
  }
}

async function getMyGrades(course) {
  return tracked('My grades', () =>
    apiGet(`/d2l/api/le/${LE}/${course.id}/grades/values/myGradeValues/`)
  );
}

// Assignment submission types in Brightspace: 0 file, 1 text, 2 on paper, 3 observed in person.
const OFFLINE_SUBMISSION_TYPES = [2, 3];

async function getAssignments(course, grades) {
  const folders = await tracked('Assignment list', () =>
    apiGet(`/d2l/api/le/${LE}/${course.id}/dropbox/folders/`)
  );
  const visible = folders.filter((f) => !f.IsHidden);
  return mapLimit(visible, 4, async (f) => {
    const grade = grades.take(f.GradeItemId, f.Name);
    const item = {
      kind: 'Assignment',
      folderId: f.Id,
      name: f.Name,
      due: toDate(f.DueDate) ?? toDate(f.Availability?.EndDate),
      url: assignmentUrl(course, f.Id),
      status: 'misc',
      submitted: null,
      score: gradeText(grade),
      note: '',
    };
    if (OFFLINE_SUBMISSION_TYPES.includes(f.SubmissionType)) {
      item.note = 'Handed in on paper or in person';
      return item;
    }
    try {
      // mysubmissions returns a list of "entity" blocks, each with its own Submissions list.
      const entries = [
        await tracked('Assignment submissions', () =>
          apiGet(`/d2l/api/le/${LE}/${course.id}/dropbox/folders/${f.Id}/submissions/mysubmissions/`)
        ),
      ].flat();
      const submissions = entries.flatMap((e) => e?.Submissions ?? []);
      if (submissions.length) {
        item.status = 'done';
        item.submitted = latest(submissions.map((s) => toDate(s.SubmissionDate)));
        const feedback = entries.find((e) => e?.Feedback?.Score != null)?.Feedback;
        item.score ??= feedback ? formatScore(feedback.Score, f.Assessment?.ScoreDenominator) : null;
      } else {
        item.status = 'todo';
      }
    } catch {
      item.note = "Brightspace didn't say whether this was submitted";
    }
    return item;
  });
}

// Quiz lists come in pages; each page has a "Next" URL until the last one.
export async function getAllQuizzes(course) {
  const quizzes = [];
  let path = `/d2l/api/le/${LE}/${course.id}/quizzes/`;
  while (path) {
    const page = await tracked('Quiz list', () => apiGet(path));
    quizzes.push(...page.Objects);
    path = page.Next ? toPath(page.Next) : null;
  }
  return quizzes;
}

async function getQuizzes(course, userId, grades) {
  const quizzes = (await getAllQuizzes(course)).filter((q) => q.IsActive);
  return mapLimit(quizzes, 4, async (q) => {
    const grade = grades.take(q.GradeItemId, q.Name);
    const item = {
      kind: 'Quiz',
      quizId: q.QuizId,
      name: q.Name,
      due: toDate(q.DueDate) ?? toDate(q.EndDate),
      url: quizUrl(course, q.QuizId),
      status: 'misc',
      submitted: null,
      score: gradeText(grade),
      note: '',
    };
    try {
      const page = await tracked('Quiz attempts', () =>
        apiGet(`/d2l/api/le/${LE}/${course.id}/quizzes/${q.QuizId}/attempts/?userId=${userId}`)
      );
      const attempts = page.Objects ?? page;
      if (attempts.length) {
        item.status = 'done';
        item.submitted = latest(
          attempts.map((a) => toDate(a.TimeCompleted ?? a.Completed ?? a.SubmittedDate ?? a.TimeStarted))
        );
        const graded = attempts.find((a) => a.Score != null);
        item.score ??= graded ? formatScore(graded.Score) : null;
      } else {
        item.status = 'todo';
      }
    } catch {
      item.note = "Brightspace didn't say whether this was attempted";
    }
    return item;
  });
}

export const quizUrl = (course, quizId) =>
  `${BASE}/d2l/lms/quizzing/user/quiz_summary.d2l?qi=${quizId}&ou=${course.id}`;

export const assignmentUrl = (course, folderId) =>
  `${BASE}/d2l/lms/dropbox/user/folder_submit_files.d2l?db=${folderId}&ou=${course.id}`;

export const eventUrl = (course, e) =>
  e.AssociatedEntity?.Link
    ? new URL(e.AssociatedEntity.Link, BASE).href
    : `${BASE}/d2l/le/calendar/${course.id}/event/${e.CalendarEventId}/detailsview`;

// Calendar events from a myEvents route, following whichever paging style it uses.
async function pagedEvents(first, label) {
  const events = [];
  let path = first;
  while (path) {
    const page = await tracked(label, () => apiGet(path));
    if (Array.isArray(page)) {
      events.push(...page);
      path = null;
    } else if (page.Objects) {
      events.push(...page.Objects);
      path = page.Next ? toPath(page.Next) : null;
    } else {
      events.push(...page.Items);
      path = page.PagingInfo?.HasMoreItems
        ? `${first}&bookmark=${encodeURIComponent(page.PagingInfo.Bookmark)}`
        : null;
    }
  }
  return events;
}

const range = (start, end) =>
  `startDateTime=${encodeURIComponent(start.toISOString())}&endDateTime=${encodeURIComponent(end.toISOString())}`;

// Raw calendar events for one class between two dates.
export function getCalendarEvents(course, start, end) {
  return pagedEvents(`/d2l/api/le/${LE}/${course.id}/calendar/events/myEvents/?${range(start, end)}`, 'Calendar events');
}

// Everything the Brightspace home page's "Upcoming events" shows: events from every
// class plus school-wide ones (posted on the university's top-level org unit).
// Uses the all-org-units calendar route; if that one isn't allowed, asks the school
// and each class separately. Events are de-duplicated by id.
export async function getHomeEvents(courses, start, end) {
  const org = await tracked('Organization', () => apiGet(`/d2l/api/lp/${LP}/organization/info`)).catch(() => null);
  const ids = [org?.Identifier, ...courses.map((c) => c.id)].filter(Boolean);
  let events;
  try {
    events = await pagedEvents(
      `/d2l/api/le/${LE}/calendar/events/myEvents/?orgUnitIdsCSV=${ids.join(',')}&${range(start, end)}`,
      'Home calendar'
    );
  } catch {
    const perUnit = await Promise.all(
      ids.map((id) => getCalendarEvents({ id }, start, end).catch(() => []))
    );
    events = perUnit.flat();
  }
  const seen = new Set();
  return events.filter((e) => !seen.has(e.CalendarEventId) && seen.add(e.CalendarEventId));
}

// Calendar events (class meetings, discussions, etc.) from 30 days ago to 6 months out.
// Events tied to an assignment or quiz are skipped because those already have a row.
async function getEvents(course) {
  const day = 24 * 60 * 60 * 1000;
  const events = await getCalendarEvents(
    course, new Date(Date.now() - 30 * day), new Date(Date.now() + 180 * day)
  );
  return events
    .filter((e) => !/dropbox|quiz/i.test(e.AssociatedEntity?.AssociatedEntityType ?? ''))
    .map((e) => {
      const type = e.AssociatedEntity?.AssociatedEntityType ?? '';
      return {
        kind: /discussion/i.test(type) ? 'Discussion' : 'Event',
        name: e.Title,
        due: toDate(e.StartDateTime) ?? toDate(e.EndDateTime),
        url: eventUrl(course, e),
        status: 'misc',
        submitted: null,
        score: null,
        note: '',
      };
    });
}

// Everything for one class. Any route that fails just contributes nothing
// (the failure shows up under "Data sources").
export async function getCourseItems(course, userId) {
  const grades = new GradeLookup(await getMyGrades(course).catch(() => []));
  const [assignments, quizzes, events] = await Promise.all([
    getAssignments(course, grades).catch(() => []),
    getQuizzes(course, userId, grades).catch(() => []),
    getEvents(course).catch(() => []),
  ]);
  return [...assignments, ...quizzes, ...events, ...grades.leftovers(course)];
}
