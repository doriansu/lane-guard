#!/usr/bin/env python3
"""Local echo fixture. Records only routing headers, never cookies or paths."""

import argparse
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

PREFIX = "/__env_probe/"
EVENTS = []
LOCK = threading.Lock()
PAGE = b"""<!doctype html><meta charset="utf-8"><title>Environment probe</title>
<h1>Local environment probe</h1><pre id="result"></pre>
<a href="/__env_probe/page?case=blank" target="_blank">New tab</a>
<a href="/__env_probe/page?case=opener" target="_blank" rel="opener">With opener</a>
<button id="popup">New window</button>
<a href="/__env_probe/redirect?case=redirect">Redirect</a>
<form action="/__env_probe/echo?case=post" target="_blank" method="post">
<button>POST in new tab (must block)</button></form>
<script>
document.querySelector('#popup').onclick=()=>window.open(
  '/__env_probe/page?case=popup','_blank','popup,width=600,height=500');
fetch('/__env_probe/echo?case=bootstrap').then(r=>r.json()).then(data=>{
  document.querySelector('#result').textContent=JSON.stringify(data,null,2);
});
</script>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def send(self, status, body, content_type="application/json", extra=()):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in extra:
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.handle_request()

    def do_POST(self):
        self.handle_request()

    def handle_request(self):
        path = urlsplit(self.path).path
        if path == "/events" and self.command == "GET":
            with LOCK:
                body = json.dumps(EVENTS).encode()
            self.send(200, body)
            return
        if not path.startswith(PREFIX):
            self.send(404, b'{"error":"outside fixture"}')
            return
        event = {
            "time": time.time(), "method": self.command, "path": self.path,
            "env": self.headers.get("x-lane"),
            "flag": self.headers.get("x-lane-enabled"),
        }
        with LOCK:
            EVENTS.append(event)
            with open(self.server.output, "a", encoding="utf-8") as output:
                output.write(json.dumps(event) + "\n")
        if path == PREFIX + "redirect":
            self.send(302, b"", extra=[("Location", PREFIX + "page?case=redirected")])
        elif path == PREFIX + "page":
            self.send(200, PAGE, "text/html; charset=utf-8")
        else:
            self.send(200, json.dumps(event).encode())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, help="New JSONL evidence file")
    args = parser.parse_args()
    # Refuse to overwrite evidence from another run.
    with open(args.output, "x", encoding="utf-8"):
        pass
    server = ThreadingHTTPServer(("127.0.0.1", 51843), Handler)
    server.output = args.output
    print("Fixture listening on http://127.0.0.1:51843", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
