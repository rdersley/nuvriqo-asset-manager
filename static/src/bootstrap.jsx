import { view } from '@forge/bridge';

async function start(){
  try{
    const context=await view.getContext();
    const location=String(context?.extension?.location||'').toLowerCase();
    if(location.includes('/reports')){
      await import('./reports.jsx');
      return;
    }
  }catch{}
  await import('./main.jsx');
}

start();
