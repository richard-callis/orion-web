"""deploy/resolve_images.py against a throwaway git history and a local fake of the
registry (ghcr) and GitHub's API: python3 -m unittest -v scripts/test_resolve_images.py"""
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, 'deploy', 'resolve_images.py')


class Fake(BaseHTTPRequestHandler):
    """ghcr: /token, /v2/<org>/<image>/tags/list (2 tags a page); GitHub: workflow runs."""
    state = None

    def log_message(self, *args):
        pass

    def send(self, status, body, headers=()):
        self.send_response(status)
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())

    def do_GET(self):
        st = self.state
        st['asked'].append(self.path)
        if st['broken'] > 0:
            st['broken'] -= 1
            return self.send(503, {})
        if self.path.startswith('/token'):
            return self.send(200, {'token': 'anon'})
        m = re.match(r'/v2/org/(orion-\w+)/tags/list\?n=\d+(?:&last=(\w+))?$', self.path)
        if m:
            if self.headers.get('Authorization') != 'Bearer anon':
                return self.send(401, {})
            tags = sorted(st['tags'].get(m.group(1), set()))
            start = tags.index(m.group(2)) + 1 if m.group(2) else 0
            page = tags[start:start + 2]
            link = [('Link', f'</v2/org/{m.group(1)}/tags/list?n=2&last={page[-1]}>; rel="next"')] \
                if start + 2 < len(tags) else []
            return self.send(200, {'tags': page}, link)
        m = re.match(r'/repos/org/orion-web/actions/workflows/([\w.-]+)/runs\?head_sha=(\w+)&branch=main', self.path)
        if m:
            if st['api_down']:
                return self.send(500, {})
            if self.headers.get('Authorization') != 'Bearer gh-token':
                return self.send(401, {})
            running = (m.group(1), m.group(2)) in st['running']
            return self.send(200, {'workflow_runs': [{'status': 'in_progress' if running else 'completed'}]})
        self.send(404, {})


class Resolve(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Fake)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.url = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.repo = os.path.join(tmp.name, 'repo')
        self.st = Fake.state = {'tags': {}, 'running': set(), 'asked': [], 'broken': 0, 'api_down': False}
        self.git('init', '-q', '-b', 'main', self.repo, cwd=tmp.name)
        self.first = self.commit('apps/web/a', 'apps/gateway/a', 'deploy/host-agent/Dockerfile')
        for image in ('web', 'gateway', 'vector'):
            self.publish(image, self.first)
        self.publish('web', 'latest')

    def git(self, *args, cwd=None):
        return subprocess.run(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', *args], cwd=cwd or self.repo,
                              check=True, capture_output=True, text=True).stdout.strip()

    def commit(self, *paths):
        for p in paths:
            full = os.path.join(self.repo, p)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, 'a') as f:
                f.write('x')
        self.git('add', '-A')
        self.git('commit', '-q', '--allow-empty', '-m', 'c')
        return self.git('rev-parse', 'HEAD')

    def publish(self, image, tag):
        self.st['tags'].setdefault(f'orion-{image}', set()).add(tag)

    def run_script(self, **env):
        r = subprocess.run([sys.executable, '-I', SCRIPT, self.repo], capture_output=True, text=True, env={
            'PATH': os.environ['PATH'], 'GITHUB_ORG': 'org', 'REGISTRY_URL': self.url, 'GITHUB_API_URL': self.url,
            'GITHUB_REPOSITORY': 'org/orion-web', 'GH_TOKEN': 'gh-token', **env})
        return r, dict(line.split('=') for line in r.stdout.splitlines())

    def check(self, web=None, gateway=None, vector=None, **env):
        r, got = self.run_script(**env)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(got, {'ORION_WEB_VERSION': web or self.first, 'ORION_GATEWAY_VERSION': gateway or self.first,
                               'ORION_VECTOR_VERSION': vector or self.first})
        return r

    def test_the_commit_itself(self):
        c = self.commit('apps/web/b')
        self.publish('web', c)
        self.check(web=c)

    def test_an_unrelated_commit_keeps_the_last_image(self):
        self.commit('docs/x')
        self.check()

    def test_a_change_long_ago_is_still_found_with_one_listing(self):
        for i in range(40):
            self.commit(f'docs/{i}')
        self.check()
        lists = [p for p in self.st['asked'] if '/tags/list' in p and 'orion-vector' in p]
        self.assertLessEqual(len(lists), 2, 'a listing, paged; not a lookup per commit')

    def test_tags_are_read_across_pages(self):
        for i in range(7):
            self.publish('vector', f'old{i}')
        self.check()

    def test_a_change_pushed_together_with_later_commits(self):
        self.commit('apps/web/b')
        self.commit('docs/x')
        head = self.commit('docs/y')
        self.publish('web', head)
        self.check(web=head)

    def test_the_newest_build_wins(self):
        # A manual rebuild at the head, after the change's own build.
        c = self.commit('apps/web/b')
        self.publish('web', c)
        head = self.commit('docs/x')
        self.publish('web', head)
        self.check(web=head)

    def test_a_running_build_skips_the_deploy(self):
        c = self.commit('apps/web/b')
        self.st['running'].add(('build-web.yml', c))
        r, _ = self.run_script()
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertIn('still running', r.stderr)
        self.assertTrue(any('&branch=main' in p for p in self.st['asked']), 'only main\'s builds count')

    def test_a_running_build_of_a_later_commit_counts(self):
        self.commit('apps/web/b')
        later = self.commit('docs/x')
        self.st['running'].add(('build-web.yml', later))
        self.assertEqual(self.run_script()[0].returncode, 3)

    def test_an_older_image_is_never_used_for_a_newer_change(self):
        # The older image's code may have failed CI, or been rolled back.
        old = self.commit('apps/web/b')
        self.publish('web', old)
        self.commit('apps/web/c')
        r, _ = self.run_script()
        self.assertEqual(r.returncode, 1)
        self.assertIn('no build of it is running', r.stderr)

    def test_another_components_build_does_not_count(self):
        c = self.commit('apps/web/b')
        self.st['running'].add(('build-gateway.yml', c))
        self.assertEqual(self.run_script()[0].returncode, 1)

    def test_github_unreachable_fails(self):
        self.commit('apps/web/b')
        self.st['api_down'] = True
        r, _ = self.run_script()
        self.assertEqual(r.returncode, 1)
        self.assertIn('HTTP 500', r.stderr)

    def test_the_token_stays_off_the_command_line(self):
        with open(SCRIPT) as f:
            self.assertNotIn('subprocess.run([\'curl', f.read())
        r, _ = self.run_script(GH_TOKEN='')
        self.commit('apps/web/b')
        r, _ = self.run_script(GH_TOKEN='')
        self.assertEqual(r.returncode, 1)
        self.assertIn('GH_TOKEN', r.stderr)

    def test_images_from_other_branches_are_not_used(self):
        self.git('checkout', '-q', '-b', 'other')
        stray = self.commit('docs/evil')
        self.publish('web', stray)
        self.git('checkout', '-q', 'main')
        self.check()

    def test_merges_count_as_one_commit(self):
        self.git('checkout', '-q', '-b', 'feature')
        inner = self.commit('apps/web/b')
        self.publish('web', inner)  # never pushed to main by itself
        self.git('checkout', '-q', 'main')
        self.git('merge', '-q', '--no-ff', '-m', 'm', 'feature')
        self.assertEqual(self.run_script()[0].returncode, 1)
        merge = self.git('rev-parse', 'HEAD')
        self.publish('web', merge)
        self.check(web=merge)

    def test_a_passing_registry_error_is_retried(self):
        self.st['broken'] = 2
        self.check()

    def test_a_registry_error_is_not_a_missing_image(self):
        self.st['broken'] = 99
        r, got = self.run_script()
        self.assertEqual((r.returncode, got), (1, {}))
        self.assertIn('HTTP 503', r.stderr)

    def test_paths_match_the_build_workflows(self):
        sys.path.insert(0, os.path.dirname(SCRIPT))
        try:
            import resolve_images
        finally:
            sys.path.pop(0)
        self.assertEqual([c[1] for c in resolve_images.COMPONENTS], ['orion-web', 'orion-gateway', 'orion-vector'])
        for var, image, workflow, paths in resolve_images.COMPONENTS:
            self.assertEqual(workflow, f'build-{image.split("-")[1]}.yml')
            with open(os.path.join(ROOT, '.github', 'workflows', workflow)) as f:
                block = re.search(r'^    paths:\n((?:      - .+\n)+)', f.read(), re.M).group(1)
            want = [p.strip("'\"").removesuffix('/**') for p in re.findall(r'- (.+)', block)]
            self.assertEqual(sorted(paths), sorted(want), image)


if __name__ == '__main__':
    unittest.main()
