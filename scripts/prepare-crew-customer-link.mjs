import fs from 'node:fs';

function patchBackend() {
  const path = new URL('../src/crew.js', import.meta.url);
  let src = fs.readFileSync(path, 'utf8');

  if (!src.includes('async function lookupJsmCustomerByEmail')) {
    const marker = "resolver.define('importCrew', async ({payload}) => {";
    if (!src.includes(marker)) throw new Error('Could not locate crew import resolver.');
    const helper = `async function lookupJsmCustomerByEmail(email) {\n  email=clean(email||'');\n  if(!email||!email.includes('@'))return{status:'no-email'};\n  const response=await api.asUser().requestJira(route\`/rest/api/3/user/search?query=\${email}&maxResults=20\`,{headers:{Accept:'application/json'}});\n  if(!response.ok)return{status:'lookup-error'};\n  const users=safeArray(await response.json()).filter(u=>u?.active!==false&&u?.accountType!=='app');\n  const exact=users.filter(u=>u?.emailAddress&&normalise(u.emailAddress)===normalise(email));\n  const matches=exact.length?exact:(users.length===1?users:[]);\n  if(matches.length===1){const u=matches[0];return{status:'linked',accountId:clean(u.accountId||''),displayName:clean(u.displayName||email),accountType:clean(u.accountType||'')};}\n  if(users.length>1)return{status:'multiple'};\n  return{status:'not-found'};\n}\n\n`;
    src = src.replace(marker, helper + marker);
  }

  if (!src.includes("resolver.define('linkCrewCustomers'")) {
    const marker = "resolver.define('getCrewReport', async () => {";
    if (!src.includes(marker)) throw new Error('Could not locate crew report resolver.');
    const resolver = `resolver.define('linkCrewCustomers',async({payload})=>{\n  const retry=payload?.retry===true;\n  const limit=Math.min(25,Math.max(1,Number(payload?.limit||20)));\n  const crewRows=(await entries(CREW_PREFIX,500)).map(e=>e.value);\n  const candidates=crewRows.filter(c=>clean(c?.email||'')&&(retry||!c?.jsmCustomerLinkStatus||c.jsmCustomerLinkStatus==='lookup-error')).slice(0,limit);\n  const assets=(await entries(ASSET_PREFIX,500)).map(e=>e.value);\n  let linked=0,notFound=0,multiple=0,errors=0,assetsLinked=0;\n  for(const crew of candidates){\n    const result=await lookupJsmCustomerByEmail(crew.email);\n    const updated={...crew,jsmCustomerLinkStatus:result.status,jsmCustomerAccountId:result.accountId||'',jsmCustomerDisplayName:result.displayName||'',jsmCustomerAccountType:result.accountType||'',jsmCustomerLinkedAt:result.status==='linked'?now():(crew.jsmCustomerLinkedAt||'')};\n    await kvs.set(crewKey(crew.crewCode),updated);\n    if(result.status==='linked'){linked+=1;for(const asset of assets){if(normalise(asset?.crewCode)!==normalise(crew.crewCode))continue;if(asset.assigneeAccountId)continue;const currentName=clean(asset.assigneeName||'');if(currentName&&normalise(currentName)!==normalise(crew.name)&&normalise(currentName)!==normalise(crew.crewCode))continue;await kvs.set(\`\${ASSET_PREFIX}\${asset.id}\`,{...asset,assigneeAccountId:result.accountId,assigneeName:result.displayName||crew.name||crew.crewCode,updatedAt:now()});await addHistory(asset.id,{type:'jsm-customer-linked',source:'crew-customer-link',message:\`Linked holder to JSM customer \${result.displayName||crew.email}\`,crewCode:crew.crewCode,accountId:result.accountId});assetsLinked+=1;}}\n    else if(result.status==='not-found')notFound+=1;else if(result.status==='multiple')multiple+=1;else errors+=1;\n  }\n  const remaining=crewRows.filter(c=>clean(c?.email||'')&&(retry||!c?.jsmCustomerLinkStatus||c.jsmCustomerLinkStatus==='lookup-error')).length-candidates.length;\n  return{processed:candidates.length,linked,notFound,multiple,errors,assetsLinked,remaining:Math.max(0,remaining)};\n});\n\n`;
    src = src.replace(marker, resolver + marker);
  }

  fs.writeFileSync(path, src);
}

function patchUi() {
  const path = new URL('../crew-static/src/main.jsx', import.meta.url);
  let src = fs.readFileSync(path, 'utf8');

  if (!src.includes('async function linkJsmCustomers()')) {
    const marker = " useEffect(()=>{load();},[]);\n";
    if (!src.includes(marker)) throw new Error('Could not locate Crew Tracking load hook.');
    const addition = marker + ` async function linkJsmCustomers(){setLoading(true);try{let processed=0,linked=0,notFound=0,multiple=0,assetsLinked=0;for(let pass=0;pass<10;pass+=1){const r=await invoke('linkCrewCustomers',{limit:20});processed+=r.processed||0;linked+=r.linked||0;notFound+=r.notFound||0;multiple+=r.multiple||0;assetsLinked+=r.assetsLinked||0;if(!r.processed||!r.remaining)break;await sleep(350);}await load();setMessage(\`JSM customer linking complete: \${processed} crew checked, \${linked} linked, \${notFound} not found, \${multiple} need review, \${assetsLinked} asset holder links updated.\`);}catch(e){setMessage(e.message||'Could not link crew to JSM customers.');}finally{setLoading(false);}}\n`;
    src = src.replace(marker, addition);
  }

  const oldHeader = " return <div className=\"page\"><header><div><h1>Internal Crew Tracking</h1><p>Import the crew register and review current devices by device type plus Jira history by crew member.</p></div><button onClick={load} disabled={loading}>Refresh</button></header>";
  const newHeader = " return <div className=\"page\"><header><div><h1>Internal Crew Tracking</h1><p>Import the crew register, link crew to existing JSM customers by email, and review current devices plus Jira history.</p></div><div><button onClick={linkJsmCustomers} disabled={loading}>Link JSM customers</button><button onClick={load} disabled={loading}>Refresh</button></div></header>";
  if (src.includes(oldHeader)) src = src.replace(oldHeader, newHeader);
  else if (!src.includes('Link JSM customers')) throw new Error('Could not update Crew Tracking header.');

  const oldHead = '<th>Crew code</th><th>Name</th><th>Location</th><th>Current devices by type</th>';
  const newHead = '<th>Crew code</th><th>Name</th><th>JSM customer</th><th>Location</th><th>Current devices by type</th>';
  if (src.includes(oldHead)) src = src.replace(oldHead, newHead);

  const oldRow = "<td><strong>{c.crewCode}</strong></td><td>{c.name||'—'}</td><td>{c.location||'—'}</td><td><DeviceTypeBreakdown";
  const newRow = "<td><strong>{c.crewCode}</strong></td><td>{c.name||'—'}</td><td>{c.jsmCustomerLinkStatus==='linked'?<><strong>{c.jsmCustomerDisplayName||'Linked'}</strong><small style={{display:'block'}}>{c.email||''}</small></>:c.email?<span className={c.jsmCustomerLinkStatus==='multiple'?'flag':''}>{c.jsmCustomerLinkStatus==='not-found'?'Not found':c.jsmCustomerLinkStatus==='multiple'?'Needs review':'Not linked'}</span>:'No email'}</td><td>{c.location||'—'}</td><td><DeviceTypeBreakdown";
  if (src.includes(oldRow)) src = src.replace(oldRow, newRow);

  const modalNeedle = "<p>{selected.location||'No location'} · {selected.status||'—'}</p></div>";
  const modalReplacement = "<p>{selected.location||'No location'} · {selected.status||'—'}</p><p>{selected.email||'No email'} · JSM customer: {selected.jsmCustomerLinkStatus==='linked'?(selected.jsmCustomerDisplayName||'Linked'):(selected.jsmCustomerLinkStatus||'Not linked')}</p></div>";
  if (src.includes(modalNeedle)) src = src.replace(modalNeedle, modalReplacement);

  fs.writeFileSync(path, src);
}

patchBackend();
patchUi();
console.log('Prepared internal crew-to-JSM customer linking.');
