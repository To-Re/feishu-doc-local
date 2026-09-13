/** Resolve the destination shown to the user; filesystem checks remain server-side. */
export function projectDestination(input:{path:string;name:string;kind:'new'|'existing';homeDirectory?:string;defaultDirectory?:string}):{path:string;error:string} {
  let path=input.path.trim();
  if(!path&&input.kind==='new'&&input.defaultDirectory)path=input.defaultDirectory.replace(/\/$/,'')+'/';
  if(!path)return {path:'',error:'请选择或输入已有 XML 文件的完整路径。'};
  if(path==='~'||path.startsWith('~/')){
    if(!input.homeDirectory?.startsWith('/'))return {path:'',error:'尚未读到本机主目录，请刷新页面或填写以 / 开头的完整路径。'};
    path=input.homeDirectory.replace(/\/$/,'')+(path==='~'?'/':path.slice(1));
  }
  if(!path.startsWith('/')||/[\u0000-\u001f]/.test(path))return {path:'',error:'路径需以 / 或 ~/ 开头。'};
  if(input.kind==='new'&&path.endsWith('/')){
    const filename=input.name.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/g,'-');
    if(!filename||filename==='.'||filename==='..')return {path:'',error:'先填写项目名称，将用它生成 XML 文件名。'};
    path+=/\.xml$/i.test(filename)?filename:filename+'.xml';
  }
  if(!/\.xml$/i.test(path))return {path:'',error:input.kind==='new'?'请输入 .xml 文件路径；如果填目录，请以 / 结尾。':'请选择已有的 .xml 文件，目录不能直接打开。'};
  const parts:string[]=[];
  for(const part of path.split('/')){if(!part||part==='.')continue;if(part==='..')parts.pop();else parts.push(part);}
  return {path:'/'+parts.join('/'),error:''};
}
