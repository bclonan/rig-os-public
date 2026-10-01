from PIL import Image,ImageDraw
import pathlib,json
root=pathlib.Path('evidence/semantic');root.mkdir(exist_ok=True)
cases=[]
for kind in ['blank','line','wrong-subject','word-dog','incomplete','outside-target']:
    im=Image.new('RGB',(512,384),'white');d=ImageDraw.Draw(im)
    if kind=='line':d.line((100,200,400,200),fill='black',width=4)
    if kind=='wrong-subject':
        d.rectangle((150,160,330,320),outline='black',width=4);d.line([(130,160),(240,60),(350,160)],fill='black',width=4);d.rectangle((210,230,260,320),outline='black',width=3)
    if kind=='word-dog':d.text((170,140),'DOG',fill='black',font_size=80)
    if kind=='incomplete':d.line([(80,200),(140,150),(230,150)],fill='black',width=4)
    if kind=='outside-target':
        outside=Image.new('RGB',(1024,384),'white');od=ImageDraw.Draw(outside);od.ellipse((600,100,780,210),outline='black',width=4);od.ellipse((770,70,850,140),outline='black',width=4)
        for x in [640,730]:od.line((x,200,x,300),fill='black',width=4)
        outside.save(root/'outside-full.png');im=outside.crop((0,0,512,384))
    im.save(root/(kind+'.png'));cases.append({'id':kind,'image':str(root/(kind+'.png')),'expectedRecognizable':False,'source':'independent controlled negative fixture'})
paint=json.load(open('evidence/paint.json'));im=Image.open('evidence/paint-after.bmp');frame=next(e['data']['observation']['frame'] for e in paint['events'] if e['type']=='observation');c=paint['canvas'];x=max(0,c['x']-frame['x']);y=max(0,c['y']-frame['y']);im.crop((x,y,min(im.width,x+c['width']),min(im.height,y+c['height']))).save(root/'paint-canvas.png')
cases.append({'id':'actual-paint','image':str(root/'paint-canvas.png'),'expectedRecognizable':None,'source':'native Paint output, acceptance unknown'})
(root/'cases.json').write_text(json.dumps(cases,indent=2))
