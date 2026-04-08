/**
 * htmlToGame.js — Convert bridge analysis HTML to md + formatting
 *
 * Parses the HTML output from bridge_analysis.py and produces:
 * - md: markdown compatible with bsd-lib's parseSystemMd
 * - formatting: visual overrides including SVG images in rowHtml
 */

/**
 * Parse bridge analysis HTML and return { md, formatting }.
 *
 * @param {string} html - The HTML string from bridge_analysis.py
 * @returns {{ md: string, formatting: object }}
 */
export function htmlToGame(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // --- Extract metadata ---
  const h1 = doc.querySelector('h1');
  const h2 = doc.querySelector('h2');
  const summary = doc.querySelector('.summary');

  const tournamentName = h1?.textContent?.trim() || '';
  const subtitle = h2?.textContent?.trim() || '';  // "Venue | Date"
  const title = [tournamentName, subtitle].filter(Boolean).join(' | ');

  // Extract pair info from summary
  const summaryText = summary?.textContent?.trim() || '';
  // Summary HTML has: <b>Pair Name</b> — Rank: <b>X</b>/Y<br>Boards ...<br>Total: ...
  const summaryHtml = summary?.innerHTML || '';
  // Clean summary: remove outer tags, keep inner HTML for text_el
  const descriptionHtml = summaryHtml
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<\/?b>/g, '')
    .replace(/<\/?small>/g, '')
    .trim();
  const descriptionText = summaryText.replace(/\s+/g, ' ');

  // --- Extract table rows ---
  const tableRows = doc.querySelectorAll('table.main tbody tr');
  const rows = [];
  let maxBidColWidth = 0;
  let maxCol1Width = 0;

  for (const tr of tableRows) {
    const boardCell = tr.querySelector('.board-cell');
    const oppCell = tr.querySelector('.opp-name');
    const analysisCell = tr.querySelector('.analysis-cell');

    if (!boardCell) continue;

    // Column 1 (bid): Extract SVG image + hand info
    const img = boardCell.querySelector('img');
    const handInfo = boardCell.querySelector('.hand-info');
    const imgSrc = img?.getAttribute('src') || '';

    // Extract SVG width from data URI to compute column width
    let svgWidth = 0;
    if (imgSrc.startsWith('data:image/svg+xml;base64,')) {
      try {
        const svgXml = atob(imgSrc.slice('data:image/svg+xml;base64,'.length));
        const wMatch = svgXml.match(/width="(\d+)"/);
        if (wMatch) svgWidth = parseInt(wMatch[1], 10);
      } catch {}
    }

    // Rebuild hand-info as compact left-aligned text
    const infoHtml = buildCompactHandInfo(handInfo);

    // Estimate hand-info text width (~6px per char at font-size 0.82em)
    const infoText = handInfo?.textContent?.trim() || '';
    const infoLines = infoText.split('\n').map(l => l.trim()).filter(Boolean);
    const maxInfoLineLen = Math.max(0, ...infoLines.map(l => l.length));
    const infoWidth = maxInfoLineLen * 6;

    // Track max content width for this row
    const contentWidth = Math.max(svgWidth, infoWidth);
    if (contentWidth > maxBidColWidth) maxBidColWidth = contentWidth;

    // Build bidHtml: image + compact info below it
    let bidHtml = '';
    if (imgSrc) {
      bidHtml += `<img src="${imgSrc}" alt="Hand diagram">`;
    }
    if (infoHtml) {
      bidHtml += `<br>${infoHtml}`;
    }

    // Plain text bid (for md)
    const bidText = handInfo?.textContent?.trim().split('\n')[0]?.trim() || '';
    // Extract board number and contract from hand-info text
    const bidShort = extractBidShort(handInfo?.textContent || '');

    // Column 2: Opponent name + DD info
    const oppText = oppCell?.textContent?.trim() || '';
    const ddSection = analysisCell?.querySelector('.dd-section');

    // Extract DD lines cleanly — strip inner HTML tags, rebuild as plain inline text
    const ddInner = ddSection?.innerHTML || '';
    const ddNsEl = ddInner.match(/<b>DD NS:<\/b>\s*(.*?)(?:<br|<b>DD EW:)/i);
    const ddEwEl = ddInner.match(/<b>DD EW:<\/b>\s*(.*)/i);
    const ddNsText = ddNsEl ? ddNsEl[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim() : '';
    const ddEwText = ddEwEl ? ddEwEl[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim() : '';

    // Build column 1 HTML: opp name + DD lines, compact with no extra spacing
    const s = 'font-size:0.9em;line-height:1.3;margin:0;padding:0';
    let col1Html = `<b>${oppText}</b>`;
    if (ddNsText || ddEwText) {
      col1Html += `<br><span style="${s}">DD NS: ${colorSuits(ddNsText)}<br>DD EW: ${colorSuits(ddEwText)}</span>`;
    }

    // Estimate col1 text width for column sizing
    // BidTable cell base font is 16px system-ui; DD text is 0.9em = 14.4px
    const oppWidth = measureTextWidth(oppText, 'bold 16px system-ui, sans-serif');
    const ddNsWidth = measureTextWidth(`DD NS: ${ddNsText}`, '14.4px system-ui, sans-serif');
    const ddEwWidth = measureTextWidth(`DD EW: ${ddEwText}`, '14.4px system-ui, sans-serif');
    const col1Width = Math.max(oppWidth, ddNsWidth, ddEwWidth);
    if (col1Width > maxCol1Width) maxCol1Width = col1Width;

    const col1Text = [oppText, `DD NS: ${ddNsText}`, `DD EW: ${ddEwText}`].filter(Boolean).join('. ');

    // Column 3: Analysis text (editable)
    // Convert class-based suit colors to inline styles for BidTable rendering
    const analysisDiv = analysisCell?.querySelector('.analysis-text');
    const col2Html = (analysisDiv?.innerHTML?.trim() || '')
      .replace(/<span class="s">/g, '<span style="color:#000;font-weight:bold">')
      .replace(/<span class="h">/g, '<span style="color:#c62828;font-weight:bold">')
      .replace(/<span class="d">/g, '<span style="color:#c62828;font-weight:bold">')
      .replace(/<span class="c">/g, '<span style="color:#2e7d32;font-weight:bold">');
    const col2Text = analysisDiv?.textContent?.trim() || '';

    rows.push({
      bidShort,
      bidHtml,
      col1Text,
      col1Html,
      col2Text,
      col2Html,
    });
  }

  // --- Extract pair name for subtitle ---
  const summaryBold = summary?.querySelector('b');
  const pairName = summaryBold?.textContent?.trim() || '';
  const summaryLines = summaryText.split(/\s+/).join(' ');

  // --- Build titleHtml: tournament name + pair info subtitle ---
  const titleHtml = `<span style="font-weight:700">${title}</span>`
    + `<br><b style="font-size:13px;color:#555">${summaryLines}</b>`;

  // --- Build md ---
  let md = '---\n';
  md += `system: ${title}\n`;
  md += `description: ${descriptionText}\n`;
  md += '---\n\n';

  // Table rows (no ## heading = no table name header)
  for (const row of rows) {
    // Escape pipe characters in text content
    const bid = escapePipe(row.bidShort);
    const col1 = escapePipe(row.col1Text);
    const col2 = escapePipe(row.col2Text);
    md += `| ${bid} | ${col1} | ${col2} |\n`;
  }

  // --- Build formatting ---
  const rowHtml = rows.map(row => ({
    bidHtml: row.bidHtml,
    columns: [
      row.col1Html ? { html: row.col1Html } : null,
      row.col2Html ? { html: row.col2Html } : null,
    ],
  }));

  // Column widths: bid column + opp/DD column (col0, absorbs) + analysis column (col1, fixed 500)
  // col0 absorbs = totalWidth - bidCol - col1
  // We want col0 = maxCol1Width + 10, so totalWidth = bidCol + (maxCol1Width + 10) + 500
  const bidColW = maxBidColWidth + 10;
  const col0W = maxCol1Width + 10;
  const col1W = 500;
  const totalWidth = bidColW + col0W + col1W;

  const formatting = {
    main: {
      titleHtml,
      elements: [
        {    // index 0: table element (only element on main page)
          width: totalWidth,
          columnWidths: [col0W, col1W],
          levelWidths: { '0': bidColW },
          gridlines: { enabled: true, color: '#D1D5DB', width: 1 },
          rowHtml,
        },
      ],
    },
  };

  return { md, formatting };
}

/**
 * Extract a short bid description from hand-info text.
 * Input like "Bd 1 | None | Dlr N\n1NT by W +1, Lead: ♦J\nScore: -120 (NS) 11% (7/62 MP)"
 * Output: "Bd 1: 1NT by W +1"
 */
function extractBidShort(text) {
  const lines = text.trim().split('\n').map(l => l.trim());
  const bdMatch = lines[0]?.match(/Bd\s*(\d+)/);
  const bdNum = bdMatch ? bdMatch[1] : '?';

  // Second line has the contract
  let contract = '';
  if (lines.length > 1) {
    // "1NT by W +1, Lead: ♦J" → "1NT by W +1"
    const m = lines[1].match(/^(.+?),\s*Lead/);
    contract = m ? m[1].trim() : lines[1].trim();
  }

  return `Bd ${bdNum}: ${contract}`;
}

/**
 * Rebuild hand-info as compact left-aligned lines.
 * Input HTML: "Bd 1 | None | Dlr N<br><b>1NT by W +1</b>, Lead: ♦J<br>Score: -120 (NS) &nbsp;<span class='result terrible'>11%</span><small>(7/62 MP)</small>"
 * Output: "Bd 1 | None | Dlr N<br><b>1NT by W +1</b>, Lead: ♦J<br>Score: -120 (NS) | 11% (7/62 MP)"
 */
function buildCompactHandInfo(handInfo) {
  if (!handInfo) return '';

  // Extract the pieces from the hand-info div
  const text = handInfo.textContent || '';
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Line 1: "Bd 1 | None | Dlr N"
  const line1 = lines[0] || '';

  // Line 2: contract + lead (preserve HTML for colored suits)
  // Find the <b> tag for contract
  const bTag = handInfo.querySelector('b');
  const contractHtml = bTag?.outerHTML || '';
  // Find lead text after the <b>
  const fullHtml = handInfo.innerHTML;
  const leadMatch = fullHtml.match(/Lead:\s*([^<\n]+(?:<span[^>]*>[^<]*<\/span>[^<\n]*)?)/);
  const leadHtml = leadMatch ? `Lead: ${leadMatch[1].trim()}` : '';
  const line2 = [contractHtml, leadHtml].filter(Boolean).join(', ');

  // Line 3: Score + percentage + MP combined
  const scoreMatch = text.match(/Score:\s*([+-]?\d+)\s*\(NS\)/);
  const score = scoreMatch ? `Score: ${scoreMatch[1]} (NS)` : '';
  const resultSpan = handInfo.querySelector('.result');
  const pct = resultSpan?.textContent?.trim() || '';
  const pctClass = resultSpan?.className?.replace('result', '')?.trim() || '';
  const mpMatch = text.match(/\((\d+\/\d+)\s*MP\)/);
  const mp = mpMatch ? `(${mpMatch[1]} MP)` : '';
  const pctHtml = pct ? `<b style="color:${getPctColor(pctClass)}">${pct}</b>` : '';
  const line3 = [score, pctHtml, mp].filter(Boolean).join(' ');

  const style = 'font-size:0.82em;line-height:1.4';
  return `<span style="${style}">${line1}<br>${line2}<br>${line3}</span>`;
}

function getPctColor(cls) {
  if (cls.includes('good')) return '#2e7d32';
  if (cls.includes('ok')) return '#558b2f';
  if (cls.includes('bad')) return '#e65100';
  if (cls.includes('terrible')) return '#c62828';
  return '#333';
}

/** Colorize suit symbols: ♥♦ in red, ♠♣ in black. */
function colorSuits(text) {
  return (text || '')
    .replace(/♥/g, '<span style="color:#c62828">♥</span>')
    .replace(/♦/g, '<span style="color:#c62828">♦</span>')
    .replace(/♠/g, '<span style="color:#000">♠</span>')
    .replace(/♣/g, '<span style="color:#2e7d32">♣</span>');
}

/** Measure text width in pixels using a canvas context. */
let _measureCtx;
function measureTextWidth(text, font) {
  if (!_measureCtx) {
    _measureCtx = document.createElement('canvas').getContext('2d');
  }
  _measureCtx.font = font;
  return _measureCtx.measureText(text).width;
}

function escapePipe(text) {
  return (text || '')
    .replace(/\|/g, '∣')          // Replace pipe with similar unicode char
    .replace(/[\n\r]+/g, ' ')     // Collapse newlines to spaces (md rows must be single-line)
    .replace(/\s+/g, ' ')         // Collapse multiple spaces
    .trim();
}
