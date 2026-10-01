import sys,json
sys.path.insert(0,'sdk/python')
from benchmark_adapter import BenchmarkAgent
class ContractBridge:
    def reset(self,host,session):self.host=host
    def next_action(self,instruction,obs,pending,host,session):
        assert 'reward' not in obs and 'evaluator' not in obs and 'task_config' not in obs
        assert 'accessibility_tree' not in obs
        return {'id':'contract-action-1','operation':'click','args':{'x':42,'y':63}}
agent=BenchmarkAgent(ContractBridge(),'vm-contract','session-contract','pixel');agent.reset()
_,actions=agent.predict('Click the authorized target',{'screenshot':b'contract-fixture','reward':1,'evaluator':{'answer':42},'accessibility_tree':'hidden for pixel track'})
assert actions==[{'action_type':'CLICK','x':42,'y':63,'button':'left'}]
print(json.dumps({'status':'PASS','level':'adapter contract','nativeBenchmarkScore':None,'actionsReturned':1}))
