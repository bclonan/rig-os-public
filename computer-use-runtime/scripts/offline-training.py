import socket,runpy,os,pathlib,json,time
class NoNetwork(socket.socket):
    def connect(self,*args,**kwargs):raise RuntimeError('Network disabled for this training process')
    def connect_ex(self,*args,**kwargs):raise RuntimeError('Network disabled for this training process')
    def sendto(self,*args,**kwargs):raise RuntimeError('Network disabled for this training process')
socket.socket=NoNetwork
os.environ['CUR_MODEL_DIR']='models/offline-'+str(int(time.time()))
import sys
sys.path.insert(0,'learner')
runpy.run_path('learner/train.py',run_name='__main__')
pathlib.Path('evidence/offline-training.json').write_text(json.dumps({'status':'PASS','networkBoundary':'Python socket subclass rejects connect, connect_ex and sendto; OS networking remains enabled','models':os.environ['CUR_MODEL_DIR'],'trainingReport':os.environ['CUR_MODEL_DIR']+'/training.json'}))
