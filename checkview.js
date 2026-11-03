// Shows a submission-check result: a one-line badge ("❌ File name says CHEM-105A…")
// that opens to show what was compared. Used on the dashboard and, through
// content.js, on Brightspace assignment pages. Only DOM code, no Brightspace calls.

export const ICONS = { ok: '✅', warn: '⚠️', bad: '❌', none: '⭕' };
const LEVEL_ICONS = { ok: '✅', info: 'ℹ️', warn: '⚠️', bad: '❌' };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const when = (iso) =>
  new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export const summaryText = (result) =>
  `${ICONS[result.status]} ${result.status === 'ok' ? 'Looks right' : result.reason}`;

// What the checker compared: one row per check, plus the start of the
// instructions and the start of your file side by side.
export function checkDetails(result) {
  const box = el('div', 'check-details');
  const files = result.files?.length ? ` · ${result.files.join(', ')}` : '';
  box.append(el('p', 'check-note', `${result.folderName ?? ''}${result.submittedAt ? ` · submitted ${when(result.submittedAt)}` : ''}${files}`));

  if (result.checks?.length) {
    const multipleFiles = new Set(result.checks.map((c) => c.file)).size > 1;
    const table = el('table', 'check-table');
    const head = el('tr');
    head.append(el('th', '', ''), el('th', '', 'Check'), el('th', '', 'Assignment / guideline'), el('th', '', 'Your file'));
    table.append(head);
    for (const c of result.checks) {
      const row = el('tr', `check-row-${c.level}`);
      row.append(
        el('td', '', LEVEL_ICONS[c.level] ?? ''),
        el('td', '', multipleFiles ? `${c.label} (${c.file})` : c.label),
        el('td', '', c.guideline ?? ''),
        el('td', '', c.found ?? '')
      );
      table.append(row);
    }
    const scroll = el('div', 'check-table-wrap');
    scroll.append(table);
    box.append(scroll);
  }

  if (result.instructionsExcerpt != null || result.fileExcerpt != null) {
    const compare = el('div', 'check-compare');
    const side = (title, text, empty) => {
      const col = el('div');
      col.append(el('strong', '', title), el('pre', '', text || empty));
      return col;
    };
    compare.append(
      side('Instructions (start)', result.instructionsExcerpt, 'No instructions text on this assignment.'),
      side('Your file (start)', result.fileExcerpt, 'No readable text.')
    );
    box.append(compare);
  }

  box.append(el('p', 'check-note', `Quick skim with simple matching, not a grade.${result.hasRubric ? ' Includes the rubric.' : ''}${result.checkedAt ? ` Checked ${when(result.checkedAt)}.` : ''}`));
  return box;
}

// The badge. Click it to show/hide the details. "Not submitted" has no details.
export function checkBadge(result, { open = false } = {}) {
  const wrap = el('div', `check check-${result.status}`);
  if (result.status === 'none' || !result.checks?.length) {
    wrap.append(el('span', 'check-summary', summaryText(result)));
    return wrap;
  }
  const button = el('button', 'check-summary', summaryText(result));
  button.type = 'button';
  button.title = 'Show what was compared';
  const details = checkDetails(result);
  details.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    details.hidden = !details.hidden;
    button.setAttribute('aria-expanded', String(!details.hidden));
  });
  wrap.append(button, details);
  return wrap;
}
