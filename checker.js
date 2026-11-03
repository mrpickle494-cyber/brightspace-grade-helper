// Submission checker: finds your latest submission to an assignment, downloads
// the file(s), reads them, and compares them with the assignment's guidelines.
//
// READ-ONLY: every request here is a GET. Nothing is ever submitted, changed,
// or deleted on Brightspace.

import { LE, apiGet, apiGetBinary, tracked, mapLimit, getCourses, assignmentUrl } from './api.js';
import { analyze } from './analyze.js';
import { extractText } from './extract.js';
import { htmlToLines, scanAll } from './scan.js';

const MAX_DOWNLOAD = 25 * 1024 * 1024; // skip anything bigger than 25 MB

let coursesPromise = null;
// Current and past classes; past ones help spot "this file is from another class".
function allCourses() {
  coursesPromise ??= getCourses()
    .then(({ current, other }) => [...current, ...other])
    .catch((err) => {
      coursesPromise = null;
      throw err;
    });
  return coursesPromise;
}

// ---------- Saved results ----------
// Kept in this browser only. A result is reused until you submit something new.

const cacheKey = (courseId, folderId) => `check:${courseId}:${folderId}`;

export function savedCheck(courseId, folderId) {
  try {
    return JSON.parse(localStorage.getItem(cacheKey(courseId, folderId)));
  } catch {
    return null;
  }
}

function saveCheck(result) {
  try {
    localStorage.setItem(cacheKey(result.courseId, result.folderId), JSON.stringify(result));
  } catch {
    // Storage full or unavailable; the result still shows, it just isn't remembered.
  }
}

// ---------- Brightspace data ----------

const linesToText = (lines) => lines.map((l) => l.cells.join(' | ')).join('\n');
const htmlToText = (html) => linesToText(htmlToLines(html));

async function latestSubmission(courseId, folderId) {
  const entries = [
    await tracked('Assignment submissions', () =>
      apiGet(`/d2l/api/le/${LE}/${courseId}/dropbox/folders/${folderId}/submissions/mysubmissions/`)
    ),
  ].flat();
  const submissions = entries.flatMap((e) => e?.Submissions ?? []);
  submissions.sort((a, b) => new Date(b.SubmissionDate) - new Date(a.SubmissionDate));
  return submissions[0] ?? null;
}

async function readFile(path, name, size) {
  if (size > MAX_DOWNLOAD) return { text: null, readError: `Too big to check (${Math.round(size / 1e6)} MB)` };
  try {
    const buffer = await tracked('File downloads', () => apiGetBinary(path));
    return extractText(name, buffer);
  } catch (err) {
    return { text: null, readError: `Couldn't download this file (${err.message})` };
  }
}

// Rubric names, criteria, and level descriptions as plain text.
function rubricText(folder) {
  const rubrics = folder.Assessment?.Rubrics ?? [];
  return rubrics
    .map((r) =>
      [
        r.Name,
        r.Description?.Text,
        ...(r.CriteriaGroups ?? []).flatMap((g) => [g.Name, ...(g.Criteria ?? []).map((c) => c.Name)]),
      ].filter(Boolean).join('\n')
    )
    .join('\n');
}

const dotted = (t) => (t.startsWith('.') ? t : `.${t}`).toLowerCase();

async function guidelines(courseId, folderId) {
  const [folder, siblings] = await Promise.all([
    tracked('Assignment details', () => apiGet(`/d2l/api/le/${LE}/${courseId}/dropbox/folders/${folderId}`)),
    tracked('Assignment list', () => apiGet(`/d2l/api/le/${LE}/${courseId}/dropbox/folders/`)).catch(() => []),
  ]);
  const attachments = await Promise.all(
    (folder.Attachments ?? []).map(async (a) => ({
      name: a.FileName,
      ...(await readFile(`/d2l/api/le/${LE}/${courseId}/dropbox/folders/${folderId}/attachments/${a.FileId}`, a.FileName, a.Size)),
    }))
  );
  const instructions = folder.CustomInstructions?.Html
    ? htmlToText(folder.CustomInstructions.Html)
    : folder.CustomInstructions?.Text ?? '';
  const rubric = rubricText(folder);
  const custom = folder.CustomAllowableFileTypes ?? folder.CustomAllowedFileTypes ?? null;
  return {
    name: folder.Name,
    // Instructions + rubric + attached instruction files, all read together.
    instructions: [instructions, rubric, ...attachments.map((a) => a.text ?? '')].filter(Boolean).join('\n\n'),
    instructionsOnly: instructions,
    hasRubric: Boolean(rubric),
    attachments: attachments.map((a) => ({ name: a.name, text: a.text })),
    allowedTypes: Array.isArray(custom) && custom.length ? custom.map(dotted) : null,
    siblingNames: siblings.filter((f) => f.Id !== folder.Id && !f.IsHidden).map((f) => f.Name),
  };
}

// ---------- The check ----------

const excerpt = (s, n = 400) => (s ? (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s) : '');

// Checks your latest submission to one assignment. Returns a result like
// { status: 'none'|'ok'|'warn'|'bad', reason, checks, folderName, courseLabel, submittedAt, files, ... }
//   recentMinutes: only check if the latest submission is this new; otherwise
//                  returns { skipped: true, submittedAt } without downloading anything.
//   force:         check again even if this submission was already checked
export async function checkFolder(courseId, folderId, { recentMinutes = null, force = false } = {}) {
  const courses = await allCourses();
  const course = courses.find((c) => String(c.id) === String(courseId)) ?? { id: courseId, short: '', name: '' };
  const otherCourses = courses.filter((c) => c !== course);
  const base = { courseId: String(course.id), folderId: String(folderId), courseLabel: course.short };

  const submission = await latestSubmission(course.id, folderId);
  if (!submission) {
    return { ...base, ...analyze({ course, otherCourses, folder: {}, submission: null }), checkedAt: Date.now() };
  }
  const submittedAt = submission.SubmissionDate;
  if (recentMinutes != null && Date.now() - new Date(submittedAt) > recentMinutes * 60 * 1000) {
    return { ...base, skipped: true, submittedAt };
  }
  const saved = savedCheck(base.courseId, base.folderId);
  if (!force && saved && String(saved.submissionId) === String(submission.Id)) return saved;

  const [folder, files] = await Promise.all([
    guidelines(course.id, folderId),
    Promise.all(
      (submission.Files ?? []).map(async (f) => ({
        name: f.FileName,
        size: f.Size,
        ...(await readFile(
          `/d2l/api/le/${LE}/${course.id}/dropbox/folders/${folderId}/submissions/${submission.Id}/files/${f.FileId}`,
          f.FileName,
          f.Size
        )),
      }))
    ),
  ]);

  const result = {
    ...base,
    ...analyze({ course, otherCourses, folder, submission: { date: submittedAt, files } }),
    folderName: folder.name,
    submissionId: String(submission.Id),
    submittedAt,
    files: files.map((f) => f.name),
    instructionsExcerpt: excerpt(folder.instructionsOnly),
    hasRubric: folder.hasRubric,
    fileExcerpt: excerpt(files.find((f) => f.text)?.text?.trim()),
    checkedAt: Date.now(),
  };
  // A text-only submission (no files) has nothing to compare.
  if (!files.length) Object.assign(result, { status: 'warn', reason: 'Submission has no files to check (text-only?)' });
  saveCheck(result);
  return result;
}

// ---------- "Check my submissions" ----------

export const CHECK_DAYS = 7;
const SEVERITY = { bad: 0, none: 1, warn: 2, ok: 3 };

// Every assignment due in the next 7 days, checked. Same callbacks as scanAll.
export function scanUpcomingChecks({ onStart, onCourse }) {
  const now = new Date();
  const until = new Date(now.getTime() + CHECK_DAYS * 24 * 60 * 60 * 1000);
  return scanAll({
    sources: [[
      'assignments',
      async (course) => {
        const folders = await tracked('Assignment list', () =>
          apiGet(`/d2l/api/le/${LE}/${course.id}/dropbox/folders/`)
        );
        const due = folders.filter((f) => !f.IsHidden && f.DueDate && new Date(f.DueDate) >= now && new Date(f.DueDate) <= until);
        return mapLimit(due, 2, async (f) => ({
          course,
          title: f.Name,
          time: new Date(f.DueDate),
          url: assignmentUrl(course, f.Id),
          sources: ['assignment'],
          folderId: f.Id,
          check: await checkFolder(course.id, f.Id).catch((err) => ({
            status: 'warn', reason: `Couldn't check (${err.message})`, checks: [],
          })),
        }));
      },
    ]],
    onStart,
    onCourse,
  });
}

// Problems first (wrong file, then not submitted, then warnings), then by due date.
export const sortChecks = (items) =>
  [...items].sort((a, b) => SEVERITY[a.check.status] - SEVERITY[b.check.status] || a.time - b.time);
