"""python3 -m unittest -v test_proxy  (no dependencies; a fake Docker daemon on a Unix socket)"""
import http.client
import json
import os
import socket
import subprocess
import sys
import socketserver
import tempfile
import threading
import time
import unittest
from unittest import mock
from urllib.parse import parse_qs, urlencode, urlsplit
from http.server import BaseHTTPRequestHandler

import proxy

SECRET = 'hunter2-made-up'
LABELS = {
    'com.docker.compose.project': 'deploy', 'com.docker.compose.service': 'orion', 'traefik.enable': 'true',
    'traefik.http.middlewares.a.basicauth.users': SECRET, 'traefik.http.middlewares.b.plugin.crowdsec.crowdsecLapiKey': SECRET,
    'traefik.http.middlewares.c.forwardauth.address': f'http://u:{SECRET}@h', 'traefik.http.routers.o.rule': 'Host(`o`)',
    'traefik.http.services.o.loadbalancer.server.port': '3000', 'com.docker.compose.project.working_dir': f'/{SECRET}',
    'org.example.note': SECRET,
}
INSPECT = {
    'Id': 'abc', 'Name': '/orion', 'Image': 'sha256:1', 'RestartCount': 2, 'Path': SECRET, 'Args': [SECRET],
    'LogPath': f'/{SECRET}', 'NewField': SECRET,
    'State': {'Status': 'running', 'Running': True, 'Error': SECRET, 'Health': {'Status': 'healthy', 'Log': [{'Output': SECRET}]}},
    'Config': {'Env': [f'TOKEN={SECRET}'], 'Cmd': [SECRET], 'Entrypoint': [SECRET], 'Healthcheck': {'Test': [SECRET]},
               'Tty': False, 'Image': 'img', 'Labels': LABELS},
    'HostConfig': {'Binds': [f'/{SECRET}:/x'], 'RestartPolicy': {'Name': 'always'}, 'LogConfig': {'Type': 'json-file', 'Config': {'t': SECRET}}},
    'Mounts': [{'Source': f'/{SECRET}'}],
    'NetworkSettings': {'Ports': {}, 'Networks': {'n': {'IPAddress': '10.0.0.2', 'DriverOpts': {'x': SECRET}}}},
}
LIST = [{'Id': 'abc', 'Names': ['/orion'], 'Image': 'img', 'Command': f'run --token {SECRET}', 'State': 'running', 'Status': 'Up',
         'Labels': LABELS, 'Mounts': [{'Source': SECRET}], 'Ports': [{'PrivatePort': 1, 'Type': 'tcp', 'X': SECRET}],
         'NetworkSettings': {'x': SECRET}}]


def event(action, type_='container', **attributes):
    return {'Type': type_, 'Action': action, 'status': action, 'id': 'abc', 'time': 1,
            'Actor': {'ID': 'abc', 'Attributes': {'name': 'orion', **LABELS, **attributes}}}


EVENTS = [event('start'), event(f'exec_create: sh -c {SECRET}', execID='e'), event('health_status: healthy'),
          event('create', 'volume', name=SECRET), event('die', exitCode='1')]


class Daemon(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    seen = []
    sent = 0
    closed = threading.Event()

    def log_message(self, *args):
        pass

    def address_string(self):
        return 'unix'

    def send(self, body, status=200, **headers):
        self.send_response(status)
        self.send_header('Content-Length', str(len(body)))
        for k, v in headers.items():
            self.send_header(k.replace('_', '-'), v)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        Daemon.seen.append(self.path)
        path = proxy.VERSION_PREFIX.sub('', self.path).split('?')[0]
        if path == '/_ping':
            return self.send(b'OK', Api_Version='1.50', Ostype='linux', Server=SECRET)
        if path == '/version':
            return self.send(json.dumps({'Version': '29', 'ApiVersion': '1.50', 'KernelVersion': SECRET}).encode())
        if path == '/containers/json':
            return self.send(json.dumps(LIST).encode())
        if path == '/containers/orion/json':
            return self.send(json.dumps(INSPECT).encode())
        if path == '/containers/broken/json':
            return self.send(json.dumps({'message': f'open /{SECRET}'}).encode(), 500)
        if path == '/containers/big/json':
            return self.send(b' ' * 2048)
        if path.endswith('/json'):
            return self.send(b'{"message":"No such container: x"}', 404)
        self.send_response(200)
        self.send_header('Transfer-Encoding', 'chunked')
        self.end_headers()
        if path == '/events':
            for e in EVENTS:
                self.chunk(json.dumps(e).encode() + b'\n')
        elif path == '/containers/noisy/logs':
            try:
                while True:
                    self.chunk(b'x' * 65536)
                    Daemon.sent += 1
            except OSError:
                Daemon.closed.set()
            self.close_connection = True
            return
        elif path == '/containers/cut/logs':
            self.chunk(b'half')
            self.wfile.write(b'ff\r\npart')
            self.close_connection = True
            return
        elif path == '/containers/quiet/logs':
            self.chunk(b'first\n')
            self.connection.settimeout(20)
            try:
                if self.connection.recv(1) == b'':
                    Daemon.closed.set()
            except OSError:
                pass
            self.close_connection = True
            return
        else:
            for n in range(3):
                self.chunk(f'line {n}\n'.encode())
        self.wfile.write(b'0\r\n\r\n')

    def chunk(self, data):
        self.wfile.write(b'%x\r\n%s\r\n' % (len(data), data))
        self.wfile.flush()


class UnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        pass  # the tests cut connections on purpose

    def get_request(self):
        sock, _ = super().get_request()
        return sock, ('unix', 0)


class ProxyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.TemporaryDirectory()
        proxy.SOCKET_PATH = os.path.join(cls.dir.name, 'docker.sock')
        cls.daemon = UnixServer(proxy.SOCKET_PATH, Daemon)
        # The tests connect from loopback: make it an ordinary, allowed client.
        proxy.HEALTH_CHECK = 'none'
        cls.proxy = proxy.Server(('127.0.0.1', 0), proxy.Handler)
        cls.proxy.clients.addresses = frozenset({'127.0.0.1'})
        for server in (cls.daemon, cls.proxy):
            threading.Thread(target=server.serve_forever, daemon=True).start()
        proxy.log = lambda message: None

    @classmethod
    def tearDownClass(cls):
        cls.proxy.shutdown()
        cls.daemon.shutdown()
        cls.proxy.server_close()
        cls.daemon.server_close()
        cls.dir.cleanup()

    def setUp(self):
        Daemon.seen.clear()

    def request(self, path, method='GET', **kw):
        conn = http.client.HTTPConnection('127.0.0.1', self.proxy.server_port, timeout=10)
        try:
            conn.request(method, path, **kw)
            r = conn.getresponse()
            return r.status, r.read(), r.headers
        finally:
            conn.close()

    def test_nothing_secret_gets_out(self):
        for path in ('/_ping', '/version', '/v1.50/containers/json?all=1', '/containers/orion/json', '/events'):
            status, body, headers = self.request(path)
            self.assertEqual(status, 200, path)
            self.assertNotIn(SECRET, body.decode() + str(headers), path)

    def test_list_keeps_what_the_watcher_needs(self):
        c = json.loads(self.request('/containers/json')[1])[0]
        self.assertEqual((c['Names'], c['State'], c['Image']), (['/orion'], 'running', 'img'))
        self.assertEqual(c['Labels'], {'com.docker.compose.project': 'deploy', 'com.docker.compose.service': 'orion', 'traefik.enable': 'true',
                                       'traefik.http.routers.o.rule': 'Host(`o`)', 'traefik.http.services.o.loadbalancer.server.port': '3000'})
        self.assertEqual(c['Ports'], [{'PrivatePort': 1, 'Type': 'tcp'}])

    def test_inspect_keeps_what_clients_need(self):
        c = json.loads(self.request('/v1.50/containers/orion/json')[1])
        self.assertEqual(c['HostConfig']['RestartPolicy'], {'Name': 'always'})
        self.assertEqual(c['State']['Health'], {'Status': 'healthy'})
        self.assertIs(c['Config']['Tty'], False)
        self.assertEqual((c['Config']['Env'], c['Mounts'], c['HostConfig']['Binds']), ([], [], []))

    def test_events_are_container_events_without_commands(self):
        events = [json.loads(line) for line in self.request('/events')[1].splitlines()]
        self.assertEqual([e['Action'] for e in events], ['start', 'exec_create', 'health_status: healthy', 'die'])
        self.assertEqual([e['status'] for e in events], [e['Action'] for e in events])
        self.assertEqual(events[3]['Actor']['Attributes']['exitCode'], '1')
        self.assertEqual(events[0]['Actor']['Attributes']['name'], 'orion')

    def test_logs_and_stats_pass_through(self):
        for kind in ('logs?stdout=1&tail=3', 'stats?stream=0'):
            self.assertEqual(self.request(f'/containers/orion/{kind}')[1], b'line 0\nline 1\nline 2\n')

    def test_unknown_query_parameters_are_dropped(self):
        self.request('/containers/orion/logs?stdout=1&details=1')
        self.request('/containers/json?all=1&size=1')
        self.assertEqual(Daemon.seen, ['/containers/orion/logs?stdout=1', '/containers/json?all=1'])

    def test_everything_else_is_refused_before_docker(self):
        for path in ('/info', '/images/json', '/containers/orion/archive?path=/', '/containers/orion/export',
                     '/containers/orion/top', '/containers/orion/changes', '/containers/orion/attach/ws', '/exec/e/json',
                     '/volumes', '/secrets', '/containers/../info', '/containers//json', '/containers/a%2fb/json',
                     '/v1.50/v1.50/version', '/containers/orion/json/', 'http://evil/version', '//evil/version',
                     '/containers/json?filters=nonsense', '/containers/json?filters=[1]'):
            self.assertEqual(self.request(path)[0], 403, path)
        for method in ('POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'CONNECT', 'TRACE', 'HEAD'):
            self.assertEqual(self.request('/containers/json', method)[0], 403, method)
        self.assertEqual(self.request('/containers/json', body=b'x')[0], 403)
        for header in ({'Upgrade': 'tcp'}, {'Expect': '100-continue'}, {'Transfer-Encoding': 'chunked'}):
            self.assertEqual(self.request('/containers/json', headers=header)[0], 403, header)
        self.assertEqual(Daemon.seen, [])

    def test_filters_match_only_what_is_shown(self):
        for path, f in (
            ('/containers/json', {'label': ['secret']}), ('/containers/json', {'volume': ['x']}),
            ('/containers/json', {'label': ['traefik.http.middlewares.a.basicauth.users=x']}),
            ('/events', {'label': {'a': True}}),
            # Docker matches these as prefixes of "exec_create: <command>".
            ('/events', {'event': ['exec_start', 'exec_create: sh -c hunt']}),
            ('/events', {'event': {'exec_create: s': True}}), ('/events', {'event': ['exec_create\n: s']}),
            ('/events', {'event': [['start']]}), ('/events', {'event': 'start'}), ('/events', {'event': [None]}),
            ('/containers/json', {'name': ['x' * 5000]}),
        ):
            self.assertEqual(self.request(f'{path}?{urlencode({"filters": json.dumps(f)})}')[0], 403, f)
        self.assertEqual(Daemon.seen, [])

    def test_filters_are_written_anew(self):
        self.request('/events?' + urlencode({'filters': '{"event":["die"],"event":{"start":true,"stop":false}}'}))
        self.assertEqual(parse_qs(urlsplit(Daemon.seen[0]).query)['filters'], ['{"event": ["start"]}'])

    def test_deep_nesting_does_not_crash(self):
        # With the 1 MB thread stacks of Alpine's Python this killed the process.
        code = (
            'import proxy, threading, sys\n'
            'threading.stack_size(1 << 20)\n'
            'def run():\n'
            '  for text in ("[" * 9000, "{\\"a\\":" * 9000):\n'
            '    try: proxy.check_filters(text)\n'
            '    except proxy.Refused: print("refused")\n'
            't = threading.Thread(target=run); t.start(); t.join()\n')
        out = subprocess.run([sys.executable, '-B', '-c', code], capture_output=True, text=True, cwd=os.path.dirname(os.path.abspath(proxy.__file__)))
        self.assertEqual((out.returncode, out.stdout), (0, 'refused\nrefused\n'), out.stderr)

    def raw(self, data):
        with socket.create_connection(('127.0.0.1', self.proxy.server_port), timeout=10) as conn:
            conn.sendall(data)
            out = b''
            while chunk := conn.recv(4096):
                out += chunk
            return out

    def test_ambiguous_requests_are_refused_and_not_reused(self):
        smuggled = b'GET /version HTTP/1.1\r\nHost: x\r\n\r\n'
        for head in (b'Content-Length: 0\r\nContent-Length: 30', b'Content-Length : 30', b'Transfer-Encoding: chunked', b'Content-Length: 30'):
            out = self.raw(b'GET /_ping HTTP/1.1\r\nHost: x\r\n' + head + b'\r\n\r\n' + smuggled)
            self.assertIn(b' 403 ', out.split(b'\r\n')[0], head)
            self.assertEqual(out.count(b'HTTP/1.1 '), 1, head)
            self.assertIn(b'Connection: close', out)
        for method in (b'GET', b'POST'):
            self.assertIn(b' 403 ', self.raw(method + b' http://[ HTTP/1.1\r\nHost: x\r\n\r\n').split(b'\r\n')[0])
        self.assertIn(b' 505 ', self.raw(b'GET /events HTTP/1.0\r\n\r\n').split(b'\r\n')[0])
        self.assertEqual(Daemon.seen, [])

    def test_allowed_filters(self):
        for f in ({'label': ['com.docker.compose.project=deploy']}, {'event': {'die': True}, 'type': {'container': True}}):
            self.assertEqual(self.request(f'/containers/json?filters={json.dumps(f).replace(" ", "")}')[0], 200)

    def test_ping(self):
        for method in ('GET', 'HEAD'):
            status, _, headers = self.request('/_ping', method)
            self.assertEqual((status, headers['Api-Version']), (200, '1.50'))

    def test_errors(self):
        status, body, _ = self.request('/containers/x/json')
        self.assertEqual((status, json.loads(body)['message']), (404, 'No such container: x'))
        status, body, _ = self.request('/containers/broken/json')
        self.assertEqual(status, 500)
        self.assertNotIn(SECRET, body.decode())
        with mock.patch.object(proxy, 'MAX_BODY', 1024):
            self.assertEqual(self.request('/containers/big/json')[0], 502)
        path, proxy.SOCKET_PATH = proxy.SOCKET_PATH, '/nonexistent'
        try:
            self.assertEqual(self.request('/version')[0], 502)
        finally:
            proxy.SOCKET_PATH = path

    def test_a_cut_stream_has_no_clean_end(self):
        with self.assertRaises(http.client.IncompleteRead):
            self.request('/containers/cut/logs?stdout=1')
        with mock.patch.object(proxy, 'MAX_EVENT', 10), self.assertRaises(http.client.IncompleteRead):
            self.request('/events')

    def test_a_quiet_stream_ends_when_the_client_leaves(self):
        for extra in (b'', b'x'):  # an unread byte must not hide the close
            Daemon.closed.clear()
            conn = socket.create_connection(('127.0.0.1', self.proxy.server_port), timeout=10)
            conn.sendall(b'GET /containers/quiet/logs?follow=1&stdout=1 HTTP/1.1\r\nHost: x\r\n\r\n')
            data = b''
            while b'first' not in data:
                data += conn.recv(4096)
            if extra:
                conn.sendall(extra)
            conn.close()
            self.assertTrue(Daemon.closed.wait(10), extra)
            self.assert_no_slots()

    def assert_no_slots(self):
        deadline = time.monotonic() + 5
        while proxy.slots.used and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertEqual(proxy.slots.used, {})

    def stream(self, container):
        conn = socket.create_connection(('127.0.0.1', self.proxy.server_port), timeout=10)
        conn.sendall(f'GET /containers/{container}/logs?follow=1&stdout=1 HTTP/1.1\r\nHost: x\r\n\r\n'.encode())
        self.assertIn(b' 200 ', conn.recv(64))
        return conn

    def wait_until_blocked(self):
        """Until the daemon can't send either: then the proxy is stuck writing to us."""
        sent, quiet, deadline = -1, 0, time.monotonic() + 10
        while quiet < 10 and time.monotonic() < deadline:
            quiet, sent = (quiet + 1 if Daemon.sent == sent else 0), Daemon.sent
            time.sleep(0.05)
        self.assertEqual(quiet, 10)

    def test_a_slow_reader_keeps_its_stream(self):
        Daemon.closed.clear()
        with mock.patch.object(proxy.Handler, 'timeout', 1):
            conn = self.stream('noisy')
            self.assertFalse(Daemon.closed.wait(3))  # blocked on a write all this time
            self.assertTrue(conn.recv(1024))
            conn.close()
            self.assertTrue(Daemon.closed.wait(10))
        self.assert_no_slots()

    def test_a_reader_that_half_closes_and_stops_is_dropped(self):
        Daemon.closed.clear()
        conn = self.stream('noisy')
        self.wait_until_blocked()
        conn.shutdown(socket.SHUT_WR)
        try:
            self.assertTrue(Daemon.closed.wait(10))
            self.assert_no_slots()
        finally:
            conn.close()

    def test_slots_are_bounded_and_returned(self):
        for _ in range(proxy.MAX_REQUESTS + 5):
            self.assertEqual(self.request('/version')[0], 200)
        self.assert_no_slots()
        held = 0
        while proxy.slots.take('127.0.0.1'):
            held += 1
        self.assertEqual(held, proxy.MAX_PER_CLIENT)
        self.assertEqual(self.request('/version')[0], 503)
        with mock.patch.object(proxy, 'HEALTH_CHECK', '127.0.0.1'):
            # Never locked out. Not with a live request: its thread could outlast the patch.
            for limit in (proxy.slots, self.proxy.connections):
                before = dict(limit.used)
                self.assertTrue(limit.take('127.0.0.1'))
                limit.give('127.0.0.1')
                self.assertEqual(limit.used, before)
        for other in ('a', 'b'):
            while proxy.slots.take(other):
                held += 1
        self.assertEqual(held, proxy.MAX_REQUESTS)
        proxy.slots.used.clear()

    def connections_used(self):
        deadline = time.monotonic() + 5
        while self.proxy.connections.used and time.monotonic() < deadline:
            time.sleep(0.02)
        return self.proxy.connections.used

    def test_connections_are_bounded_and_returned(self):
        self.assertEqual(self.connections_used(), {})
        open_ = [socket.create_connection(('127.0.0.1', self.proxy.server_port), timeout=10) for _ in range(proxy.MAX_CONNECTIONS_PER_CLIENT)]
        time.sleep(0.3)
        with socket.create_connection(('127.0.0.1', self.proxy.server_port), timeout=10) as one_more:
            self.assertEqual(one_more.recv(1), b'')
        for conn in open_:
            conn.close()
        self.assertEqual(self.connections_used(), {})
        for broken in ('threading.Thread.start', 'socket.socket.setsockopt'):
            with mock.patch(broken, side_effect=RuntimeError('none left') if 'Thread' in broken else OSError('gone')):
                with socket.socket() as a:
                    a.connect(('127.0.0.1', self.proxy.server_port))
                    a.settimeout(10)
                    self.assertEqual(a.recv(1), b'', broken)
            self.assertEqual(self.connections_used(), {}, broken)

    def test_only_named_services_may_connect(self):
        server, clients = self.proxy, proxy.Clients()
        may = lambda address: server.verify_request(None, (address, 1))
        with mock.patch.object(proxy, 'ALLOWED_CLIENTS', ['vector', 'gone']), \
             mock.patch.object(server, 'clients', clients), \
             mock.patch.object(socket, 'gethostbyname_ex') as lookup:
            self.assertFalse(may('172.30.0.3'))  # nobody before the first lookup
            lookup.side_effect = lambda n: (n, [], ['172.30.0.3']) if n == 'vector.' else self.fail(socket.EAI_NONAME)
            clients.refresh()
            calls = lookup.call_count
            self.assertTrue(may('172.30.0.3'))
            for address in ('172.30.0.1', '172.30.0.9', '10.0.0.1', '127.0.0.1'):  # the bridge's host side, others
                self.assertFalse(may(address))
            self.assertEqual(lookup.call_count, calls)  # connecting never looks anything up
            lookup.side_effect = lambda n: self.fail(socket.EAI_AGAIN)
            clients.refresh()
            self.assertTrue(may('172.30.0.3'))  # a passing failure
            clients.known['vector'] = (['172.30.0.3'], time.monotonic() - 31)
            clients.refresh()
            self.assertFalse(may('172.30.0.3'))  # a lasting one
            lookup.side_effect = lambda n: (n, [], ['172.30.0.7'])
            clients.refresh()
            self.assertTrue(may('172.30.0.7'))  # it moved
            lookup.side_effect = lambda n: self.fail(socket.EAI_NONAME)
            clients.refresh()
            self.assertFalse(may('172.30.0.7'))  # stopped, when DNS says so: at once
        with mock.patch.object(proxy, 'HEALTH_CHECK', '127.0.0.1'):
            self.assertTrue(may('127.0.0.1'))

    def fail(self, code=None):
        if isinstance(code, int):
            raise socket.gaierror(code, 'lookup')
        super().fail(code)


if __name__ == '__main__':
    unittest.main()
