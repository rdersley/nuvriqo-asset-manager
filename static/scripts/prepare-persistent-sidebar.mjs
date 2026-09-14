import fs from 'node:fs';

const path = new URL('../src/main.jsx', import.meta.url);
let src = fs.readFileSync(path, 'utf8');

const oldSettingsReturn = "  if(mode==='settings')return <main><Settings initial={settings}";
const newSettingsReturn = "  if(mode==='settings')return <div className=\"nv-shell\"><aside className=\"nv-sidebar\"><div className=\"nv-brand\"><div className=\"nv-logo\">N</div><div><strong>Nuvriqo</strong><small>Asset Manager</small></div></div><nav><NavButton active={false} icon=\"⌂\" onClick={()=>setMode('overview')}>Overview</NavButton><NavButton active={false} icon=\"▣\" onClick={()=>setMode('assets')}>Assets</NavButton><NavButton icon=\"⇧\" onClick={()=>setShowImport(true)}>Imports</NavButton><NavButton active={false} icon=\"▥\" onClick={()=>setMode('reports')}>Reports</NavButton><NavButton active={true} icon=\"⚙\" onClick={()=>setMode('settings')}>Configuration</NavButton></nav><div className=\"nv-sidebar-bottom\"><span>Help & Support</span><span>Documentation</span><span className=\"nv-version\">Nuvriqo · UI v1</span></div></aside><main className=\"nv-main\"><Settings initial={settings}";

if (src.includes(oldSettingsReturn)) {
  src = src.replace(oldSettingsReturn, newSettingsReturn);
  const settingsEnd = "setMode('overview');}}/></main>;";
  const replacementEnd = "setMode('overview');}}/></main></div>;";
  if (!src.includes(settingsEnd)) throw new Error('Could not locate Configuration return end.');
  src = src.replace(settingsEnd, replacementEnd);
} else if (!src.includes("active={true} icon=\"⚙\"")) {
  throw new Error('Could not locate Configuration early return.');
}

fs.writeFileSync(path, src);
console.log('Prepared persistent Asset Manager sidebar on Configuration screen.');
