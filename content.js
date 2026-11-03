// Content script: Chrome runs this on Brightspace assignment pages. If you
// submitted to this assignment in the last 30 minutes, it checks the submission
// and shows the result in a small box in the corner. Otherwise it shows a
// "Check my submission" button. It only reads; it never clicks or submits anything.

(() => {
  const RECENT_MINUTES = 30;

  // Which assignment is this? The URL has ?db=<folder>&ou=<course>; some pages only
  // have it in their links.
  function findIds() {
    const fromUrl = new URLSearchParams(location.search);
    if (fromUrl.get('db') && fromUrl.get('ou')) return { folderId: fromUrl.get('db'), courseId: fromUrl.get('ou') };
    for (const a of document.querySelectorAll('a[href*="db="][href*="ou="]')) {
      const p = new URL(a.href, location.href).searchParams;
      if (p.get('db') && p.get('ou')) return { folderId: p.get('db'), courseId: p.get('ou') };
    }
    return null;
  }

  const ids = findIds();
  if (!ids) return;

  // The box lives in a "shadow root" so Brightspace's styles and ours don't mix.
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:min(520px,calc(100vw - 32px));';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('link');
  style.rel = 'stylesheet';
  style.href = chrome.runtime.getURL('checkview.css');
  const local = document.createElement('style');
  local.textContent = `
    .box { font: 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #fff; color: #1c1f24;
           border: 1px solid #e3e6ea; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.15); padding: 10px 12px;
           max-height: 70vh; overflow: auto; }
    .head { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 12px; color: #6b7280; margin-bottom: 4px; }
    button.plain { font: inherit; background: none; border: 0; color: #6b7280; cursor: pointer; padding: 0 4px; font-size: 16px; }
    button.run { font: inherit; padding: 4px 10px; border-radius: 6px; border: 1px solid #e3e6ea; background: #fff; cursor: pointer; }
  `;
  const box = document.createElement('div');
  box.className = 'box';
  root.append(style, local, box);

  function show(...content) {
    const head = document.createElement('div');
    head.className = 'head';
    const title = document.createElement('span');
    title.textContent = 'Grade Helper · submission check';
    const close = document.createElement('button');
    close.className = 'plain';
    close.textContent = '×';
    close.title = 'Hide';
    close.addEventListener('click', () => host.remove());
    head.append(title, close);
    box.replaceChildren(head, ...content);
    if (!host.isConnected) document.body.append(host);
  }

  const text = (s) => {
    const p = document.createElement('div');
    p.textContent = s;
    return p;
  };

  function ask(recentMinutes) {
    return chrome.runtime.sendMessage({ target: 'background', type: 'checkSubmission', ...ids, recentMinutes });
  }

  async function render(result) {
    if (result?.error) return show(text(`Couldn't check: ${result.error}`));
    if (result.status === 'none') return; // nothing submitted yet; Brightspace already says so
    if (result.skipped) {
      const run = document.createElement('button');
      run.className = 'run';
      run.textContent = 'Check my submission';
      run.addEventListener('click', async () => {
        show(text('Checking your submission…'));
        render(await ask(null));
      });
      return show(run);
    }
    const { checkBadge } = await import(chrome.runtime.getURL('checkview.js'));
    show(checkBadge(result, { open: result.status !== 'ok' }));
  }

  ask(RECENT_MINUTES).then(render, (err) => show(text(`Couldn't check: ${err.message}`)));
})();
