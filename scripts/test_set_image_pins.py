"""deploy/set-image-pins.sh on a copy of the deploy directory:
python3 -m unittest -v scripts/test_set_image_pins.py"""
import os
import shutil
import stat
import subprocess
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = 'SECRET=s3cret\nORION_WEB_VERSION=old\nGITHUB_ORG=org\nORION_VECTOR_VERSION=old\n'


class Pins(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        shutil.copy(os.path.join(ROOT, 'deploy', 'set-image-pins.sh'), self.dir)
        self.env = os.path.join(self.dir, '.env')
        with open(self.env, 'w') as f:
            f.write(ENV)
        os.chmod(self.env, 0o600)

    def run_it(self, pins, path=None):
        return subprocess.run(['bash', os.path.join(self.dir, 'set-image-pins.sh')], input=pins,
                              capture_output=True, text=True,
                              env={**os.environ, 'PATH': path or os.environ['PATH']})

    def read(self):
        with open(self.env) as f:
            return f.read()

    def test_replaces_the_pins_and_keeps_the_rest(self):
        r = self.run_it('ORION_WEB_VERSION=abc\nORION_GATEWAY_VERSION=abc\nORION_VECTOR_VERSION=v1.2\n')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.read(), 'SECRET=s3cret\nGITHUB_ORG=org\nORION_WEB_VERSION=abc\n'
                                      'ORION_GATEWAY_VERSION=abc\nORION_VECTOR_VERSION=v1.2\n')
        self.assertEqual(stat.S_IMODE(os.stat(self.env).st_mode), 0o600)
        self.assertEqual(sorted(os.listdir(self.dir)), ['.env', 'set-image-pins.sh'])

    def test_only_the_pins_given_are_replaced(self):
        self.assertEqual(self.run_it('ORION_WEB_VERSION=abc\n').returncode, 0)
        self.assertEqual(self.read(), 'SECRET=s3cret\nGITHUB_ORG=org\nORION_VECTOR_VERSION=old\nORION_WEB_VERSION=abc\n')

    def test_refuses_anything_but_pins(self):
        for bad in ('', 'SECRET=x\n', 'ORION_WEB_VERSION=a b\n', 'ORION_WEB_VERSION=$(id)\n',
                    'ORION_WEB_VERSION=abc\nORION_GATEWAY_VERSION=repo@sha256:1\n', 'ORION_WEB_VERSION=\n'):
            r = self.run_it(bad)
            self.assertNotEqual(r.returncode, 0, bad)
        self.assertEqual(self.read(), ENV)

    def test_a_read_error_does_not_replace_the_env(self):
        # As root an unreadable file is still readable: a grep that fails stands in.
        bin_dir = os.path.join(self.dir, 'bin')
        os.mkdir(bin_dir)
        with open(os.path.join(bin_dir, 'grep'), 'w') as f:
            f.write('#!/bin/sh\nexit 2\n')
        os.chmod(os.path.join(bin_dir, 'grep'), 0o755)
        r = self.run_it('ORION_WEB_VERSION=abc\n', path=bin_dir + ':' + os.environ['PATH'])
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.read(), ENV)
        self.assertEqual(sorted(os.listdir(self.dir)), ['.env', 'bin', 'set-image-pins.sh'])

    def test_a_symlinked_env_stays_a_symlink(self):
        real = os.path.join(self.dir, 'real.env')
        os.rename(self.env, real)
        os.symlink('real.env', self.env)
        self.assertEqual(self.run_it('ORION_WEB_VERSION=abc\n').returncode, 0)
        self.assertTrue(os.path.islink(self.env))
        with open(real) as f:
            self.assertIn('ORION_WEB_VERSION=abc', f.read())


if __name__ == '__main__':
    unittest.main()
