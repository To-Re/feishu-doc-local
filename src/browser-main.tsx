import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserApp } from './browser/BrowserApp';
import './ui/styles.css';
import 'katex/dist/katex.min.css';

class Boundary extends Component<{children:ReactNode},{error:string}> {
  state={error:''};
  static getDerivedStateFromError(error:Error){return{error:error.message};}
  render(){return this.state.error?<main className="loading"><h1>页面暂时无法显示</h1><p>{this.state.error}</p><p>刷新前请保留尚未保存的输入；重新授权目录后可以读取磁盘文件。</p></main>:this.props.children;}
}
createRoot(document.getElementById('root')!).render(<Boundary><BrowserApp/></Boundary>);
