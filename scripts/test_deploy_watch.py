"""deploy/watch-deploy.sh and deploy/auto-rollback.sh on copies of the deploy directory, with
a fake docker, git, curl and sleep on PATH:
python3 -m unittest -v scripts/test_deploy_watch.py"""
import os
import shutil
import stat
import subprocess
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVICES = ('orion', 'orion-worker', 'gateway', 'vector')

# State lives in files under $FAKE: cid_<svc>, inspect_<cid>, curl_rc, head, diff, diff_rc,
# on_sleep (a script run at the first sleep), calls (a log of what was run).
DOCKER = r'''#!/bin/sh
echo "docker $*" >> "$FAKE/calls"
case "$1" in
  compose) for a; do last=$a; done; cat "$FAKE/cid_$last" 2>/dev/null; exit 0 ;;
  inspect) for a; do last=$a; done; cat "$FAKE/inspect_$last" 2>/dev/null || exit 1 ;;
  exec) shift 2; exec "$@" ;;
esac
'''
CURL = '#!/bin/sh\nexit "$(cat "$FAKE/curl_rc" 2>/dev/null || echo 0)"\n'
SLEEP = '#!/bin/sh\nif [ -f "$FAKE/on_sleep" ]; then sh "$FAKE/on_sleep"; rm -f "$FAKE/on_sleep"; fi\n'
GIT = r'''#!/bin/sh
shift 2
echo "git $*" >> "$FAKE/calls"
case "$1" in
  rev-parse) cat "$FAKE/head" ;;
  diff) cat "$FAKE/diff" 2>/dev/null; exit "$(cat "$FAKE/diff_rc" 2>/dev/null || echo 0)" ;;
  checkout) exit 0 ;;
esac
'''
STUB = '#!/bin/sh\necho "$(basename "$0") $*" >> "$FAKE/calls"\nexit "$(cat "$FAKE/$(basename "$0")_rc" 2>/dev/null || echo 0)"\n'
GOOD_SHA = 'a' * 40
BAD_SHA = 'b' * 40


def write(path, text, mode=0o755):
    with open(path, 'w') as f:
        f.write(text)
    os.chmod(path, mode)


class Base(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.fake = os.path.join(tmp.name, 'fake')
        self.bin = os.path.join(tmp.name, 'bin')
        self.deploy = os.path.join(tmp.name, 'repo', 'deploy')
        for d in (self.fake, self.bin, self.deploy):
            os.makedirs(d)
        for name, text in (('docker', DOCKER), ('curl', CURL), ('sleep', SLEEP), ('git', GIT)):
            write(os.path.join(self.bin, name), text)
        for name in ('watch-deploy.sh', 'auto-rollback.sh'):
            shutil.copy(os.path.join(ROOT, 'deploy', name), self.deploy)
        for name in ('rollback.sh', 'wait-healthy.sh'):  # what auto-rollback runs: stubbed
            write(os.path.join(self.deploy, name), STUB)

    def put(self, name, text):
        write(os.path.join(self.fake, name), text, 0o644)

    def calls(self):
        try:
            with open(os.path.join(self.fake, 'calls')) as f:
                return f.read().splitlines()
        except FileNotFoundError:
            return []

    def run_script(self, *args, script):
        return subprocess.run(['bash', os.path.join(self.deploy, script), *args], capture_output=True, text=True,
                              env={**os.environ, 'PATH': self.bin + ':' + os.environ['PATH'],
                                   'FAKE': self.fake, 'WATCH_INTERVAL': '30'})


class Watch(Base):
    def setUp(self):
        super().setUp()
        for svc in SERVICES:
            self.put(f'cid_{svc}', f'{svc}-1\n')
            self.put(f'inspect_{svc}-1', 'running healthy 0\n')

    def watch(self):
        return self.run_script('90', script='watch-deploy.sh')

    def test_passes_when_everything_stays_healthy(self):
        r = self.watch()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('survived', r.stdout)
        self.assertNotIn('::error::', r.stdout)

    def test_the_watch_runs_every_interval(self):
        self.assertEqual(self.watch().returncode, 0)
        self.assertEqual(len([c for c in self.calls() if c.endswith('curl -fsS --max-time 10 -o /dev/null http://localhost:3000/api/health')]), 4)

    def test_fails_on_a_restart_count_change(self):
        self.put('on_sleep', f'echo "running healthy 1" > "{self.fake}/inspect_orion-worker-1"\n')
        r = self.watch()
        self.assertEqual(r.returncode, 1)
        self.assertIn('::error::orion-worker restarted (RestartCount 0 -> 1)', r.stdout)

    def test_fails_on_an_unhealthy_status(self):
        self.put('on_sleep', f'echo "running unhealthy 0" > "{self.fake}/inspect_gateway-1"\n')
        r = self.watch()
        self.assertEqual(r.returncode, 1)
        self.assertIn('::error::gateway is unhealthy, not healthy', r.stdout)

    def test_fails_on_a_container_that_is_not_running(self):
        self.put('on_sleep', f'echo "exited none 0" > "{self.fake}/inspect_orion-1"\n')
        r = self.watch()
        self.assertEqual(r.returncode, 1)
        self.assertIn('::error::orion is exited, not running', r.stdout)

    def test_fails_on_a_recreated_container(self):
        self.put('on_sleep', f'echo orion-2 > "{self.fake}/cid_orion"; echo "running healthy 0" > "{self.fake}/inspect_orion-2"\n')
        r = self.watch()
        self.assertEqual(r.returncode, 1)
        self.assertIn('::error::orion was recreated', r.stdout)

    def test_fails_when_api_health_stops_answering(self):
        self.put('on_sleep', f'echo 22 > "{self.fake}/curl_rc"\n')
        r = self.watch()
        self.assertEqual(r.returncode, 1)
        self.assertIn('::error::orion /api/health did not answer OK', r.stdout)

    def test_fails_at_the_start_when_a_service_is_not_there(self):
        os.remove(os.path.join(self.fake, 'cid_gateway'))
        r = self.watch()
        self.assertEqual(r.returncode, 1)
        self.assertIn('::error::gateway has no container', r.stdout)

    def test_vector_is_only_a_warning(self):
        self.put('inspect_vector-1', 'exited none 0\n')
        r = self.watch()
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn('::warning::vector is exited', r.stdout)
        os.remove(os.path.join(self.fake, 'cid_vector'))
        r = self.watch()
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn('::warning::vector has no container', r.stdout)


class AutoRollback(Base):
    def setUp(self):
        super().setUp()
        self.put('head', BAD_SHA + '\n')
        write(os.path.join(self.deploy, '.last-good'), f'GIT_SHA={GOOD_SHA}\nDEPLOYED_AT=x\n', 0o600)

    def result(self):
        path = os.path.join(self.deploy, '.last-rollback')
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o644)
        with open(path) as f:
            lines = f.read().splitlines()
        self.assertEqual([line.split('=')[0] for line in lines], ['FAILED_SHA', 'ROLLED_BACK_TO', 'RESULT', 'AT', 'REASON'])
        return dict(line.split('=', 1) for line in lines)

    def test_rolls_back_when_no_migrations_changed(self):
        r = self.run_script(script='auto-rollback.sh')
        self.assertEqual(r.returncode, 1, 'a rolled-back deploy still fails the job')
        self.assertIn(f'::error::Deploy of {BAD_SHA} failed and was rolled back to {GOOD_SHA}.', r.stdout)
        calls = self.calls()
        self.assertIn(f'git diff --name-only {GOOD_SHA} {BAD_SHA} -- apps/web/prisma/migrations', calls)
        self.assertEqual([c.split()[0] for c in calls if c.startswith('rollback.sh') or c.startswith('wait-healthy.sh')],
                         ['rollback.sh', 'wait-healthy.sh', 'wait-healthy.sh'])
        self.assertIn(f'git checkout --quiet -B main {GOOD_SHA}', calls)
        res = self.result()
        self.assertEqual((res['RESULT'], res['FAILED_SHA'], res['ROLLED_BACK_TO']), ('rolled_back', BAD_SHA, GOOD_SHA))
        self.assertRegex(res['AT'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$')

    def test_refuses_when_migrations_changed(self):
        self.put('diff', 'apps/web/prisma/migrations/t20260101000000_x/migration.sql\n')
        r = self.run_script(script='auto-rollback.sh')
        self.assertEqual(r.returncode, 1)
        self.assertIn('::error::Deploy of', r.stdout)
        self.assertIn('changed database migrations', r.stdout)
        self.assertIn('restore.sh predeploy_<timestamp>', r.stdout)
        self.assertFalse([c for c in self.calls() if c.startswith(('rollback.sh', 'wait-healthy.sh', 'git checkout'))])
        res = self.result()
        self.assertEqual((res['RESULT'], res['ROLLED_BACK_TO']), ('skipped_migrations', ''))

    def test_refuses_when_the_comparison_fails(self):
        self.put('diff_rc', '128\n')
        r = self.run_script(script='auto-rollback.sh')
        self.assertEqual(r.returncode, 1)
        self.assertEqual(self.result()['RESULT'], 'skipped_migrations')
        self.assertFalse([c for c in self.calls() if c.startswith('rollback.sh')])

    def test_no_last_good(self):
        os.remove(os.path.join(self.deploy, '.last-good'))
        r = self.run_script(script='auto-rollback.sh')
        self.assertEqual(r.returncode, 1)
        self.assertIn('nothing to roll back to', r.stdout)
        self.assertFalse([c for c in self.calls() if c.startswith(('rollback.sh', 'wait-healthy.sh'))])
        res = self.result()
        self.assertEqual((res['RESULT'], res['FAILED_SHA'], res['ROLLED_BACK_TO']), ('no_last_good', BAD_SHA, ''))

    def test_rollback_failure_is_recorded(self):
        self.put('rollback.sh_rc', '1\n')
        r = self.run_script(script='auto-rollback.sh')
        self.assertEqual(r.returncode, 1)
        self.assertEqual(self.result()['RESULT'], 'rollback_failed')
        self.assertFalse([c for c in self.calls() if c.startswith('git checkout')])

    def test_unhealthy_after_rollback_is_recorded(self):
        self.put('wait-healthy.sh_rc', '1\n')
        r = self.run_script(script='auto-rollback.sh')
        self.assertEqual(r.returncode, 1)
        self.assertEqual(self.result()['RESULT'], 'rollback_failed')


if __name__ == '__main__':
    unittest.main()
