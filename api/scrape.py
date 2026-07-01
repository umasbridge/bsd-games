import json
import os
import sys
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scrapers'))


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)

        try:
            data = json.loads(body)
            url = data.get('url')
            name = data.get('name')
            if not url:
                self._json(400, {'error': 'url is required'})
                return

            if 'lovebridge.com' in url:
                from lovebridge import scrape
            elif 'bridgewebs.com' in url:
                from bridgewebs import scrape
            elif 'wbbridge.in' in url:
                from sg import scrape
            else:
                from srini import scrape

            scrape(url, name=name)
            self._json(200, {'success': True})

        except ValueError as e:
            self._json(400, {'error': str(e)})
        except Exception as e:
            self._json(500, {'error': str(e)})

    def _json(self, status, data):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())
