"""Proposed Agent-OS mapping, actual host integration UNVERIFIED."""
import sys,pathlib
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]/'sdk'/'python'))
from computer_use_runtime import RuntimeClient
def submit_goal(url,token,task_contract):return RuntimeClient(url,token).submit(task_contract)
if __name__=='__main__':
    import uuid
    c=RuntimeClient('http://127.0.0.1:4317',pathlib.Path('.data/service.token').read_text().strip());caps=c.request('/api/capabilities');run_id=str(uuid.uuid4())
    contract={'schemaVersion':1,'id':run_id,'correlationId':str(uuid.uuid4()),'requester':'local-user','goal':'Set display name','target':{k:caps[k] for k in ['host','session','identity']},'parameters':{'name':'Python client'},'effects':['edit'],'requirements':[{'name':'name','value':'Python client','origin':'user_explicit'}],'unresolved':[],'method':'form.seed','expected':{'result':'Python client'},'budgets':{'steps':8,'deadlineMs':15000}}
    print(c.submit(contract))
