// Service worker: Chrome wakes this up when the toolbar icon is clicked.
// Its only job is to open the dashboard in a full tab.
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

// Submission checks requested from a Brightspace assignment page (content.js) are
// handed to the hidden offscreen page, which can read PDFs and Word files.
let creating = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_PARSER'],
      justification: 'Read submitted PDF/Word files to check them against the assignment',
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'background' || msg.type !== 'checkSubmission') return false;
  ensureOffscreen()
    .then(() => chrome.runtime.sendMessage({ ...msg, target: 'offscreen' }))
    .then(sendResponse, (err) => sendResponse({ error: err.message }));
  return true; // answer comes later
});
