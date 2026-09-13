import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './ui/styles.css';
import 'katex/dist/katex.min.css';
class Boundary extends Component<{children:ReactNode},{error:string}> {
  state={error:''};
  static getDerivedStateFromError(error:Error){return{error:error.message};}
  render(){return this.state.error?<main className="loading"><h1>这份文档暂时无法打开</h1><p>{this.state.error}</p><p>原文件保持完整。可以修正 XML 后刷新页面。</p></main>:this.props.children;}
}
createRoot(document.getElementById('root')!).render(<Boundary><App/></Boundary>);
