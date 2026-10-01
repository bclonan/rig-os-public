"""Standard-library client. The host submits goals; the service owns execution."""
import json,urllib.request,urllib.parse,uuid
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Runtime redirects are forbidden')

class RuntimeClient:
    def __init__(self,url,token):self.url=url.rstrip('/');self.token=token;self.opener=urllib.request.build_opener(NoRedirect)
    def request(self,path,method='GET',body=None,key=None):
        req=urllib.request.Request(self.url+path,data=None if body is None else json.dumps(body).encode(),method=method,headers={'Authorization':'Bearer '+self.token,'Content-Type':'application/json','X-Correlation-ID':str(uuid.uuid4()),'Idempotency-Key':key or str(uuid.uuid4())})
        with self.opener.open(req,timeout=130) as response:return json.load(response)
    def submit(self,contract):return self.request('/api/tasks','POST',contract,contract['id'])
    def status(self,run_id):return self.request('/api/tasks/'+urllib.parse.quote(run_id,safe=''))
    def advice(self,run_id):return self.request('/api/tasks/'+urllib.parse.quote(run_id,safe='')+'/advice')
    def drawing_plan(self,request,key=None):return self.request('/api/drawing-plans','POST',request,key)
    def execute_drawing(self,plan_id,key=None):return self.request('/api/drawing-plans/'+urllib.parse.quote(plan_id,safe='')+'/execute','POST',{},key or plan_id)
    def assess_canvas(self,run_id,subject,model):return self.request('/api/desktop/tasks/'+urllib.parse.quote(run_id,safe='')+'/assess','POST',{'subject':subject,'model':model})
    def control(self,run_id,command):return self.request('/api/tasks/'+urllib.parse.quote(run_id,safe='')+'/control','POST',{'command':command})
    def events(self,after=0):
        req=urllib.request.Request(self.url+'/api/events?after='+str(after),headers={'Authorization':'Bearer '+self.token})
        with self.opener.open(req,timeout=130) as response:
            for line in response:
                if line.startswith(b'data: '):yield json.loads(line[6:])
