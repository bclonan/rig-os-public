"""Read public upstream interfaces and licenses. Never execute upstream agent code."""
import urllib.request, json, pathlib, datetime
repos=['oculix-org/Oculix','OpenAdaptAI/openadapt-flow','microsoft/UFO','bytedance/UI-TARS-desktop','simular-ai/Agent-S','xlang-ai/OpenCUA','microsoft/OmniParser','statelyai/xstate','microsoft/playwright','RaiMan/SikuliX1','Villavu/Simba','SRL/SRL','Ineedajob/RSBot','open-rpa/openrpa','PrismarineJS/mineflayer-statemachine','microsoft/WindowsAgentArena','xlang-ai/OSWorld']
root=pathlib.Path('evidence/upstream');root.mkdir(parents=True,exist_ok=True)
def get(url):
 req=urllib.request.Request(url,headers={'User-Agent':'computer-use-runtime-source-inspection'})
 with urllib.request.urlopen(req,timeout=25) as f:return f.read()
records=[]
for repo in repos:
 record={'repository':repo,'retrievedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
 try:
  info=json.loads(get('https://api.github.com/repos/'+repo));branch=info['default_branch'];commit=json.loads(get('https://api.github.com/repos/'+repo+'/commits/'+branch))['sha'];record.update(commit=commit,license=info.get('license'),url=info['html_url'])
  files=json.loads(get('https://api.github.com/repos/'+repo+'/git/trees/'+commit+'?recursive=1'))['tree'];paths=[x['path'] for x in files if x['type']=='blob'];record['candidateInterfaces']=[p for p in paths if any(x in p.lower() for x in ['agent.py','desktop_env','license','readme','state_machine'])][:80]
  wanted=[p for p in paths if p.lower() in ['readme.md','license','license.md','license.txt']]
  if repo.endswith('OSWorld'):wanted += [p for p in paths if p in ['mm_agents/agent.py','desktop_env/desktop_env.py','desktop_env/envs/desktop_env.py']]
  if repo.endswith('WindowsAgentArena'):wanted += [p for p in paths if p.endswith('mm_agents/agent.py') or p.endswith('desktop_env/envs/desktop_env.py')]
  for p in wanted[:6]:
   data=get(f'https://raw.githubusercontent.com/{repo}/{commit}/{p}');(root/(repo.replace('/','_')+'_'+p.replace('/','_'))).write_bytes(data)
  record['inspectedFiles']=wanted[:6];record['status']='inspected'
 except Exception as e:record.update(status='unavailable',error=str(e))
 records.append(record);print(repo,record['status'],flush=True)
 (root/'index.json').write_text(json.dumps(records,indent=2),encoding='utf-8')
