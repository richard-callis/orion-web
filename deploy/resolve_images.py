#!/usr/bin/env python3
"""
The image each ORION component should run at the checked-out commit, printed as
VAR=<commit> lines (ORION_WEB_VERSION etc.), for the deploy workflow.

Builds run only for pushes that touch a component, and tag its image with the commit
pushed. So the right image is the newest one built in this history since the
component's last change (a manual rebuild included). Never :latest: that is whatever
was built last, from any commit, and queued deploys cancel each other, so a deploy
can't count on having been triggered by the build it needs.

When nothing has been built since the last change, older images are not used: that
change's code may have failed CI, or been rolled back. Instead:
  exit 3  a build of it on main is still running: skip this deploy, the build's own follows;
  exit 1  it failed or never ran; also on any registry or API error.

Usage: resolve_images.py [repository]   (default: the one this file is in)
Environment: GITHUB_ORG; GITHUB_REPOSITORY and GH_TOKEN to ask GitHub about builds
(the token is read from the environment, never put on a command line).
"""
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

REGISTRY = os.environ.get('REGISTRY_URL', 'https://ghcr.io')
API = os.environ.get('GITHUB_API_URL', 'https://api.github.com')
# The paths of each build workflow's trigger (tests check they match .github/workflows/build-*.yml).
COMPONENTS = [
    ('ORION_WEB_VERSION', 'orion-web', 'build-web.yml',
     ['apps/web', 'package.json', 'package-lock.json', '.dockerignore', '.github/workflows/build-web.yml']),
    ('ORION_GATEWAY_VERSION', 'orion-gateway', 'build-gateway.yml',
     ['apps/gateway', 'package.json', 'package-lock.json', '.dockerignore', '.github/workflows/build-gateway.yml']),
    ('ORION_VECTOR_VERSION', 'orion-vector', 'build-vector.yml',
     ['deploy/host-agent/Dockerfile', '.github/workflows/build-vector.yml']),
]


class Failed(Exception):
    pass


def log(level, text):
    print(f'::{level}::{text}', file=sys.stderr)


def fetch(url, headers=None, tries=3):
    """(body, headers), retried; a 4xx other than 429 isn't."""
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), timeout=30) as r:
                return r.read(), r.headers
        except urllib.error.HTTPError as e:
            if e.code < 500 and e.code != 429 or attempt == tries - 1:
                raise Failed(f'{url.split("?")[0]}: HTTP {e.code}') from None
        except (urllib.error.URLError, OSError) as e:
            if attempt == tries - 1:
                raise Failed(f'{url.split("?")[0]}: {e}') from None
        time.sleep(5 * (attempt + 1))


def tags(org, image):
    """Every tag of the image (anonymous pull: the packages are public)."""
    body, _ = fetch(f'{REGISTRY}/token?scope=repository:{org}/{image}:pull')
    auth = {'Authorization': 'Bearer ' + json.loads(body)['token']}
    out, url = set(), f'{REGISTRY}/v2/{org}/{image}/tags/list?n=1000'
    for _ in range(100):
        body, headers = fetch(url, auth)
        out.update(json.loads(body).get('tags') or [])
        link = re.search(r'<([^>]+)>;\s*rel="next"', headers.get('Link') or '')
        if not link:
            return out
        url = urllib.parse.urljoin(REGISTRY, link.group(1))
    raise Failed(f'{image}: too many pages of tags')


def building(workflow, commits):
    """Is a run of this build workflow on main, for one of these commits, still going?"""
    repo, token = os.environ.get('GITHUB_REPOSITORY'), os.environ.get('GH_TOKEN')
    if not repo or not token:
        raise Failed('GITHUB_REPOSITORY and GH_TOKEN are needed to ask GitHub about builds')
    headers = {'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json'}
    for sha in commits:
        body, _ = fetch(f'{API}/repos/{repo}/actions/workflows/{workflow}/runs?head_sha={sha}&branch=main&per_page=10',
                        headers)
        if any(r.get('status') != 'completed' for r in json.loads(body).get('workflow_runs') or []):
            return True
    return False


def git(repo, *args):
    return subprocess.run(['git', '-C', repo, *args], check=True, capture_output=True, text=True).stdout.split()


def resolve(repo, org, var, image, workflow, paths):
    change = git(repo, 'rev-list', '--first-parent', '-n', '1', 'HEAD', '--', *paths)
    if not change:
        raise Failed(f'{image}: nothing in this history builds it')
    since = []  # the last change and every later commit, newest first: those builds carry its code
    for sha in git(repo, 'rev-list', '--first-parent', 'HEAD'):
        since.append(sha)
        if sha == change[0]:
            break
    else:
        raise Failed(f'{image}: {change[0][:12]} isn\'t on the first-parent history')
    for attempt in (1, 2):
        have = tags(org, image)
        found = next((sha for sha in since if sha in have), None)
        if found:
            return f'{var}={found}'
        if attempt == 2:
            break
        if building(workflow, since):
            log('notice', f'{image}: the build of {change[0][:12]} (its last change) is still running; its own deploy follows')
            raise SystemExit(3)
        # It may have finished between the two questions: look once more.
    raise Failed(f'{image}: nothing is built for {change[0][:12]} (its last change) or later, and no build of it is running')


def main():
    repo = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    org = os.environ.get('GITHUB_ORG')
    if not org:
        log('error', 'set GITHUB_ORG')
        return 1
    try:
        lines = [resolve(repo, org, *c) for c in COMPONENTS]
    except Failed as e:
        log('error', str(e))
        return 1
    print('\n'.join(lines))
    return 0


if __name__ == '__main__':
    sys.exit(main())
