#!/usr/bin/env python3
"""
docker-read-proxy: a read-only, sanitizing view of the Docker API
(infra-manager design §5.1, step I1).

The Docker socket is root on the host, mounted :ro or not. This service is meant to
be the only thing that holds it for reading: it serves a few GET endpoints over TCP, to
the services named in ALLOWED_CLIENTS only, and refuses everything else.

Served: ping, version, container list, inspect, container events, stats and logs. The
first five are rebuilt from an allowlist of fields, so environment variables, commands,
mounts and unlisted labels never leave it, nor do fields a later Docker version adds.
Stats (numbers) and logs are passed through as they are.
"""

import http.client
import json
import os
import re
import select
import socket
import socketserver
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qsl, urlencode, urlsplit

SOCKET_PATH = os.environ.get('DOCKER_SOCKET', '/var/run/docker.sock')
PORT = int(os.environ.get('PORT', '2375'))
BIND = os.environ.get('BIND', '0.0.0.0')
# Compose service names that may connect. The network alone
# doesn't keep others out: an internal bridge is still reachable from the host.
ALLOWED_CLIENTS = os.environ.get('ALLOWED_CLIENTS', '').split()
HEALTH_CHECK = '127.0.0.1'  # outside every limit below
MAX_REQUESTS = 64           # at once, streams included
MAX_PER_CLIENT = 32
MAX_CONNECTIONS = 96
MAX_CONNECTIONS_PER_CLIENT = 40
MAX_FILTERS = 4096
MAX_BODY = 16 * 1024 * 1024  # of a response that is rebuilt
MAX_EVENT = 256 * 1024       # one event line

ID = r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}'
VERSION_PREFIX = re.compile(r'^/v1\.\d{1,3}(?=/)')
# What compose drift checks and routing need. Not traefik middlewares (they hold
# credentials and free-form plugin options) nor compose's host paths.
LABEL = re.compile(
    r'^(com\.docker\.compose\.(project|service|container-number|oneoff|config-hash|version|depends_on|image)'
    r'|traefik\.enable|traefik\.docker\.network'
    r'|traefik\.(http|tcp|udp)\.routers\.[\w-]+\.(rule|entrypoints|service|priority|middlewares|tls|tls\.certresolver)'
    r'|traefik\.(http|tcp|udp)\.services\.[\w-]+\.loadbalancer\.server\.(port|scheme))$', re.I | re.A)


def log(message):
    print(f'docker-read-proxy: {message}', flush=True)


# ── Sanitizing ────────────────────────────────────────────────────────────────

def pick(source, *keys):
    return {k: source[k] for k in keys if k in source} if isinstance(source, dict) else {}


def labels(source):
    if not isinstance(source, dict):
        return {}
    return {k: v for k, v in source.items() if LABEL.fullmatch(k)}


def ports(source):
    return [pick(p, 'IP', 'PrivatePort', 'PublicPort', 'Type') for p in source or [] if isinstance(p, dict)]


def clean_list(items):
    out = []
    for c in items:
        out.append({
            **pick(c, 'Id', 'Names', 'Image', 'ImageID', 'Created', 'State', 'Status'),
            'Command': '',
            'Ports': ports(c.get('Ports')),
            'Labels': labels(c.get('Labels')),
            'HostConfig': pick(c.get('HostConfig'), 'NetworkMode'),
            'Mounts': [],
        })
    return out


def clean_inspect(c):
    config, host, state = c.get('Config') or {}, c.get('HostConfig') or {}, c.get('State') or {}
    out = pick(c, 'Id', 'Created', 'Image', 'Name', 'RestartCount', 'Driver', 'Platform')
    out['State'] = pick(state, 'Status', 'Running', 'Paused', 'Restarting', 'OOMKilled', 'Dead', 'Pid',
                        'ExitCode', 'StartedAt', 'FinishedAt')
    if isinstance(state.get('Health'), dict):
        # Its Log holds the health check's output.
        out['State']['Health'] = pick(state['Health'], 'Status', 'FailingStreak')
    out['Config'] = {
        **pick(config, 'Hostname', 'User', 'Tty', 'OpenStdin', 'Image', 'ExposedPorts', 'StopSignal'),
        'Env': [], 'Cmd': [], 'Labels': labels(config.get('Labels')),
    }
    out['HostConfig'] = {
        **pick(host, 'NetworkMode', 'RestartPolicy', 'Privileged', 'ReadonlyRootfs', 'CapAdd', 'CapDrop', 'PidMode',
               'Memory', 'NanoCpus', 'CpuShares', 'PidsLimit'),
        'LogConfig': pick(host.get('LogConfig'), 'Type'),
        'Binds': [],
    }
    out['Mounts'] = []
    net = c.get('NetworkSettings') or {}
    out['NetworkSettings'] = {
        **pick(net, 'Ports'),
        'Networks': {n: pick(v, 'NetworkID', 'IPAddress', 'Gateway', 'MacAddress')
                     for n, v in (net.get('Networks') or {}).items()},
    }
    return out


def clean_event(e):
    """The event, or None for one that isn't about a container."""
    if not isinstance(e, dict) or e.get('Type') != 'container':
        return None
    # "exec_create: sh -c …" carries the whole command.
    action = str(e.get('Action', '')).split(':', 1)[0]
    if action.startswith('health_status'):
        action = str(e.get('Action', ''))
    actor = e.get('Actor') or {}
    attributes = actor.get('Attributes') or {}
    out = pick(e, 'id', 'from', 'Type', 'scope', 'time', 'timeNano')
    if 'status' in e:
        out['status'] = action
    out['Action'] = action
    out['Actor'] = {
        'ID': actor.get('ID', ''),
        'Attributes': {**pick(attributes, 'name', 'image', 'exitCode', 'signal', 'execDuration'), **labels(attributes)},
    }
    return out


def clean_version(v):
    return pick(v, 'Version', 'ApiVersion', 'MinAPIVersion', 'Os', 'Arch')


# ── Requests ──────────────────────────────────────────────────────────────────

class Refused(Exception):
    pass


# A filter answers yes or no about what it matches, so it may only match what is shown.
FILTERS = {'id', 'name', 'status', 'health', 'ancestor', 'event', 'container', 'type', 'image', 'label',
           'network', 'exited', 'before', 'since', 'scope'}
# Docker matches event values as prefixes of the action, and an exec's action is its command.
EVENT = re.compile(r'^([a-z_]{1,32}|health_status: (healthy|unhealthy|starting))$')


def check_filters(text):
    """The filters, checked and written anew, or Refused."""
    # Bounded before parsing: deep nesting overflows the parser's stack.
    if len(text) > MAX_FILTERS or text.count('[') + text.count('{') > 64:
        raise Refused('filters too large')
    try:
        filters = json.loads(text)
    except (ValueError, RecursionError):
        raise Refused('bad filters')
    if not isinstance(filters, dict):
        raise Refused('bad filters')
    out = {}
    for key, values in filters.items():
        if key not in FILTERS or not isinstance(values, (list, dict)):
            raise Refused('filter')
        values = [v for v, on in values.items() if on is True] if isinstance(values, dict) else values
        for v in values:
            if not isinstance(v, str):
                raise Refused('filter value')
            if key == 'label' and not LABEL.fullmatch(v.split('=', 1)[0]):
                raise Refused('label filter')
            if key == 'event' and not EVENT.fullmatch(v):
                raise Refused('event filter')
        out[key] = values
    return json.dumps(out)


class Route:
    def __init__(self, pattern, query, kind, clean=None):
        self.pattern, self.query, self.kind, self.clean = re.compile(f'^{pattern}$'), set(query), kind, clean


ROUTES = [
    Route(r'/_ping', [], 'raw'),
    Route(r'/version', [], 'json', clean_version),
    Route(r'/containers/json', ['all', 'limit', 'filters'], 'json', clean_list),
    Route(rf'/containers/{ID}/json', [], 'json', clean_inspect),
    Route(rf'/containers/{ID}/stats', ['stream', 'one-shot'], 'stream'),
    # Not "details": it adds the log driver's env and label attributes to each line.
    Route(rf'/containers/{ID}/logs', ['follow', 'stdout', 'stderr', 'since', 'until', 'timestamps', 'tail'], 'stream'),
    Route(r'/events', ['since', 'until', 'filters'], 'events', clean_event),
]


def resolve(target):
    """(route, upstream path) for a request target, or Refused."""
    try:
        parts = urlsplit(target)
    except ValueError:
        raise Refused('url')
    if parts.scheme or parts.netloc or '%' in parts.path or '//' in parts.path:
        raise Refused('path')
    prefix = VERSION_PREFIX.match(parts.path)
    path = VERSION_PREFIX.sub('', parts.path)
    route = next((r for r in ROUTES if r.pattern.fullmatch(path)), None)
    if route is None:
        raise Refused('not served')
    query = []
    for key, value in parse_qsl(parts.query, keep_blank_values=True):
        if key not in route.query:
            # Dropped, not refused: clients send defaults such as size=0 or details=0.
            continue
        if key == 'filters':
            if not value:
                continue
            value = check_filters(value)
        query.append((key, value))
    if route.kind == 'events' and not any(k == 'filters' for k, _ in query):
        query.append(('filters', json.dumps({'type': {'container': True}})))
    return route, (prefix.group(0) if prefix else '') + path + (f'?{urlencode(query)}' if query else '')


class UnixConnection(http.client.HTTPConnection):
    def __init__(self):
        super().__init__('docker', timeout=30)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(SOCKET_PATH)


class Slots:
    """`total` at once, `each` of them for one address; the health check always gets in."""

    def __init__(self, total, each):
        self.total, self.each, self.lock, self.used = total, each, threading.Lock(), {}

    def take(self, client):
        if client == HEALTH_CHECK:
            return True
        with self.lock:
            if sum(self.used.values()) >= self.total or self.used.get(client, 0) >= self.each:
                return False
            self.used[client] = self.used.get(client, 0) + 1
            return True

    def give(self, client):
        if client == HEALTH_CHECK:
            return
        with self.lock:
            self.used[client] -= 1
            if not self.used[client]:
                del self.used[client]


slots = Slots(MAX_REQUESTS, MAX_PER_CLIENT)


class Clients:
    """
    The addresses of ALLOWED_CLIENTS, looked up in the background: a lookup can take
    seconds, and must not hold up a connection, let alone everyone else's.
    """
    INTERVAL = 2
    KEEP = 30  # seconds an address outlives a failing lookup

    def __init__(self):
        self.known = {}  # name -> (addresses, when)
        self.addresses = frozenset()

    def refresh(self):
        for name in ALLOWED_CLIENTS:
            try:
                # The dot: not a relative name, so no search domains.
                self.known[name] = (socket.gethostbyname_ex(f'{name}.')[2], time.monotonic())
            except socket.gaierror as err:
                if err.errno == socket.EAI_NONAME or time.monotonic() - self.known.get(name, ([], 0))[1] > self.KEEP:
                    self.known.pop(name, None)
            except OSError:
                if time.monotonic() - self.known.get(name, ([], 0))[1] > self.KEEP:
                    self.known.pop(name, None)
        self.addresses = frozenset(a for found, _ in self.known.values() for a in found)

    def run(self):
        while True:
            try:
                self.refresh()
            except Exception as err:  # never end: nobody could connect any more
                log(f'lookup failed: {type(err).__name__}')
            time.sleep(self.INTERVAL)


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'docker-read-proxy'
    sys_version = ''
    timeout = 60

    def log_message(self, *args):  # no access log
        pass

    def reply(self, status, body, content_type='application/json', headers=()):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        for k, v in headers:
            self.send_header(k, v)
        if self.close_connection:
            self.send_header('Connection', 'close')
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def fail(self, status, message):
        self.close_connection = True
        self.reply(status, json.dumps({'message': f'docker-read-proxy: {message}'}).encode())

    def refuse(self):
        log(f'refused {self.command} {self.path.split('?')[0][:200]!r} from {self.client_address[0]}')
        self.fail(403, 'not allowed')

    do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = do_CONNECT = do_TRACE = refuse

    def do_HEAD(self):
        if VERSION_PREFIX.sub('', self.path) != '/_ping':
            return self.refuse()
        self.serve()

    def do_GET(self):
        self.serve()

    def has_body(self):
        """Anything that says a body or an upgrade follows, or a header we can't read plainly."""
        headers = self.headers
        return bool(
            headers.defects
            or any(k != k.strip() or ' ' in k or '\t' in k for k in headers.keys())
            or any(headers.get(k) is not None for k in ('Transfer-Encoding', 'Upgrade', 'Expect'))
            or headers.get_all('Content-Length', []) not in ([], ['0']))

    def serve(self):
        if self.request_version != 'HTTP/1.1':
            return self.fail(505, 'HTTP/1.1 only')  # streams are chunked
        if self.has_body():
            return self.refuse()
        try:
            route, path = resolve(self.path)
        except Refused:
            return self.refuse()
        client = self.client_address[0]
        if not slots.take(client):
            return self.fail(503, 'too many requests')
        upstream = UnixConnection()
        try:
            upstream.request(self.command, path)
            response = upstream.getresponse()
            if response.status >= 300:
                return self.error(response)
            if route.kind == 'raw':
                self.reply(200, response.read(1024), 'text/plain',
                           [(h, response.headers[h]) for h in ('Api-Version', 'Ostype') if response.headers.get(h)])
            elif route.kind == 'json':
                body = response.read(MAX_BODY + 1)
                if len(body) > MAX_BODY:
                    return self.fail(502, 'response too large')
                self.reply(200, json.dumps(route.clean(json.loads(body))).encode())
            else:
                self.stream(upstream, response, route.clean if route.kind == 'events' else None)
        except (OSError, http.client.HTTPException, ValueError, AttributeError, TypeError) as err:
            self.close_connection = True
            if not getattr(self, 'streaming', False):
                log(f'{route.kind} failed: {type(err).__name__}')
                try:
                    self.fail(502, 'docker is not answering')
                except OSError:
                    pass
        finally:
            upstream.close()
            slots.give(client)

    def error(self, response):
        """Docker's status; its text only for the client's own mistakes (others name host paths)."""
        message = 'docker answered with an error'
        if response.status in (400, 404, 409):
            message = str(json.loads(response.read(64 * 1024)).get('message', message))[:500]
        self.reply(response.status, json.dumps({'message': message}).encode())

    def stream(self, upstream, response, clean):
        self.streaming = True
        # No write deadline: a client that is slow (its own sink is down) keeps its stream.
        # Keepalive and watch_client notice one that is gone.
        self.connection.settimeout(None)
        self.close_connection = True
        self.send_response(200)
        self.send_header('Content-Type', response.headers.get('Content-Type', 'application/octet-stream'))
        self.send_header('Transfer-Encoding', 'chunked')
        self.send_header('Connection', 'close')
        self.end_headers()
        sock = upstream.sock or response.fp.raw._sock
        sock.settimeout(None)  # a quiet container's log may say nothing for days
        done = threading.Event()
        threading.Thread(target=self.watch_client, args=(sock, done), daemon=True).start()
        try:
            if clean:
                while True:
                    line = response.readline(MAX_EVENT + 1)
                    if not line:
                        break
                    if len(line) > MAX_EVENT:
                        log('event too long, stream closed')
                        raise ValueError('event too long')  # no clean end: something is missing
                    event = clean(json.loads(line)) if line.strip() else None
                    if event is not None:
                        self.chunk(json.dumps(event).encode() + b'\n')
            else:
                while data := response.read1(64 * 1024):
                    self.chunk(data)
            self.wfile.write(b'0\r\n\r\n')
        finally:
            done.set()

    def chunk(self, data):
        self.wfile.write(b'%x\r\n%s\r\n' % (len(data), data))
        self.wfile.flush()

    def watch_client(self, sock, done):
        """
        End a quiet stream when the client goes away, instead of at the next line. Any
        byte ends it too: a client has nothing more to say, and unread bytes would hide
        its leaving.
        """
        try:
            poll = select.poll()
            poll.register(self.connection, select.POLLIN | select.POLLRDHUP)
            while not done.is_set():
                if poll.poll(5000):
                    break
        except (OSError, ValueError):
            pass
        if not done.is_set():
            # Both: the handler may be reading from Docker or stuck writing to the client.
            for s in (sock, self.connection):
                try:
                    s.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 64

    def __init__(self, *args):
        super().__init__(*args)
        self.clients = Clients()
        self.connections = Slots(MAX_CONNECTIONS, MAX_CONNECTIONS_PER_CLIENT)
        self.logged_at = float('-inf')

    def server_bind(self):
        # Not HTTPServer's: it looks up this host's name before listening.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = 'docker-read-proxy', self.server_address[1]

    def verify_request(self, request, client_address):
        address = client_address[0]
        if address == HEALTH_CHECK or address in self.clients.addresses:
            return True
        if time.monotonic() - self.logged_at > 10:
            self.logged_at = time.monotonic()
            log(f'refused a connection from {address}')
        return False

    def process_request(self, request, client_address):
        if not self.connections.take(client_address[0]):
            return self.shutdown_request(request)
        try:
            request.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
            request.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, 60)
            super().process_request(request, client_address)
        except Exception:  # no thread to be had, say; the thread gives it back otherwise
            self.connections.give(client_address[0])
            self.shutdown_request(request)
            log('could not serve a connection')

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.connections.give(client_address[0])

    def handle_error(self, request, client_address):
        log(f'request from {client_address[0]} failed: {type(sys.exc_info()[1]).__name__}')


def healthcheck():
    """For the container's health check: is this proxy, and Docker behind it, answering?"""
    conn = http.client.HTTPConnection('127.0.0.1', PORT, timeout=5)
    conn.request('GET', '/_ping', headers={'Connection': 'close'})
    response = conn.getresponse()
    response.read()
    return response.status == 200


if __name__ == '__main__':
    if sys.argv[1:] == ['healthcheck']:
        sys.exit(0 if healthcheck() else 1)
    log(f'listening on :{PORT} for {" ".join(ALLOWED_CLIENTS) or "nobody"}')
    server = Server((BIND, PORT), Handler)
    threading.Thread(target=server.clients.run, daemon=True).start()
    server.serve_forever()
