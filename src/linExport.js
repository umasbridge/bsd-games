const DEALER_TO_LIN = { N: '3', E: '4', S: '1', W: '2' };
const VUL_TO_LIN = { none: 'o', ns: 'n', ew: 'e', both: 'b', NS: 'n', EW: 'e' };

function boardToLin(board, boardNumber) {
  const dealer = DEALER_TO_LIN[board.dealer] || '3';
  const vul = VUL_TO_LIN[board.vulnerability] || 'o';
  const hands = ['s', 'w', 'n', 'e'].map(d => {
    const sp = (board[`${d}_spades`] || '').replace(/10/g, 'T');
    const h = (board[`${d}_hearts`] || '').replace(/10/g, 'T');
    const dm = (board[`${d}_diamonds`] || '').replace(/10/g, 'T');
    const c = (board[`${d}_clubs`] || '').replace(/10/g, 'T');
    return `S${sp}H${h}D${dm}C${c}`;
  }).join(',');
  return `qx|o${boardNumber}|md|${dealer}${hands}|rh||ah|Board ${boardNumber}|sv|${vul}|pg||`;
}

// What a stored LIN actually contains — some sources (e.g. BridgeWebs)
// only have deal + contract, where the handviewer adds nothing.
export function linHasBidding(lin) { return !!lin && /(^|\|)mb\|/.test(lin); }
export function linHasPlay(lin) { return !!lin && /(^|\|)pc\|/.test(lin); }

export function openHandviewer(lin) {
  if (!lin) return;
  const url = `https://www.bridgebase.com/tools/handviewer.html?bbo=y&lin=${encodeURIComponent(lin)}`;

  // Desktop: draggable floating window, docked bottom-right
  if (window.innerWidth >= 768) {
    openFloatingHandviewer(url);
    return;
  }

  // Full-screen in-app overlay (works on phones where a new tab has no way back)
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#fff;display:flex;flex-direction:column;';

  const cleanup = (popHistory) => {
    overlay.remove();
    window.removeEventListener('popstate', onPop);
    document.removeEventListener('keydown', onKey);
    if (popHistory) history.back();
  };
  const onPop = () => cleanup(false);
  const onKey = (e) => { if (e.key === 'Escape') cleanup(true); };

  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 12px;background:#1f2937;flex-shrink:0;';

  const back = document.createElement('button');
  back.textContent = '← Back';
  back.style.cssText = 'background:#fff;border:none;border-radius:4px;padding:5px 12px;font-size:14px;font-weight:600;cursor:pointer;';
  back.onclick = () => cleanup(true);

  const title = document.createElement('span');
  title.textContent = 'BBO Handviewer';
  title.style.cssText = 'color:#fff;font-size:14px;font-weight:600;';

  const ext = document.createElement('a');
  ext.textContent = 'New tab ↗';
  ext.href = url;
  ext.target = '_blank';
  ext.rel = 'noopener';
  ext.style.cssText = 'margin-left:auto;color:#93c5fd;font-size:13px;text-decoration:none;';

  const iframe = document.createElement('iframe');
  iframe.src = url;
  iframe.style.cssText = 'flex:1;border:none;width:100%;';

  bar.append(back, title, ext);
  overlay.append(bar, iframe);
  document.body.appendChild(overlay);

  // Hardware/browser back closes the overlay instead of leaving the app
  history.pushState({ handviewer: true }, '');
  window.addEventListener('popstate', onPop);
  document.addEventListener('keydown', onKey);
}

function openFloatingHandviewer(url) {
  // Only one handviewer window at a time — opening a new hand replaces it
  document.getElementById('bbo-handviewer-float')?.remove();

  const win = document.createElement('div');
  win.id = 'bbo-handviewer-float';
  const w = Math.min(560, window.innerWidth - 32);
  const h = Math.min(620, window.innerHeight - 32);
  win.style.cssText = `position:fixed;right:16px;bottom:16px;width:${w}px;height:${h}px;z-index:9999;` +
    'background:#fff;border:1px solid #d1d5db;border-radius:8px;overflow:hidden;' +
    'box-shadow:0 8px 24px rgba(0,0,0,0.25);display:flex;flex-direction:column;';

  const cleanup = () => {
    win.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') cleanup(); };

  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;align-items:center;gap:10px;padding:6px 10px;background:#1f2937;flex-shrink:0;cursor:move;user-select:none;';

  const title = document.createElement('span');
  title.textContent = 'BBO Handviewer';
  title.style.cssText = 'color:#fff;font-size:13px;font-weight:600;';

  const ext = document.createElement('a');
  ext.textContent = 'New tab ↗';
  ext.href = url;
  ext.target = '_blank';
  ext.rel = 'noopener';
  ext.style.cssText = 'margin-left:auto;color:#93c5fd;font-size:12px;text-decoration:none;';

  const close = document.createElement('button');
  close.textContent = '✕';
  close.style.cssText = 'background:none;border:none;color:#d1d5db;font-size:14px;cursor:pointer;padding:2px 6px;';
  close.onclick = cleanup;

  const iframe = document.createElement('iframe');
  iframe.src = url;
  iframe.style.cssText = 'flex:1;border:none;width:100%;';

  bar.onmousedown = (e) => {
    if (e.target === ext || e.target === close) return;
    e.preventDefault();
    const rect = win.getBoundingClientRect();
    const offX = e.clientX - rect.left;
    const offY = e.clientY - rect.top;
    // switch from right/bottom to left/top anchoring so drag math is direct
    win.style.left = rect.left + 'px';
    win.style.top = rect.top + 'px';
    win.style.right = 'auto';
    win.style.bottom = 'auto';
    iframe.style.pointerEvents = 'none'; // iframe would swallow mousemove
    const onMove = (ev) => {
      win.style.left = Math.max(0, Math.min(ev.clientX - offX, window.innerWidth - 60)) + 'px';
      win.style.top = Math.max(0, Math.min(ev.clientY - offY, window.innerHeight - 40)) + 'px';
    };
    const onUp = () => {
      iframe.style.pointerEvents = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  bar.append(title, ext, close);
  win.append(bar, iframe);
  document.body.appendChild(win);
  document.addEventListener('keydown', onKey);
}

export async function downloadLin(supabase, analysis) {
  const filters = analysis.filters || {};
  const stageIds = filters.stage_ids || (filters.stage_id ? [filters.stage_id] : []);
  if (!stageIds.length) return;

  const { data: boards } = await supabase
    .from('bg_boards')
    .select('board_number, dealer, vulnerability, n_spades, n_hearts, n_diamonds, n_clubs, s_spades, s_hearts, s_diamonds, s_clubs, e_spades, e_hearts, e_diamonds, e_clubs, w_spades, w_hearts, w_diamonds, w_clubs')
    .in('stage_id', stageIds)
    .order('board_number');

  if (!boards?.length) return;

  const lines = boards.map(b => boardToLin(b, b.board_number));
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(analysis.name || 'boards').replace(/[^a-zA-Z0-9_-]/g, '_')}.lin`;
  a.click();
  URL.revokeObjectURL(url);
}
