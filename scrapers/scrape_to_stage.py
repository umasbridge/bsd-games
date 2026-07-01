#!/usr/bin/env python3
"""
Scrape a URL and move the data to existing (discovery-created) stages.

Accepts a JSON mapping of target stages. Runs the scraper once, then
matches each newly created stage to the correct target by source_url.
"""

import argparse
import json
import os
import subprocess
import sys

from db import get_client, move_stage_data, cleanup_empty_hierarchy, find_participants


def _detect_scraper(url):
    if 'bridgewebs.com' in url:
        return 'bridgewebs.py'
    elif 'lovebridge.com' in url:
        return 'lovebridge.py'
    else:
        return 'srini.py'


def _run_scraper_and_collect(scraper, url, existing_before):
    """Run a scraper and return newly created stage IDs."""
    scraper_path = os.path.join(os.path.dirname(__file__), scraper)
    c = get_client()

    result = subprocess.run(
        ['python3', scraper_path, url],
        capture_output=True, text=True, env=os.environ,
        cwd=os.path.dirname(__file__),
        timeout=600,
    )

    if result.returncode != 0:
        print(f'Scraper error for {url}: {result.stderr}', file=sys.stderr)
        return []

    print(result.stdout, file=sys.stderr)

    all_stages_after = c.table('bg_stages').select('id, event_id, source_url, name').execute()
    return [s for s in (all_stages_after.data or []) if s['id'] not in existing_before]


def _match_and_move(new_stages, stage_mappings):
    """Match new stages to targets and move data."""
    import re
    matched = 0
    for ns in new_stages:
        ns_url = (ns.get('source_url') or '').lower()
        target = None

        for sm in stage_mappings:
            sm_url = (sm.get('sourceUrl') or '').lower()
            if not ns_url or not sm_url:
                continue
            # Match by event key
            ns_key = re.search(r'event=(\d{8}_\d+)', ns_url)
            sm_key = re.search(r'event=(\d{8}_\d+)', sm_url)
            if ns_key and sm_key and ns_key.group(1) == sm_key.group(1):
                target = sm
                break
            # Match by URL slug + path (normalize trailing slash and index.html)
            ns_clean = re.sub(r'#.*$', '', ns_url).rstrip('/').replace('/index.html', '')
            sm_clean = re.sub(r'#.*$', '', sm_url).rstrip('/').replace('/index.html', '')
            if ns_clean == sm_clean:
                target = sm
                break

        if not target and len(new_stages) == len(stage_mappings):
            target = stage_mappings[new_stages.index(ns)]

        if target:
            print(f'Moving {ns["name"]} → {target["stageId"]}', file=sys.stderr)
            move_stage_data(ns['id'], target['stageId'], target['eventId'])
            cleanup_empty_hierarchy(ns['id'])
            matched += 1
        else:
            print(f'No target for {ns["name"]}', file=sys.stderr)
            cleanup_empty_hierarchy(ns['id'])

    return matched


def scrape_and_move(url, stage_mappings):
    """Scrape all URLs (grouping by platform) and move data to target stages."""
    c = get_client()

    # Record existing stages
    existing_before = set()
    all_stages = c.table('bg_stages').select('id').execute()
    for s in (all_stages.data or []):
        existing_before.add(s['id'])

    # Group mappings by platform/scraper
    from collections import defaultdict
    groups = defaultdict(list)
    for sm in stage_mappings:
        src = (sm.get('sourceUrl') or '').replace('&amp;', '&')
        scraper = _detect_scraper(src)
        groups[scraper].append(sm)

    total_matched = 0
    for scraper, mappings in groups.items():
        # Use the first URL to trigger scraping (scraper discovers siblings)
        first_url = mappings[0]['sourceUrl'].replace('&amp;', '&')

        # For srini, each URL is independent — scrape each separately
        if scraper == 'srini.py':
            # Deduplicate by base URL (strip fragment and index.html)
            import re
            seen_urls = set()
            for sm in mappings:
                src = sm['sourceUrl'].replace('&amp;', '&')
                src = re.sub(r'#.*$', '', src)
                src = re.sub(r'/index\.html$', '/', src)
                if src in seen_urls:
                    continue
                seen_urls.add(src)
                # Find all mappings that share this base URL
                batch = [m for m in mappings if re.sub(r'#.*$', '', re.sub(r'/index\.html', '/', m['sourceUrl'].replace('&amp;', '&'))) == src]
                new_stages = _run_scraper_and_collect(scraper, src, existing_before)
                if new_stages:
                    total_matched += _match_and_move(new_stages, batch)
                    for ns in new_stages:
                        existing_before.add(ns['id'])
        else:
            # BridgeWebs/LoveBridge: one scrape discovers all sessions
            new_stages = _run_scraper_and_collect(scraper, first_url, existing_before)
            if new_stages:
                total_matched += _match_and_move(new_stages, mappings)
                for ns in new_stages:
                    existing_before.add(ns['id'])

    return total_matched > 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('url', help='URL to scrape')
    parser.add_argument('--mappings', required=True, help='JSON array of {stageId, eventId, sourceUrl}')
    args = parser.parse_args()

    mappings = json.loads(args.mappings)
    success = scrape_and_move(args.url, mappings)
    print(json.dumps({'success': success}))


if __name__ == '__main__':
    main()
