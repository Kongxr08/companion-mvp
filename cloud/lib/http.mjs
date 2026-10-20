import { Engine, AppError } from './engine.mjs';

const headers={
  'Cache-Control':'private, no-store, max-age=0','X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'same-origin','X-Frame-Options':'DENY',
  'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
export const jsonResponse=(value,status=200,extra={})=>Response.json(value,{status,headers:{...headers,...extra}});
export const htmlResponse=html=>new Response(html,{headers:{...headers,'Content-Type':'text/html; charset=utf-8'}});
async function readJson(request,max){
  if(request.headers.get('Content-Type')?.split(';')[0].trim()!=='application/json')throw new AppError('需要JSON请求',415);
  if(Number(request.headers.get('Content-Length'))>max)throw new AppError('文件或消息太大',413);
  const reader=request.body?.getReader();if(!reader)throw new AppError('请求内容为空');
  const chunks=[];let size=0;
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>max){await reader.cancel();throw new AppError('文件或消息太大',413);}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.byteLength;}
  try{const data=JSON.parse(new TextDecoder().decode(bytes));if(!data||typeof data!=='object'||Array.isArray(data))throw new Error();return data;}
  catch{throw new AppError('JSON内容无效');}
}
export async function handleApi(request,db,user,env={},clock){
  if(!user?.userId||!user?.email)return jsonResponse({error:'请先登录你的账号',sign_in:'/signin-with-chatgpt?return_to=%2F'},401);
  if(!db)return jsonResponse({error:'云端数据库尚未就绪，请稍后重试。'},503);
  const path=new URL(request.url).pathname;
  try{
    const engine=new Engine(db,user.userId,env,clock);
    if(request.method==='GET'){
      if(path==='/api/state')return jsonResponse({...await engine.snapshot(),account:{display_name:user.displayName||user.email,email:user.email},hosting:'cloud'});
      if(path==='/api/export')return jsonResponse(await engine.export(),200,{'Content-Disposition':'attachment; filename="companion-export.json"'});
      return jsonResponse({error:'接口不存在'},404);
    }
    if(request.method!=='POST')return jsonResponse({error:'不支持此请求方式'},405,{Allow:'GET, POST'});
    if(request.headers.get('Origin')!==new URL(request.url).origin||request.headers.get('Sec-Fetch-Site')==='cross-site')return jsonResponse({error:'仅允许本站页面提交请求'},403);
    const data=await readJson(request,path==='/api/import'?2*1024*1024:60000);
    let result;
    switch(path){
      case '/api/chat':result=await engine.chat(data.message,data.request_id);break;
      case '/api/memory':result=await engine.changeMemory(data);break;
      case '/api/memory/delete':result=await engine.changeMemory(data,true);break;
      case '/api/settings':result=await engine.saveSettings(data);break;
      case '/api/profile/apply':result=await engine.saveSettings({},true);break;
      case '/api/tasks':result=await engine.addTask(data.title,data.due_at);break;
      case '/api/tasks/cancel':result=await engine.cancelTask(data.id);break;
      case '/api/history/clear':result=await engine.clearHistory();break;
      case '/api/import':result=await engine.importBackup(data);break;
      default:return jsonResponse({error:'接口不存在'},404);
    }
    return jsonResponse(result);
  }catch(error){
    if(error instanceof AppError)return jsonResponse({error:error.message},error.status);
    // Do not log exception objects, SQL bindings, model bodies, or private messages.
    console.error('companion_operation_failed');
    return jsonResponse({error:'保存暂时失败，请稍后重试；输入内容已保留。'},500);
  }
}
