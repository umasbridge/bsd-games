import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scrapers'))

# Vercel runs in UTC; session labels/dates use local time ("TZ" is a
# reserved env name on Vercel, so configure via BBO_TZ)
os.environ['TZ'] = os.environ.get('BBO_TZ', 'Asia/Kolkata')
time.tzset()


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)

        try:
            data = json.loads(body)
            action = data.get('action')
            username = (data.get('username') or '').strip()
            start_date = (data.get('start_date') or '').strip()
            end_date = (data.get('end_date') or '').strip() or start_date

            if not username or not start_date:
                self._json(400, {'error': 'username and start_date are required'})
                return

            from bbo import (
                build_url, fetch_hands_html, parse_hands_html,
                group_sessions, session_summary, import_session,
            )

            url = build_url(username, start_date, end_date)
            page = fetch_hands_html(url)
            hands = parse_hands_html(page)
            sessions = group_sessions(hands, username)

            if action == 'sessions':
                self._json(200, {'sessions': [session_summary(s) for s in sessions]})
                return

            if action == 'import':
                keys = data.get('keys') or []
                names = data.get('names') or {}
                if not keys:
                    self._json(400, {'error': 'keys is required for import'})
                    return
                by_key = {s['key']: s for s in sessions}
                imported, missing = [], []
                for key in keys:
                    sess = by_key.get(key)
                    if not sess:
                        missing.append(key)
                        continue
                    import_session(sess, username, url, name=names.get(key),
                                   user_id=data.get('user_id'))
                    imported.append(names.get(key) or sess['label'])
                result = {'success': True, 'imported': imported}
                if missing:
                    result['missing'] = missing
                self._json(200, result)
                return

            self._json(400, {'error': f'unknown action: {action}'})

        except ValueError as e:
            self._json(400, {'error': str(e)})
        except Exception as e:
            self._json(500, {'error': str(e)})

    def _json(self, status, data):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())
