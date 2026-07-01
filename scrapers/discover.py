#!/usr/bin/env python3
"""
Tournament discovery from wbbridge.in results pages.

Parses the results page to find all events and their result URLs,
identifies the platform (BridgeWebs or Srini/bfi.net.in), and returns
structured JSON for the frontend to display.

Usage:
    python3 scrapers/discover.py <wbbridge_url>
    python3 scrapers/discover.py <bridgewebs_url>
"""

import argparse
import json
import re
import ssl
import sys
import urllib.request

_ssl_ctx = ssl.create_default_context()
_ssl_ctx.check_hostname = False
_ssl_ctx.verify_mode = ssl.CERT_NONE


def _fetch(url):
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    })
    with urllib.request.urlopen(req, context=_ssl_ctx) as resp:
        return resp.read().decode('utf-8', errors='replace')


def discover_wbbridge(url):
    """Parse a wbbridge.in tournament results page.
    Returns {tournament_name, events: [{name, date, sessions: [{label, url, platform}]}]}
    """
    html = _fetch(url)

    # Extract tournament name from page title or h1
    title_match = re.search(r'<title>(.*?)</title>', html, re.IGNORECASE)
    h1_match = re.search(r'<h1[^>]*>(.*?)</h1>', html, re.IGNORECASE | re.DOTALL)
    tournament_name = ''
    if h1_match:
        tournament_name = re.sub(r'<[^>]+>', '', h1_match.group(1)).strip()
    elif title_match:
        tournament_name = re.sub(r'<[^>]+>', '', title_match.group(1)).strip()

    # Parse table rows, preserving the site's own event grouping
    rows = re.findall(r'<tr[^>]*>(.*?)</tr>', html, re.DOTALL)

    current_date = ''
    current_event = ''
    event_groups = []
    current_group = None

    for row in rows:
        cells = re.findall(r'<td[^>]*>(.*?)</td>', row, re.DOTALL)
        if not cells:
            continue

        cell0 = re.sub(r'<[^>]+>', '', cells[0]).strip()
        cell1 = re.sub(r'<[^>]+>', '', cells[1]).strip().replace('&nbsp;', '').replace('\xa0', '') if len(cells) > 1 else ''

        # Skip header row
        if cell0 == 'Date':
            continue

        # Single-cell row = section header (event name with colspan)
        if len(cells) == 1 and cell0:
            current_event = cell0
            current_group = {'name': current_event, 'sessions': []}
            event_groups.append(current_group)
            continue

        # Row with date in cell0 = new date group, cell1 = first event name for that date
        date_match = re.match(r'^(\d{1,2})/(\d{1,2})/(\d{2,4})$', cell0)
        if date_match:
            d, m, y = date_match.groups()
            if len(y) == 2:
                y = f'20{y}'
            current_date = f'{d.zfill(2)}/{m.zfill(2)}/{y}'
            has_link = bool(re.search(r'href="', row))
            if cell1:
                if has_link:
                    # Date row that is also a session (e.g. "01/12/25 | Elimination")
                    current_event = cell1
                    current_group = {'name': current_event, 'sessions': []}
                    event_groups.append(current_group)
                    links = re.findall(r'href="([^"]+)"', row)
                    for link_url in links:
                        platform = 'bridgewebs' if 'bridgewebs.com' in link_url else 'srini' if 'bfi.net.in' in link_url else 'unknown'
                        event_key = None
                        if platform == 'bridgewebs':
                            m2 = re.search(r'event=(\d{8}_\d+)', link_url)
                            if m2: event_key = m2.group(1)
                        current_group['sessions'].append({
                            'name': cell1,
                            'date': current_date,
                            'url': link_url,
                            'platform': platform,
                            'event_key': event_key,
                        })
                else:
                    current_event = cell1
                    current_group = {'name': current_event, 'sessions': []}
                    event_groups.append(current_group)
            continue

        # Row where cell1 is empty = section header; cell1 has time = session
        is_time = bool(re.match(r'^\d{1,2}:\d{2}', cell1))
        has_link = bool(re.search(r'href="', row))

        if not cell1 and not has_link:
            current_event = cell0
            current_group = {'name': current_event, 'sessions': []}
            event_groups.append(current_group)
        elif is_time or has_link:
            # Session row
            links = re.findall(r'href="([^"]+)"', row)
            if not links:
                continue

            url = links[0]
            platform = 'bridgewebs' if 'bridgewebs.com' in url else 'srini' if 'bfi.net.in' in url else 'unknown'
            event_key = None
            if platform == 'bridgewebs':
                m = re.search(r'event=(\d{8}_\d+)', url)
                if m:
                    event_key = m.group(1)

            if current_group is None:
                current_group = {'name': current_event or cell0, 'sessions': []}
                event_groups.append(current_group)

            session_name = cell0
            current_group['sessions'].append({
                'name': session_name,
                'date': current_date,
                'url': url,
                'platform': platform,
                'event_key': event_key,
            })

    # Deduplicate sessions within each group
    for group in event_groups:
        seen = set()
        deduped = []
        for s in group['sessions']:
            key = f"{s['date']}|{s['name']}|{s['url']}"
            if key not in seen:
                seen.add(key)
                deduped.append(s)
        group['sessions'] = deduped

    # Remove empty groups
    event_groups = [g for g in event_groups if g['sessions']]

    # Merge pass 1: exact name match across dates
    merged = {}
    merged_order = []
    for g in event_groups:
        key = g['name'].upper()
        if key in merged:
            merged[key]['sessions'].extend(g['sessions'])
        else:
            merged[key] = g
            merged_order.append(key)
    event_groups = [merged[k] for k in merged_order]

    # Merge pass 2: groups sharing the same bfi.net.in URL slug
    def _get_slug(sessions):
        for s in sessions:
            m = re.search(r'/uploads/\d{4}/([^/]+)', s.get('url', ''))
            if m: return m.group(1)
        return None

    slug_merged = []
    slug_map = {}
    for g in event_groups:
        slug = _get_slug(g['sessions'])
        if slug and slug in slug_map:
            slug_map[slug]['sessions'].extend(g['sessions'])
        else:
            if slug:
                slug_map[slug] = g
            slug_merged.append(g)
    event_groups = slug_merged

    # Merge pass 3: alpha-only name comparison
    def _alpha_key(name):
        return re.sub(r'[^A-Za-z]', '', name).upper()

    def _should_merge(a, b):
        short, long = (a, b) if len(a) <= len(b) else (b, a)
        # Full prefix match (shorter is entirely contained at start of longer)
        if len(short) >= 8 and long.startswith(short):
            return True
        # First 16 chars match (handles typos in longer names)
        if len(short) >= 16 and long[:16] == short[:16]:
            return True
        return False

    final = []
    for g in event_groups:
        found = False
        gk = _alpha_key(g['name'])
        for m in final:
            mk = _alpha_key(m['name'])
            if _should_merge(gk, mk):
                m['sessions'].extend(g['sessions'])
                if len(g['name']) < len(m['name']):
                    m['name'] = g['name']
                found = True
                break
        if not found:
            final.append(g)
    event_groups = final

    return {
        'tournament_name': tournament_name,
        'event_groups': event_groups,
    }


def discover(url):
    """Auto-detect URL type and discover tournament events."""
    if 'wbbridge.in' in url:
        result = discover_wbbridge(url)
    elif 'bridgewebs.com' in url:
        from bridgewebs import discover_club
        result = discover_club(url)
        return result
    else:
        raise ValueError(f'Unsupported URL format: {url}')

    return result


def save_discovery(result):
    """Save discovery results to Supabase.
    Creates tournament, events, and stages (empty — no boards yet).
    Returns the saved structure with IDs.
    """
    from db import upsert_tournament, upsert_event, upsert_stage

    tournament_name = result['tournament_name'].replace('Results - ', '').strip()
    tournament_id = upsert_tournament({
        'name': tournament_name,
        'location': None,
        'date_start': None,
        'source_format': 'bridgewebs',
        'source_meta': {'discovery_url': result.get('discovery_url', '')},
    })

    saved_events = []
    for i, group in enumerate(result.get('event_groups', [])):
        event_id = upsert_event({
            'tournament_id': tournament_id,
            'name': group['name'],
            'type': 'pairs',
            'scoring': 'mp',
            'event_order': i + 1,
            'source_url': None,
            'source_meta': {},
        })

        saved_sessions = []
        for j, sess in enumerate(group.get('sessions', [])):
            source_url = sess.get('url', '').replace('&amp;', '&')
            stage_name = f"{sess['name']} ({_format_date(sess.get('date', ''))})"
            # Avoid unique constraint on source_url for stages sharing same URL
            stage_source_url = f"{source_url}#stage={j}" if source_url else None
            stage_id = upsert_stage({
                'event_id': event_id,
                'name': stage_name,
                'stage_order': j + 1,
                'source_url': stage_source_url,
                'source_meta': {
                    'platform': sess.get('platform', ''),
                    'event_key': sess.get('event_key'),
                    'date': sess.get('date', ''),
                },
            })
            saved_sessions.append({**sess, 'stage_id': stage_id})

        saved_events.append({
            'event_id': event_id,
            'name': group['name'],
            'sessions': saved_sessions,
        })

    return {
        'tournament_id': tournament_id,
        'tournament_name': tournament_name,
        'events': saved_events,
    }


def _format_date(date_str):
    """Convert dd/mm/yyyy to readable format."""
    if not date_str:
        return ''
    parts = date_str.split('/')
    if len(parts) != 3:
        return date_str
    d, m, y = parts
    months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    try:
        return f"{int(d)} {months[int(m)-1]} {y}"
    except (ValueError, IndexError):
        return date_str


def main():
    parser = argparse.ArgumentParser(description='Discover tournament events.')
    parser.add_argument('url', help='Tournament results URL (wbbridge.in or bridgewebs.com)')
    parser.add_argument('--save', action='store_true', help='Save discovery to database')
    args = parser.parse_args()

    try:
        result = discover(args.url)
        if args.save:
            saved = save_discovery(result)
            print(json.dumps(saved, default=list))
        else:
            print(json.dumps(result, indent=2, default=list))
    except ValueError as e:
        print(f'ERROR: {e}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
