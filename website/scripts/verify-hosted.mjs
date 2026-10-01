import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
const base='https://rig-os.netlify.app';
const report={at:new Date().toISOString(),base,checks:[],errors:[]};
const publication=await (await fetch(base+'/publication.json')).json();
assert.equal(publication.counts.markdownDocuments,51);
for(let i=0;i<publication.documents.length;i+=6){
  const batch=await Promise.all(publication.documents.slice(i,i+6).map(async doc=>{
    const response=await fetch(base+doc.url);
    assert.equal(response.status,200,doc.url);
    assert.match(await response.text(),/<main/);
    return {path:doc.url,status:response.status};
  }));report.checks.push(...batch);
}
for(const name of ['rig-os-tour','runtime-demo','rig-os-social']){
  const response=await fetch(`${base}/media/${name}.mp4`,{headers:{Range:'bytes=0-1023'}});
  assert.equal(response.status,206);
  assert.match(response.headers.get('content-type'),/video\/mp4/);
  await response.arrayBuffer();
  report.checks.push({media:name,rangeStatus:response.status,contentType:response.headers.get('content-type')});
}
assert.equal((await fetch(base+'/this-page-does-not-exist-qa')).status,404);
const browser=await chromium.launch();
try{
  const page=await browser.newPage({viewport:{width:1440,height:1000},colorScheme:'dark'});
  page.on('pageerror',e=>report.errors.push(e.message));
  await page.goto(base,{waitUntil:'networkidle'});
  await page.screenshot({path:'qa/hosted-landing.png'});
  await page.locator('[data-node="runtime"]').click();
  assert.match(await page.locator('#detail-link').getAttribute('href'),/runtime\/index.ts/);
  for(const video of ['tour','runtime']){
    await page.locator(`[data-video="${video}"]`).click();
    await page.waitForFunction(()=>document.querySelector('video').readyState>=2);
    const start=await page.locator('video').evaluate(async v=>{v.muted=true;await v.play();return v.currentTime;});
    await page.waitForTimeout(650);
    const state=await page.locator('video').evaluate(v=>({time:v.currentTime,duration:v.duration,cues:v.textTracks[0]?.cues?.length||0}));
    assert.ok(state.time>start);assert.ok(state.cues>0);report.checks.push({playback:video,...state});
  }
  await page.goto(base+'/map/',{waitUntil:'networkidle'});
  await page.locator('[data-flow="desktop-task"]').click();
  await page.locator('#next-step').click();
  assert.match(await page.locator('#step-progress').innerText(),/Step 2 of 9/);
  await page.locator('#list-mode').click();
  await page.locator('#list-view [data-node]').first().click();
  await page.locator('#component-sources button').first().click();
  assert.ok(await page.locator('#source-dialog').evaluate(x=>x.open));
  report.checks.push({map:'journey steps, inspector and source dialog passed'});
  await page.goto(base+'/docs/',{waitUntil:'networkidle'});
  await page.locator('[data-open-search]').click();
  await page.locator('#doc-query').fill('providers');
  await page.locator('#search-results a').first().waitFor();
  report.checks.push({searchResults:await page.locator('#search-results a').count()});
  await page.goto(base+'/docs/computer-use-runtime/ARCHITECTURE/',{waitUntil:'networkidle'});
  await page.locator('.mermaid svg').nth(1).waitFor();
  report.checks.push({mermaidDiagrams:await page.locator('.mermaid svg').count()});
  assert.deepEqual(report.errors,[]);
  report.status='PASS';
}finally{await browser.close();await fs.writeFile('qa/hosted.json',JSON.stringify(report,null,2));}
console.log(JSON.stringify({status:report.status,checks:report.checks.length,pageErrors:report.errors}));
