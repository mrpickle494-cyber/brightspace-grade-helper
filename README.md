# Brightspace Grade Helper

A Chrome extension that puts every USC Brightspace class, grade and deadline on one page, and checks my submissions for mistakes before they cost points.

I built it after missing due dates that were buried in announcements, and after uploading a chemistry lab to a business class and getting a 0.

## Features

- **One dashboard.** Every current class with its overall grade. Open a class to see three columns: To Do, Completed (with submit date and score) and Miscellaneous, each sorted by date and linked to Brightspace.
- **Status from Brightspace only.** To Do versus Completed comes from Brightspace's own submission records and is re-checked on every load.
- **Due tomorrow.** Scans each class's calendar, assignments, announcements and posted schedules (including PDF and Word files) for anything due tomorrow. Reads loose dates like "Due Mon 10/5" or "by Tuesday", and lists each item once.
- **Tests and quizzes.** Every upcoming exam and quiz for the next four months, grouped by date, with practice quizzes and review sessions filtered out.
- **Submission checker.** Downloads my latest submission, compares it with the assignment's instructions, rubric and allowed file types, and flags a likely wrong class or assignment, wrong file type, empty file or missing questions. Also runs automatically on an assignment page right after I submit.
- **Next 7 days calendar.** Every assignment, quiz and calendar event for the week, by time.

## How it works

- **Chrome Manifest V3**, plain HTML, CSS and JavaScript. No framework, no build step.
- **Brightspace REST API (D2L Valence)**, using the login already in the browser. No passwords are stored, and all data stays on the computer.
- **Read-only.** Every request is a GET; the extension never submits, edits or deletes anything.
- **Rule-based checking, no AI.** The submission checker compares course codes, assignment numbers, file types, length and keyword overlap. It only marks a file "likely wrong" on strong evidence.
- **Bundled file readers.** [pdf.js](https://mozilla.github.io/pdf.js/) and [mammoth](https://github.com/mwilliamson/mammoth.js) ship inside the extension, since Chrome extensions can't load code from the internet. A hidden offscreen page reads files for checks started on Brightspace pages.

| File | What it does |
| --- | --- |
| `manifest.json` | Extension setup and permissions |
| `background.js` | Service worker: opens the dashboard, relays submission checks |
| `dashboard.html`, `dashboard.js`, `dashboard.css` | The dashboard page |
| `api.js` | All Brightspace API calls |
| `dates.js` | Reads dates and times out of free text |
| `scan.js`, `tomorrow.js`, `tests.js` | The Due tomorrow and Tests dropdowns |
| `analyze.js`, `extract.js`, `checker.js`, `checkview.js` | The submission checker |
| `content.js`, `offscreen.html`, `offscreen.js` | Checks on Brightspace assignment pages |
| `vendor/` | pdf.js and mammoth, with their licenses |

## Install

It is built for USC's Brightspace (`brightspace.usc.edu`) and needs a USC login.

1. Download or clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose this folder.
4. Log in to Brightspace in Chrome, then click the extension's icon.

To use it with another school's Brightspace, change the address in `manifest.json` and in `BASE` in `api.js`.

## Status

A personal tool in active use. A few Brightspace API routes (such as downloading your own submitted files) may need adjusting on other schools' setups.
