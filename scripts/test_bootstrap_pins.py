"""deploy/bootstrap.sh keeps the image pins a deploy exports:
python3 -m unittest -v scripts/test_bootstrap_pins.py"""
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
with open(os.path.join(ROOT, 'deploy', 'bootstrap.sh')) as f:
    LINES = f.read().splitlines()

SOURCE_ENV = re.compile(r'(^|[;&|]|\bthen|\bdo)\s*(source|\.)\s+\S*\.env\b')
COMPOSE = re.compile(r'\$COMPOSE\b|docker[ -]compose\b')


def code(line):
    return line.split('#', 1)[0] if not line.lstrip().startswith('#') else ''


class Pins(unittest.TestCase):
    def test_every_source_of_env_restores_the_pins_before_compose_runs(self):
        # .env holds the previous deploy's pins: sourcing it without restoring the
        # exported ones makes later compose commands use the old images.
        sources = [i for i, line in enumerate(LINES) if SOURCE_ENV.search(code(line))]
        self.assertGreaterEqual(len(sources), 3)
        for i in sources:
            for line in LINES[i + 1:]:
                if 'eval "$VERSION_OVERRIDES"' in code(line):
                    break
                self.assertIsNone(COMPOSE.search(code(line)),
                                  f'bootstrap.sh line {i + 1}: .env sourced, compose runs before the pins are restored')

    def test_recreating_one_service_leaves_its_dependencies(self):
        # --force-recreate without --no-deps recreates the dependencies too.
        for i, line in enumerate(LINES):
            if '--force-recreate' in code(line):
                self.assertIn('--no-deps', line, f'bootstrap.sh line {i + 1}')


if __name__ == '__main__':
    unittest.main()
