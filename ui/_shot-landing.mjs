import puppeteer from 'puppeteer-core';
const url = process.argv[2] || 'http://127.0.0.1:8791/';
const b = await puppeteer.launch({executablePath:'/usr/bin/google-chrome', headless:true, args:['--no-sandbox','--disable-gpu','--force-color-profile=srgb']});
for (const s of [
  {name:'/tmp/land-desktop.png', w:1440, h:900, dsf:1},
  {name:'/tmp/land-mobile.png',  w:412,  h:915, dsf:2},
]){
  const p = await b.newPage();
  await p.setViewport({width:s.w, height:s.h, deviceScaleFactor:s.dsf});
  await p.goto(url, {waitUntil:'networkidle0', timeout:30000});
  await new Promise(r=>setTimeout(r,400));
  await p.screenshot({path:s.name, fullPage:true});
  console.log('shot', s.name);
  await p.close();
}
await b.close();
