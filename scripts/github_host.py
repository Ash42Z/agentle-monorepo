#!/usr/bin/env python3
"""Host-only GitHub App client. Never prints authentication material."""
import base64,json,os,subprocess,time,urllib.request
from pathlib import Path
CONFIG=Path('/root/.config/agentle')
def token():
 c=json.loads((CONFIG/'config.json').read_text())
 enc=lambda b:base64.urlsafe_b64encode(b).rstrip(b'=')
 body=enc(b'{"alg":"RS256","typ":"JWT"}')+b'.'+enc(json.dumps({'iat':int(time.time())-60,'exp':int(time.time())+540,'iss':str(c['githubAppId'])}).encode())
 signature=subprocess.run(['openssl','dgst','-sha256','-sign',str(CONFIG/'github-app.pem')],input=body,capture_output=True,check=True).stdout
 jwt=(body+b'.'+enc(signature)).decode()
 return api('/app/installations/'+str(c['githubInstallationId'])+'/access_tokens','POST',{},jwt)['token']
def api(path,method='GET',data=None,credential=None):
 request=urllib.request.Request('https://api.github.com'+path,method=method,data=json.dumps(data).encode() if data is not None else None,headers={'Authorization':'Bearer '+(credential or token()),'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'})
 with urllib.request.urlopen(request,timeout=30) as r:return json.load(r) if r.status!=204 else None
def git(args,cwd):
 import tempfile
 with tempfile.TemporaryDirectory(prefix='agentle-git-') as d:
  secret=Path(d)/'token';secret.write_text(token());secret.chmod(0o600)
  ask=Path(d)/'ask';ask.write_text('#!/bin/sh\ncase "$1" in *Username*) echo x-access-token;; *) cat '+str(secret)+';; esac\n');ask.chmod(0o700)
  return subprocess.run(['git','-c','credential.helper=','-c','core.hooksPath=/dev/null',*args],cwd=cwd,env={**os.environ,'GIT_ASKPASS':str(ask),'GIT_TERMINAL_PROMPT':'0'},check=True)
if __name__=='__main__':
 import sys
 if sys.argv[1]=='git':git(sys.argv[3:],sys.argv[2])
 elif sys.argv[1]=='check':
  sha=sys.argv[2];c=json.loads((CONFIG/'config.json').read_text());repo='/repos/'+c['repository'];t=token()
  head=api(repo+'/git/ref/heads/main',credential=t)['object']['sha']
  if head!=sha:raise SystemExit('Deployment SHA must be current main')
  runs=api(repo+'/actions/runs?head_sha='+sha+'&event=push',credential=t)['workflow_runs']
  valid=False
  for run in runs:
   if run['path']!='.github/workflows/ci.yaml' or run['head_sha']!=sha:continue
   jobs=api(repo+'/actions/runs/'+str(run['id'])+'/jobs',credential=t)['jobs']
   if any(j['name']=='test' and j['conclusion']=='success' for j in jobs):valid=True
  if not valid:raise SystemExit('Exact commit has no successful CI test job')
