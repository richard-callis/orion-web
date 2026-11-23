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
# on_sleep (a script run at the first sleep), on_sleep_2 (at the second), compose_rc, checkout_rc,
# calls (a log of what was run).
DOCKER = r'''#!/bin/sh
echo "docker $*" >> "$FAKE/calls"
case "$1" in
  compose) rc=$(cat "$FAKE/compose_rc" 2>/dev/null || echo 0); [ "$rc" = 0 ] || exit "$rc"
           for a; do last=$a; done; cat "$FAKE/cid_$last" 2>/dev/null; exit 0 ;;
  inspect) for a; do last=$a; done; cat "$FAKE/inspect_$last" 2>/dev/null || exit 1 ;;
  exec) shift 2; exec "$@" ;;
esac
'''
CURL = '#!/bin/sh\nexit "$(cat "$FAKE/curl_rc" 2>/dev/null || echo 0)"\n'
SLEEP = r'''#!/bin/sh
echo "sleep $1" >> "$FAKE/calls"
n=$(( $(cat "$FAKE/sleeps" 2>/dev/null || echo 0) + 1 )); echo $n > "$FAKE/sleeps"
if [ -f "$FAKE/on_sleep" ]; then sh "$FAKE/on_sleep"; rm -f "$FAKE/on_sleep"; fi
if [ "$n" = 2 ] && [ -f "$FAKE/on_sleep_2" ]; then sh "$FAKE/on_sleep_2"; fi
'''
GIT = r'''#!/bin/sh
shift 2
echo "git $*" >> "$FAKE/calls"
case "$1" in
  rev-parse) cat "$FAKE/head" ;;
  diff) cat "$FAKE/diff" 2>/dev/null; exit "$(cat "$FAKE/diff_rc" 2>/dev/null || echo 0)" ;;
  checkout) exit "$(cat "$FAKE/checkout_rc" 2>/dev/null || echo 0)" ;;
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

    def run_script(self, *args, script, env=None):
        return subprocess.run(['bash', os.path.join(self.deploy, script), *args], capture_output=True, text=True,
                              env={**os.environ, 'PATH': self.bin + ':' + os.environ['PATH'],
                                   'FAKE': self.fake, 'WATCH_INTERVAL': '30', **(env or {})})


class Watch(Base):
    def setUp(self):
        super().setUp()
        for svc in SERVICES:
            self.put(f'cid_{svc}', f'{svc}-1\n')
            self.put(f'inspect_{svc}-1', 'running none 0\n' if svc == 'gateway' else 'running healthy 0\n')  # gateway has no healthcheck

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
        self.assertEqual([c for c in self.calls() if c.startswith('sleep')], ['sleep 30'] * 3)

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

    def test_one_unhealthy_round_is_tolerated(self):
        self.put('on_sleep', f'echo "running unhealthy 0" > "{self.fake}/inspect_orion-worker-1"\n')
        self.put('on_sleep_2', f'echo "running healthy 0" > "{self.fake}/inspect_orion-worker-1"\n')
        r = self.watch()
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn('::warning::orion-worker is unhealthy, not healthy (check 1 of 2', r.stdout)
        self.assertNotIn('::error::', r.stdout)

    def test_one_failed_api_health_round_is_tolerated(self):
        self.put('on_sleep', f'echo 28 > "{self.fake}/curl_rc"\n')
        self.put('on_sleep_2', f'rm "{self.fake}/curl_rc"\n')
        r = self.watch()
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn('::warning::orion /api/health did not answer OK (exit 28', r.stdout)

    def test_consecutive_unhealthy_rounds_fail_and_the_tolerance_is_configurable(self):
        self.put('inspect_orion-worker-1', 'running unhealthy 0\n')
        r = self.watch()
        self.assertEqual(r.returncode, 1)
        self.assertIn('::error::orion-worker is unhealthy, not healthy (2 checks in a row)', r.stdout)
        r = self.run_script('90', script='watch-deploy.sh', env={'WATCH_TOLERANCE': '3'})
        self.assertIn('::error::orion-worker is unhealthy, not healthy (3 checks in a row)', r.stdout)

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
        self.assertIn('::error::orion /api/health did not answer OK (exit 22', r.stdout)

    def test_no_api_health_error_for_a_recreated_orion(self):
        self.put('on_sleep', f'echo orion-2 > "{self.fake}/cid_orion"; echo "running healthy 0" > "{self.fake}/inspect_orion-2"; echo 22 > "{self.fake}/curl_rc"\n')
        r = self.watch()
        self.assertEqual(r.returncode, 1)
        self.assertIn('::error::orion was recreated', r.stdout)
        self.assertNotIn('/api/health', r.stdout)

    def test_fails_when_a_container_cannot_be_inspected(self):
        os.remove(os.path.join(self.fake, 'inspect_gateway-1'))
        r = self.watch()
        self.assertEqual(r.returncode, 1)
        self.assertIn('::error::gateway could not be inspected', r.stdout)

    def test_a_failing_docker_compose_is_reported_as_that(self):
        self.put('compose_rc', '1\n')
        r = self.watch()
        self.assertEqual(r.returncode, 1)
        self.assertIn('::error::orion could not be listed (docker compose ps failed)', r.stdout)
        self.assertNotIn('has no container', r.stdout)
        self.assertNotIn('/api/health', r.stdout)

    def test_bad_arguments_are_refused(self):
        for args, env in ((('abc',), {}), (('90',), {'WATCH_INTERVAL': '0'}), (('90',), {'WATCH_TOLERANCE': '0'})):
            r = self.run_script(*args, script='watch-deploy.sh', env=env)
            self.assertEqual(r.returncode, 2, (args, env, r.stdout, r.stderr))
            self.assertIn('::error::usage', r.stdout)

    def test_a_watch_shorter_than_the_interval_still_checks_once(self):
        r = self.run_script('5', script='watch-deploy.sh')
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertEqual([c for c in self.calls() if c.startswith('sleep')], ['sleep 30'])

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

    def test_a_vector_that_stays_down_is_warned_about_once(self):
        os.remove(os.path.join(self.fake, 'cid_vector'))
        r = self.watch()
        self.assertEqual(r.stdout.count('::warning::vector'), 1)


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
        self.assertEqual([c for c in calls if c.startswith(('rollback.sh', 'wait-healthy.sh'))],
                         ['rollback.sh ', 'wait-healthy.sh orion-worker 360'])
        checkout = f'git checkout --quiet -B main {GOOD_SHA}'
        self.assertIn(checkout, calls)
        self.assertLess(calls.index(checkout), calls.index('rollback.sh '), 'the good tree is checked out before the containers are recreated')
        self.assertEqual(self.result()['REASON'], 'deploy failed; images rolled back')
        res = self.result()
        self.assertEqual((res['RESULT'], res['FAILED_SHA'], res['ROLLED_BACK_TO']), ('rolled_back', BAD_SHA, GOOD_SHA))
        self.assertRegex(res['AT'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$')

    def test_reason_names_the_failed_step(self):
        r = self.run_script(script='auto-rollback.sh', env={'BOOTSTRAP_OUTCOME': 'success', 'HEALTH_OUTCOME': 'success', 'WATCH_OUTCOME': 'failure'})
        self.assertEqual(r.returncode, 1)
        self.assertEqual(self.result()['REASON'], 'watch failed; images rolled back')

    def test_a_failed_checkout_is_noted_and_the_rollback_goes_ahead(self):
        self.put('checkout_rc', '1\n')
        r = self.run_script(script='auto-rollback.sh')
        self.assertEqual(r.returncode, 1)
        self.assertIn('::warning::could not check out', r.stdout)
        self.assertIn('rollback.sh ', self.calls())
        res = self.result()
        self.assertEqual((res['RESULT'], res['ROLLED_BACK_TO']), ('rolled_back', GOOD_SHA))
        self.assertIn(f'checkout of {GOOD_SHA} failed', res['REASON'])

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
        self.assertIn('::error::Deploy of', r.stdout)
        self.assertIn('could not tell whether it changed migrations', r.stdout)
        self.assertIn('git diff failed', r.stdout)
        self.assertIn('restore.sh predeploy_<timestamp>', r.stdout)
        res = self.result()
        self.assertEqual((res['RESULT'], res['ROLLED_BACK_TO']), ('skipped_migrations', ''))
        self.assertFalse([c for c in self.calls() if c.startswith(('rollback.sh', 'git checkout'))])

    def test_diff_warnings_on_stderr_are_not_changed_files(self):
        write(os.path.join(self.bin, 'git'), GIT.replace('diff) cat', 'diff) echo "warning: x" >&2; cat'))
        r = self.run_script(script='auto-rollback.sh')
        self.assertEqual(self.result()['RESULT'], 'rolled_back', r.stdout)

    def test_the_failed_deploy_is_the_last_good(self):
        self.put('head', GOOD_SHA + '\n')
        r = self.run_script(script='auto-rollback.sh')
        self.assertEqual(r.returncode, 1)
        self.assertIn('it is itself the recorded last-good', r.stdout)
        self.assertIn('restore.sh predeploy_<timestamp>', r.stdout)
        self.assertFalse([c for c in self.calls() if c.startswith(('rollback.sh', 'wait-healthy.sh', 'git checkout'))])
        res = self.result()
        self.assertEqual((res['RESULT'], res['ROLLED_BACK_TO']), ('rollback_failed', ''))

    def test_no_last_good(self):
        os.remove(os.path.join(self.deploy, '.last-good'))
        r = self.run_script(script='auto-rollback.sh')
        self.assertEqual(r.returncode, 1)
        self.assertIn('nothing to roll back to', r.stdout)
        self.assertIn('restore.sh predeploy_<timestamp>', r.stdout)
        self.assertFalse([c for c in self.calls() if c.startswith(('rollback.sh', 'wait-healthy.sh'))])
        res = self.result()
        self.assertEqual((res['RESULT'], res['FAILED_SHA'], res['ROLLED_BACK_TO']), ('no_last_good', BAD_SHA, ''))

    def test_a_last_good_without_a_sha(self):
        write(os.path.join(self.deploy, '.last-good'), 'DEPLOYED_AT=x\n', 0o600)
        r = self.run_script(script='auto-rollback.sh')
        self.assertEqual(r.returncode, 1)
        self.assertIn('deploy/.last-good has no GIT_SHA', r.stdout)
        self.assertIn('restore.sh predeploy_<timestamp>', r.stdout)
        self.assertFalse([c for c in self.calls() if c.startswith('rollback.sh')])
        res = self.result()
        self.assertEqual((res['RESULT'], res['ROLLED_BACK_TO']), ('no_last_good', ''))
        self.assertIn('has no GIT_SHA', res['REASON'])

    def test_rollback_failure_is_recorded(self):
        self.put('rollback.sh_rc', '1\n')
        r = self.run_script(script='auto-rollback.sh')
        self.assertEqual(r.returncode, 1)
        self.assertIn(f'::error::Deploy of {BAD_SHA} failed and the rollback to {GOOD_SHA} failed', r.stdout)
        self.assertIn('rollback.sh already ran', r.stdout)
        self.assertIn('restore.sh predeploy_<timestamp>', r.stdout)
        self.assertFalse([c for c in self.calls() if c.startswith('wait-healthy.sh')])
        res = self.result()
        self.assertEqual((res['RESULT'], res['ROLLED_BACK_TO']), ('rollback_failed', ''))
        self.assertIn('rollback.sh failed', res['REASON'])

    def test_unhealthy_worker_after_rollback_is_recorded(self):
        self.put('wait-healthy.sh_rc', '1\n')
        r = self.run_script(script='auto-rollback.sh')
        self.assertEqual(r.returncode, 1)
        self.assertIn('the images are back on', r.stdout)
        self.assertIn('orion-worker is not healthy', r.stdout)
        self.assertIn('restore.sh predeploy_<timestamp>', r.stdout)
        res = self.result()
        self.assertEqual((res['RESULT'], res['ROLLED_BACK_TO']), ('rollback_failed', GOOD_SHA))
        self.assertIn('orion-worker not healthy after it', res['REASON'])
        self.assertNotIn('rollback.sh failed', res['REASON'])


class Workflow(unittest.TestCase):
    """What ORION will rely on in deploy.yml (plain text: PyYAML is not guaranteed)."""

    def setUp(self):
        with open(os.path.join(ROOT, '.github', 'workflows', 'deploy.yml')) as f:
            text = f.read()
        self.steps = {}
        self.order = []
        for block in text.split('\n      - name: ')[1:]:
            name = block.split('\n', 1)[0].strip()
            self.steps[name] = block
            self.order.append(name)

    def test_the_rollback_step_and_its_inputs(self):
        step = self.steps['Automatic rollback']
        self.assertIn("\n        if: failure() && steps.bootstrap.outcome != 'skipped'\n", step)
        self.assertIn('run: $DEPLOY_DIR/auto-rollback.sh', step)
        for step_id in ('bootstrap', 'health', 'watch'):
            self.assertIn(f'_OUTCOME: ${{{{ steps.{step_id}.outcome }}}}', step)
        self.assertIn('\n        id: bootstrap\n', self.steps['Bootstrap and start stack'])
        self.assertIn('\n        id: health\n', self.steps['Wait for ORION health'])
        self.assertIn('\n        id: watch\n', self.steps['Watch the new version'])

    def test_the_watch_comes_between_health_and_last_good(self):
        o = self.order
        self.assertEqual(o.index('Wait for ORION health') + 1, o.index('Watch the new version'))
        self.assertEqual(o.index('Watch the new version') + 1, o.index('Record last-good deploy'))
        self.assertIn('watch-deploy.sh', self.steps['Watch the new version'])

    def test_both_new_steps_have_a_timeout(self):
        self.assertIn('timeout-minutes: 20', self.steps['Watch the new version'])
        self.assertIn('timeout-minutes: 30', self.steps['Automatic rollback'])


if __name__ == '__main__':
    unittest.main()
