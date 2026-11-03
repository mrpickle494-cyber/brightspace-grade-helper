// Runs in a hidden extension page (an "offscreen document") so submission checks
// started from a Brightspace page can use pdf.js and the Word reader, which need
// a real page to run in. background.js forwards requests here.
import { checkFolder } from './checker.js';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'checkSubmission') return false;
  checkFolder(msg.courseId, msg.folderId, { recentMinutes: msg.recentMinutes ?? null })
    .then(sendResponse, (err) => sendResponse({ error: err.message }));
  return true; // answer comes later
});
